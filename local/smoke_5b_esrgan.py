"""Smoke test: ~8s of Wan2.2-TI2V-5B video (chained native sub-clips) + a Real-ESRGAN upscaled version,
so we can eyeball whether ESRGAN cleans up the 5B's x64-VAE softness/deformation. Usage:
  python smoke_5b_esrgan.py <start.png>
Outputs /tmp/smoke_5b_raw.mp4 (8s, 480p) and /tmp/smoke_5b_esrgan.mp4 (8s, ESRGAN then back to a sharp 480p).
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FF = os.environ.get("VB_FFMPEG", "ffmpeg")
M5 = open(os.path.join(HERE, ".model-path-5b")).read().strip()
START = sys.argv[1]
PROMPT = "the man walks slowly through the moody room toward the camera, subtle natural motion, cinematic handheld camera, film lighting"
FPS = 24
SUB_SEC = 2.4          # one native 5B clip
N_SUB = 4              # ~9.6s total -> trim/keep ~8s
STEPS = int(os.environ.get("VB_SMOKE_STEPS", "12"))


def last_frame(video: str, out: str):
    subprocess.run([FF, "-y", "-loglevel", "error", "-sseof", "-0.4", "-i", video, "-frames:v", "1", "-update", "1", out], check=True)
    return out


def run():
    from wan_i2v import run_i2v

    subs = []
    start = START
    t0 = time.time()
    for i in range(N_SUB):
        out = f"/tmp/smk_sub_{i}.mp4"
        r = run_i2v({"model_dir": M5, "image": start, "prompt": PROMPT, "out": out,
                     "seconds": SUB_SEC, "fps": FPS, "steps": STEPS, "width": 832, "height": 480, "seed": 42 + i})
        if not r.get("ok"):
            print("SUB", i, "FAILED", r); return
        subs.append(out)
        print(f"  sub {i+1}/{N_SUB} ok ({time.time()-t0:.0f}s elapsed)", flush=True)
        if i < N_SUB - 1:
            start = last_frame(out, f"/tmp/smk_last_{i}.png")
    # concat raw
    lst = "/tmp/smk_concat.txt"
    open(lst, "w").write("\n".join(f"file '{s}'" for s in subs) + "\n")
    subprocess.run([FF, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "/tmp/smoke_5b_raw.mp4"], check=True)
    print(f"  RAW 8s done ({time.time()-t0:.0f}s)", flush=True)

    # ESRGAN: upscale every frame, then downscale back to a crisp 480p (detail recovery, same size to compare)
    from PIL import Image
    from realesrgan_ncnn_py import Realesrgan
    up = Realesrgan(gpuid=0, model=0)
    fin, fout = "/tmp/smk_frames_in", "/tmp/smk_frames_out"
    os.makedirs(fin, exist_ok=True); os.makedirs(fout, exist_ok=True)
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", "/tmp/smoke_5b_raw.mp4", os.path.join(fin, "f_%05d.png")], check=True)
    frames = sorted(f for f in os.listdir(fin) if f.endswith(".png"))
    te = time.time()
    for f in frames:
        img = Image.open(os.path.join(fin, f)).convert("RGB")
        out = up.process_pil(img).resize((832, 480), Image.LANCZOS)  # upscale->detail, back to 480p to compare
        out.save(os.path.join(fout, f))
    subprocess.run([FF, "-y", "-loglevel", "error", "-framerate", str(FPS),
                    "-i", os.path.join(fout, "f_%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "/tmp/smoke_5b_esrgan.mp4"], check=True)
    print(f"  ESRGAN {len(frames)} frames done ({time.time()-te:.0f}s). TOTAL {time.time()-t0:.0f}s", flush=True)
    print("DONE raw=/tmp/smoke_5b_raw.mp4 esrgan=/tmp/smoke_5b_esrgan.mp4", flush=True)


run()
