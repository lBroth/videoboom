"""Local keyframe stage (scene images), MLX-native via mflux.

Text->image with FLUX schnell (4-step, fast); when an identity reference is given, FLUX Kontext places that
exact subject into the scene (the local answer to the cloud "put these people in the shot"). Single-resident
via the ModelManager. Kontext takes ONE reference image, so a multi-cast shot uses the lead's reference.
"""
import os

from manager import get


def _model_config(name: str, base_model: str = "schnell"):
    # A HF repo ("owner/name", e.g. an ungated pre-quantized mirror) loads via from_name + base_model arch;
    # presets (flux2_klein_4b, …) are ModelConfig classmethods; plain names (schnell, dev) via from_name.
    from mflux.models.common.config.model_config import ModelConfig
    if "/" in name:
        return ModelConfig.from_name(name, base_model=base_model)
    preset = getattr(ModelConfig, name, None)
    return preset() if callable(preset) else ModelConfig.from_name(name)


def _txt2img(quantize: int, name: str, base_model: str):
    from mflux.models.flux.variants.txt2img.flux import Flux1
    return Flux1(quantize=quantize, model_config=_model_config(name, base_model))


def _kontext(quantize: int, name: str, base_model: str):
    from mflux.models.flux.variants.kontext.flux_kontext import Flux1Kontext
    return Flux1Kontext(quantize=quantize, model_config=_model_config(name, base_model))


def _txt2img_image(req, quant, w, h, seed):
    # ungated pre-quantized mflux mirror of FLUX.1-schnell (BFL's own schnell repo is HF-gated)
    name = req.get("model", "dhairyashil/FLUX.1-schnell-mflux-4bit")
    base = req.get("base_model", "schnell")
    flux = get("kf:txt2img:" + name, lambda: _txt2img(quant, name, base))
    return flux.generate_image(
        seed, req["prompt"], num_inference_steps=int(req.get("steps", 4)),
        height=h, width=w, guidance=float(req.get("guidance", 3.5)),
    )


def run_keyframe(req: dict) -> dict:
    out = req["out"]
    seed = int(req.get("seed", 42))
    quant = int(req.get("quantize", 4))
    w = int(req.get("width", 1024))
    h = int(req.get("height", 576))
    ref = req.get("ref")  # optional single identity reference image (cast lead)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    img = None
    mode = "txt2img"
    if ref:
        # Identity injection via FLUX Kontext, ungated mflux mirror (BFL FLUX.1-Kontext-dev is HF-gated).
        # If it can't load (gating/format), don't fail the scene — fall back to a plain txt2img keyframe.
        try:
            name = req.get("kontext_model", "akx/FLUX.1-Kontext-dev-mflux-4bit")
            base = req.get("kontext_base", "dev")
            flux = get("kf:kontext:" + name, lambda: _kontext(quant, name, base))
            img = flux.generate_image(
                seed, req["prompt"], num_inference_steps=int(req.get("kontext_steps", 20)),
                height=h, width=w, guidance=float(req.get("kontext_guidance", 2.5)), image_path=ref,
            )
            mode = "kontext"
        except Exception as e:  # noqa: BLE001
            print(f"[vb-local] kontext unavailable ({str(e)[:120]}); falling back to txt2img", flush=True)
            img = None
    if img is None:
        img = _txt2img_image(req, quant, w, h, seed)

    img.save(path=out, overwrite=True)
    return {"ok": os.path.exists(out) and os.path.getsize(out) > 0, "width": w, "height": h, "mode": mode}
