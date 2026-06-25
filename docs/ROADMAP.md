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

## Next
- **CI release builds**: GitHub Actions matrix (windows / macos / linux) running `npm run dist` so each
  OS's installer is built + published on tag (the bundled ffmpeg binary is per-OS).
- **Settings polish**: per-stage model picker + a "test key" button; show estimated cost before render.
- **More i2v models**: expose cheaper / alternative image-to-video models cleanly (keep `gen_video()`
  model-agnostic).

## Parked / later
- Lip-sync (deferred — keep medium/wide shots until solved); seamless flow-chain between clips.
- Additional modes (news / shorts / animation).
- Auto-update for packaged builds.
