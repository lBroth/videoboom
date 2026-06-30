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
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GPU_LOCK = threading.Lock()  # one model job at a time (shared unified memory)


def _handle_i2v(req: dict) -> dict:
    # The video model self-loads/frees its weights outside the ModelManager, so first evict any resident
    # keyframe/LLM/VLM model — otherwise that (~10GB FLUX, ~19GB LLM) plus the ~19-24GB video model OOMs
    # unified memory (Metal "Insufficient Memory").
    from manager import unload_all
    unload_all()
    if req.get("engine") == "ltx":
        from ltx_i2v import run_ltx_i2v  # LTX-2.3, first+last frame morph
        return run_ltx_i2v(req)
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


ROUTES = {
    "/i2v": _handle_i2v,
    "/stt": _handle_stt,
    "/llm": _handle_llm,
    "/vlm": _handle_vlm,
    "/keyframe": _handle_keyframe,
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


def main() -> None:
    ap = argparse.ArgumentParser(description="Videoboom local-model sidecar")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[vb-local] sidecar on http://127.0.0.1:{args.port}  routes={sorted(ROUTES)}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
