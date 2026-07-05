# Roadmap

> Videoboom is an **open-source, local-only desktop app** — a song becomes a music video entirely on the
> user's own Apple Silicon Mac (an MLX Python sidecar): no accounts, no keys, no cloud. History: local-first
> prototype → AWS serverless SaaS (coins/Cognito/DynamoDB) → bring-your-own-key cloud desktop
> (OpenRouter/Replicate) → today's local-only build; every earlier stage was deleted (recoverable from git
> history).

## Done
- **Desktop app**: Electron shell (`src/main`, `src/preload`, `renderer/`) + an in-process TypeScript
  render engine (`src/engine/`); no accounts, no server, no keys.
- **On-device stack**: every stage runs locally through the MLX sidecar — STT (mlx-whisper), story/shot-list
  LLM (mlx-lm), keyframes (mflux FLUX + Kontext), image-to-video (mlx-video Wan 2.2), portrait caption +
  safety (mlx-vlm). Zero per-render cost, fully offline, nothing leaves the machine.
- **Render pipeline**: story from the actual lyrics → shot list → identity-preserving keyframes → per-scene
  video (on-device Wan 2.2, single start frame chained into one continuous shot) → beat-cut assemble, with
  tolerant failure handling.
- **Vocal-aligned editing**: on-device forced alignment (mlx-whisper) + frame-grid retiming; a vocal scene
  snaps to its first sung word.
- **Cast**: reusable characters from a photo and/or prompt; multi-subject scenes.
- **Per-scene refresh**, **preview-then-resume**, AI-tagged output metadata.
- **Engine in TS, models in a sidecar**: the render/orchestration engine is in-process TypeScript (async,
  never blocks the main process); heavy model inference runs in a resident Python MLX sidecar
  (`local/server.py`), reached over localhost HTTP.
- **Packaging**: `npm run dist` → `electron-builder` (macOS dmg is the shipped target; the config still
  carries the Windows/Linux targets that wait on the CUDA backend); ffmpeg bundled (`ffmpeg-static`) so end
  users need no toolchain.
- **CI/CD**: GitHub Actions — typecheck + unit tests + build and headless engine/smoke tests on all three
  OSes; on a `v*` tag a matrix build publishes the installers to GitHub Releases (v0.1.0 shipped).

## Next — local-only hardening (`LOCAL_PLAN.md`)
Running every stage on the user's own hardware is no longer a future idea — it's the **shipped**
architecture (see the Done list and `docs/MODELS.md` / `docs/LOCAL-MODELS.md`). What's left is hardening it,
and the detailed roadmap lives in [`LOCAL_PLAN.md`](../LOCAL_PLAN.md) — not duplicated here. Milestones:
- **M0** reconciliation groundwork + CI guard scripts.
- **M1** finish cutting the last cloud code (ordered commits C1–C6).
- **M2** sidecar contract v2 + MLX handler refactor.
- **M3** bootstrap + a **CUDA backend** (Windows / Linux, NVIDIA) so the app isn't Apple-only.
- **M4** model catalog + downloader + Model Manager UI.
- **M5** hardware detection / tiers / setup wizard / auto-config + a real-time ETA estimator.
- **M6** lockdown + cross-platform packaging.

## TODO — local i2v model options (researched 2026)
Shipped today: **Quality = Wan 2.2 I2V-A14B bf16-relay + Wan2.2-Lightning** (the open leader for cinematic
i2v with realistic people, fits 48GB via relay-shedding) and **Fast = FastWan-5B (DMD 3-step)** as the
draft/preview tier. LTX was tried and removed (LTX-2.3 22B is not lighter/faster than Wan-14B on Mac — the
"fast LTX" reputation is its CUDA distilled pipeline). Remaining ideas:
- **Watchlist — HunyuanVideo-1.5** (8.3B, Apache-2.0): lightest of the strong models, best motion/physics;
  add once a mature **native MLX** runner ships (only an MPS port of the original Hunyuan exists today).
- Not worth it on Mac: CogVideoX / Mochi / SVD / Wan2.2-Animate (obsolete or CUDA-only).
- The full cross-platform model/quant/tier plan (incl. CUDA backend and a model catalog) lives in
  `LOCAL_PLAN.md` (M0–M6).

## TODO — format presets (music video / ad-spot / …) instead of free-text style
Let the Create screen pick a **preconfigured format preset** rather than only typing a free style. Each
preset is a different *storyboard director* (it swaps the LLM's story-bible + shot-list prompting and the
pacing), not just a style string — so the same engine (Suno song + local pipeline + Kontext subject
placement) produces music videos OR ads/spots.
- **music-video** (today): narrative bible, lyric-synced shots, emotional arc, performer/scenes.
- **ad / product / spot**: the PRODUCT is the hero — benefit-driven shots, lifestyle context, hero/product
  close-ups, brand mood, punchier beat-synced cuts, and a closing CTA / logo moment. The "cast" generalises
  to a **product reference image** placed into scenes via the existing Kontext seam (same mechanism as a face).
- Future presets: news, shorts/vertical, animation/toon, trailer.
- Build: a `format` field on the project; branch `storyBible` + `shotListPrompt` (the SYS + rules in
  pipeline.ts) on it; a preset picker in Create (renderer); generalise cast → "subject" (person | product).
  ~90% of the infra already exists — the work is the per-format director prompts + UI + product framing.

## TODO — block re-triggering a generation that's already running
A render is already one-at-a-time in the backend (the main process refuses a second render / resume /
scene-regenerate while one is active, returning a clear error — no new job is created). Finish the UX:
- **Disable the action buttons** (Render, Finish full song, Regenerate scene, Create) while any generation
  is in progress — show a busy/disabled state so a second trigger can't even be attempted.
- If one is somehow triggered anyway, surface the backend's "a render is already in progress" error in the
  UI instead of silently doing nothing.

## Also next
- **Settings polish**: per-stage model picker (see `LOCAL_PLAN.md` M4/M5).
- **More i2v models**: expose alternative on-device image-to-video models cleanly (keep the local i2v path
  in `genVideoLocal()` model-agnostic).
- **Landing page**: GitHub Pages site (built; goes live once the repo is public).

## Parked / later
- Lip-sync (deferred — keep medium/wide shots until solved); seamless flow-chain between clips.
- Additional modes (news / shorts / animation).
- Auto-update for packaged builds.
