"""Render the same 3-second shot through both 14B tiers, for a side-by-side quality read.

The tiers differ in two things and this script changes nothing else — same start keyframe, same prompt,
same seed, same canvas, same chaining:

    fast     4 steps + tiny VAE (TAEHV)      expected ~132 s per sub-clip
    quality  6 steps + the official Wan VAE  expected ~246 s per sub-clip

Both figures are projections from the measured 27.5 s/step at 832x480/37f; the point of this script is to
replace them with real numbers and real frames. The 6-step choice in particular is unvalidated: Lightning
is distilled to 4, and pushing a distilled schedule too far over-denoises into flat, slow-motion output.
If 6 does not visibly beat 4, the Quality tier should drop back to 4 steps and keep only the official VAE.

3 seconds needs two chained sub-clips, because the 14B is capped at 37 frames (2.31 s at its native
16 fps). The chaining here mirrors src/engine/backends/local/video.ts: sub-clip 2 starts from sub-clip 1's
real last frame, so the seam is the same one production produces.

Usage:
    python local/ab_tiers.py --image <keyframe.png> --prompt "..." [--seconds 3] [--tier fast|quality|both]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("VB_LOCAL_PORT", "8765"))
FPS = 16  # 14B native
MAX_FRAMES = 37  # the 48GB working-set cap; 2.31 s per sub-clip

TIERS = {
    # steps, tiny_vae, label
    "fast": (4, 1, "Lightning 4-step + tiny VAE (TAEHV)"),
    "quality": (6, 0, "Lightning 6-step + official Wan VAE"),
    # The control arm. fast->quality changes the step count AND the decoder at once, so a quality win
    # cannot be attributed. This isolates the decoder: if it matches 'quality', the extra two steps buy
    # nothing and Quality should run at 4.
    "vaeonly": (4, 0, "Lightning 4-step + official Wan VAE (isolates the decoder)"),
}


def post(route: str, payload: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{route}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def ffmpeg() -> str:
    return os.environ.get("VB_FFMPEG", "ffmpeg")


def last_frame(video: str, out: str) -> str:
    """The clip's real final frame, the way ffmpeg.ts lastFrame() takes it (seek from EOF)."""
    subprocess.run(
        [ffmpeg(), "-y", "-loglevel", "error", "-sseof", "-0.4", "-i", video, "-update", "1", "-q:v", "2", out],
        check=True,
    )
    return out


def concat(parts: list[str], out: str) -> str:
    lst = out + ".txt"
    with open(lst, "w") as fh:
        for p in parts:
            fh.write(f"file '{os.path.abspath(p)}'\n")
    subprocess.run(
        [ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out],
        check=True,
    )
    return out


def render_tier(tier: str, args, model_dir: str, lora: tuple[str, str] | None) -> dict:
    steps, tiny, label = TIERS[tier]
    native = MAX_FRAMES / FPS
    n_sub = max(1, int(-(-args.seconds // native)))  # ceil
    outdir = os.path.join(args.outdir, tier)
    os.makedirs(outdir, exist_ok=True)

    parts, timings, start_img = [], [], args.image
    for i in range(n_sub):
        remaining = args.seconds - i * native
        secs = min(native, remaining + 0.35) if i == n_sub - 1 else native
        sub = os.path.join(outdir, f"sub_{i}.mp4")
        payload = {
            "model_dir": model_dir,
            "image": start_img,
            "prompt": args.prompt,
            "out": sub,
            "seconds": secs,
            "fps": FPS,
            "width": args.width,
            "height": args.height,
            "seed": args.seed + i,
            "max_frames": MAX_FRAMES,
            "min_frames": 21,
            "tiling": "auto",
            "tiny_vae": tiny,
            "steps": steps,
        }
        if lora:
            payload["lora_high"], payload["lora_low"] = lora
            payload["lora_strength_high"] = 0.6
            payload["lora_strength_low"] = 1.0
        print(f"  [{tier}] sub-clip {i + 1}/{n_sub}: {steps} steps, tiny_vae={tiny}, {secs:.2f}s", flush=True)
        t0 = time.time()
        r = post("/i2v", payload, timeout=args.deadline)
        dt = time.time() - t0
        if not r.get("ok"):
            raise RuntimeError(f"{tier} sub-clip {i}: {r.get('error')}")
        timings.append(dt)
        parts.append(sub)
        print(f"        {dt:.1f}s  ({r.get('num_frames')} frames)", flush=True)
        if i < n_sub - 1:
            start_img = last_frame(sub, os.path.join(outdir, f"last_{i}.png"))

    final = os.path.join(args.outdir, f"{tier}.mp4")
    concat(parts, final) if len(parts) > 1 else subprocess.run(
        [ffmpeg(), "-y", "-loglevel", "error", "-i", parts[0], "-c", "copy", final], check=True
    )
    return {
        "tier": tier,
        "label": label,
        "steps": steps,
        "tiny_vae": bool(tiny),
        "sub_clips": n_sub,
        "per_sub_s": [round(t, 1) for t in timings],
        "total_s": round(sum(timings), 1),
        "out": final,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--seed", type=int, default=42)
    # Derived from TIERS so adding an arm cannot silently fail at the CLI boundary.
    ap.add_argument("--tier", choices=[*TIERS, "both"], default="both")
    ap.add_argument("--outdir", default=os.path.join(HERE, "..", "ab_out"))
    ap.add_argument("--deadline", type=int, default=3600)
    args = ap.parse_args()
    args.outdir = os.path.abspath(args.outdir)
    os.makedirs(args.outdir, exist_ok=True)

    model_dir = open(os.path.join(HERE, ".model-path")).read().strip()
    ld = os.path.join(HERE, ".lightning-dir")
    lora = None
    if os.path.isfile(ld):
        d = open(ld).read().strip()
        hi, lo = os.path.join(d, "high_noise_model.safetensors"), os.path.join(d, "low_noise_model.safetensors")
        if os.path.isfile(hi) and os.path.isfile(lo):
            lora = (hi, lo)
    if not lora:
        sys.exit("Lightning LoRA missing — both tiers depend on it, refusing to render the 40-step path.")

    tiers = ["fast", "quality"] if args.tier == "both" else [args.tier]
    results = []
    for t in tiers:
        print(f"\n=== {t}: {TIERS[t][2]} ===", flush=True)
        results.append(render_tier(t, args, model_dir, lora))

    print("\n" + "=" * 68)
    for r in results:
        print(f"{r['tier']:<9}{r['steps']} steps  tiny_vae={str(r['tiny_vae']):<5} "
              f"{r['total_s']:>7.1f}s  {r['per_sub_s']}  -> {r['out']}")
    if len(results) == 2:
        f, q = results
        print(f"\nquality/fast = {q['total_s'] / f['total_s']:.2f}x   "
              f"(projection was 246/132 = 1.86x)")
    with open(os.path.join(args.outdir, "results.json"), "w") as fh:
        json.dump(results, fh, indent=2)


if __name__ == "__main__":
    main()
