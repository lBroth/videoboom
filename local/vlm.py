"""Local VLM stage (portrait captioning), MLX-native via mlx-vlm.

Same job as the cloud VLM: one concise description of a person for consistent re-generation. gemma-3-12b
can be literally the same model as the cloud default. Single-resident via the ModelManager.
"""
from manager import get


def _load(repo: str):
    import mlx_vlm
    from mlx_vlm.utils import load_config
    model, processor = mlx_vlm.load(repo)
    config = load_config(repo)
    return (model, processor, config)


def run_vlm(req: dict) -> dict:
    import mlx_vlm
    from mlx_vlm.prompt_utils import apply_chat_template

    repo = req.get("model", "mlx-community/gemma-3-12b-it-4bit")
    image = req["image"]
    prompt = req.get("prompt", "Describe this image.")
    max_tokens = int(req.get("max_tokens", 200))

    model, processor, config = get("vlm:" + repo, lambda: _load(repo))
    formatted = apply_chat_template(processor, config, prompt, num_images=1)
    out = mlx_vlm.generate(model, processor, formatted, image=image, max_tokens=max_tokens, verbose=False)
    text = getattr(out, "text", None) or str(out)
    return {"ok": True, "text": text.strip()}
