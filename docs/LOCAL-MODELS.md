# Local models (on-device, Apple Silicon)

Status: **image-to-video is always on-device — Wan 2.2 via mlx-video.** The Fast/Quality
switch in Settings IS the model choice: **Fast** = FastWan-5B (DMD 3-step draft), **Quality**
= Wan I2V-A14B (bf16-relay; sharp x16 VAE, best quality, no people-deform, slower). Both
render at 480p on-device and **finish at 1080p** via a finish chain (RIFE interpolation →
Real-ESRGAN upscale → filmic grade) that runs on every render.

User-facing setup + tunables live in [`local/README.md`](../local/README.md). This
page is the architecture for contributors.

## Shape

```
Electron main (in-process TS engine)
        │  genVideoLocal()  — video is always on-device
        ▼
src/engine/localVideo.ts  ──HTTP /i2v──▶  local/server.py  ──▶  mlx-video (Wan 2.2)
   build payload + POST                    resident process       generate_video()
        ▲  (process lifecycle: sidecar.ts)  one job at a time
        └── the sidecar writes the mp4 straight to the scene's tmp path ─┘
```

- **Why a separate process, not in-process:** MLX/Wan is Python. The app's engine
  is TypeScript and stays that way. The sidecar's Python deps and the model weights are
  never bundled into the installer (Wan alone is ~118GB) — users provision them with
  `local/setup.sh` (or Settings → On-device → Download).
- **Why resident:** loading a 14B model is expensive; the process stays warm for the
  app's lifetime so import + weights are paid once, not per scene.
- **Lifecycle:** `sidecar.ts` lazily spawns `server.py` on the first stage call and
  polls `/health`; `localVideo.ts` then POSTs one `/i2v` per sub-clip. The sidecar writes
  the mp4 to the scene's tmp path (same machine, same FS — no bytes over the socket). A
  global lock in the server serialises diffusion runs; the engine also runs a single
  worker (`VB_WORKERS=1`).

## Where it plugs in

- `src/engine/pipeline.ts` → `renderClip()` always renders on-device: it calls
  `renderLocalScene()`, which chains native-length sub-clips through `genVideoLocal()`
  (each i2v continues from the previous clip's last frame) into one continuous shot. There
  is no cloud branch and no `providers.ts` — every stage goes through `src/engine/stages.ts`,
  which delegates to the `local*.ts` wrappers.
- Wan i2v takes a **single** start frame — there is no last-frame conditioning; a long
  scene gets its motion from the chained sub-clips, not a first+last morph.
- The chained clip is already ≥ the scene window, so `renderClip()` finishes it with
  `trimToWindow()` (cut the excess frames — no `setpts` retime, so real speed, never
  slow-mo), and `assemble()` normalises every clip with `conformClip()` before the concat.
- `src/engine/ffmpeg.ts` → `vW()`/`vH()` are live env reads (not load-time consts) so the
  on-device 480p resolution (`VB_W=832`/`VB_H=480`, injected by settings) reaches both Wan
  generation and the failed-scene fill — every clip shares one size for concat.
- `src/main/settings.ts` → `localVideoModel` (`5b`/`14b`) + the hd flag; `settingsEnv()`
  injects `VB_LOCAL_VIDEO_MODEL`, `VB_LOCAL_QUALITY`, the 480p `VB_W`/`VB_H`, and a single
  worker (`VB_WORKERS=1`).

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

## Full local mode — every stage on-device (shipped)

The whole pipeline runs offline behind the same sidecar: no network at generation time,
weights downloaded once.

### Per-stage on-device models
| Stage | On-device model | Notes |
|---|---|---|
| VLM (face caption) | **gemma-3-12b** (mlx-vlm) | anchors cast identity; safety fail-open |
| STT (lyric timing) | whisper-large-v3-turbo (mlx-whisper) | per-word timings, cached |
| Story / shot-list LLM | Qwen3.6-35B-A3B-4bit (mlx-lm + llguidance JSON) | grammar-constrained JSON |
| Keyframe image | FLUX schnell + FLUX Kontext (mflux) | schnell txt2img; Kontext for cast identity |
| Video i2v | **Wan 2.2** (mlx-video) | Fast = FastWan-5B / Quality = Wan-14B |

### Model Manager (single-resident, load-on-demand + unload)
Stages run sequentially (LLM storyboard → all keyframes → all clips), so only **one**
model needs to be resident at a time → fits 48GB. `ensure(modelKey)`: if a different
model is resident, **unload** it (free the MLX cache), then load the requested one; it
stays resident **within** a stage (e.g. Wan across every clip) — which also removes the
per-clip reload. Sidecar endpoints behind the same GPU lock: `/llm`, `/keyframe`,
`/vlm`, `/stt`, `/i2v`.

### Settings: enable → download, with guards
- The Settings **Download** button fetches each stage's model (hf download, + convert for
  Wan), shown with live progress + a `ready | downloading | error` state.
- **A download BLOCKS generation**: render is refused while any required model is
  downloading or not-ready, with a clear message (e.g. "Downloading Wan 2.2 — 45%").
- **One render at a time**: a global render lock — a second render request while one is
  running is blocked/queued.

### Caveats
Huge one-time downloads (Wan ~118GB, Qwen ~19GB, FLUX ~10GB, whisper ~2GB) and slow (video
dominates) — the trade for running the whole thing offline on your own machine.

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
- AMD ROCm = immature → skipped for now. A machine below the bar simply can't run on-device
  — there is no cloud fallback; `localCapabilities()` / `HARDWARE_SPEC` gate it and say why.
