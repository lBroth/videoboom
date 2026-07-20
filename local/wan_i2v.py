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
    _keep_compiled(gen)
    try:
        from manager import register_unload_hook
        register_unload_hook(_free_resident_wan)
    except Exception:  # noqa: BLE001
        pass
    _PATCHED = True


def _keep_compiled(gen) -> None:
    """generate_video re-wraps each transformer with `m._compiled = mx.compile(m)` on EVERY call, throwing
    away the previous wrapper's traced graphs — so even with resident weights each clip re-traces the
    forward (the main reason resident mode measured net-negative). Patch the module's mx.compile so an
    object that already carries a `_compiled` wrapper keeps it; anything else compiles as usual."""
    mx_mod = gen.mx
    orig = mx_mod.compile
    if getattr(orig, "_vb_keep_compiled", False):
        return

    def compile_keep(fn, *args, **kwargs):
        existing = getattr(fn, "_compiled", None)
        if existing is not None:
            return existing
        return orig(fn, *args, **kwargs)

    compile_keep._vb_keep_compiled = True
    mx_mod.compile = compile_keep


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


def _model_config(model_dir: str) -> dict:
    import json
    try:
        with open(os.path.join(model_dir, "config.json")) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _wants_relay(model_dir: str) -> bool:
    """True for a DUAL model stored unquantized (bf16): both experts resident
    would be ~54GB, so it only fits 48GB via relay-shedding (one expert at a
    time, swapped at the timestep boundary). Quantized dirs (config carries a
    "quantization" key) keep the stock mlx-video path untouched."""
    c = _model_config(model_dir)
    return bool(c.get("dual_model")) and "quantization" not in c


def run_i2v(req: dict) -> dict:
    # Imported lazily so the server can answer /health before mlx-video is ready.
    use_relay = _wants_relay(req["model_dir"])
    # FastWan DMD distill (draft tier): exact trained step list + renoise
    # sampler, CFG off, euler. Marked by "fastwan_dmd" in the model config.
    fastwan_spec = _model_config(req["model_dir"]).get("fastwan_dmd")
    if fastwan_spec:
        import fastwan_dmd
        dmd_steps = fastwan_dmd.patch(fastwan_spec)
        req = dict(req, steps=dmd_steps, guide_scale="1", scheduler="euler")
        req.setdefault("tiling", "aggressive")
    # Route bf16 dual (relay) AND FastWan through the vendored fork
    # (local/relay_generate.py): bit-identical math, only expert residency
    # differs, and it carries the first+last morph (end_image) support that the
    # stock module lacks. FastWan (single model) runs it in parallel mode.
    via_relay = bool(use_relay or fastwan_spec)
    if via_relay:
        from relay_generate import generate_video
    else:
        from mlx_video.models.wan_2.generate import generate_video

    # Resident Wan weights across clips: OFF by default and UNUSABLE on 48GB — verified twice (2026-07-02,
    # even with compile-keep + tiny-VAE): clip 1 completes, then clip 2's 11GB bf16 T5 load on top of the
    # ~16GB resident transformers gets the process memory-killed by the kernel. Opt in
    # (VB_LOCAL_WAN_RESIDENT=1) only on 64/128GB Macs. On 48GB the reload savings come from the SMALL
    # components instead: tiny-VAE decode (done) + a resident int8 T5 (mlx-umt5, ~6.3GB — B3).
    if int(req.get("resident", os.environ.get("VB_LOCAL_WAN_RESIDENT", "0"))) and not use_relay:
        _ensure_resident()
    _set_wired_limit()

    # Tiny-VAE decode (TAEHV on torch-MPS): official decode -> seconds, near-official quality. Covers the
    # 16ch (14B/2.1) VAE via taew2_1 and the 48ch (5B/2.2) VAE via taew2_2 — see tiny_vae.py.
    if int(req.get("tiny_vae", os.environ.get("VB_LOCAL_TINY_VAE", "0"))):
        import tiny_vae
        tiny_vae.patch()
        if via_relay:
            # tiny_vae patches the STOCK module's loader; mirror it onto the relay fork so the shim
            # applies there too. This must follow `via_relay`, not `use_relay`: FastWan (5B) also runs
            # through the fork, and it is the path where the official decode actually dominates.
            import relay_generate
            from mlx_video.models.wan_2 import generate as _stock_gen
            relay_generate.load_vae_decoder = _stock_gen.load_vae_decoder

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
    # Motion is decided by the HIGH-noise expert and full-strength Lightning flattens it (the known
    # slow-motion complaint, HF lightx2v discussions #5/#20) — a reduced strength there restores motion
    # amplitude while the low-noise expert keeps full distillation for detail.
    strength = float(req.get("lora_strength", 1.0))
    s_high = float(req.get("lora_strength_high", strength))
    s_low = float(req.get("lora_strength_low", strength))
    loras_high = [(req["lora_high"], s_high)] if req.get("lora_high") else None
    loras_low = [(req["lora_low"], s_low)] if req.get("lora_low") else None
    if loras_high or loras_low:
        if steps is None:
            steps = 4
        if guide_scale is None:
            guide_scale = "1"   # CFG off (skips the uncond pass → 2x faster per step)

    # First+last morph: when the app supplies a target keyframe (the NEXT
    # scene's first frame), the clip interpolates image -> end_image. Only the
    # vendored relay fork handles it (dual channel-concat + 5B mask-blend); the
    # stock module ignores it, so end_image is honored only on relay/FastWan.
    end_image = req.get("end_image")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    _gen_kwargs = {}
    if end_image and (use_relay or fastwan_spec):
        _gen_kwargs["end_image"] = end_image

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
        # bf16-relay runs closer to the 48GB ceiling than Q4 — "aggressive"
        # VAE tiling is the measured-safe default there (81f probes at 36.8GB);
        # quantized paths keep the historical "auto".
        tiling=req.get("tiling", "aggressive" if use_relay else "auto"),
        # trim_first_frames is a T2V-only first-frame fix; it desyncs the I2V conditioning tensor (y is
        # built from num_frames, latents from num_frames+trim*4) → keep 0 for i2v. The first frame here is
        # the input image anyway.
        trim_first_frames=int(req.get("trim_first_frames", 0)),
        loras_high=loras_high,
        loras_low=loras_low,
        **_gen_kwargs,
    )
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    return {"ok": ok, "num_frames": num_frames, "width": width, "height": height, "fps": fps, "steps": steps, "lightning": bool(loras_high or loras_low), "morph": bool(_gen_kwargs.get("end_image"))}
