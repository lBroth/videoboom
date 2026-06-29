# Videoboom — local models (Apple Silicon / MLX)

Opt-in, on-device generation. The first model wired up is **Wan 2.2 I2V-A14B**
(image-to-video) running MLX-native via [Blaizzy/mlx-video](https://github.com/Blaizzy/mlx-video).
No keys, no cloud, no per-second cost — but it is **slow** (a 14B diffusion model
on a Mac: minutes per clip) and **heavy** (large download + lots of unified memory).

This directory is a small Python sidecar the Electron app talks to over
`http://127.0.0.1:8765`. The app spawns it on demand and keeps it warm.

## Requirements

- Apple Silicon Mac (M-series), macOS 14+
- Python ≥ 3.11 — `brew install python@3.12`
- ~85GB free disk for setup (67GB source checkpoint + 18GB MLX Q4). Use an
  external SSD via `VB_LOCAL_MODELS_DIR=/Volumes/SSD/vb-models` if needed.
- 48GB+ unified memory recommended for 720p.

## Setup (once)

```bash
bash local/setup.sh
```

This creates `local/.venv`, installs `mlx-video`, downloads
`Wan-AI/Wan2.2-I2V-A14B`, converts it to a 4-bit MLX model under `local/models/`,
and records the path in `local/.model-path` (read automatically by the app).

8-bit instead of 4-bit (bigger, slightly better): `VB_LOCAL_BITS=8 bash local/setup.sh`.

## Turn it on

In the app: **Settings → Video backend → Local (Wan 2.2 MLX)**. New renders use
local i2v; everything else (storyboard LLM, keyframes, lyric timing) stays cloud
until those stages get local backends too.

Equivalent env (for `npm run dev`):

```
VB_VIDEO_BACKEND=local
VB_LOCAL_WAN_DIR=/abs/path/to/Wan2.2-I2V-A14B-MLX-Q4   # optional; else .model-path
```

## Tunables (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `VB_LOCAL_PORT` | `8765` | sidecar port |
| `VB_LOCAL_DIR` | `<repo>/local` | sidecar dir (server.py, .venv, .model-path) |
| `VB_LOCAL_PYTHON` | `local/.venv/bin/python` | interpreter that runs the server |
| `VB_LOCAL_WAN_DIR` | `local/.model-path` | converted MLX model dir |
| `VB_LOCAL_WAN_FPS` | `16` | native fps used for frame budgeting |
| `VB_LOCAL_WAN_STEPS` | config (40) | diffusion steps — `10` for fast previews |
| `VB_LOCAL_MAX_FRAMES` | `81` | per-clip frame cap (81 ≈ 5s native @16fps) |
| `VB_LOCAL_DEADLINE_SEC` | `1800` | per-clip timeout |
| `VB_W` / `VB_H` | `1280` / `704` (local) | render resolution (720p) |

## Manual smoke test

```bash
source local/.venv/bin/activate
python -m mlx_video.models.wan_2.generate \
  --model-dir "$(cat local/.model-path)" \
  --image some.png --prompt "the person slowly turns and smiles, cinematic" \
  --width 1280 --height 704 --num-frames 81 --steps 10 \
  --output-path /tmp/wan_test.mp4
```

## Notes / roadmap

- **Resident weights (Phase 2):** upstream `generate_video` reloads T5 + both
  transformers + VAE every call. The warm process + OS page cache soften this, but
  a true weight-resident denoise loop is a follow-up.
- Next local backends to add behind the same sidecar: storyboard LLM (mlx-lm),
  keyframes (mflux / Qwen-Image), WhisperX → whisper.cpp / mlx-whisper.
