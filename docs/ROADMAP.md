# Roadmap

> Videoboom is now an **open-source, bring-your-own-key desktop app**. It went local-first (Phase 0) →
> AWS serverless SaaS (coins/Cognito/DynamoDB) → back to a desktop app, this time open-source + BYOK.
> The SaaS code was deleted (recoverable from git history).

## Done
- **Desktop app**: Electron shell (`src/main`, `src/preload`, `renderer/`) + an in-process TypeScript
  render engine (`src/engine/`), keys stored encrypted via the OS keychain, no server, no Python.
- **Render pipeline**: story from the actual lyrics → shot list → identity-preserving keyframes →
  per-scene video (Kling, first+last-frame) → beat-cut assemble, with tolerant failure handling.
- **Vocal-aligned editing**: forced alignment (Replicate) + frame-grid retiming; a vocal scene snaps to
  its first sung word.
- **Cast**: reusable characters from a photo and/or prompt; multi-subject scenes.
- **Per-scene refresh**, **preview-then-resume**, AI-tagged output metadata.
- **BYOK + at-cost**: user pastes their own OpenRouter / Replicate keys; the app shows real provider
  cost with no markup.
- **Packaging**: `npm run dist` → native installers (Windows NSIS + portable, macOS dmg, Linux
  AppImage + deb); ffmpeg bundled (`ffmpeg-static`) so end users need no toolchain.
- **Sidecar removed**: ported the Python render engine to TypeScript (in-process, async) — one runtime,
  no PyInstaller, simpler cross-OS builds.
- **CI/CD**: GitHub Actions — typecheck + unit tests + build and headless engine/smoke tests on all
  three OSes; on a `v*` tag a matrix build publishes the installers to GitHub Releases (v0.1.0 shipped).

## Next — local / on-device models (the BYOK idea, all the way)
Let the user run models on their **own hardware** instead of paying a cloud provider — zero per-render
cost, fully offline, maximum privacy. The engine is already provider-abstracted (every stage is a model
+ endpoint), so this is mostly wiring + Settings, staged easiest-first:
- **LLM (story + shot list)** — point at any **OpenAI-compatible local server** (Ollama / LM Studio /
  llama.cpp) via a custom base URL + model in Settings. Smallest lift: the engine already speaks the
  OpenAI chat schema; just make the base URL configurable per stage.
- **Transcription** — local **whisper.cpp / WhisperX** instead of Replicate (word timings on-device).
- **Keyframes** — local image generation (**ComfyUI / Stable Diffusion**) behind the same `cloudKeyframe`
  seam.
- **Video (i2v)** — local open models (**Wan / SVD**) via ComfyUI; heaviest, needs a capable GPU / Apple
  Silicon, so it lands last.
- Keep it **opt-in and mix-and-match**: e.g. local LLM + cloud video, chosen per stage in Settings.

## TODO — estimated cost / minute in Settings
Show a live **€/min of video** estimate in Settings, computed from the **active cloud models** per stage
(local stages = €0, since they run on the user's own hardware).
- Per-stage cost model (per 1 min of finished video):
  - **Video i2v** (the dominant cost): ~60s of clips per minute × the provider's per-second rate
    (e.g. Kling). Half-known already — `cost.ts` tracks real spend after a render; reuse those rates.
  - **Keyframes**: ~(scenes per minute) × per-image price of the active image model.
  - **LLM** (story + shot list): ~tokens per render × the model's input/output price (small).
  - **STT**: per-song flat (Replicate WhisperX), amortised over the song length (small).
  - **VLM / moderation**: per cast/upload, not per video minute → show separately or omit.
- Sum the stages currently set to **cloud**; show "€0 (fully local)" when every stage is local.
- Source rates from a small `pricing` table (cents per second / per image / per Mtoken) keyed by model
  slug, with sensible defaults + an option to edit (prices drift). Recompute on any backend/model change.
- It's an **estimate** — label it; the post-render `cost.ts` total is the real figure.

## Also next
- **Settings polish**: per-stage model picker + a "test key" button.
- **More i2v models**: expose cheaper / alternative image-to-video models cleanly (keep `genVideo()`
  model-agnostic).
- **Landing page**: GitHub Pages site (built; goes live once the repo is public).

## Parked / later
- Lip-sync (deferred — keep medium/wide shots until solved); seamless flow-chain between clips.
- Additional modes (news / shorts / animation).
- Auto-update for packaged builds.
