# Folder structure

The repo root **is** the desktop app (Electron + React + an in-process TypeScript render engine).

```
package.json              the app: scripts (dev/build/dist) + electron-builder config (win/mac/linux targets)
vite.config.ts            renderer build (root = renderer/, relative base for file:// in the packaged app)
tsconfig.json             TS for src/ + renderer/
tailwind.config.js · postcss.config.js   renderer styling

src/
  main/                   Electron main — window, IPC, runs the engine, OS-keychain key storage
    index.ts              app/window lifecycle + the IPC surface; streamOp() runs an engine op
    keychain.ts           BYOK secrets — safeStorage-encrypted keys.json; decrypt -> engine config
    settings.ts           non-secret model/render settings -> VB_* config
    projects.ts           read-only project/scene/character state off disk for the renderer
  preload/                contextBridge — exposes window.vb (the only surface the renderer can touch)
  engine/                 the render engine (in-process, async; replaces the old Python sidecar)
    index.ts              runEngine(command,args,env,onEvent) dispatch; emits events, returns result
    pipeline.ts           storyboard -> keyframe pass -> clip pass -> assemble; regen; portrait
    providers.ts          OpenRouter (LLM/keyframe/VLM/moderation/i2v) + Replicate/Groq transcription
    segment.ts            vocal-phrase segmentation + frame-grid timing + energy windows
    ffmpeg.ts             bundled ffmpeg/ffprobe; probe, thumb, ->png, fit-to-grid, still-fill, PCM decode
    storage.ts            local-filesystem state + media under the userData data/ dir
    config.ts · cost.ts   injected key/model config; informational cost accounting
    selftest.ts           offline ffmpeg self-test (VB_ENGINE_TEST=1)

renderer/                 React + TS + Vite UI
  App.tsx                 Create / Videos / Cast / Settings
  components/ui.tsx       reusable kit (Button, Field, Card, Modal, Spinner, …)
  main.tsx · index.css · vb.d.ts (window.vb types)

icons/                    app icon
docs/                     ARCHITECTURE · FOLDER-STRUCTURE · PROVIDERS · ROADMAP · research/
```

Build outputs (gitignored): `dist/` (esbuild main+preload), `renderer-dist/` (vite), `release/`
(electron-builder installers). ffmpeg ships via `ffmpeg-static` / `ffprobe-static` (no checked-in binaries).
