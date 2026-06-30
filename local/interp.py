"""Frame interpolation via RIFE (rife-ncnn-vulkan, Apple GPU through MoltenVK) — 2x a video's frame rate.

Used to render Wan clips at HALF the frames (faster denoise + VAE) then interpolate back up to the target
fps with real motion. RIFE at 2x (small frame gap) is near-ground-truth on cinematic pans/walking. MIT
licensed (wrapper + weights). Falls back to nothing here — the engine handles the ffmpeg fallback.

run_interpolate(req): {video, out, [model], [gpuid]} -> {ok, frames_in, frames_out}. Doubles the frame
count (inserts one midpoint between each pair); the caller muxes at 2x fps for real-time playback.
"""
import os
import subprocess

_RIFE = {}


def _ffmpeg() -> str:
    # ffmpeg-static path passed by the caller, else system ffmpeg
    return os.environ.get("VB_FFMPEG", "ffmpeg")


def _extract_frames(video: str, d: str) -> int:
    os.makedirs(d, exist_ok=True)
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-i", video, os.path.join(d, "f_%05d.png")], check=True)
    return len([f for f in os.listdir(d) if f.endswith(".png")])


def run_interpolate(req: dict) -> dict:
    from PIL import Image
    from rife_ncnn_vulkan_python import Rife

    video = req["video"]
    out = req["out"]
    model = req.get("model", "rife-v4.6")
    gpuid = int(req.get("gpuid", 0))

    work = video + "_interp"
    fin = os.path.join(work, "in")
    fout = os.path.join(work, "out")
    os.makedirs(fout, exist_ok=True)
    n = _extract_frames(video, fin)
    if n < 2:
        return {"ok": False, "error": "need >= 2 frames to interpolate"}

    frames = sorted(f for f in os.listdir(fin) if f.endswith(".png"))
    first = Image.open(os.path.join(fin, frames[0])).convert("RGB")
    w, h = first.size
    key = (model, w, h, gpuid)
    if key not in _RIFE:
        _RIFE[key] = Rife(gpuid=gpuid, model=model, scale=2, width=w, height=h)
    rife = _RIFE[key]

    # interleave: f0, mid(f0,f1), f1, mid(f1,f2), f2, ...  -> 2n-1 frames
    oi = 0
    prev = first
    Image.open(os.path.join(fin, frames[0])).convert("RGB").save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1
    for i in range(1, n):
        cur = Image.open(os.path.join(fin, frames[i])).convert("RGB")
        mid = rife.process(prev, cur, timestep=0.5)
        mid.save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1
        cur.save(os.path.join(fout, f"o_{oi:05d}.png")); oi += 1
        prev = cur

    fps = float(req.get("out_fps", 24))
    subprocess.run([
        _ffmpeg(), "-y", "-loglevel", "error", "-framerate", str(fps),
        "-i", os.path.join(fout, "o_%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
    ], check=True)
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    return {"ok": ok, "frames_in": n, "frames_out": oi, "width": w, "height": h}
