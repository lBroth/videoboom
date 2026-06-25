# Video Models with First+Last Frame Control & Face-Input Policy

**Project:** Videoboom — song-to-AI-music-video pipeline (Gemini keyframe → image-to-video with first_frame + last_frame for smooth scene morphs)
**Date:** 2026-06-21
**Author:** research agent

## Executive summary

The best drop-in alternative to Veo 3.1 on the **same OpenRouter video endpoint** is **`kwaivgi/kling-v3.0-pro`** (or the cheaper `kwaivgi/kling-v3.0-std`): it natively supports `first_frame` + `last_frame` keyframe interpolation, animates realistic human portraits as a headline feature, and is licensed for commercial use — switching is a one-line `model` change because OpenRouter's unified `frame_images` schema is identical to what Veo uses today. **No major hosted model truthfully advertises a *looser* policy on faces of minors than Veo** — every commercial provider (Kling, Seedance, Veo) restricts *recognizable real people* and applies heightened child-safety filtering; the practical difference is that Kling/Seedance reliably accept *AI-generated/fictional* faces (e.g. a Gemini-generated baby) that Veo's over-aggressive minor filter falsely rejects. The durable, filter-proof fix remains the **toon/stylized art direction** (animated character renders sail through every model's face filter), but the immediate switch is **Kling v3.0 Pro on OpenRouter as the primary, Seedance 2.0 / Wan 2.7 as fallbacks**.

---

## Comparison table

All "OpenRouter" rows are confirmed from the live API (`GET https://openrouter.ai/api/v1/videos/models`, fetched 2026-06-21). The `First+Last frame` column reflects the model's exact `supported_frame_images` array.

| Model | Route | First+Last frame | Accepts realistic face input? | Minors policy | Max res / length | ~Price (per sec) | Commercial OK? | Source |
|---|---|---|---|---|---|---|---|---|
| **Kling v3.0 Pro** `kwaivgi/kling-v3.0-pro` | OpenRouter | **YES** — `["first_frame","last_frame"]` | **Yes** — animating real portraits is a headline feature; blocks *recognizable real public figures* and NSFW | Heightened child-safety filter (stricter each version); accepts AI-generated child renders in practice | 720p / 3–15s | $0.112 (no audio) / $0.168 (audio) | Yes — commercial license | [1][2][9] |
| **Kling v3.0 Std** `kwaivgi/kling-v3.0-std` | OpenRouter | **YES** | Same as Pro | Same as Pro | 720p / 3–15s | $0.084 / $0.126 (audio) | Yes | [1][2] |
| **Kling Video O1** `kwaivgi/kling-video-o1` | OpenRouter | **YES** | Same as Kling family | Same | 720p / 5 or 10s | $0.112 | Yes | [1] |
| **Seedance 2.0** `bytedance/seedance-2.0` | OpenRouter | **YES** | **Partial** — refuses *recognizable real identifiable people*; passes AI renders, 3D characters, costumed/non-matching faces | No explicit minors policy published; same real-person refusal applies | 1080p / 4–15s | ~token-priced (`0.000007`/video-token) | Yes (check plan terms) | [1][8][12] |
| **Seedance 2.0 Fast** `bytedance/seedance-2.0-fast` | OpenRouter | **YES** | Same as Seedance 2.0 | Same | 720p / 4–15s | ~`0.0000056`/token | Yes | [1] |
| **Seedance 1.5 Pro** `bytedance/seedance-1-5-pro` | OpenRouter | **YES** | Same as Seedance family | Same | 1080p / 4–12s | ~`0.0000024`/token | Yes | [1] |
| **Wan 2.7** `alibaba/wan-2.7` | OpenRouter | **YES** — also exposes `last_image` passthrough | Yes — open-weights lineage (Wan FLF2V) is permissive; hosted endpoint adds moderation | No published minors carve-out | 1080p / 2–10s | $0.10 | Yes (Apache-2.0 open weights; hosted route commercial) | [1][6] |
| **Veo 3.1** `google/veo-3.1` | OpenRouter | **YES** | **Restrictive** — image-to-video filter falsely flags faces/minors; `personGeneration` passthrough (`allow_adult`/`allow_all`) | **Strictest** — blocks any anchor image read as a child, incl. Gemini-generated babies (the Videoboom problem) | 4K / 4,6,8s | $0.20–$0.40 (+4K) | Yes | [1][3][5] |
| **Veo 3.1 Fast** `google/veo-3.1-fast` | OpenRouter | **YES** | Same restrictive filter | Same | 4K / 4,6,8s | $0.08–$0.30 | Yes | [1] |
| **Veo 3.1 Lite** `google/veo-3.1-lite` | OpenRouter | **YES** | Same | Same | 1080p / 4,6,8s | $0.03–$0.08 | Yes | [1] |
| **Hailuo 2.3 (MiniMax)** `minimax/hailuo-2.3` | OpenRouter | **NO** — `["first_frame"]` only | Yes — strong character animation; standard real-person/NSFW limits | Standard | 1080p / 6 or 10s | ~$0.082 | Yes | [1] |
| **Wan 2.6** `alibaba/wan-2.6` | OpenRouter | **NO** — first_frame only | Yes | — | 1080p / 5 or 10s | $0.04–$0.15 | Yes | [1] |
| **Grok Imagine Video** `x-ai/grok-imagine-video` | OpenRouter | **NO** — first_frame only | Yes (xAI is permissive) | Standard | 720p / 1–15s | $0.05 (480p) / $0.07 (720p) | Yes | [1] |
| **Sora 2 Pro** `openai/sora-2-pro` | OpenRouter | **NO** — `supported_frame_images: null` (no frame conditioning) | Restrictive (OpenAI likeness rules) | Strict | 1080p / 4–20s | $0.30–$0.50 | Yes | [1] |
| **Runway Gen-4 / Gen-4 Turbo** | Direct (runwayml.com); Keyframes UI | **YES (keyframes)** — first + last frame, multi-keyframe (Gen-3+ feature) | Yes — industry-leading identity preservation on portraits | Standard | 1080p+ | plan-based | Yes — royalty-free on paid plans (free tier = no commercial rights) | [10] |
| **Luma Ray3 / Dream Machine** | Direct (lumalabs.ai) | **YES (keyframes)** — explicit Start Frame + End Frame interpolation | Yes | Standard | 1080p+ | plan-based | Yes | [7] |
| **Vidu Q1/Q3** | Direct (vidu.com) | **YES (start+end reference)** — start/end frame feature | Yes | Standard | 1080p | plan-based | Yes | [11] |
| **Pika (Pikaframes)** | Direct (pika.art) | **YES** — start/end + up to 5 keyframes, up to 25s | Yes | Standard | 1080p / up to 25s | plan-based | Yes | [7] |
| **Wan 2.1/2.2 FLF2V (open weights)** | Self-host / fal / Replicate / ComfyUI | **YES** — FLF2V = First-Last-Frame-to-Video, the model's core mode | **Yes — no upstream face filter when self-hosted** | None (self-hosted) | 720p (14B) | infra cost only | **Yes — Apache-2.0** | [6] |
| **Groq** | — | **N/A** | **N/A** | N/A | N/A | N/A | N/A — see verdict | [4] |

---

## Per-model notes (top 5 candidates)

### 1. Kling v3.0 Pro / Std — `kwaivgi/kling-v3.0-pro`, `kwaivgi/kling-v3.0-std` (PRIMARY RECOMMENDATION)
- **Frame control:** `supported_frame_images: ["first_frame","last_frame"]` — confirmed on the live OpenRouter API. Kling pioneered the start+end-frame UX; you can supply both frames, or only an end frame, and it interpolates the in-between. Identical request shape to current Veo path. [1][2]
- **Faces:** Kling's marketing *leads* with "upload a portrait and watch it breathe, blink, turn its head… faces stay sharp" and lip-sync — i.e. real portraits are the intended use, not a blocked one. It restricts **recognizable real public figures** and NSFW, and moderation tightens with each version, but it does **not** carry Veo's broken "this looks like a minor" false-positive on wholesome Gemini-generated characters. [9]
- **Minors:** heightened child-safety moderation exists (as with all providers) but is not the trip-wire Veo's is; AI-generated child/baby renders that read as wholesome generally pass.
- **Specs/price:** 720p, 3–15s, native audio. **$0.112/s** (no audio) or **$0.168/s** (with audio) Pro; Std is **$0.084 / $0.126**. Passthrough: `negative_prompt`, `cfg_scale`. [1]
- **Commercial:** Kling Standard image-to-video is under a commercial license permitting research + commercial use. [2]
- **Trade-off vs Veo:** capped at 720p (Veo offers 1080p/4K) and no aspect ratios beyond 16:9/9:16/1:1. For a music video, 720p is usually fine; upscale (e.g. SeedVR2 per the open-stack notes) if needed.

### 2. Seedance 2.0 — `bytedance/seedance-2.0` (FALLBACK A)
- **Frame control:** `["first_frame","last_frame"]` confirmed; ByteDance documents a dedicated First-Last-Frame-to-Video workflow. [1][8]
- **Faces — read carefully:** Seedance enforces a **hard upstream rule refusing reference images containing detectable *real, identifiable* human faces** (esp. public figures). BUT original illustrations, 3D/character renders, AI-generated fictional portraits, and costumed faces that don't match a specific real person **pass through**. So for Videoboom's AI-generated characters it generally works; for a real photo of a real person it may refuse. [8][12]
- **Minors:** no explicit published minors policy; the real-identifiable-person refusal is the governing rule.
- **Specs/price:** up to 1080p, 4–15s, audio. Token-priced (~`0.000007`/video-token). 1.5 Pro is cheaper (~`0.0000024`/token) and also first+last. [1]
- **Commercial:** allowed; verify plan terms (CapCut/Dreamina lineage permits commercial use). [12]

### 3. Wan 2.7 — `alibaba/wan-2.7` (FALLBACK B + open-weights escape hatch)
- **Frame control:** `["first_frame","last_frame"]` on the hosted OpenRouter route, **plus** a `last_image` passthrough param. The open-weights lineage is literally named **FLF2V (First-Last-Frame-to-Video)** — first+last is the model's native design. [1][6]
- **Faces:** the hosted Alibaba endpoint adds moderation, but the **open weights (Wan 2.1/2.2 FLF2V-14B, Apache-2.0) have no upstream face filter** when self-hosted on fal/Replicate/ComfyUI. This is the ultimate "accepts any face for legitimate content" option and the only fully license-clean, filter-free path. [6]
- **Specs/price:** hosted: 1080p, 2–10s, audio, **$0.10/s**. Self-host: infra cost only. [1]
- **Commercial:** Apache-2.0 — unambiguously commercial-OK for both weights and output. [6]

### 4. Runway Gen-4 (Keyframes) — direct API (FALLBACK, off OpenRouter)
- **Frame control:** Runway's Keyframes feature (Gen-3 onward, carried into Gen-4) supports first + last frame and intermediate keyframes. Not on OpenRouter's video endpoint — requires Runway's own API. [10]
- **Faces:** industry-leading identity preservation when animating portraits; standard real-person/likeness moderation.
- **Commercial:** royalty-free, you own copyright **on paid plans**; free tier grants **no** commercial rights — must be on Standard/Unlimited/Enterprise. [10]
- **Why fallback only:** separate integration + auth, plan-gated commercial rights.

### 5. Luma Ray3 / Pika Pikaframes / Vidu — direct APIs (keyframe specialists)
- **Luma Ray3:** explicit **Start Frame + End Frame** interpolation with spatial continuity across camera moves; commercial OK. Direct (lumalabs.ai), not on OpenRouter. [7]
- **Pika Pikaframes:** start/end images **plus up to 5 keyframes**, up to 25s at 1080p — the most flexible multi-keyframe transitions, ideal for music-video morph chains. Direct (pika.art). [7]
- **Vidu Q1/Q3:** start+end reference-frame feature; Q3 (Jan 2026) adds 16s native audio-video. Direct. [11]
- All accept realistic faces with standard moderation; all commercial-usable. Use only if you outgrow OpenRouter's unified endpoint and want richer multi-keyframe control.

---

## Groq video? — VERDICT: **NO**

**Groq does not offer any video generation.** Groq (the LPU inference company, *not* xAI's "Grok") is a fast-inference provider for **LLMs and Whisper speech-to-text only**. Its supported-models catalog covers text generation (Llama, DeepSeek, Gemma), reasoning, TTS, OCR/vision *understanding*, content moderation, and Whisper ASR — **no image or video *generation* endpoints exist.** [4]

> Caution: search engines conflate **Groq** with **Grok** (xAI). xAI's *Grok Imagine Video* **does** do video (and is on OpenRouter as `x-ai/grok-imagine-video`) — but it only supports a single `first_frame` (no last_frame), so it does **not** meet Videoboom's hard requirement. Do not confuse the two. [1]

Use Groq for what it's good at in this pipeline (fast LLM calls, Whisper transcription of the song); route all video generation through OpenRouter.

---

## Recommendation

### Switch primary model: Veo 3.1 → **Kling v3.0 Pro**
- **Exact OpenRouter model id:** `kwaivgi/kling-v3.0-pro` (cost-saver: `kwaivgi/kling-v3.0-std`).
- **Why:** it's the only hosted model that meets all three hard requirements *and* sits on the **same OpenRouter `frame_images` endpoint Videoboom already uses** — so the swap is a one-line `model` change, not a re-integration. It explicitly markets realistic-portrait animation and lacks Veo's broken minor-detection false-positive.
- **Caveat:** 720p cap and no published explicit "we allow X faces Veo blocks" guarantee — but in practice it animates the wholesome AI-generated characters Veo wrongly rejects.

### Add as fallbacks (cascade)
1. `kwaivgi/kling-v3.0-pro` (primary)
2. `bytedance/seedance-2.0` (first+last, 1080p; passes AI/fictional faces, refuses real identifiable people)
3. `alibaba/wan-2.7` (first+last, 1080p, $0.10/s) — and the **open-weights Wan FLF2V on fal/Replicate** when you need a *guaranteed no-face-filter* path for legitimate content.

### Integration notes — request shape is unchanged
Same endpoint, same `frame_images` schema as the current Veo path. Just change `model`:

```
POST https://openrouter.ai/api/v1/videos
{
  "model": "kwaivgi/kling-v3.0-pro",
  "prompt": "<scene description>",
  "frame_images": [
    { "type": "image_url", "image_url": { "url": "<scene N keyframe>" }, "frame_type": "first_frame" },
    { "type": "image_url", "image_url": { "url": "<scene N+1 keyframe>" }, "frame_type": "last_frame" }
  ],
  "resolution": "720p"
}
```
Async: the submit response returns a job id + polling URL; **poll `GET /api/v1/videos/{jobId}` until `status: completed`**, then download from `unsigned_urls`. [docs]
- Kling passthrough params available: `negative_prompt`, `cfg_scale`. Drop Veo-only params (`personGeneration`, `aspectRatio`) when not on a Veo model.
- For Seedance fallback, watch for upstream refusal on **real identifiable** faces; route real-person inputs to Kling or to self-hosted Wan FLF2V instead.

### The durable fix (per existing project memory): toon/stylized art direction
No commercial hosted model publishes a policy that is *more permissive on minors* than Veo — they all restrict recognizable real people and apply child-safety filtering. The only filter-proof guarantee is to keep characters **stylized/animated** (illustration / 3D render look). Stylized faces pass every model's filter including Veo's, Seedance explicitly whitelists "original illustrations / 3D character renders," and self-hosted Wan FLF2V has no filter at all. Treat Kling as the immediate unblock and the toon art direction as the structural one. This aligns with the existing "avoid close-ups until lip-sync" and open-video-stack memory notes.

---

## Sources

1. OpenRouter live video models API — `GET https://openrouter.ai/api/v1/videos/models` and `GET https://openrouter.ai/api/v1/models?output_modalities=video` (fetched 2026-06-21): exact `supported_frame_images`, resolutions, durations, pricing for all 14 hosted video models.
2. OpenRouter — Kling Video v3.0 Pro / Standard model pages: https://openrouter.ai/kwaivgi/kling-v3.0-pro , https://openrouter.ai/kwaivgi/kling-v3.0-std
3. Google AI Developers Forum — "Veo 3.1 image-to-video blocks wholesome commercial storyboard — child safety false positive": https://discuss.ai.google.dev/t/veo-3-1-image-to-video-blocks-wholesome-commercial-storyboard-child-safety-false-positive/131917
4. Groq supported models (LLM + Whisper only, no video gen): https://console.groq.com/docs/models
5. Google Veo 3.1 `personGeneration` (allow_adult/allow_all) + face/celebrity filter: https://ai.google.dev/gemini-api/docs/video and https://discuss.ai.google.dev/t/persongeneration-on-veo-3-1/107802
6. Wan 2.1/2.2 FLF2V (First-Last-Frame, Apache-2.0 open weights): https://huggingface.co/Wan-AI/Wan2.1-FLF2V-14B-720P and https://www.runcomfy.com/comfyui-workflows/wan-2-2-flf2v-first-last-frame-video-generation
7. Luma Ray3 keyframes (Start+End frame) & Pika Pikaframes (start/end + up to 5 keyframes): https://lumalabs.ai/news/ray3-modify , https://pikaais.com/pikaframes/
8. Seedance 2.0 first-last-frame workflow & real-face restriction: https://www.mindstudio.ai/blog/seedance-2-0-content-restrictions-workarounds
9. Kling image-to-video portrait animation (faces as intended use): https://kling.ai/feature/image-to-video
10. Runway Gen-4 keyframes + commercial rights (paid-plan): https://help.runwayml.com/hc/en-us/articles/34170748696595-Creating-with-Keyframes-on-Gen-3 and https://www.krea.ai/models/runway
11. Vidu Q1/Q3 start+end reference frames: (Vidu docs / DualView comparison) https://www.dualview.ai/blog/ai-tools/best-ai-video-models.html
12. Seedance global release — platforms, pricing, commercial use & restrictions: https://www.mindstudio.ai/blog/seedance-2-global-release-platforms-restrictions
- OpenRouter Video Generation guide (request schema, `frame_images`/`frame_type`, async polling): https://openrouter.ai/docs/guides/overview/multimodal/video-generation
