# Architecture

Videoboom is an **open-source, bring-your-own-key desktop app**. An Electron shell runs an in-process
TypeScript render engine. Everything runs on the user's machine; the only network calls are to the model
providers the user configured with their own keys. See also `AGENTS.md`.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Renderer — React/Vite UI  (renderer/)                                         │
│  Create · Videos · Cast · Settings.  Talks ONLY to window.vb (no direct net).  │
└───────────────▲────────────────────────────────────────────────────────────────┘
                │  window.vb  (contextBridge; the only surface the UI can touch)
┌───────────────┴────────────────────────────────────────────────────────────────┐
│  Electron main  (src/main)                                                      │
│   · window + IPC                                                                 │
│   · API keys stored ENCRYPTED via OS keychain (safeStorage); decrypted in-mem    │
│   · runs the engine per operation; forwards its events to the UI (sidecar:<op>)   │
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │  runEngine(command, args, env, onEvent)  — in-process, async
┌───────────────┴─────────────────────────────────────────────────────────────────┐
│  Render engine — TypeScript  (src/engine/)                                       │
│   index(dispatch) · pipeline · providers · segment · ffmpeg · storage · cost      │
│   create-project · render(preview) · resume · regenerate-scene · character-* ·     │
│   get-project.   state + media = plain files under the userData data/ dir          │
│        │ OpenRouter (story LLM · keyframes · video clips · moderation)            │
│        │ Replicate  (forced-aligned transcription for vocal-locked editing)       │
│        ▼ ffmpeg/ffprobe (bundled static binaries) → final MP4                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The engine runs **in the main process** and is **async throughout** — ffmpeg runs as child processes,
model calls are `fetch` — so the UI never blocks. There is no Python and no separate process; events flow
back through the same `onEvent` callback the IPC layer forwards to the renderer.

## The render pipeline (`src/engine/pipeline.ts`, dispatched by command)

1. **storyboard** — transcribe the song (forced-aligned via Replicate) → story bible (LLM) → shot list
   (LLM, structured output). Plans the **whole song** (one record per scene, capped at `MAX_SCENES`),
   each with the `cast` in that scene. A **preview** render does only the opening ~25%; **resume**
   renders the rest, reusing the preview.
2. **scene** (bounded-concurrency pool) — per scene: generate a **keyframe** placing the scene's cast
   (reference photos + identity-preserving prompt) → generate the **video clip** (Kling, first+last-frame
   morph) → fit to the frame grid + thumbnail. A permanently-failed scene is **tolerated** (left
   `failed`; the rest still assemble).
3. **assemble** — concatenate the available clips + the song → MP4 + a first-frame **poster** → `done`.
   Output is tagged as AI-generated in the file metadata.
4. **regenerate-scene** — surgical per-scene fix: re-render one scene (keeping the neighbor seam) and
   re-assemble.
5. **character-portrait** — turn an uploaded photo and/or a text prompt into a clean, consistent AI
   portrait — the cast's reusable identity.

## Vocal-aligned editing
WhisperX-style forced alignment (Replicate) gives per-word timestamps; `src/engine/segment.ts` retimes
scenes onto a frame grid (`fitToWindow`) so cuts lock to the singing with no cumulative drift. A vocal
scene's start snaps to its first sung word.

## Identity consistency
Keyframes are generated from the cast's reference portraits with a strong "reproduce every facial feature
exactly, no blending/de-aging" prompt; `VB_MAX_SUBJECTS` must cover the whole cast so nobody is dropped (a
dropped reference = the model invents that subject). The clip animates the keyframe, so keyframe identity
= clip identity.

## Keys, storage & privacy
Keys are the user's, stored encrypted with the OS keychain (`safeStorage`) and passed to the engine in
memory per operation (`src/engine/config.ts`) — never logged, never written to the project store or git.
Projects (state JSON + media) are plain files under the userData `data/` dir (`src/engine/storage.ts`,
local filesystem only).

## Packaging
`electron-builder` produces the native installers; `ffmpeg-static` / `ffprobe-static` are bundled and
`asarUnpack`ed (the engine rewrites `app.asar` → `app.asar.unpacked` in the binary path). No Python, no
PyInstaller. The only per-OS piece is the ffmpeg binary (downloaded by `npm install`), so each OS is
built on its own machine (or CI runner): Windows → NSIS installer + portable `.exe`; macOS → `.dmg`;
Linux → `.AppImage` + `.deb`.
