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
# KEYFRAME is FLUX-schnell only (the render prerequisite); FLUX-Kontext is optional (portrait/reference).
# VIDEO is NOT a plain repo list — it's a PRE-CONVERTED MLX repo picked per engine (see VIDEO_ENGINES /
# download_video); readiness is the per-engine marker, not a raw cache check.
STAGE_REPOS = {
    "STT": ["mlx-community/whisper-large-v3-turbo"],
    "LLM": ["lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit"],
    "VLM": ["mlx-community/gemma-3-12b-it-4bit"],
    "KEYFRAME": ["dhairyashil/FLUX.1-schnell-mflux-4bit"],
}
# Optional, on-demand (not a render prerequisite): FLUX-Kontext for cast/reference-driven keyframes.
OPTIONAL_REPOS = {
    "KEYFRAME_KONTEXT": ["akx/FLUX.1-Kontext-dev-mflux-4bit"],
}
# Pre-converted MLX video engines, picked by settings.localVideoModel. No source download, no on-device
# convert — a plain snapshot of a ready-to-run MLX repo + a per-engine marker.
VIDEO_ENGINES = {
    # Fast: FastWan-5B DMD 3-step (published self-contained, ~24GB, fits 32GB unified).
    "5b": {"repo": "lBroth/FastWan2.2-TI2V-5B-MLX", "name": "FastWan2.2-TI2V-5B-MLX", "marker": ".model-path-5b", "lightning": False,
           "required": ["config.json", "t5_encoder.safetensors", "vae.safetensors", "model.safetensors"]},
    # Quality: our own Wan-14B MLX bf16 (~64GB) — relay-shedding loads ONE expert at a time (peak ~32.6GB,
    # fits 48GB), which quantized repos that keep both experts resident (Q4 peaked 67.7GB) do not.
    "14b": {"repo": "lBroth/Wan2.2-I2V-A14B-MLX-bf16", "name": "Wan2.2-I2V-A14B-MLX-bf16", "marker": ".model-path", "lightning": True,
            "required": ["config.json", "t5_encoder.safetensors", "vae.safetensors",
                         "high_noise_model.safetensors", "low_noise_model.safetensors"]},
}


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def download_video() -> None:
    """Provision the video stage by snapshotting a PRE-CONVERTED MLX repo (no 120GB fp32 source, no on-device
    convert, no torch) picked by settings.localVideoModel — '5b' Fast (FastWan) / '14b' Quality (Wan Q8) — and
    writing the per-engine marker the app reads. 14b also fetches the Lightning 4-step LoRA (else it falls back
    to the ~38 min/clip 40-step path)."""
    from huggingface_hub import snapshot_download

    here = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.environ.get("VB_LOCAL_MODELS_DIR", os.path.join(here, "models"))
    # Markers go in the WRITABLE marker dir (userData when packaged; the code dir is read-only there).
    marker_dir = os.environ.get("VB_LOCAL_MARKER_DIR", here)
    os.makedirs(models_dir, exist_ok=True)
    os.makedirs(marker_dir, exist_ok=True)

    engine = os.environ.get("VB_LOCAL_VIDEO_MODEL", "5b")
    spec = VIDEO_ENGINES.get(engine, VIDEO_ENGINES["5b"])
    dest = os.path.join(models_dir, spec["name"])
    marker = os.path.join(marker_dir, spec["marker"])
    # Every weight the engine opens, not a sentinel pair. A sentinel made an interrupted fetch
    # UNRECOVERABLE: a DNS drop mid-snapshot (observed 2026-08-03) left the small files — config.json and
    # t5_encoder — and neither 28.6GB expert, and because those two exist the next Download click skipped
    # the snapshot, rewrote the marker and reported success in under a second. The 57GB that were actually
    # missing could never be fetched from the UI again. snapshot_download resumes and is a cheap etag
    # check when everything is present, so re-running it on an incomplete dir is the correct behavior.
    required = [os.path.join(dest, f) for f in spec["required"]]

    if not all(os.path.exists(f) for f in required):
        emit({"event": "progress", "pct": 1, "repo": spec["repo"]})
        snapshot_download(spec["repo"], local_dir=dest)
    # The marker is what readiness resolves, so it must never point at a partial dir.
    missing = [os.path.basename(f) for f in required if not os.path.exists(f)]
    if missing:
        emit({"event": "error", "error": f"{spec['repo']}: incomplete download, missing {', '.join(missing)}"})
        raise SystemExit(1)
    with open(marker, "w") as fh:
        fh.write(dest)

    # Wan2.2-Lightning 4-step I2V LoRA — 14B only (the fast path: 4 steps + CFG off instead of 40 steps).
    if spec["lightning"]:
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
            with open(os.path.join(marker_dir, ".lightning-dir"), "w") as fh:
                fh.write(light_lora)

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

    # VIDEO isn't a plain snapshot — it's a per-engine MLX repo, so it has no STAGE_REPOS entry and must be
    # dispatched BEFORE the repo lookup (which would otherwise reject it as an unknown stage).
    if stage == "VIDEO":
        download_video()
        return

    # Optional stages (KEYFRAME_KONTEXT) are downloaded on demand, not as a render prerequisite — they
    # are still plain snapshots, so they share this path.
    repos = STAGE_REPOS.get(stage) or OPTIONAL_REPOS.get(stage)
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
