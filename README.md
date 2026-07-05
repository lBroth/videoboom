<p align="center">
  <img src="icons/icon.png" width="124" alt="Videoboom" />
</p>

<h1 align="center">Videoboom</h1>

<p align="center">
  <b>Turn a song into a complete music video — on your own machine by default.</b>
</p>

<p align="center">
  <a href="https://github.com/lBroth/videoboom/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/lBroth/videoboom?color=b14dff&label=download"></a>
  <a href="https://lbroth.github.io/videoboom/"><img alt="Website" src="https://img.shields.io/badge/website-videoboom-ff4db8"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-7c4dff">
  <a href="https://github.com/lBroth/videoboom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lBroth/videoboom/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center">
  <a href="https://github.com/lBroth/videoboom/releases/latest"><b>⬇ Download</b></a> ·
  <a href="https://lbroth.github.io/videoboom/"><b>Website</b></a> ·
  <a href="#install-run-from-source">Run from source</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/ROADMAP.md">Roadmap</a>
</p>

---

Videoboom is an open-source desktop app. Drop in a song, optionally add a cast (reusable AI
characters built from a photo or a description), and it writes a story from the lyrics, designs the
shots, generates keyframes, animates each scene, and cuts the final video to the beat.

Videoboom is **local-default hybrid**. Every stage runs **on-device by default** on Apple Silicon via a
resident Python MLX sidecar — transcription (Whisper), story + shot list (Qwen3 LLM), keyframes
(FLUX + Kontext), image-to-video (Wan 2.2), and face caption + safety (gemma-3 VLM). With no key, generation
is fully local, private and offline: the only time Videoboom touches the network is to download the model
weights once, and your song and your video never leave your machine.

Local is the point: **private, free to run, offline** once the models are downloaded. Want more speed or a
specific model on one stage? You can **optionally** bring your own key to run that stage in the cloud
(OpenRouter · Kling · Replicate) — it's **off by default**, chosen per stage, and nothing leaves your
machine unless you turn it on for that stage.

> **Why local-default?** Cloud video generation is expensive and sends your song to someone else's servers.
> Running the models locally means it's private, it's free to run, and it works offline once the models
> are downloaded. When you want more speed or a specific model, opt a stage into cloud with your own key.
> On-device generation needs a capable Mac (see requirements below).

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
- **Preview first** — render the opening ~25% quickly, then continue to the full song.
- **On-device by default** — transcription, story, keyframes and video all run locally (Apple Silicon / MLX);
  private and offline, no key required.
- **Optional cloud, per stage** — bring your own key to opt individual stages into OpenRouter (LLM / VLM /
  keyframes), Kling (video) or Replicate (WhisperX timing). Off by default; nothing leaves the machine unless
  you turn it on.
- AI-generated output is tagged as such in the file metadata.

## System requirements
Videoboom runs the AI models **on your own GPU** — nothing is streamed, nothing is metered. On-device
generation needs one of:

| GPU | Minimum | Status |
|-----|---------|--------|
| **Apple Silicon — MLX / Metal** | M-series Mac · **48 GB+ unified memory** (64 GB recommended — measured on-device peaks: Wan-14B bf16-relay ~33 GB, FastWan-5B ~55 GB) | ✅ shipping |
| **NVIDIA — CUDA** | driver ≥ 570 · **8 GB+ VRAM** · compute capability ≥ 8.6 · Windows / Linux | 🚧 on the roadmap |

Plus **~50 GB free disk** for the model weights (downloaded once). The app detects your machine, picks the
right models and quantization for it, and gates local generation until you meet the bar. No supported GPU?
You can still generate by opting individual stages into cloud with your own key — but on-device stays the
default.

## Install (run from source)
```bash
# repo root — the Electron app (Node); ffmpeg ships bundled (ffmpeg-static).
npm install
npm run dev

# one-time: install the on-device model sidecar (Python venv + MLX) and download/convert the Wan video model
bash local/setup.sh
```
The remaining stage models (STT / LLM / VLM / keyframes) download from **Settings → On-device → Download**.
Once every required stage shows *Ready*, **Create** a video — fully local, nothing to paste. To route a
stage through cloud instead, add your provider key in **Settings** and opt that stage in.

## Packaged builds (no install for end users)
`npm run dist` bundles ffmpeg into a native macOS installer. The Electron app orchestrates the render;
on-device generation uses the Python MLX sidecar installed once by `bash local/setup.sh` (a user-owned
venv, not bundled into the installer).

| OS      | Output (`release/`) |
|---------|---------------------|
| macOS   | `.dmg`              |

## Repository layout
```
src/main/      Electron main — window, IPC, runs the engine, on-device model settings + downloads
src/preload/   contextBridge — exposes window.vb (the only surface the renderer can touch)
src/engine/    TypeScript render engine — transcribe ▸ story ▸ shot list ▸ keyframes ▸ i2v ▸ assemble
               (stages.ts wraps the on-device local*.ts modules by default, and the cloud/ clients when a
               stage is opted in)
src/engine/cloud/  Optional bring-your-own-key providers — OpenRouter (LLM/VLM/keyframes), Kling (video),
               Replicate (WhisperX timing); used only for stages the user explicitly enables
local/         Python MLX sidecar (server.py) + setup/download scripts for the on-device models
renderer/      React UI (Create / Videos / Cast / Settings), wired to window.vb
icons/         app icon
docs/          ARCHITECTURE · FOLDER-STRUCTURE · MODELS · LOCAL-MODELS · ROADMAP (+ research/)
```

## How it works
The TypeScript engine runs in-process in the Electron main process: per operation it streams progress
events to the UI. By default each generation stage calls the on-device MLX models through the resident
Python sidecar (`local/server.py`); if you opt a stage into cloud with your own key, that stage calls the
matching client under `src/engine/cloud/` instead. ffmpeg (bundled) does the cutting. Projects (state +
media) are plain files under the app's data directory. With no key, nothing leaves the machine.

## License
Apache-2.0 — see [LICENSE](LICENSE). You are responsible for the content you generate and for complying
with the licenses of the on-device models you download.
