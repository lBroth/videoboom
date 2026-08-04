"""Video upscale via Real-ESRGAN (ncnn/Vulkan on the Apple GPU through MoltenVK).

The diffusion models emit 832x480 / 896x512 — watched fullscreen that reads soft no matter how good the
denoise was. This upscales every frame with a GAN (validated on this Mac in smoke_5b_esrgan.py), then
scales to the target height (default 1080) with lanczos in the final encode. Frame-by-frame + streaming
directories, so memory stays flat regardless of video length.

run_upscale(req): {video, out, [target_h=1080], [model=0], [gpuid]} -> {ok, frames, width, height}
Model indices (realesrgan_ncnn_py bundled weights):
  0 = realesr-animevideov3-x2 (default — video-tuned, least flicker, fast)
  1/2 = animevideov3 x3/x4, 3 = realesrgan-x4plus-anime, 4 = realesrgan-x4plus (photo GAN, more flicker)
"""
import os
import shutil
import subprocess


def _ffmpeg() -> str:
    return os.environ.get("VB_FFMPEG", "ffmpeg")


def _ffprobe() -> str:
    p = os.environ.get("VB_FFPROBE", "")
    if p:
        return p
    ff = _ffmpeg()
    guess = os.path.join(os.path.dirname(ff), "ffprobe")
    return guess if os.path.isfile(guess) else "ffprobe"


def run_upscale(req: dict) -> dict:
    from PIL import Image
    from realesrgan_ncnn_py import Realesrgan

    video = req["video"]
    out = req["out"]
    target_h = int(req.get("target_h", 1080))
    model = int(req.get("model", os.environ.get("VB_UPSCALE_MODEL", "0")))
    gpuid = int(req.get("gpuid", 0))

    work = video + "_upscale"
    # Stale frames from a failed/killed previous run would get appended to a retry's image sequence by
    # ffmpeg's image2 demuxer — always start clean.
    shutil.rmtree(work, ignore_errors=True)
    fin = os.path.join(work, "in")
    fout = os.path.join(work, "out")
    os.makedirs(fin, exist_ok=True)
    os.makedirs(fout, exist_ok=True)

    # probe the source fps so the upscaled video keeps the exact same timing
    p = subprocess.run(
        [_ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
         "-of", "default=nw=1:nk=1", video],
        capture_output=True, text=True,
    )
    rate = (p.stdout or "").strip() or "24/1"
    try:
        num, den = rate.split("/")
        fps = float(num) / float(den)  # ffprobe can report '0/0' (unknown) → ZeroDivisionError → fallback
    except (ValueError, ZeroDivisionError):
        fps = 24.0
    if not (0 < fps < 1000):
        fps = 24.0

    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-i", video, os.path.join(fin, "f_%06d.png")], check=True)
    frames = sorted(f for f in os.listdir(fin) if f.endswith(".png"))
    if not frames:
        return {"ok": False, "error": "no frames extracted"}

    # No caching: the sidecar runs each job in a fresh subprocess (MoltenVK isolation), nothing persists.
    up = Realesrgan(gpuid=gpuid, model=model)

    w = h = 0
    for f in frames:
        img = Image.open(os.path.join(fin, f)).convert("RGB")
        big = up.process_pil(img)
        w, h = big.size
        big.save(os.path.join(fout, f))
        os.remove(os.path.join(fin, f))  # keep the working set one frame deep on disk

    # even width for yuv420p at the target height
    subprocess.run([
        _ffmpeg(), "-y", "-loglevel", "error", "-framerate", f"{fps:.6f}",
        "-i", os.path.join(fout, "f_%06d.png"),
        "-vf", f"scale=-2:{target_h}:flags=lanczos",
        "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", out,
    ], check=True)
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    shutil.rmtree(work, ignore_errors=True)
    return {"ok": ok, "frames": len(frames), "width": w, "height": h, "fps": fps, "target_h": target_h}


if __name__ == "__main__":
    # Subprocess entrypoint for the sidecar (see server._run_isolated): request JSON on stdin, result JSON
    # as the last stdout line. Keeps this Vulkan wrapper out of the sidecar process (MoltenVK clash).
    import json
    import sys
    print(json.dumps(run_upscale(json.load(sys.stdin))), flush=True)
