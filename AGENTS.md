# AGENTS.md — Videoboom working rules

Rules any agent (human or AI) MUST follow in this repo. Violations have caused real bugs.

## What this is
Videoboom is an **open-source, bring-your-own-key (BYOK) desktop app** that turns a song into a music
video on the user's own machine. An **Electron** shell (`src/main`, `src/preload`, `renderer/`) runs an
**in-process TypeScript render engine** (`src/engine/`); ffmpeg ships bundled (`ffmpeg-static`). The user
pastes their own provider keys; the app calls those providers directly and the user pays them at cost.
**No accounts, no server, no wallet, no Python, nothing leaves the machine** except the generation API
calls. Ships for Windows / macOS / Linux.

> History: this was once a local-first Mac app (Phase 0), then an AWS serverless SaaS (coins / Cognito /
> DynamoDB / Step Functions). Both are gone — that code was deleted (recoverable from git history).
> Anything mentioning coins, wallets, Cognito, DynamoDB, S3, Lambda, or CDK is **historical**.

## Docs
- **Keep docs in sync with the code.** Any change to the architecture, the render flow, the engine/IPC
  contract, key storage, providers, or env/config MUST update the matching doc in the SAME change —
  stale docs that claim the wrong behavior are treated as bugs.
- Current docs that MUST stay accurate (keep minimal + truthful): `README.md`, `AGENTS.md`,
  `docs/ARCHITECTURE.md`, `docs/FOLDER-STRUCTURE.md`, `docs/PROVIDERS.md`, `docs/ROADMAP.md`.
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

## Keys & privacy (BYOK)
- API keys are the **user's**. Stored **encrypted via the OS keychain** (Electron `safeStorage`) in the
  app's userData; decrypted only in-memory and injected into the render engine per operation as config
  (`VB_OPENROUTER_API_KEY`, `REPLICATE_API_TOKEN`, …, read via `src/engine/config.ts`). **Never log
  secrets**; never write them to the project store or to git. The gitignored `keys.json` must never be
  committed.
- Nothing is uploaded to a Videoboom server — there is none. The only network calls are to the provider
  APIs the user configured.

## Models are user-facing (the opposite of the old SaaS)
- This is BYOK: the user **chooses** the LLM / image / video models in **Settings**. Every model is a
  `VB_*_MODEL` env var with a sensible default. Naming models in the UI/docs is fine here. Do NOT
  re-introduce the old "hide the provider" stripping — that was a SaaS concern.

## Engine contract
- The engine runs **in-process** (`src/engine/`), driven by `runEngine(command, args, env, onEvent)`
  (`src/engine/index.ts`). It calls `onEvent` with progress events — `{event:'stage'|'keyframe'|'scene'|…}`
  then exactly one terminal `{event:'result'}` or `{event:'error'}`; the promise rejects on error. The
  main process forwards every event to the renderer on `sidecar:<opId>` (channel name kept for the UI
  contract). Same command set as before: `create-project`, `render` (`--preview`), `resume`,
  `regenerate-scene`, `character-create`, `character-portrait`, `get-project`.
- The engine is async throughout — it runs in the main process, so it must **never block the event loop**:
  ffmpeg runs as async child processes, model calls are `fetch`. No `spawnSync` on hot paths.
- State + media are **plain files** under `VB_DATA_DIR` (default the app's userData `data/`).
  `src/engine/storage.ts` is **local filesystem only** — do not reintroduce any cloud coupling.
- ffmpeg/ffprobe come from `ffmpeg-static` / `ffprobe-static`; packaged builds `asarUnpack` them and the
  engine rewrites `app.asar` → `app.asar.unpacked` in the binary path.

## Image / video generation
- **Video model = Kling** (`kwaivgi/kling-v3.0-std` for Fast, `-pro` for HD) via OpenRouter, first+last
  frame morph (duration {5,10}). Kling animates realistic adults, children, AND toon. Keep
  `genVideo()` model-agnostic so the user can swap in another i2v model from Settings.
- **Identity**: keyframes are built from the cast's reference portraits with a strong "reproduce every
  facial feature exactly, no blending/de-aging" prompt; the cap (`VB_MAX_SUBJECTS`) must cover the whole
  cast (a dropped reference = an invented subject). The clip animates the keyframe, so keyframe identity
  = clip identity.
- **Never render readable text / letters / logos** in images.
- People default to **Western/European** looks; never default to Asian/Chinese. Exceptions only via an
  explicit character/reference image.
- Prefer **medium/wide shots**; avoid tight close-ups until lip-sync is solved.

## Cost
- Track REAL provider cost in **cents** (`src/engine/cost.ts`, `costTotal()`); OpenRouter returns it in
  `usage.cost` (send `usage:{include:true}`). The user sees the **at-cost** number — there is no margin
  and no wallet. Record cost on success AND failure (partial cost on failed ops).

## Code quality
- **No duplication.** Shared logic lives in ONE helper (config/env reads, storage paths, cost accounting,
  the progress event emitter). Never copy a block across the engine modules — extract it.
- **Reusable UI.** Build on the shared `renderer/components/ui.tsx` primitives (Button, Field, Card, …);
  don't re-implement inputs/buttons/modals per screen.

## Process
- Don't change models/behavior mid-generation without consent.
- Never harvest credentials from other projects/repos.
