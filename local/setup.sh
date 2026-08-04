#!/usr/bin/env bash
# One-time setup for Videoboom local models (Apple Silicon / MLX).
# Creates the venv, installs Blaizzy/mlx-video, then hands the video engine to download.py.
# Run once:  bash local/setup.sh
#
# Disk: ~69GB for the pre-converted Wan-14B bf16 repo plus ~2.5GB for the Lightning LoRA. The other
# stages (STT / LLM / VLM / keyframes) install from Settings -> On-device and add roughly another
# 28GB. Point the models dir at an
# external SSD with VB_LOCAL_MODELS_DIR if internal disk is tight.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PY_BASE="${VB_LOCAL_PYTHON_BASE:-$(command -v python3.12 || command -v python3.11 || true)}"
VENV="$HERE/.venv"
MODELS_DIR="${VB_LOCAL_MODELS_DIR:-$HERE/models}"
ENGINE="${VB_LOCAL_VIDEO_MODEL:-14b}"

if [ -z "$PY_BASE" ]; then
  echo "ERROR: need Python >= 3.11. Install with:  brew install python@3.12" >&2
  exit 1
fi
echo "==> Python base: $PY_BASE"
"$PY_BASE" --version

echo "==> Creating venv at $VENV"
"$PY_BASE" -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -U pip wheel
echo "==> Installing mlx-video + huggingface_hub"
python -m pip install -r "$HERE/requirements.txt"

mkdir -p "$MODELS_DIR"
export HF_HUB_DISABLE_XET=1   # the Xet backend stalls large downloads

# The video engine comes from download.py, the same provisioner the app's Download button uses: a plain
# snapshot of a PRE-CONVERTED MLX repo, plus the Lightning LoRA and the per-engine marker.
#
# This used to download Wan-AI/Wan2.2-I2V-A14B (the ~120GB fp32 checkpoint), spend hours converting it to
# Q4, and write THAT into .model-path. Two things were wrong with it. Q4 does not fit: its config carries a
# `quantization` key, so wan_i2v.py's relay never engages and both experts stay resident — measured at
# 67.7GB peak against the app's own 48GB floor, where the pre-converted bf16 relay peaks at 32.6GB and is
# also faster (27.5 vs 47.6 s/step). And .model-path is exactly what videoReady() and modelDir() resolve,
# so the unusable model was the one the app picked up, reporting Ready.
#
# One provisioner, one marker. VB_LOCAL_VIDEO_MODEL selects the engine (14b default, 5b retired).
echo "==> Provisioning the video engine ($ENGINE) via download.py"
VB_LOCAL_VIDEO_MODEL="$ENGINE" VB_LOCAL_MODELS_DIR="$MODELS_DIR" VB_LOCAL_MARKER_DIR="$HERE" \
  python "$HERE/download.py" VIDEO

echo ""
echo "==> Done. download.py wrote the model dir and its marker under $HERE."
echo "    The app reads the marker automatically; nothing to configure."
echo ""
echo "The remaining stage models (STT / LLM / VLM / keyframes) install from"
echo "Settings -> On-device -> Download."
echo ""
