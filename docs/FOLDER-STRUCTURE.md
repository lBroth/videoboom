# Folder structure

The repo root **is** the desktop app (Electron + React + an in-process TypeScript render engine).

```
package.json              the app: scripts (dev/build/dist) + electron-builder config (macOS target)
vite.config.ts            renderer build (root = renderer/, relative base for file:// in the packaged app)
tsconfig.json             TS for src/ + renderer/
tailwind.config.js · postcss.config.js   renderer styling

src/
  main/                   Electron main — window, IPC, on-device model settings + downloads
    index.ts              app/window lifecycle + the IPC surface; streamOp() runs an engine op
    settings.ts           local-only model/render settings (v2) -> VB_* config
    localModels.ts        on-device capability gate + per-stage model availability/downloads
    projects.ts           read-only project/scene/character state off disk for the renderer
  preload/                contextBridge — exposes window.vb (the only surface the renderer can touch)
  engine/                 the render engine (TypeScript, in-process, async)
    index.ts              runEngine(command,args,env,onEvent) dispatch; emits events, returns result
    pipeline.ts           storyboard -> keyframe pass -> clip pass -> assemble; regen; portrait
    stages.ts             shared stage helpers + schemas; delegate to the local*.ts on-device modules
    localStt/Llm/Vlm/Keyframe/Video.ts   per-stage wrappers over the Python MLX sidecar
    sidecar.ts            starts/keeps the localhost model sidecar warm; POST helper
    segment.ts            vocal-phrase segmentation + frame-grid timing + energy windows
    ffmpeg.ts             bundled ffmpeg/ffprobe; probe, thumb, ->png, trim-to-grid, conform, still-fill, PCM
    storage.ts            local-filesystem state + media under the userData data/ dir
    config.ts             injected VB_* model config
    selftest.ts           offline ffmpeg self-test (VB_ENGINE_TEST=1)

local/                    Python MLX model sidecar — server.py + per-stage runners; setup.sh / download.py
renderer/                 React + TS + Vite UI
  App.tsx                 Create / Videos / Cast / Settings
  components/ui.tsx       reusable kit (Button, Field, Card, Modal, Spinner, …)
  fonts/                  bundled Inter woff2 (no external font request)
  main.tsx · index.css · vb.d.ts (window.vb types)

icons/                    app icon
docs/                     ARCHITECTURE · FOLDER-STRUCTURE · MODELS · LOCAL-MODELS · ROADMAP · research/
```

Build outputs (gitignored): `dist/` (esbuild main+preload), `renderer-dist/` (vite), `release/`
(electron-builder installers). ffmpeg ships via `ffmpeg-static` / `ffprobe-static` (no checked-in binaries).
