"""Round 2 (SAFE) — 14B (x16 VAE = sharper than the 5B) at FEW frames + RIFE 2x interpolation.

The 14B at 37 frames exhausted unified memory and kernel-panicked the Mac, so this NEVER runs 37 frames:
it generates short clips (13/17/21 frames, all 4n+1) — light on memory — then RIFE-doubles each back up to
a normal frame count, giving 14B quality at a safe peak. bench.py caps MLX memory so an over-budget run
fails cleanly instead of crashing the OS. Usage: python bench_14b.py <image.png>
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, ".venv/bin/python")
M14 = os.path.join(HERE, "models/Wan2.2-I2V-A14B-MLX-Q4")
LDIR = open(os.path.join(HERE, ".lightning-dir")).read().strip()
LH, LL = os.path.join(LDIR, "high_noise_model.safetensors"), os.path.join(LDIR, "low_noise_model.safetensors")
IMG = sys.argv[1]
PROMPT = "the man turns from the window and walks slowly toward the camera, cinematic handheld camera, moody natural light"
# steps=4 + guide=1 = the Wan2.2-Lightning fast path (bench.py calls generate_video directly, so unlike
# wan_i2v.run_i2v it does NOT auto-set steps=4 when LoRAs are present — must pass it explicitly).
base = dict(model_dir=M14, image=IMG, prompt=PROMPT, width=832, height=480, steps=4, guide_scale="1", lora_high=LH, lora_low=LL)

# 14B is 16fps native; keep frames LOW (memory-safe), RIFE 2x doubles them back to a usable clip.
# 4n+1 only: 13 (~0.8s -> 25f), 17 (~1.06s -> 33f), 21 (~1.3s -> 41f). 37 is the killer — excluded.
FRAMES = [int(x) for x in os.environ.get("VB_BENCH_FRAMES", "13,17,21").split(",")]
configs = [dict(base, label=f"14B-{f}f", num_frames=f, out=f"/tmp/b14_{f}.mp4") for f in FRAMES]

KEEP = ("BENCH_RESULT", "Denoising:", "VAE decode:", "Total time:", "Insufficient", "Traceback")
for c in configs:
    print(f"\n##### {c['label']} (num_frames={c['num_frames']})", flush=True)
    p = subprocess.run([PY, os.path.join(HERE, "bench.py"), json.dumps(c)], capture_output=True, text=True)
    for line in (p.stdout + p.stderr).splitlines():
        if any(k in line for k in KEEP):
            print(line, flush=True)
    # RIFE 2x the result (Apple GPU) so we can eyeball 14B-quality at a doubled frame count.
    if os.path.exists(c["out"]):
        rife_out = c["out"].replace(".mp4", "_rife.mp4")
        env = {**os.environ, "VB_FFMPEG": os.environ.get("VB_FFMPEG", "ffmpeg"), "PYTHONPATH": HERE}
        r = subprocess.run([PY, "-c",
            f"from interp import run_interpolate; print(run_interpolate({{'video':'{c['out']}','out':'{rife_out}','out_fps':24}}))"],
            capture_output=True, text=True, env=env)
        for line in (r.stdout + r.stderr).splitlines():
            if "frames_out" in line or "ok" in line.lower():
                print("  RIFE:", line.strip(), flush=True)
print("\n##### 14B+RIFE BENCH DONE", flush=True)
