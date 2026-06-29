"""Wan 2.2 I2V-A14B image-to-video, MLX-native (Apple Silicon).

Thin wrapper over Blaizzy/mlx-video's `generate_video` (the dual-model Wan2.2
pipeline). One job at a time — the server serialises calls so only one diffusion
run touches the GPU/unified-memory at once.

NOTE (Phase 2): upstream `generate_video` loads T5 + both transformers + VAE on
every call and frees them at the end, so weights are NOT cached across requests.
The server process staying warm + the OS page cache keep the model files hot, but
a true weight-resident loop would mean vendoring the denoise loop. Left as a
follow-up — correctness first.
"""
import functools
import os

# Resident Wan weights: mlx-video's generate_video reloads T5 + both 14B transformers + VAE from disk on
# every call. We memoize the heavy loaders (the transformers + VAE — NOT T5, which generate_video frees
# before denoise to save memory) so clips 2..N reuse the in-memory weights instead of re-reading ~16GB.
# The cache lives outside the ModelManager; a manager unload-hook drops it when a keyframe/LLM model loads.
_RESIDENT_WAN: dict = {}
_PATCHED = False
_WIRED_SET = False


def _free_resident_wan() -> None:
    if not _RESIDENT_WAN:
        return
    _RESIDENT_WAN.clear()
    import gc
    import mlx.core as mx
    gc.collect()
    try:
        mx.clear_cache()
    except Exception:  # noqa: BLE001
        pass


def _memoize(mod, name: str) -> None:
    orig = getattr(mod, name)
    if getattr(orig, "_vb_memoized", False):
        return

    @functools.wraps(orig)
    def wrapper(*args, **kwargs):
        path = str(args[0]) if args else ""
        key = (name, path, repr(kwargs.get("loras")))
        if key not in _RESIDENT_WAN:
            _RESIDENT_WAN[key] = orig(*args, **kwargs)
        return _RESIDENT_WAN[key]

    wrapper._vb_memoized = True
    setattr(mod, name, wrapper)


def _ensure_resident() -> None:
    """Patch generate_video's heavy loaders to memoize by path (+ loras), and register a hook so the cache
    is freed when another heavy model (keyframe/LLM) loads via the ModelManager."""
    global _PATCHED
    if _PATCHED:
        return
    from mlx_video.models.wan_2 import generate as gen
    for name in ("load_wan_model", "load_vae_decoder", "load_vae_encoder"):
        _memoize(gen, name)
    try:
        from manager import register_unload_hook
        register_unload_hook(_free_resident_wan)
    except Exception:  # noqa: BLE001
        pass
    _PATCHED = True


def _set_wired_limit() -> None:
    # Opt-in (VB_LOCAL_WIRED_GB): pin weights as wired so macOS doesn't compress/page the resident model.
    global _WIRED_SET
    if _WIRED_SET:
        return
    _WIRED_SET = True
    gb = os.environ.get("VB_LOCAL_WIRED_GB", "")
    if not gb:
        return
    try:
        import mlx.core as mx
        mx.set_wired_limit(int(float(gb) * 1024 ** 3))
    except Exception:  # noqa: BLE001
        pass


def _snap_4n1(n: int) -> int:
    """Wan requires num_frames = 4n+1 (5, 9, 13, ... 81)."""
    n = max(5, int(n))
    return n - ((n - 1) % 4)


def run_i2v(req: dict) -> dict:
    # Imported lazily so the server can answer /health before mlx-video is ready.
    from mlx_video.models.wan_2.generate import generate_video

    # Resident Wan weights across clips: OFF by default. Measured net-NEGATIVE on a 48GB Mac — keeping the
    # ~16GB transformers resident saves the ~15s reload but starves the denoise (memory pressure + per-call
    # re-compile), making each clip slower overall. Opt in (VB_LOCAL_WAN_RESIDENT=1) only on a higher-memory
    # Mac (64/128GB) where the headroom exists. The real speed levers are TI2V-5B / fewer-frames+RIFE.
    if int(req.get("resident", os.environ.get("VB_LOCAL_WAN_RESIDENT", "0"))):
        _ensure_resident()
    _set_wired_limit()

    model_dir = req["model_dir"]
    image = req["image"]
    prompt = req["prompt"]
    out = req["out"]

    fps = int(req.get("fps", 16))                 # Wan2.2 native ~16fps (frame budgeting only)
    seconds = float(req.get("seconds", 5))
    min_frames = _snap_4n1(int(req.get("min_frames", 21)))
    max_frames = _snap_4n1(int(req.get("max_frames", 81)))
    num_frames = req.get("num_frames") or round(seconds * fps)
    num_frames = max(min_frames, min(max_frames, _snap_4n1(num_frames)))

    width = int(req.get("width", 1280))
    height = int(req.get("height", 704))
    seed = int(req.get("seed", -1))

    # None -> use the model config defaults (I2V: 40 steps, guide 3.5/3.5, shift 5.0,
    # official Chinese negative prompt). Pass-throughs let the app override for speed.
    steps = req.get("steps")
    guide_scale = req.get("guide_scale")          # e.g. "3.5,3.5"
    shift = req.get("shift")
    negative_prompt = req.get("negative_prompt")  # None = config default

    # Wan2.2-Lightning 4-step distilled LoRA (high/low noise). When present this is the "fast but keeps
    # quality" path: 4 steps + CFG off (guide=1) ≈ 20x fewer 14B transformer passes than 40-step CFG.
    strength = float(req.get("lora_strength", 1.0))
    loras_high = [(req["lora_high"], strength)] if req.get("lora_high") else None
    loras_low = [(req["lora_low"], strength)] if req.get("lora_low") else None
    if loras_high or loras_low:
        if steps is None:
            steps = 4
        if guide_scale is None:
            guide_scale = "1"   # CFG off (skips the uncond pass → 2x faster per step)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    generate_video(
        model_dir=model_dir,
        prompt=prompt,
        image=image,
        width=width,
        height=height,
        num_frames=num_frames,
        steps=(int(steps) if steps else None),
        guide_scale=guide_scale,
        shift=(float(shift) if shift else None),
        seed=seed,
        output_path=out,
        negative_prompt=negative_prompt,
        scheduler=req.get("scheduler", "unipc"),
        tiling=req.get("tiling", "auto"),
        # trim_first_frames is a T2V-only first-frame fix; it desyncs the I2V conditioning tensor (y is
        # built from num_frames, latents from num_frames+trim*4) → keep 0 for i2v. The first frame here is
        # the input image anyway.
        trim_first_frames=int(req.get("trim_first_frames", 0)),
        loras_high=loras_high,
        loras_low=loras_low,
    )
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    return {"ok": ok, "num_frames": num_frames, "width": width, "height": height, "fps": fps, "steps": steps, "lightning": bool(loras_high or loras_low)}
