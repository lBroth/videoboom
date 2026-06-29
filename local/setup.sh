#!/usr/bin/env bash
# One-time setup for Videoboom local models (Apple Silicon / MLX).
# Creates a venv, installs Blaizzy/mlx-video, downloads Wan2.2-I2V-A14B and converts
# it to a quantized MLX model. Run once:  bash local/setup.sh
#
# Disk: the PyTorch source checkpoint is ~67GB and the Q4 MLX output ~18GB. Keep both
# (re-converting at other bit-widths reuses the source). Point the models dir at an
# external SSD with VB_LOCAL_MODELS_DIR if internal disk is tight.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PY_BASE="${VB_LOCAL_PYTHON_BASE:-$(command -v python3.12 || command -v python3.11 || true)}"
VENV="$HERE/.venv"
MODELS_DIR="${VB_LOCAL_MODELS_DIR:-$HERE/models}"
SRC="$MODELS_DIR/Wan2.2-I2V-A14B"
BITS="${VB_LOCAL_BITS:-4}"
MLX="$MODELS_DIR/Wan2.2-I2V-A14B-MLX-Q${BITS}"

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

# A finished conversion has the T5 encoder + (quantized) transformers. We gate on t5_encoder.safetensors
# because the convert script writes T5 last — its presence means convert ran to completion (not a crash
# that left only bf16 transformers).
if [ -f "$MLX/t5_encoder.safetensors" ] && [ -f "$MLX/config.json" ]; then
  echo "==> MLX model already present: $MLX"
else
  if [ ! -d "$SRC" ] || [ ! -f "$SRC/config.json" ]; then
    echo "==> Downloading Wan-AI/Wan2.2-I2V-A14B (full fp32 checkpoint, ~120GB — this takes a while)"
    # huggingface_hub >=1.0 dropped `huggingface-cli`; the CLI is now `hf`.
    hf download Wan-AI/Wan2.2-I2V-A14B --local-dir "$SRC"
  fi
  echo "==> Converting -> MLX Q${BITS} (quantize runs after T5/VAE; needs torch + ~18GB free)"
  rm -rf "$MLX"   # never trust a partial conversion — redo cleanly
  python -m mlx_video.models.wan_2.convert \
    --checkpoint-dir "$SRC" \
    --output-dir "$MLX" \
    --quantize --bits "$BITS" --group-size 64
fi

# Wan2.2-Lightning 4-step distilled LoRA (I2V) — the "fast but keeps quality" path: 4 steps + CFG off
# instead of 40 steps. ~1.2GB per noise model. Skip with VB_LOCAL_NO_LIGHTNING=1.
LIGHT_DIR="$MODELS_DIR/Wan2.2-Lightning"
LIGHT_LORA="$LIGHT_DIR/Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1"
if [ "${VB_LOCAL_NO_LIGHTNING:-0}" != "1" ]; then
  if [ ! -f "$LIGHT_LORA/high_noise_model.safetensors" ]; then
    echo "==> Downloading Wan2.2-Lightning I2V 4-step LoRA (~2.5GB)"
    hf download lightx2v/Wan2.2-Lightning \
      --include "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/*" \
      --local-dir "$LIGHT_DIR"
  fi
  if [ -f "$LIGHT_LORA/high_noise_model.safetensors" ]; then
    echo "$LIGHT_LORA" > "$HERE/.lightning-dir"
    echo "==> Lightning LoRA: $LIGHT_LORA"
  fi
fi

echo "$MLX" > "$HERE/.model-path"
echo ""
echo "==> Done. MLX model: $MLX"
echo "    (recorded in local/.model-path — the app reads it automatically)"
echo ""
echo "Turn it on in the app: Settings -> Video backend -> Local (Wan 2.2 MLX)."
echo "Or via env:  VB_VIDEO_BACKEND=local  VB_LOCAL_WAN_DIR=$MLX"
echo ""
echo "Source checkpoint kept at $SRC (delete to reclaim ~67GB if you won't re-convert)."
