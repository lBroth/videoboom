# Local models (on-device, Apple Silicon)

Status: **Wan 2.2 I2V-A14B (image-to-video) is wired and the default local model**
(best quality: sharp x16 VAE, no people-deform). LTX-2.3 and Wan 5B are the explicit
fast choices. A finish chain (RIFE interpolation → Real-ESRGAN 1080p upscale → filmic
grade) runs on every local render.

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

## Finish chain (fluidity + resolution)

- **RIFE 2x** (`/interp`, rife-v4.26 ncnn under `local/models/`): every sub-24fps clip
  (the 14B is 16fps native) is interpolated to 2× right after i2v, so the 24fps conform
  DECIMATES instead of duplicating frames (duplication = the old visible judder).
  Per-clip ONLY — never interpolate an assembled timeline (it would morph across cuts).
- **Real-ESRGAN upscale** (`/upscale`): assemble runs the concatenated timeline to 1080p
  (`VB_UPSCALE_H`), then a **filmic grade** (`VB_FINISH` = off|subtle|filmic: deband →
  S-curve → micro-sharpen → temporal grain). Both best-effort — failures leave the raw cut.
- The rife/realesrgan ncnn wheels each bundle MoltenVK — importing both in one process
  SEGFAULTS, so the sidecar runs each job in an isolated subprocess (`_run_isolated`).

## Known limits

- **Weights reload per call.** Upstream `generate_video` loads + frees the text encoder +
  transformers + VAE each request (LTX reloads everything per scene too). Warm process +
  OS page cache help; a true weight-resident denoise loop is the Model Manager TODO.
- **48GB memory ceiling.** Attention is O(seq_len²), so frames×resolution is hard-capped.
  480p / 37 frames is the stable point; 49f or 720p hit Metal "Insufficient Memory".
- **Slow & heavy.** ~5.5 min/clip at 480p/37f Lightning 4-step; a full song is long.
- **Slow-mo fixed** by cutting local scenes to ~native clip length and rendering the last
  chained sub-clip only as long as the remaining window needs.

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

> **Status:** the MLX (Apple Silicon) version of all of the above is **implemented** —
> model-agnostic sidecar (`/i2v /stt /llm /vlm /keyframe`), ModelManager, per-stage
> dispatch, download-gated Settings toggles + render guards, capability gate.

---

## TODO — CUDA backend (Windows / Linux, NVIDIA)

MLX is Apple-only. Windows/Linux run the same pipeline on **NVIDIA CUDA**, using **direct
Python libraries** — explicitly **no Ollama, no ComfyUI** (those are just wrappers; the Mac
sidecar already imports mlx libs in-process, and the CUDA sidecar mirrors that with torch).
The whole framework (model-agnostic sidecar, ModelManager, per-stage dispatch, download
gating, Settings UI, capability gate) is **reused as-is** — only the handler implementations
change from mlx to torch.

### Per-stage libraries (direct, in-process)
| Stage | CUDA library |
|---|---|
| Video i2v | diffusers `WanImageToVideoPipeline` (Wan 2.2; FP8/GGUF) — faster on CUDA than MLX |
| Keyframe | diffusers `FluxPipeline` / `FluxKontextPipeline` |
| LLM | transformers `AutoModelForCausalLM`, or **llama-cpp-python** (GGUF — the lib Ollama wraps, used directly) |
| VLM | transformers (gemma-3 vision) |
| STT | faster-whisper / whisperx (already CUDA-native) |

### Wiring
- `VB_LOCAL_DEVICE = mlx | cuda`, auto-detected (Apple Silicon → mlx, NVIDIA present → cuda);
  each handler imports the matching backend. Could split `local/` into `backends/mlx` +
  `backends/cuda` sharing one `server.py` + `manager.py`.
- ModelManager unload on CUDA = drop ref + `gc.collect()` + `torch.cuda.empty_cache()`.
- `localCapabilities()` extended: detect NVIDIA + VRAM via `nvidia-smi
  --query-gpu=memory.total`; supported = (Apple Silicon ≥32GB) OR (NVIDIA ≥16GB VRAM).

### Minimum hardware (NVIDIA — video Wan 14B is the bottleneck)
- **≥16GB VRAM** (FP8/Q4 + 480p) minimum; **24GB recommended** (RTX 3090/4090).
- 12GB only with heavy offload → very slow. System RAM 32GB+, fast SSD.
- AMD ROCm = immature → skipped for now. No strong GPU → stay on cloud (the BYOK default).
