"""Round 1 smoke test — 5B step floor. Run a fixed image/prompt/seed at several native step counts to find
the lowest steps that still hold quality. Reuses bench.py per config (fresh process = clean peak mem).
Usage: python bench_steps.py <image.png>
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, ".venv/bin/python")
M5 = open(os.path.join(HERE, ".model-path-5b")).read().strip()
IMG = sys.argv[1]
PROMPT = "the man turns from the window and walks slowly toward the camera, cinematic handheld camera, moody natural light"
base = dict(model_dir=M5, image=IMG, prompt=PROMPT, width=832, height=480, num_frames=57, guide_scale="5.0")

# steps to probe (descending so the fast ones come first)
STEPS = [int(x) for x in (os.environ.get("VB_BENCH_STEPS", "4,6,8,10").split(","))]
configs = [dict(base, label=f"5B-{s}step", steps=s, out=f"/tmp/bs_5b_{s}.mp4") for s in STEPS]

KEEP = ("BENCH_RESULT", "Denoising:", "VAE decode:", "Total time:", "Insufficient", "Traceback")
for c in configs:
    print(f"\n##### {c['label']}", flush=True)
    p = subprocess.run([PY, os.path.join(HERE, "bench.py"), json.dumps(c)], capture_output=True, text=True)
    for line in (p.stdout + p.stderr).splitlines():
        if any(k in line for k in KEEP):
            print(line, flush=True)
print("\n##### STEPS BENCH DONE", flush=True)
