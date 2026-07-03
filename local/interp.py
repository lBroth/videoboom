"""Frame interpolation via RIFE (rife-ncnn-vulkan, Apple GPU through MoltenVK) — 2x a video's frame rate.

Used to render Wan clips at HALF the frames (faster denoise + VAE) then interpolate back up to the target
fps with real motion. RIFE at 2x (small frame gap) is near-ground-truth on cinematic pans/walking. MIT
licensed (wrapper + weights). Falls back to nothing here — the engine handles the ffmpeg fallback.

run_interpolate(req): {video, out, [model], [gpuid], [out_fps]} -> {ok, frames_in, frames_out}. Doubles the
frame count (a midpoint between each pair + the last frame repeated once = 2n frames), muxed at out_fps
(pass 2x the source fps) so the clip keeps exactly its source duration with real in-between motion.
"""
import os
import shutil
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))


def _ffmpeg() -> str:
    # ffmpeg-static path passed by the caller, else system ffmpeg
    return os.environ.get("VB_FFMPEG", "ffmpeg")


def _default_model() -> str:
    """Newest bundled RIFE first: rife-v4.25/4.26 handle large/fast motion far better than the wheel's
    2022-era rife-v4.6 (and the installed wheel special-cases their padding). Absolute dir under
    local/models/ wins; VB_RIFE_MODEL overrides; rife-v4.6 (bundled in the wheel) is the fallback."""
    envm = os.environ.get("VB_RIFE_MODEL", "")
    if envm:
        return envm
    for name in ("rife-v4.26", "rife-v4.25"):
        d = os.path.join(_HERE, "models", name)
        if os.path.isfile(os.path.join(d, "flownet.param")):
            return d
    return "rife-v4.6"


def _extract_frames(video: str, d: str) -> int:
    os.makedirs(d, exist_ok=True)
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-i", video, os.path.join(d, "f_%05d.png")], check=True)
    return len([f for f in os.listdir(d) if f.endswith(".png")])


def run_interpolate(req: dict) -> dict:
    from PIL import Image
    from rife_ncnn_vulkan_python import Rife

    video = req["video"]
    out = req["out"]
    model = req.get("model") or _default_model()
    gpuid = int(req.get("gpuid", 0))

    work = video + "_interp"
    # A previous FAILED/killed run leaves stale frames here; ffmpeg's image2 demuxer would happily append
    # them to a shorter retry's sequence (corrupted output) — always start from a clean dir.
    shutil.rmtree(work, ignore_errors=True)
    fin = os.path.join(work, "in")
    fout = os.path.join(work, "out")
    os.makedirs(fout, exist_ok=True)
    n = _extract_frames(video, fin)
    if n < 2:
        shutil.rmtree(work, ignore_errors=True)
        return {"ok": False, "error": "need >= 2 frames to interpolate"}

    frames = sorted(f for f in os.listdir(fin) if f.endswith(".png"))
    first = Image.open(os.path.join(fin, frames[0])).convert("RGB")
    w, h = first.size
    # No caching: the sidecar runs each job in a fresh subprocess (MoltenVK isolation), so nothing persists.
    rife = Rife(gpuid=gpuid, model=model, scale=2, width=w, height=h)

    # interleave: f0, mid(f0,f1), f1, mid(f1,f2), f2, ..., fN, fN  -> 2n frames. The final frame repeats
    # once so the clip keeps EXACTLY its source duration at 2x fps (2n-1 frames would run 1/(2*fps) short
    # per clip — enough to break the chained-total >= scene-window invariant and drift the timeline).
    oi = 0
    prev = first
    Image.open(os.path.join(fin, frames[0])).convert("RGB").save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1
    for i in range(1, n):
        cur = Image.open(os.path.join(fin, frames[i])).convert("RGB")
        mid = rife.process(prev, cur, timestep=0.5)
        mid.save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1
        cur.save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1
        prev = cur
    prev.save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1

    fps = float(req.get("out_fps", 24))
    subprocess.run([
        _ffmpeg(), "-y", "-loglevel", "error", "-framerate", str(fps),
        "-i", os.path.join(fout, "o_%05d.png"),
        # CRF 14: this hop feeds further re-encodes (trim/concat) — keep it visually lossless.
        "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", out,
    ], check=True)
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    shutil.rmtree(work, ignore_errors=True)  # frame PNGs are big; don't leak them per clip
    return {"ok": ok, "frames_in": n, "frames_out": oi, "width": w, "height": h, "model": os.path.basename(str(model))}


if __name__ == "__main__":
    # Subprocess entrypoint for the sidecar (see server._run_isolated): request JSON on stdin, result JSON
    # as the last stdout line. Keeps this Vulkan wrapper out of the sidecar process (MoltenVK clash).
    import json
    import sys
    print(json.dumps(run_interpolate(json.load(sys.stdin))), flush=True)
