"""Local LLM stage (story bible + shot list), MLX-native via mlx-lm.

Returns plain text; the engine's llmJson reuses its existing tolerant JSON extraction, so the structured
storyboard works the same as the cloud path. Qwen3 thinking is disabled (/no_think + <think> strip) so the
token budget goes to the answer, not the scratchpad. Single-resident via the ModelManager — loading the LLM
evicts other heavy models (e.g. a previously-resident keyframe model).
"""
import re

from manager import get

_THINK = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def _load(repo: str):
    import mlx_lm
    return mlx_lm.load(repo)


def run_llm(req: dict) -> dict:
    import mlx_lm
    from mlx_lm.sample_utils import make_sampler

    repo = req.get("model", "lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit")
    model, tok = get("llm:" + repo, lambda: _load(repo))

    system = (req.get("system") or "").strip()
    user = req.get("prompt") or ""
    max_tokens = int(req.get("max_tokens", 2000))
    temp = float(req.get("temperature", 0.7))

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    # Qwen3 is a reasoning model — enable_thinking=False is the hard switch that skips the <think> block so
    # the whole budget goes to the answer (the soft "/no_think" tag is ignored by Qwen3.6). Fall back if the
    # tokenizer's template doesn't accept the kwarg.
    try:
        prompt = tok.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=False)
    except TypeError:
        prompt = tok.apply_chat_template(messages, add_generation_prompt=True)

    sampler = make_sampler(temp=temp, top_p=float(req.get("top_p", 0.95)))
    text = mlx_lm.generate(model, tok, prompt=prompt, max_tokens=max_tokens, sampler=sampler, verbose=False)
    text = _THINK.sub("", text or "").strip()
    return {"ok": True, "text": text}
