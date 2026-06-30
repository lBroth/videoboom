"""One-config Wan benchmark run. Takes a JSON config on argv, runs generate_video in a FRESH process
(clean peak-memory), prints BENCH_RESULT json + lets generate_video's own Denoising/VAE/Total timers through.
"""
import json
import os
import sys
import time

import mlx.core as mx

# Optional MLX memory cap. OFF by default — a cap set BELOW what the 14B needs strangles it into swap
# (image-encode went 4.4s -> 49s under a 46GB cap), which earlier led to a false "14B unusable" read. The
# real crash that rebooted the Mac was two model processes running at once; the app already serialises to
# one GPU job, so no cap is needed there. Set VB_BENCH_MEM_GB only as a deliberate ceiling for stress tests.
_cap = os.environ.get("VB_BENCH_MEM_GB", "")
if _cap:
    try:
        mx.set_memory_limit(int(float(_cap) * 1024 ** 3))
    except Exception:
        pass

from mlx_video.models.wan_2.generate import generate_video

cfg = json.loads(sys.argv[1])
lh = [(cfg["lora_high"], 1.0)] if cfg.get("lora_high") else None
ll = [(cfg["lora_low"], 1.0)] if cfg.get("lora_low") else None

t0 = time.time()
generate_video(
    model_dir=cfg["model_dir"],
    prompt=cfg["prompt"],
    image=cfg["image"],
    width=cfg["width"],
    height=cfg["height"],
    num_frames=cfg["num_frames"],
    steps=cfg.get("steps"),
    guide_scale=cfg.get("guide_scale"),
    shift=cfg.get("shift"),
    seed=42,
    output_path=cfg["out"],
    loras_high=lh,
    loras_low=ll,
    trim_first_frames=0,
    tiling=cfg.get("tiling", "auto"),
)
dt = time.time() - t0
peak = mx.get_peak_memory() / 1e9
print("BENCH_RESULT " + json.dumps({
    "label": cfg["label"],
    "total_s": round(dt, 1),
    "peak_gb": round(peak, 1),
    "model": cfg["model_dir"].split("/")[-1],
    "steps": cfg.get("steps"),
    "guide": cfg.get("guide_scale"),
    "frames": cfg["num_frames"],
    "res": f'{cfg["width"]}x{cfg["height"]}',
    "out": cfg["out"],
}), flush=True)
