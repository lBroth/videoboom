"""Round 2 — 14B quality vs speed via fewer frames + interpolation. Generates the 14B (x16 VAE = sharper)
at full frames (baseline) and at HALF frames (faster), then ffmpeg-minterpolates the half back to full so we
can compare 14B-quality at ~half the gen time. Usage: python bench_14b.py <image.png>
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
import importlib.util

FF = importlib.util.find_spec  # noqa: F841 (keep import minimal)
IMG = sys.argv[1]
PROMPT = "the man turns from the window and walks slowly toward the camera, cinematic handheld camera, moody natural light"
base = dict(model_dir=M14, image=IMG, prompt=PROMPT, width=832, height=480, guide_scale="1", lora_high=LH, lora_low=LL)

# 14B is 16fps native; 37 frames ~= 2.3s. Half = 19 (4n+1) -> minterpolate back to ~37.
configs = [
    dict(base, label="14B-Lightning-37f", num_frames=37, out="/tmp/b14_37.mp4"),
    dict(base, label="14B-Lightning-19f", num_frames=19, out="/tmp/b14_19.mp4"),
]
KEEP = ("BENCH_RESULT", "Denoising:", "VAE decode:", "Total time:", "Insufficient", "Traceback")
for c in configs:
    print(f"\n##### {c['label']}", flush=True)
    p = subprocess.run([PY, os.path.join(HERE, "bench.py"), json.dumps(c)], capture_output=True, text=True)
    for line in (p.stdout + p.stderr).splitlines():
        if any(k in line for k in KEEP):
            print(line, flush=True)
print("\n##### 14B BENCH DONE — minterpolate the 19f next", flush=True)
