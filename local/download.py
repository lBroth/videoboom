"""Download (and report progress for) the model(s) a local stage needs.

Used by the app's Settings "Download" button: `python download.py <STAGE>` snapshot-downloads the stage's
HF repo(s) into the shared HF cache and prints JSON progress lines the main process forwards to the UI:
  {"event":"progress","pct":42.0,"mb":8123}
  {"event":"done","pct":100}
  {"event":"error","error":"..."}
VIDEO (Wan 2.2) is the heavy download+convert; it has its own path here (mirrors local/setup.sh) so the
in-app "all required stages present" render gate is satisfiable from the Download button, not just setup.sh.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time

# One source of truth for stage -> HF repos (mirrored read-only by src/main/localModels.ts for status).
# VIDEO lists the Wan-AI source checkpoint; it is snapshot-downloaded AND converted (see download_video).
STAGE_REPOS = {
    "STT": ["mlx-community/whisper-large-v3-turbo"],
    "LLM": ["lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit"],
    "VLM": ["mlx-community/gemma-3-12b-it-4bit"],
    "KEYFRAME": ["dhairyashil/FLUX.1-schnell-mflux-4bit", "akx/FLUX.1-Kontext-dev-mflux-4bit"],
    "VIDEO": ["Wan-AI/Wan2.2-I2V-A14B"],
}


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def download_video() -> None:
    """Wan 2.2 I2V-A14B: snapshot the fp32 checkpoint, convert to a quantized MLX model, fetch the Lightning
    4-step LoRA, and record the marker the app reads (local/.model-path). Mirrors local/setup.sh in Python so
    the in-app Download button provisions the video stage. Heavy: ~120GB source, ~18GB MLX output."""
    from huggingface_hub import snapshot_download

    here = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.environ.get("VB_LOCAL_MODELS_DIR", os.path.join(here, "models"))
    bits = os.environ.get("VB_LOCAL_BITS", "4")
    os.makedirs(models_dir, exist_ok=True)
    src = os.path.join(models_dir, "Wan2.2-I2V-A14B")
    mlx = os.path.join(models_dir, f"Wan2.2-I2V-A14B-MLX-Q{bits}")
    marker = os.path.join(here, ".model-path")

    def record(path: str) -> None:
        with open(marker, "w") as fh:
            fh.write(path)

    # A finished conversion has the T5 encoder (written last) + config — gate on it so a crashed partial
    # convert re-runs instead of being trusted.
    if os.path.exists(os.path.join(mlx, "t5_encoder.safetensors")) and os.path.exists(os.path.join(mlx, "config.json")):
        record(mlx)
        emit({"event": "done", "pct": 100})
        return

    if not (os.path.isdir(src) and os.path.exists(os.path.join(src, "config.json"))):
        emit({"event": "progress", "pct": 1, "repo": "Wan-AI/Wan2.2-I2V-A14B"})
        snapshot_download("Wan-AI/Wan2.2-I2V-A14B", local_dir=src)

    emit({"event": "progress", "pct": 60, "repo": "converting -> MLX Q%s" % bits})
    shutil.rmtree(mlx, ignore_errors=True)  # never trust a partial conversion — redo cleanly
    subprocess.run(
        [sys.executable, "-m", "mlx_video.models.wan_2.convert",
         "--checkpoint-dir", src, "--output-dir", mlx,
         "--quantize", "--bits", str(bits), "--group-size", "64"],
        check=True,
    )

    # Wan2.2-Lightning 4-step I2V LoRA (the fast path: 4 steps + CFG off instead of 40 steps).
    light_dir = os.path.join(models_dir, "Wan2.2-Lightning")
    light_lora = os.path.join(light_dir, "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1")
    if not os.path.exists(os.path.join(light_lora, "high_noise_model.safetensors")):
        emit({"event": "progress", "pct": 92, "repo": "lightx2v/Wan2.2-Lightning"})
        snapshot_download(
            "lightx2v/Wan2.2-Lightning",
            allow_patterns=["Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/*"],
            local_dir=light_dir,
        )
    if os.path.exists(os.path.join(light_lora, "high_noise_model.safetensors")):
        with open(os.path.join(here, ".lightning-dir"), "w") as fh:
            fh.write(light_lora)

    record(mlx)
    emit({"event": "done", "pct": 100})


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

    # VIDEO isn't a plain snapshot — it downloads + converts (mirrors setup.sh).
    if stage == "VIDEO":
        download_video()
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
