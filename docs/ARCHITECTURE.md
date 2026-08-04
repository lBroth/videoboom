# Architecture

Videoboom is an **open-source, local-only desktop app**. An Electron shell runs an in-process TypeScript
render engine; every generation stage runs **on-device** (Apple Silicon / MLX) through a resident Python
sidecar. Nothing leaves the machine — the only network use is downloading the model weights once. See also
`AGENTS.md`.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Renderer — React/Vite UI  (renderer/)                                         │
│  Create · Videos · Cast · Settings.  Talks ONLY to window.vb (no direct net).  │
└───────────────▲────────────────────────────────────────────────────────────────┘
                │  window.vb  (contextBridge; the only surface the UI can touch)
┌───────────────┴────────────────────────────────────────────────────────────────┐
│  Electron main  (src/main)                                                      │
│   · window + IPC   · no secrets — everything runs locally                        │
│   · on-device model settings + downloads (settings.ts / localModels.ts)          │
│   · runs the engine per operation; forwards its events to the UI (sidecar:<op>)   │
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │  runEngine(command, args, env, onEvent)  — in-process, async
┌───────────────┴─────────────────────────────────────────────────────────────────┐
│  Render engine — TypeScript  (src/engine/)                                       │
│   index(dispatch) · pipeline · stages · segment · ffmpeg · storage                │
│   create-project · render(preview) · resume · regenerate-scene · character-* ·     │
│   get-project.   state + media = plain files under the userData data/ dir          │
│        │  stages.ts → local*.ts → sidecar (localhost HTTP)                         │
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │  POST /stt · /llm · /keyframe · /vlm · /i2v · /interp · /upscale
┌───────────────┴─────────────────────────────────────────────────────────────────┐
│  On-device model sidecar — Python/MLX  (local/server.py)                          │
│   mlx-whisper · mlx-lm (Qwen) · mflux (FLUX/Kontext) · mlx-video (Wan 2.2) ·        │
│   mlx-vlm (gemma) · RIFE · Real-ESRGAN.   ffmpeg/ffprobe (bundled) → final MP4     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The TypeScript engine runs **in the main process** and is **async throughout** — ffmpeg runs as child
processes, model calls are async HTTP to the localhost sidecar — so the UI never blocks. Events flow back
through the same `onEvent` callback the IPC layer forwards to the renderer. The sidecar is started on
demand (`src/engine/sidecar.ts`) and stays warm so the heavy MLX import is paid once.

## The render pipeline (`src/engine/pipeline.ts`, dispatched by command)

1. **storyboard** — transcribe the song on-device (mlx-whisper, per-word timing) → story bible (LLM) →
   shot list (LLM, structured output). Empty words is a legitimate instrumental (proceeds in mood mode),
   not an error. Plans the **whole song** (one record per scene, capped at `MAX_SCENES`), each with the
   `cast` in that scene. A **preview** render does only the opening ~25%; **resume** renders the rest.
2. **scene** — per scene: generate a **keyframe** placing the scene's cast (reference photos +
   identity-preserving prompt) → generate the **video clip** (Wan 2.2, one continuous shot of chained
   native sub-clips from a single start frame) → **trim** to the frame grid + thumbnail. Video is
   GPU-serialized (one clip at a time). A permanently-failed scene is **tolerated** (left `failed`; the
   rest still assemble).
3. **assemble** — concatenate the available clips + the song → MP4 + a first-frame **poster** → `done`.
   Output is tagged as AI-generated in the file metadata.
4. **regenerate-scene** — surgical per-scene fix: re-render one scene (keeping the neighbor seam) and
   re-assemble.
5. **character-portrait** — turn an uploaded photo and/or a text prompt into a clean, consistent AI
   portrait — the cast's reusable identity.

## Vocal-aligned editing
On-device whisper gives per-word timestamps; `src/engine/segment.ts` snaps scene boundaries onto a frame
grid so cuts lock to the singing with no cumulative drift. Each chained clip is `trimToWindow`'d (frame-count
trim, real speed — never a setpts retime) to its exact slot; `assemble` then conforms every clip to a single
resolution (`conformClip`) before the concat. A vocal scene's start snaps to its first sung word.

## Identity consistency
Keyframes are generated from the cast's reference portraits with a strong "reproduce every facial feature
exactly, no blending/de-aging" prompt; `VB_MAX_SUBJECTS` must cover the whole cast so nobody is dropped (a
dropped reference = the model invents that subject). The clip animates the keyframe, so keyframe identity
= clip identity.

## Storage & privacy
There are no keys or secrets — every stage runs on-device. Projects (state JSON + media) are plain files
under the userData `data/` dir (`src/engine/storage.ts`, local filesystem only). The only network use is
downloading model weights (`local/setup.sh` / `local/download.py`); generation is fully offline. Boot
removes any stale `keys.json` left by the old cloud build.

## Packaging
`electron-builder` produces the macOS `.dmg`; `ffmpeg-static` / `ffprobe-static` are bundled and
`asarUnpack`ed (the engine rewrites `app.asar` → `app.asar.unpacked` in the binary path). On-device
generation uses the Python MLX sidecar (`local/`), installed once by `bash local/setup.sh` as a user-owned
venv — it is not bundled into the installer. The `renderer/fonts/` Inter woff2 ships in-app, so the UI makes
no external font request (the CSP stays `'self'`-only).
