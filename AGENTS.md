# AGENTS.md — Videoboom working rules

Rules any agent (human or AI) MUST follow in this repo. Violations have caused real bugs.

## What this is
Videoboom is an **open-source, local-only desktop app** that turns a song into a music video entirely on
the user's own machine. An **Electron** shell (`src/main`, `src/preload`, `renderer/`) runs an **in-process
TypeScript render engine** (`src/engine/`); ffmpeg ships bundled (`ffmpeg-static`). Every generation stage
runs **on-device** (Apple Silicon / MLX) through a resident Python sidecar (`local/server.py`). **No
accounts, no server, no wallet, no API keys** — the only network use is downloading the model weights once.
Nothing about the song or the video leaves the machine. Targets macOS (Apple Silicon).

> History: this was once an AWS serverless SaaS (coins / Cognito / DynamoDB), then a bring-your-own-key
> cloud build (OpenRouter / Replicate). Both are gone — that code was deleted (recoverable from git
> history). Anything mentioning coins, wallets, Cognito/DynamoDB/S3/Lambda/CDK, **or cloud provider keys
> (OpenRouter, Replicate, `VB_*_MODEL` slugs, `safeStorage` keychain)** is **historical**.

## Docs
- **Keep docs in sync with the code.** Any change to the architecture, the render flow, the engine/IPC
  contract, the on-device model stack, or env/config MUST update the matching doc in the SAME change —
  stale docs that claim the wrong behavior are treated as bugs.
- Current docs that MUST stay accurate (keep minimal + truthful): `README.md`, `AGENTS.md`,
  `docs/ARCHITECTURE.md`, `docs/FOLDER-STRUCTURE.md`, `docs/MODELS.md`, `docs/LOCAL-MODELS.md`,
  `docs/ROADMAP.md`.
- Don't hoard docs — few accurate ones beat many stale ones. `docs/research/*` is point-in-time
  reference; truly dead docs are deleted, not left to rot.

## Prompts & data integrity
- **NEVER truncate variables or prompts** sent to models/APIs (no `prompt[:1500]`, `lyrics[:6000]`,
  `text[:1800]`, …) unless strictly necessary AND verified for a hard model limit. Truncation silently
  drops content (lyrics, story, scene detail) and corrupts output. Prove the limit first, then chunk.
- **Do not cap `max_tokens`** arbitrarily — songs vary in length; size limits dynamically.
- Use **structured output** (JSON schema) for every LLM call whose result is parsed.
- **Fail-fast**: if any step errors (no lyrics, no story bible, incomplete shot list), emit an error
  event and stop. Never pad with generic/invented scenes — every scene comes from the actual lyrics.

## Language
- **English only** — all UI text, code, comments, docs, and commit messages. (Assistant chat replies may
  match the user's language; anything written into the repo is English.)

## Privacy (local-only)
- There are **no API keys and no secrets** — every stage runs on-device. Do NOT reintroduce cloud clients,
  key storage (`safeStorage`/`keys.json`), or `VB_*_API_KEY` / provider-token env. Boot removes any stale
  `keys.json` left by the old cloud build.
- Nothing is uploaded anywhere. The **only** network use is downloading model weights (Hugging Face) via
  `local/setup.sh` / `local/download.py`. Generation itself is fully offline.

## On-device models
- Stages run locally on Apple Silicon (MLX) through the sidecar: STT (mlx-whisper), story/shot-list LLM
  (mlx-lm), keyframes (mflux FLUX + Kontext), image-to-video (mlx-video Wan 2.2), portrait caption + safety
  (mlx-vlm). The TypeScript wrappers in `src/engine/stages.ts` delegate to the `src/engine/local*.ts`
  modules; keep that indirection (no cloud branch). Video model + fast/hd quality are chosen in Settings
  (`src/main/settings.ts`, injected as `VB_*` env). See `docs/MODELS.md`.
- A machine that can't run on-device (not Apple Silicon, or under the RAM floor) is surfaced via
  `localCapabilities()`; the required-hardware spec lives in ONE place (`HARDWARE_SPEC`).

## Engine contract
- The engine runs **in-process** (`src/engine/`), driven by `runEngine(command, args, env, onEvent)`
  (`src/engine/index.ts`). It calls `onEvent` with progress events — `{event:'stage'|'keyframe'|'scene'|…}`
  then exactly one terminal `{event:'result'}` or `{event:'error'}`; the promise rejects on error. The
  main process forwards every event to the renderer on `sidecar:<opId>` (channel name kept for the UI
  contract). Same command set as before: `create-project`, `render` (`--preview`), `resume`,
  `regenerate-scene`, `character-create`, `character-portrait`, `get-project`.
- The engine is async throughout — it runs in the main process, so it must **never block the event loop**:
  ffmpeg runs as async child processes, model calls are async HTTP to the localhost sidecar. No `spawnSync`
  on hot paths.
- State + media are **plain files** under `VB_DATA_DIR` (default the app's userData `data/`).
  `src/engine/storage.ts` is **local filesystem only** — do not reintroduce any cloud coupling.
- ffmpeg/ffprobe come from `ffmpeg-static` / `ffprobe-static`; packaged builds `asarUnpack` them and the
  engine rewrites `app.asar` → `app.asar.unpacked` in the binary path.

## Image / video generation
- **Video model = Wan 2.2** on-device (mlx-video). The Fast/Quality choice IS the model choice: **Fast** =
  FastWan-5B (DMD 3-step draft, `.model-path-5b` → FastWan2.2-TI2V-5B-MLX, marker-forced in
  `local/wan_i2v.py`); **Quality** = Wan I2V-A14B bf16-relay. **Both finish at 1080p** — the shot renders
  at 480p on-device, then the finish pass interpolates (RIFE) + upscales (Real-ESRGAN) to 1080p (native
  1080p diffusion OOMs on-device). Each scene renders as one continuous shot of chained native sub-clips
  (single start frame), then trims to the frame grid — never a stretched slow-mo clip. Keep the `5b`/`14b`
  selection in `localVideo.ts` intact (`localVideoModel` in settings drives it).
- **Identity**: keyframes are built from the cast's reference portraits with a strong "reproduce every
  facial feature exactly, no blending/de-aging" prompt; the cap (`VB_MAX_SUBJECTS`) must cover the whole
  cast (a dropped reference = an invented subject). The clip animates the keyframe, so keyframe identity
  = clip identity.
- **Never render readable text / letters / logos** in images.
- People default to **Western/European** looks; never default to Asian/Chinese. Exceptions only via an
  explicit character/reference image.
- Prefer **medium/wide shots**; avoid tight close-ups until lip-sync is solved.

## Code quality
- **No duplication.** Shared logic lives in ONE helper (config/env reads, storage paths,
  the progress event emitter). Never copy a block across the engine modules — extract it.
- **Reusable UI.** Build on the shared `renderer/components/ui.tsx` primitives (Button, Field, Card, …);
  don't re-implement inputs/buttons/modals per screen.

## Process
- Don't change models/behavior mid-generation without consent.
- Never harvest credentials from other projects/repos.
