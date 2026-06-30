"""LTX-2.3 image-to-video (distilled two-stage), MLX-native. Supports first-frame (--image) AND last-frame
(--end-image) conditioning, so a clip flows smoothly between two consistent keyframes (the fix for the 5B's
identity drift). Text encoder = gemma-3-12b-it-4bit (avoids the LTX repo's 60GB encoder). Higher res + faster
than the Wan paths (two-stage distilled: low-res many-step + hi-res few-step refine).
"""
import os


def _snap_8n1(n: int) -> int:
    """LTX frame count works best as 8n+1 (25, 33, 49, ...). Round UP so the clip is >= the requested
    duration and the engine can TRIM it to the exact scene window (never time-stretch)."""
    n = max(9, int(n))
    r = (n - 1) % 8
    return n if r == 0 else n + (8 - r)


def run_ltx_i2v(req: dict) -> dict:
    from mlx_video.models.ltx_2.generate import generate_video

    out = req["out"]
    fps = int(req.get("fps", 24))
    seconds = float(req.get("seconds", 2.0))
    min_f = _snap_8n1(int(req.get("min_frames", 25)))
    max_f = _snap_8n1(int(req.get("max_frames", 97)))
    num_frames = req.get("num_frames") or round(seconds * fps)
    num_frames = max(min_f, min(max_f, _snap_8n1(num_frames)))

    width = int(req.get("width", 896))   # /64
    height = int(req.get("height", 512))  # /64
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    generate_video(
        model_repo=req["model_dir"],
        text_encoder_repo=req.get("text_encoder", "mlx-community/gemma-3-12b-it-4bit"),
        prompt=req["prompt"],
        height=height,
        width=width,
        num_frames=num_frames,
        seed=int(req.get("seed", 42)),
        fps=fps,
        output_path=out,
        image=req["image"],                         # first frame
        end_image=req.get("end_image") or None,     # optional last frame → smooth morph between keyframes
        verbose=False,
    )
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    return {"ok": ok, "num_frames": num_frames, "width": width, "height": height, "fps": fps,
            "engine": "ltx", "end_image": bool(req.get("end_image"))}
