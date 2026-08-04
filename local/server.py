"""Resident local-model HTTP sidecar for Videoboom.

Started on demand by the Electron engine (src/engine/sidecar.ts). Stays warm for the app's lifetime so the
heavy Python/MLX import (and, per model, the weights) is paid once, not per request. Localhost only; one
GPU job at a time (a single global lock). Model-agnostic: each request names the model(s) it needs, so one
process serves every on-device stage.

Endpoints
  GET  /health        -> {ok}
  POST /i2v   {json}   -> {ok, num_frames, ...}   Wan 2.2 image-to-video (blocks minutes)
  POST /stt   {json}   -> {ok, words:[{start,end,word}], text}   whisper transcription + word timing

Heavy handlers write their output straight to a path in the request (same machine, same FS) or return
small JSON; serialised by GPU_LOCK so concurrent requests queue rather than oversubscribe memory.
"""
import argparse
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GPU_LOCK = threading.Lock()  # one model job at a time (shared unified memory)


def _handle_i2v(req: dict) -> dict:
    # The video model self-loads/frees its weights outside the ModelManager, so first evict any resident
    # keyframe/LLM/VLM model — otherwise that (~10GB FLUX, ~19GB LLM) plus the ~19-24GB video model OOMs
    # unified memory (Metal "Insufficient Memory").
    from manager import unload_all
    unload_all()
    from wan_i2v import run_i2v          # Wan 2.2 (5B / 14B)
    return run_i2v(req)


def _handle_stt(req: dict) -> dict:
    from stt import run_stt
    return run_stt(req)


def _handle_llm(req: dict) -> dict:
    from llm import run_llm
    return run_llm(req)


def _handle_vlm(req: dict) -> dict:
    from vlm import run_vlm
    return run_vlm(req)


def _handle_keyframe(req: dict) -> dict:
    from keyframe import run_keyframe
    return run_keyframe(req)


def _run_isolated(script: str, req: dict) -> dict:
    """Run an ncnn/Vulkan job (interp.py / upscale.py) in a FRESH python subprocess. The rife and
    realesrgan wheels each statically bundle MoltenVK — importing both in one process duplicates objc
    classes and SEGFAULTS (verified). Isolation also returns all Vulkan memory the moment the job ends.
    Still under GPU_LOCK like every job. The child reads the request JSON on stdin and prints the result
    JSON as its last stdout line (the ncnn wrappers spam progress lines first)."""
    import os
    import signal
    import subprocess
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    # start_new_session so a timeout can kill the WHOLE process group: the worker spawns ffmpeg children,
    # and killing only the python pid would leave a re-parented ffmpeg running (CPU + half-written files).
    p = subprocess.Popen(
        [sys.executable, os.path.join(here, script)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = p.communicate(input=json.dumps(req).encode(), timeout=int(req.get("timeout_sec", 5400)))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            p.kill()
        p.communicate()
        return {"ok": False, "error": f"{script} timed out"}
    if p.returncode != 0:
        tail = (err or b"")[-800:].decode(errors="replace")
        return {"ok": False, "error": f"{script} exited {p.returncode}: {tail}"}
    for line in reversed((out or b"").decode(errors="replace").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                pass
    return {"ok": False, "error": f"{script}: no JSON result in output"}


def _handle_interp(req: dict) -> dict:
    # RIFE frame interpolation — isolated subprocess (see _run_isolated), no MLX model, no unload_all().
    return _run_isolated("interp.py", req)


def _handle_upscale(req: dict) -> dict:
    # Real-ESRGAN video upscale — isolated subprocess, same deal as /interp.
    return _run_isolated("upscale.py", req)


ROUTES = {
    "/i2v": _handle_i2v,
    "/stt": _handle_stt,
    "/llm": _handle_llm,
    "/vlm": _handle_vlm,
    "/keyframe": _handle_keyframe,
    "/interp": _handle_interp,
    "/upscale": _handle_upscale,
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ok": True, "routes": sorted(ROUTES)})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        handler = ROUTES.get(self.path)
        if handler is None:
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"bad request: {e}"})
            return
        with GPU_LOCK:
            try:
                result = handler(req)
                self._send(200 if result.get("ok") else 500, result)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, *args) -> None:  # silence per-request stderr spam
        pass


def _watch_parent(ppid: int) -> None:
    """Exit when the Electron process that spawned us is gone.

    We are a plain child, so on macOS a quit re-parents us to launchd and we would otherwise keep running
    forever — with the last heavy model still resident (manager.py evicts only at the head of /i2v), i.e.
    10-19 GB of unified memory held with no app on screen. sidecar.ts kills us on a clean quit; this covers
    the cases where it cannot (crash, SIGKILL). os._exit skips atexit/GC on purpose: the point is to release
    the memory immediately, and a diffusion job holding GPU_LOCK would stall a graceful shutdown.
    """
    while True:
        time.sleep(5)
        try:
            os.kill(ppid, 0)
        except OSError:
            print("[vb-local] parent gone — exiting", flush=True)
            os._exit(0)


def main() -> None:
    ap = argparse.ArgumentParser(description="Videoboom local-model sidecar")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--parent-pid", type=int, default=0, help="exit when this pid disappears")
    args = ap.parse_args()
    if args.parent_pid:
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[vb-local] sidecar on http://127.0.0.1:{args.port}  routes={sorted(ROUTES)}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
