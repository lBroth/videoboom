# Models

Every generation stage runs **on-device** (Apple Silicon / MLX) through a resident Python sidecar
(`local/server.py`, started on demand by `src/engine/sidecar.ts`). There are no cloud calls and no API
keys — the network is used only to download the model weights once. The TypeScript stage wrappers live in
`src/engine/stages.ts` and delegate to the `src/engine/local*.ts` modules.

| Stage | Model (default) | Wrapper | Notes |
|-------|-----------------|---------|-------|
| Transcription / timing (STT) | `whisper-large-v3-turbo` (mlx-whisper) | `localStt.ts` | per-word timestamps → vocal-locked editing; zero words = instrumental (proceeds) |
| Story bible + shot list (LLM) | Qwen3 (mlx-lm) | `localLlm.ts` | structured JSON output |
| Keyframes | FLUX schnell + FLUX Kontext (mflux) | `localKeyframe.ts` | no ref → schnell txt2img; cast ref → Kontext, identity-preserving |
| Video (image-to-video) | Wan 2.2 I2V-A14B (default) / TI2V-5B (mlx-video) | `localVideo.ts` | 14B fast = Lightning 4-step, hd = full-step; 480p, chained sub-clips per scene |
| Portrait caption + upload safety (VLM) | gemma-3 (mlx-vlm) | `localVlm.ts` | caption anchors identity; safety is fail-open |
| Interpolation | RIFE (ncnn) | sidecar `/interp` | de-judders the 14B's native 16fps onto the 24fps timeline |
| Upscale | Real-ESRGAN | sidecar `/upscale` | one 480p → 1080p pass over the assembled timeline |

## Provisioning

`bash local/setup.sh` (or **Settings → On-device → Download**, which runs `local/download.py`) fetches each
stage's weights into the Hugging Face cache. The Wan video model is additionally **converted** to a
quantized MLX model, and its path is recorded in `local/.model-path` — that marker is the readiness check
for the video stage. A render is gated until STT, LLM, keyframe, and video models are all present.

Video model + quality (`fast`/`hd`) are chosen in `src/main/settings.ts` and injected as `VB_*` env vars.
See `docs/LOCAL-MODELS.md` for the detailed model notes and the finish chain.
