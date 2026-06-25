# Providers

All generation is cloud (no on-device models), called **directly from the user's machine with the
user's own keys** (BYOK). Every model is a `VB_*_MODEL` env var with a default, and is **swappable from
Settings** — naming models here and in the UI is fine (this is BYOK, not a hosted service).

| Stage | Provider | Default model (env) | Notes |
|------|----------|---------------------|-------|
| Transcription / alignment | **Replicate** | WhisperX (`REPLICATE_API_TOKEN`) | forced-aligned word timestamps → vocal-locked editing |
| Story bible | OpenRouter | `anthropic/claude-sonnet-4.6` (`VB_STORY_MODEL`) | |
| Shot list / LLM | OpenRouter | `google/gemini-3.5-flash` (`VB_LLM_MODEL`) | structured output |
| Keyframes | OpenRouter | `google/gemini-3-pro-image` (`VB_KEYFRAME_MODEL`) | identity from cast refs; GPT image needs `input_fidelity:high` |
| Video clips | OpenRouter | `kwaivgi/kling-v3.0-std` / `-pro` (`VB_OR_VIDEO_MODEL`) | first+last-frame morph; std=Fast, pro=HD |
| Image moderation | OpenRouter (vision) | `google/gemini-3.5-flash` (`VB_MODERATION_MODEL`) | SAFE/UNSAFE on a downscaled upload; fail-open |

**Keys** (entered in Settings, encrypted via the OS keychain `safeStorage`, passed to the in-process
engine as config per op in `src/engine/config.ts` — never logged, never in git):

| Key | env | Needed |
|-----|-----|--------|
| OpenRouter | `VB_OPENROUTER_API_KEY` | **required** (LLM, keyframes, video, moderation) |
| Replicate | `REPLICATE_API_TOKEN` | **required** (WhisperX forced-aligned transcription) |

Two keys, both required: OpenRouter can't transcribe, so Replicate reads the lyrics + timing; everything
else runs through OpenRouter.

**Cost**: OpenRouter returns real `usage.cost` (we send `usage:{include:true}`) → cents. The app shows
that **at-cost** total (no margin, no wallet). The user pays the providers directly.
