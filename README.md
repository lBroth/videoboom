# Videoboom

**Turn a song into a complete music video — on your own machine, with your own API keys.**

Videoboom is an open-source desktop app. Drop in a song, optionally add a cast (reusable AI
characters built from a photo or a description), and it writes a story from the lyrics, designs the
shots, generates keyframes, animates each scene, and cuts the final video to the beat.

It's **bring-your-own-key (BYOK)**: you paste your own OpenRouter / Replicate keys, the app calls those
providers directly, and you pay them at cost. No accounts, no subscription, no markup — nothing leaves
your machine except the generation calls you pay for.

> **Why BYOK?** Cloud video generation is genuinely expensive (~€25–30 of provider cost per finished
> minute). A hosted service has to mark that up to survive, which makes it absurd for casual use. BYOK
> removes the middleman: you see exactly what each render costs and decide.

```
song ─▶ transcribe (forced-aligned) ─▶ story from the lyrics ─▶ shot list
     ─▶ keyframes (your cast, kept consistent) ─▶ per-scene video ─▶ assemble ─▶ MP4
```

## Features
- **Story from the actual lyrics** — a narrative that tracks the song, not generic filler.
- **Vocal-aligned editing** — WhisperX forced alignment + frame-grid retiming, so scenes lock to the
  singing with no cumulative drift.
- **Reusable cast** — a photo and/or a description becomes a consistent character reused across scenes.
- **Per-scene refresh** — re-roll a single scene without touching the rest of the cut.
- **Preview first** — render the opening ~25% cheaply, then continue to the full song.
- **Your models** — swap the LLM / image / video models in Settings (e.g. a cheaper i2v model).
- AI-generated output is tagged as such in the file metadata.

## Install (run from source)
```bash
# repo root — Node only, no Python. ffmpeg ships bundled (ffmpeg-static).
npm install
npm run dev
```
Open **Settings**, paste an **OpenRouter** key (required) and a **Replicate** token (for accurate lyric
timing), then **Create** a video. Keys are encrypted with your OS keychain and never leave the machine.

## Packaged builds (no install for end users)
`npm run dist` bundles ffmpeg into a native installer for the OS you run it on. The render engine is pure
TypeScript (no Python, no PyInstaller); the only per-OS piece is the bundled ffmpeg binary, downloaded by
`npm install`, so each OS is built on its own machine (or a CI runner):

| OS      | Output (`release/`)                         |
|---------|---------------------------------------------|
| Windows | `Setup .exe` (installer) + portable `.exe`  |
| macOS   | `.dmg`                                       |
| Linux   | `.AppImage` (click-to-run) + `.deb`         |

## Repository layout
```
src/main/      Electron main — window, IPC, runs the engine, OS-keychain key storage
src/preload/   contextBridge — exposes window.vb (the only surface the renderer can touch)
src/engine/    TypeScript render engine — transcribe ▸ story ▸ shot list ▸ keyframes ▸ i2v ▸ assemble
renderer/      React UI (Create / Videos / Cast / Settings), wired to window.vb
icons/         app icon
docs/          ARCHITECTURE · FOLDER-STRUCTURE · PROVIDERS · ROADMAP (+ research/)
```

## How it works
The engine runs in-process in the Electron main process: per operation it streams progress events to the
UI, with your keys + model choices injected from the keychain. Generation is your own cloud API calls
(OpenRouter + Replicate); ffmpeg (bundled) does the cutting. Projects (state + media) are plain files
under the app's data directory.

## License
Apache-2.0 — see [LICENSE](LICENSE). Videoboom only orchestrates third-party model APIs; you are
responsible for complying with each provider's terms and for the content you generate.
