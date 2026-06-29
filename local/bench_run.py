"""Driver: run the Wan benchmark configs as fresh subprocesses (clean peak mem), print timings.
Usage: python bench_run.py <image.png>
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, ".venv/bin/python")
M14 = os.path.join(HERE, "models/Wan2.2-I2V-A14B-MLX-Q4")
M5 = os.path.join(HERE, "models/Wan2.2-TI2V-5B-MLX")
LDIR = open(os.path.join(HERE, ".lightning-dir")).read().strip()
LH = os.path.join(LDIR, "high_noise_model.safetensors")
LL = os.path.join(LDIR, "low_noise_model.safetensors")
IMG = sys.argv[1]
PROMPT = "the man turns away from the window and walks slowly toward the camera, cinematic handheld camera, moody natural light"
base = dict(image=IMG, prompt=PROMPT, width=832, height=480)

configs = [
    dict(label="14B-Q4-Lightning-4step", model_dir=M14, num_frames=37, steps=4, guide_scale="1", lora_high=LH, lora_low=LL, out="/tmp/b_14b.mp4", **base),
    dict(label="5B-bf16-10step", model_dir=M5, num_frames=57, steps=10, guide_scale="5.0", out="/tmp/b_5b10.mp4", **base),
    dict(label="5B-bf16-20step", model_dir=M5, num_frames=57, steps=20, guide_scale="5.0", out="/tmp/b_5b20.mp4", **base),
    dict(label="5B-bf16-40step", model_dir=M5, num_frames=57, steps=40, guide_scale="5.0", out="/tmp/b_5b40.mp4", **base),
]

KEEP = ("BENCH_RESULT", "Denoising:", "VAE decode:", "Total time:", "Models loaded:", "Image encoding:", "Insufficient", "Error", "Traceback")
for c in configs:
    print(f"\n##### RUN {c['label']} (steps={c['steps']} frames={c['num_frames']})", flush=True)
    p = subprocess.run([PY, os.path.join(HERE, "bench.py"), json.dumps(c)], capture_output=True, text=True)
    for line in (p.stdout + p.stderr).splitlines():
        if any(k in line for k in KEEP):
            print(line, flush=True)
print("\n##### BENCH DONE", flush=True)
