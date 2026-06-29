"""Download (and report progress for) the model(s) a local stage needs.

Used by the app's Settings "Download" button: `python download.py <STAGE>` snapshot-downloads the stage's
HF repo(s) into the shared HF cache and prints JSON progress lines the main process forwards to the UI:
  {"event":"progress","pct":42.0,"mb":8123}
  {"event":"done","pct":100}
  {"event":"error","error":"..."}
Video (Wan) is NOT here — it's the heavy download+convert handled by setup.sh.
"""
import json
import os
import sys
import threading
import time

# One source of truth for stage -> HF repos (mirrored read-only by src/main/localModels.ts for status).
STAGE_REPOS = {
    "STT": ["mlx-community/whisper-large-v3-turbo"],
    "LLM": ["lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit"],
    "VLM": ["mlx-community/gemma-3-12b-it-4bit"],
    "KEYFRAME": ["dhairyashil/FLUX.1-schnell-mflux-4bit", "akx/FLUX.1-Kontext-dev-mflux-4bit"],
}


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def main() -> None:
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")  # the Xet backend stalls large downloads
    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.constants import HF_HUB_CACHE

    stage = (sys.argv[1] if len(sys.argv) > 1 else "").upper()
    repos = STAGE_REPOS.get(stage)
    if not repos:
        emit({"event": "error", "error": f"unknown stage {stage}"})
        return

    api = HfApi()

    def total_size(repo: str) -> int:
        try:
            info = api.model_info(repo, files_metadata=True)
            return sum((s.size or 0) for s in (info.siblings or []))
        except Exception:  # noqa: BLE001
            return 0

    totals = {r: total_size(r) for r in repos}
    grand = sum(totals.values()) or 1

    def cache_dir(repo: str) -> str:
        return os.path.join(HF_HUB_CACHE, "models--" + repo.replace("/", "--"))

    stop = threading.Event()

    def poll() -> None:
        while not stop.is_set():
            got = sum(_dir_size(cache_dir(r)) for r in repos)
            emit({"event": "progress", "pct": round(min(99.0, 100 * got / grand), 1), "mb": round(got / 1e6)})
            stop.wait(2)

    th = threading.Thread(target=poll, daemon=True)
    th.start()
    try:
        for r in repos:
            emit({"event": "progress", "pct": round(min(99.0, 100 * sum(_dir_size(cache_dir(x)) for x in repos) / grand), 1), "repo": r})
            snapshot_download(r)
        stop.set()
        emit({"event": "done", "pct": 100})
    except Exception as e:  # noqa: BLE001
        stop.set()
        emit({"event": "error", "error": str(e)[:300]})
        sys.exit(1)


if __name__ == "__main__":
    main()
