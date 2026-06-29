"""Single-resident model manager for the sidecar.

48GB unified memory can't hold Wan (~20GB) + an LLM (~19GB) + FLUX (~10GB) at once, so we keep at most ONE
*heavy* model resident. Loading a new heavy model first evicts the previous one (drop the ref, gc, free the
MLX buffer cache). Within a stage (many calls, same key) the model is reused — fast; switching stage swaps
it. Light models (e.g. whisper ~1.6GB) can be marked heavy=False to coexist.

Wan i2v is NOT managed here — upstream generate_video loads + frees its own weights per call.
"""
import gc

import mlx.core as mx

_RESIDENT: dict = {}      # key -> loaded object
_HEAVY: set = set()       # keys that count against the single-resident budget
_UNLOAD_HOOKS: list = []   # called when a heavy model loads — frees OTHER heavy state (e.g. resident Wan)


def register_unload_hook(fn) -> None:
    """Register a callback run right before a heavy model loads, so external heavy caches (the resident Wan
    weights, which live outside this manager) get freed to make room. Not called by unload_all()."""
    _UNLOAD_HOOKS.append(fn)


def _free() -> None:
    gc.collect()
    try:
        mx.clear_cache()
    except Exception:  # noqa: BLE001
        pass


def get(key: str, loader, heavy: bool = True):
    """Return the model for `key`, loading via `loader()` if absent. Loading a heavy model evicts every
    other heavy model first — and fires the unload hooks (e.g. drops resident Wan) — to free unified memory."""
    if key in _RESIDENT:
        return _RESIDENT[key]
    if heavy:
        for k in [k for k in _RESIDENT if k in _HEAVY]:
            del _RESIDENT[k]
            _HEAVY.discard(k)
        for hook in _UNLOAD_HOOKS:
            try:
                hook()
            except Exception:  # noqa: BLE001
                pass
        _free()
    obj = loader()
    _RESIDENT[key] = obj
    if heavy:
        _HEAVY.add(key)
    return obj


def unload_all() -> None:
    _RESIDENT.clear()
    _HEAVY.clear()
    _free()
