# Local models (on-device, Apple Silicon)

Status: **Wan 2.2 I2V-A14B (image-to-video) is wired.** Other stages (storyboard
LLM, keyframes, lyric timing) are still cloud. This is the first step of moving the
whole pipeline on-device.

User-facing setup + tunables live in [`local/README.md`](../local/README.md). This
page is the architecture for contributors.

## Shape

```
Electron main (in-process TS engine)
        │  VB_VIDEO_BACKEND=local
        ▼
src/engine/localVideo.ts  ──HTTP /i2v──▶  local/server.py  ──▶  mlx-video (Wan 2.2)
   spawn + warm + POST                     resident process       generate_video()
        ▲                                   one job at a time
        └── writes mp4 to the same tmp path the cloud path uses ─┘
```

- **Why a separate process, not in-process:** MLX/Wan is Python. The app's engine
  is TypeScript and stays that way. The sidecar is opt-in and never bundled into the
  installer — users run `local/setup.sh` themselves (v2 "bring models on-device" path).
- **Why resident:** loading a 14B model is expensive; the process stays warm for the
  app's lifetime so import + (Phase 2) weights are paid once, not per scene.
- **Lifecycle:** `localVideo.ts` lazily spawns `server.py` on the first local clip,
  polls `/health`, then POSTs one `/i2v` per scene. The sidecar writes the mp4 to the
  scene's tmp path (same machine, same FS — no bytes over the socket). A global lock in
  the server serialises diffusion runs; the engine also forces `VB_WORKERS=1` for local.

## Where it plugs in

- `src/engine/pipeline.ts` → `renderClip()` branches on `VB_VIDEO_BACKEND`: `local`
  calls `genVideoLocal()`, else the cloud `providers.genVideo()`. Keyframe, segment,
  fit-to-window and assemble are unchanged — the local clip flows through the same
  `fitToWindow` retime + concat as a cloud clip.
- Wan i2v is conditioned on a **single** start frame, so the cloud path's last-frame
  morph (`kfLast`) is ignored locally.
- `src/engine/ffmpeg.ts` → `vW()`/`vH()` are now live env reads (not load-time consts)
  so the local 720p resolution (`VB_W=1280`/`VB_H=704`, injected by settings) reaches
  both Wan generation and the failed-scene fill — every clip shares one size for concat.
- `src/main/settings.ts` → `videoBackend` + `localWanDir`; `settingsEnv()` maps local
  to `VB_VIDEO_BACKEND=local`, 720p, single worker.

## Known limits

- **Weights reload per call.** Upstream `generate_video` loads + frees T5 + both
  transformers + VAE each request. Warm process + OS page cache help; a true
  weight-resident denoise loop is folded into the Model Manager (TODO below).
- **48GB memory ceiling.** Attention is O(seq_len²), so frames×resolution is hard-capped.
  480p / 37 frames is the stable point; 49f or 720p hit Metal "Insufficient Memory".
- **Slow & heavy.** ~5.5 min/clip at 480p/37f Lightning 4-step; a full song is long.
- **Slow-mo fixed** by cutting local scenes to ~native clip length (`VB_LOCAL_MAX_FRAMES /
  VB_LOCAL_WAN_FPS`, ~2.3s) so clips render at real speed instead of being time-stretched.

---

## TODO — Full local mode (all stages on-device)

Goal: one switch that runs the **whole** pipeline offline (no OpenRouter/Replicate),
behind the same sidecar. Designed, not yet built.

### Per-stage local models
| Stage | Cloud now | Local | "Same model"? |
|---|---|---|---|
| VLM (face caption) | gemma-3-12b | **gemma-3-12b** (mlx-vlm) | ✅ identical |
| STT (lyric timing) | WhisperX (Replicate) | whisper-large-v3-turbo (mlx-whisper) | ~same family, cached |
| Story / shot-list LLM | Claude Sonnet / Gemini | Qwen3.6-35B-A3B-4bit (mlx-lm + llguidance JSON) | open equivalent, cached |
| Keyframe image | gemini-image | FLUX / Qwen-Image (mflux), Kontext for identity | open equivalent |
| Video i2v | Kling | **Wan 2.2 MLX** | ✅ done |

Frontier cloud models (Sonnet, gemini-image) have no downloadable weights → local uses
open **equivalents**, except the VLM which can be literally the same gemma-3.

### Model Manager (single-resident, load-on-demand + unload)
Stages run sequentially (LLM storyboard → all keyframes → all clips), so only **one**
model needs to be resident at a time → fits 48GB. `ensure(modelKey)`: if a different
model is resident, **unload** it (free the MLX cache), then load the requested one; it
stays resident **within** a stage (e.g. Wan across every clip) — which also removes the
per-clip reload. New sidecar endpoints behind the same GPU lock: `/llm`, `/keyframe`,
`/vlm`, `/stt` (+ existing `/i2v`).

### Settings: enable → download, with guards (hard requirements)
- Toggling a stage to **local** in Settings **downloads** that model (hf download, +
  convert for Wan-style), shown with live progress + a `ready | downloading | error` state.
- **A download BLOCKS generation**: render is refused while any required local model is
  downloading or not-ready, with a clear message (e.g. "Downloading Wan 2.2 — 45%").
- **One render at a time**: a global render lock — a second render request while one is
  running is blocked/queued (also fixes the duplicate-render state seen in testing).

### Build order
1. **Render lock** (single active render) + **Model Manager** (resident + unload) — base.
2. **STT** local (whisper already cached) — quick win, drops Replicate.
3. **Story/shot LLM** local (Qwen cached + grammar-constrained JSON).
4. **Keyframe** local (mflux + Kontext) + the download manager / Settings guards.

### Caveats
Huge downloads (Wan ~118GB, Qwen ~19GB, FLUX ~10GB, whisper ~2GB); slow (video
dominates); quality below the cloud frontier.
