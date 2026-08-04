# Videoboom DUAL_BACKEND_PLAN

Status: FINAL architecture plan, 2026-07-05. Base: branch `local-only-pivot` (clean, 12-commit local-only conversion). Owner: lead architect. This document defines the **reverse pivot** from local-only back to a **local-default hybrid**: cloud inference is re-added behind the same clean per-stage interface the local-only refactor produced, restored from the pre-pivot cloud stack at git `5125093~1`. It supersedes the four dual-backend draft designs (1: interface/config/auto-config, 2: cloud restoration, 3: pipeline unification, 4: UI/UX); every verifier blocker and major is resolved in-text or carried as an explicit open question in §10. The local cross-platform/tier/catalog/ETA content of `LOCAL_PLAN.md` still governs the *local path* — this plan only adds the cloud path and the dispatcher between them.

---

## 0. Summary

**End state.** One render pipeline (`src/engine/pipeline.ts`) that names no backend. Each of the five stages — **STT, LLM, VLM, KEYFRAME, VIDEO** (moderation rides VLM) — has a **cloud impl** and a **local impl** behind one interface, selected per-stage by a pure resolver. Cloud = OpenRouter (LLM story/shot-list, VLM caption/safety, keyframe image, moderation) + Kling-via-OpenRouter (video i2v) + Replicate (WhisperX forced alignment), all restored from `5125093~1` and refit to the interface. Local = the shipped MLX stack (Qwen3 / gemma-3 / FLUX+Kontext / Wan 2.2 / whisper). The renderer never decides a backend; it displays what the resolver resolved.

**The four hard invariants** (encoded at exactly one choke point — `pickBackend` in `src/main/autoconfig.ts`):

- **I1 — No key ⇒ local.** A stage whose provider has no key is *always* local. Checked first, un-overridable. STT's provider is Replicate; LLM/VLM/KEYFRAME/VIDEO's provider is OpenRouter.
- **I2 — Key ⇒ still local by default.** A present key never activates cloud on its own. Cloud runs only where the user explicitly pinned that stage to cloud, or set the master control to `prefer-cloud`. `auto`/`prefer-local` with a key present ⇒ still local (privacy-first).
- **I3 — Tier never enables cloud.** Hardware tier only selects *which local model/quant*. An unsupported-hardware machine with no key stays local (render blocked, UI nudges "add a key + opt in") — it is **never** silently sent to cloud.
- **I4 — Zero-key/local-only-build users lose nothing.** The just-shipped local-only build's users migrate to all-`auto` stages (which resolve all-local under I1/I2), keep every local knob (`sttLang`, `workers`, `localVideoModel`, `localQuality`, `localWanDir`), and every local-relevant UI control stays reachable without a key.

**The three structural rules that make "tutto uguale (più possibile)" true:**
1. `pipeline.ts` calls only `P.*` accessors from `stages.ts`; it holds **no** `if (backend==='cloud')` branch, **no** `VB_*_BACKEND` env read, **no** direct `genVideoLocal`/cloud import.
2. The two irreducible video divergences (Wan chains native sub-clips from a single start frame; Kling makes one clip/scene with a first+last morph) live **inside** each `renderScenes` impl, behind one signature — not in the pipeline (this is the blocker-fix against Design 3).
3. Everything else — segmentation profile, keyframe identity, frame-grid conform target, resolution normalization at concat, grade, cost — is **shared** or read off the resolved backend object.

---

## 1. The per-stage backend interface

### 1.0 File layout

```
src/engine/
  backends/
    types.ts        // the five stage interfaces + Stage/Backend types (NEW)
    registry.ts     // stageBackend() → impl object, for all five stages (NEW)
    sceneShared.ts  // backend-agnostic scene helpers shared by both video impls (NEW)
  cloud/            // restored from 5125093~1:src/engine/providers.ts, split per stage (NEW)
    http.ts  llm.ts  stt.ts  vlm.ts  keyframe.ts  video.ts
  localLlm.ts localStt.ts localVlm.ts localKeyframe.ts localVideo.ts  // KEPT as-is
  stages.ts         // dispatchers: bodies delegate to registry; signatures unchanged (EDIT)
  config.ts         // re-add stageBackend() (EDIT)
  cost.ts           // restored verbatim from 5125093~1 (NEW)
  ffmpeg.ts         // re-add fitToWindow from 5125093~1 (EDIT)
  pipeline.ts       // route video through P.video(); drop hardcoded-local (EDIT)
```

`check-no-cloud.sh`'s path-keyed allowlist is exactly `src/engine/cloud/**`, `src/engine/cost.ts`, `src/main/keychain.ts`, `src/shared/netAllowlist.ts` — every provider URL lives only there (§6).

### 1.1 `backends/types.ts` — the interfaces

Each method carries the *exact* signature the current `stages.ts` already exposes, so `pipeline.ts`'s call sites are untouched. There are **five** stages; moderation is a method on the VLM interface (same provider, same module — no sixth stage, no `VB_MODERATION_BACKEND`; resolves the Design-1 dead-var minor).

```ts
import type { Word, STTResult } from '../stages';
export type Backend = 'cloud' | 'local';
export type Stage = 'STT' | 'LLM' | 'VLM' | 'KEYFRAME' | 'VIDEO';   // moderation ⊂ VLM

export interface LlmBackend {
  // role tags the call so cloud picks VB_STORY_MODEL vs VB_LLM_MODEL; local ignores it (see §1.3).
  llmJson(system: string, user: string, schema: any,
          role: string | undefined, maxTokens: number, temperature: number): Promise<any | null>;
}
export interface SttBackend {
  // {ok:true,words:[]} = legitimate instrumental; {ok:false} = genuine failure. Same contract both sides.
  transcribeWords(audioPath: string): Promise<{ ok: boolean; words: Word[]; error?: string }>;
}
export interface VlmBackend {
  vlmCaption(imgPath: string): Promise<string>;
  moderateImage(path: string): Promise<[boolean, string[]]>;         // fails OPEN
}
export interface KeyframeBackend {
  keyframe(prompt: string, out: string, refs: [string, string][], toon: boolean): Promise<boolean>;
  concurrency(): number;   // local → workers() (GPU-serial); cloud → max(workers, VB_KF_WORKERS)
  needsGpu(): boolean;     // local → true; cloud → false (used by the GPU lock, §5/§7)
}
export interface VideoBackend {
  // ONE entry point owns the WHOLE keyframe+clip loop for these scenes (both continuity models).
  renderScenes(ctx: SceneRenderCtx): Promise<void>;
  // single-scene refresh (+ neighbour re-render for the cloud morph); used by regenerateScene.
  refreshScene(ctx: SceneRenderCtx, k: number, vary: string): Promise<[boolean, string]>;
  timelineRes(): { w: number; h: number };  // local 832×480 · cloud 1280×720 — drives VB_W/VB_H (§5, blocker-fix)
  needsUpscale(): boolean;                   // local → ESRGAN→1080 · cloud → light scale→1080
  needsGpu(): boolean;                       // local → true · cloud → false (GPU lock)
}
export interface SceneRenderCtx {
  pid: string; p: any; toRender: number[]; target: number;
  toon: boolean; emit: Emit; cancelled: Cancelled;
}
```

**Why `renderScenes` and not `renderScene` (Design-3 blocker fix).** Design 3 exposed a singular `renderScene(startImg, endImg, …)`, which forces the scene *loop* to stay in `pipeline.ts` and re-introduces the exact `if (seq) {…LOCAL…} else {…CLOUD…}` branch (with cloud-only `endImg`/`kf[k+1]` threading) that HARD CONSTRAINT #1 forbids. We adopt Design 1/2's `renderScenes(ctx)`: the entire keyframe pass + clip loop lives inside each impl. The pipeline calls one `await P.video().renderScenes(ctx)` with no `seq`/`parallel` branch, no `endImg` threading, no `LOCAL`/`CLOUD` comment. The sequential-chain vs parallel-morph split is the one irreducible divergence and it lives where it belongs — in the two impls.

### 1.2 `backends/registry.ts` — dispatch

```ts
import { stageBackend } from '../config';
import type * as T from './types';
export const stt = (): T.SttBackend =>
  stageBackend('STT') === 'cloud' ? require('../cloud/stt').cloudStt : require('./local/stt').localStt;
export const llm = (): T.LlmBackend =>
  stageBackend('LLM') === 'cloud' ? require('../cloud/llm').cloudLlm : require('./local/llm').localLlm;
export const vlm = (): T.VlmBackend =>
  stageBackend('VLM') === 'cloud' ? require('../cloud/vlm').cloudVlm : require('./local/vlm').localVlm;
export const keyframe = (): T.KeyframeBackend =>
  stageBackend('KEYFRAME') === 'cloud' ? require('../cloud/keyframe').cloudKeyframe : require('./local/keyframe').localKeyframe;
export const video = (): T.VideoBackend =>
  stageBackend('VIDEO') === 'cloud' ? require('../cloud/video').cloudVideo : require('./local/video').localVideo;
```

`local/*.ts` are thin adapters wrapping the existing `src/engine/local*.ts` (no file moves) into the interface shape; `require` (not top-level import) keeps a cloud-only render from loading the Python-driven local modules and vice-versa. `stageBackend` defaults to `'local'` (§2.1) so a missing env var never routes to cloud (defense-in-depth for I1–I3).

### 1.3 STT stage — instrumental-vs-failure is the whole game

- **Local** (`localStt.transcribeWordsLocal`, unchanged): already returns `{ ok, words, error? }` (`src/engine/localStt.ts:8`).
- **Cloud** (`cloud/stt.ts`, from `5125093~1:src/engine/providers.ts` private `transcribeWhisperx` ≈ :204 + public `transcribeWords` :254): the PRE code returned `null` for **both** a real failure and a zero-word instrumental (`if (!words.length) return null;`). **This must be reworked** (major fix): the cloud wrapper returns
  - `{ ok:false, error }` on **any** submit / poll-timeout / HTTP / status≠succeeded / missing-token failure, and
  - `{ ok:true, words:[] }` **only** for a genuinely empty *successful* transcript.

  Concretely: drop the `if (!words.length) return null` collapse; keep `toMp3_16k` + `data:audio/mpeg` inline + `version:VB_WHISPERX_VERSION` + `align_output:true` + 4 s poll / 300 s deadline + `costAdd(VB_WHISPERX_CENTS)`. The dispatcher `stages.transcribe` (unchanged shape, current `stages.ts:95`) wraps `{ok,words,error}` into `STTResult`, so `pipeline.ts:245-250`'s `if (!stt.ok)` behaves identically for both backends and an instrumental is never mistaken for a Replicate outage.

### 1.4 LLM stage — two models behind one call (major fix)

The current shared `storyBible` (`stages.ts:62-82`) passes `model=undefined` to `llmJson`. Pre-pivot, `storyBible` explicitly supplied `VB_STORY_MODEL` (`providers.ts:172-173`) so the narrative bible ran on `claude-sonnet` while the shot-list ran on `gemini-flash` (`VB_LLM_MODEL`, `providers.ts:89`). A cloud impl reading only `VB_LLM_MODEL` cannot tell the two calls apart. Fix: **thread a `role` tag** through the fourth positional arg (which currently is the vestigial `_model?`):

```ts
// stages.ts (dispatcher)
export async function llmJson(system, user, schema, role?: string, maxTokens = 4000, temperature = 0.7) {
  return R.llm().llmJson(system, user, schema, role, maxTokens, temperature);
}
// stages.ts storyBible — pass the tag instead of undefined:
return llmJson(system, user, BIBLE_SCHEMA, 'story', mt, 0.5);
// pipeline.ts shot-list call stays `P.llmJson(sys, user, SCENES_SCHEMA, undefined, …)` (→ shot-list model).
```

```ts
// cloud/llm.ts
llmJson(system, user, schema, role, mt, temp) {
  const model = role === 'story'
    ? env('VB_STORY_MODEL', 'anthropic/claude-sonnet-4.6')
    : env('VB_LLM_MODEL', 'google/gemini-3.5-flash');
  /* verbatim body from providers.ts:84-116: response_format json_schema, 3× retry, <think> strip,
     brace-slice fallback, costAdd(orCost(r)) */
}
```

`local/llm.ts` ignores `role` and calls `llmJsonLocal(system, user, schema, mt, temp)` (`localLlm.ts:27`). `llmComplete` (`providers.ts:56`) is restored into `cloud/llm.ts` for parity though the pipeline never calls it.

### 1.5 VLM + moderation stage

`cloud/vlm.ts` = `vlmCaption` (`providers.ts:332`) + `moderateImage` (`providers.ts:359`, fails OPEN, `moderationUri` downscale — `ffmpeg.moderationUri` still present at `ffmpeg.ts:87`). `moderateImage` keys off `stageBackend('VLM')` — no separate MODERATION stage. `local/vlm.ts` wraps `vlmCaptionLocal` / `moderateImageLocal` (`localVlm.ts:20,33`).

### 1.6 KEYFRAME stage

`cloud/keyframe.ts` = `cloudKeyframe` (`providers.ts:277`), signature already interface-shaped: no-text/no-Asian clause, `TOON_STYLE` (imported from `stages.ts`, not duplicated), refs inlined as `image_url`, `modalities:['image','text']`, `input_fidelity:high` for gpt models, 4× retry. `concurrency()` = `Math.max(workers(), envInt('VB_KF_WORKERS', 4))` (network-parallel) for cloud, `workers()` (GPU-serial) for local — this is the single home of the pre-pivot `kfWorkers` one-liner (`5125093~1:pipeline.ts:43`). `needsGpu()` = local-only.

### 1.7 VIDEO stage — the irreducible pair, both loops inside the impl

Both impls import shared helpers from `backends/sceneShared.ts`: `buildKeyframe`, `keyframePath`, `refsForScene`, `decideCutContinue`, `keyframePassOrdered`, `finishClip` (conform + first-frame-thumbnail + scene status/emit — the tail of today's `renderClip`, `pipeline.ts:446-459`), `assemble`. Only the loop shape and the generate call differ.

- **`local/video.ts` `localVideo.renderScenes(ctx)`** = today's `renderScenesLocalChained` (`pipeline.ts:465-513`) moved verbatim: `decideCutContinue` (LLM cut/continue + anti-drift `VB_LOCAL_CHAIN_MAX` cap), keyframes for **cut** scenes only via `keyframePassOrdered(concurrency=P.keyframe().concurrency())`, then a **sequential** clip loop where a `continue` scene starts from the previous clip's real last frame. Per-clip generation is today's `renderLocalScene` (`pipeline.ts:393-422`): chain `ceil(wdur / nativeSec)` native sub-clips, each `genVideoLocal` i2v from the prior clip's `lastFrame`, `concatClips`, then `finishClip` → `trimToWindow`. RIFE 2× stays inside `genVideoLocal` (invisible). `timelineRes()` = `{832,480}`, `needsUpscale()` = true, `needsGpu()` = true. `endImg` does not exist here (Wan takes a single start frame).
- **`cloud/video.ts` `cloudVideo.renderScenes(ctx)`** = the pre-pivot standard path (`5125093~1:pipeline.ts:584-608`): one keyframe **per** scene, ordered pass at `concurrency=P.keyframe().concurrency()`, then a **`mapPool(renderable, workers())` parallel** clip pass where each scene calls `genVideo(kf[k], prompt, raw, wdur, kf[k+1] ?? null, p.videoModel ?? null, seed)` (`providers.ts:414`) — the `kf[k+1]` first+last morph and the per-project `p.videoModel` slug override (`5125093~1:pipeline.ts:437`, minor fix), then `finishClip` → `fitToWindow`. `timelineRes()` = `{1280,720}`, `needsUpscale()` = false, `needsGpu()` = false.

`finishClip` picks trim-vs-fit from the same `VideoBackend` object (`raw ≥ window ? trim : fit`) — both target the identical telescoping frame grid `round(end·fps) − round(start·fps)`; only cut-vs-retime differs. `conformClip` (`ffmpeg.ts:136`, shared, unchanged) scale-fits+pads every clip to the current `vW×vH` timeline at concat, so a project rendered under one backend concatenates cleanly.

**`refreshScene` (regenerateScene major fix).** `regenerateScene` (`pipeline.ts:666`) is a separate single-scene call site; the video interface owns it so the cloud morph survives. `localVideo.refreshScene(ctx, k, vary)`: fresh keyframe → `renderClip(start=kf, end=null)`. `cloudVideo.refreshScene(ctx, k, vary)`: fresh keyframe `fk` → compute `lastK = keyframe(k+1)` → `renderClip(k, fk, lastK)`, then re-render neighbour `k-1` with `fk` as **its** `last_frame` (restores `5125093~1:pipeline.ts:710-716`), so both scene boundaries morph correctly. `rerenderClips` (`pipeline.ts:642`) resets done scenes to pending and calls `renderScenes` — already backend-neutral, no special casing.

---

## 2. Config & settings — v2 → v3

**One schema for all four artifacts** (blocker fix: Designs 1/2/4 forked three shapes). We adopt the **nested `mode`/`backend`** shape (the master audit's pick: it cleanly separates "follow the master control" from an explicit pin and matches the tri-state UI) with **UPPERCASE stage-id keys** (Design 2's casing — the audit-confirmed correct one: `localModels.STAGE_REPOS`, `modelStatus()`, `DL_STAGES`, and the `VB_<STAGE>_BACKEND` env names are all uppercase; Design 4's lowercase would miss every `modelsStatus()` lookup). Cloud slugs use the **long git names** (`storyModel`…) required-and-seeded-from-DEFAULTS so `toEnv` always emits.

### 2.1 `config.ts` — re-add `stageBackend` (default local)

```ts
export function stageBackend(stage: string, d = 'local'): 'cloud' | 'local' {
  return env('VB_' + stage + '_BACKEND', d) === 'cloud' ? 'cloud' : 'local';
}
```

Default flips from the pre-pivot `'cloud'` to `'local'`. The resolver always emits an explicit `VB_<STAGE>_BACKEND`, so this default is only a failsafe — and the failsafe is local.

### 2.2 `src/main/settings.ts` — v3 schema (SETTINGS_VERSION = 3)

```ts
export type Stage = 'STT' | 'LLM' | 'VLM' | 'KEYFRAME' | 'VIDEO';
export type Backend = 'cloud' | 'local';
export interface StageSelection { mode: 'auto' | 'manual'; backend?: Backend; }  // backend only when mode:'manual'
export interface CloudModels {
  storyModel: string; llmModel: string; keyframeModel: string;
  videoModel: string; vlmModel: string; moderationModel: string;
}
export interface Settings {
  settingsVersion: number;                                        // 3
  backendPreference: 'auto' | 'prefer-local' | 'prefer-cloud';    // master control
  stages: Record<Stage, StageSelection>;                          // per-stage auto/pin
  cloud: CloudModels;                                             // OpenRouter/Replicate slugs (advanced)
  // ── preserved v2 local knobs (unchanged, still emitted for local-resolved stages) ──
  sttLang: string; workers: number;
  localVideoModel: '5b' | '14b'; localQuality: 'fast' | 'hd'; localWanDir: string;
}
export const DEFAULTS: Settings = {
  settingsVersion: 3,
  backendPreference: 'auto',
  stages: { STT:{mode:'auto'}, LLM:{mode:'auto'}, VLM:{mode:'auto'}, KEYFRAME:{mode:'auto'}, VIDEO:{mode:'auto'} },
  cloud: {
    storyModel: 'anthropic/claude-sonnet-4.6', llmModel: 'google/gemini-3.5-flash',
    keyframeModel: 'google/gemini-3.1-flash-image', videoModel: 'kwaivgi/kling-v3.0-std',
    vlmModel: 'google/gemma-3-12b-it', moderationModel: 'google/gemini-3.5-flash',
  },
  sttLang: '', workers: 4, localVideoModel: '14b', localQuality: 'fast', localWanDir: '',
};
```

### 2.3 Migration (I4 — the shipped local-only build stays byte-for-byte local)

`migrate(raw)` handles v2 (local-only, current), v1 (pre-pivot flat cloud), and unknown blobs:

```ts
function migrate(raw: any): Settings {
  const str = (x:any, d:string) => typeof x === 'string' && x ? x : d;
  const sel = (b:any): StageSelection => (b === 'local' ? {mode:'manual', backend:'local'} : {mode:'auto'});
  return {
    settingsVersion: 3,
    // v2 has no backendPreference → 'auto'. v1 may carry it; else 'auto'.
    backendPreference: raw?.backendPreference === 'prefer-local' || raw?.backendPreference === 'prefer-cloud'
      ? raw.backendPreference : 'auto',
    stages: {
      // v1 flat fields (sttBackend/…) → 'local' becomes a manual pin; 'cloud'/absent → 'auto'
      // (NOT a cloud pin — that would violate I2; the user re-opts-in explicitly after migrating).
      STT: raw?.stages?.STT ?? sel(raw?.sttBackend),
      LLM: raw?.stages?.LLM ?? sel(raw?.llmBackend),
      VLM: raw?.stages?.VLM ?? sel(raw?.vlmBackend),
      KEYFRAME: raw?.stages?.KEYFRAME ?? sel(raw?.keyframeBackend),
      VIDEO: raw?.stages?.VIDEO ?? sel(raw?.videoBackend),
    },
    cloud: {
      storyModel: str(raw?.cloud?.storyModel ?? raw?.storyModel, DEFAULTS.cloud.storyModel),
      llmModel: str(raw?.cloud?.llmModel ?? raw?.llmModel, DEFAULTS.cloud.llmModel),
      keyframeModel: str(raw?.cloud?.keyframeModel ?? raw?.keyframeModel, DEFAULTS.cloud.keyframeModel),
      videoModel: str(raw?.cloud?.videoModel ?? raw?.videoModel, DEFAULTS.cloud.videoModel),
      vlmModel: str(raw?.cloud?.vlmModel ?? raw?.vlmModel, DEFAULTS.cloud.vlmModel),
      moderationModel: str(raw?.cloud?.moderationModel ?? raw?.moderationModel, DEFAULTS.cloud.moderationModel),
    },
    // ── PRESERVED v2 local fields, verbatim (I4) ──
    sttLang: str(raw?.sttLang, ''),
    workers: Number.isFinite(raw?.workers) ? Number(raw.workers) : 4,
    localVideoModel: raw?.localVideoModel === '5b' ? '5b' : '14b',   // 'ltx' legacy → '14b'
    localQuality: raw?.localQuality === 'hd' ? 'hd' : 'fast',
    localWanDir: str(raw?.localWanDir, ''),
  };
}
```

The existing persist-on-version-bump in `getSettings` (`settings.ts:59-65`) is kept: a v2 blob rewrites once at v3 with all-`auto` stages. Because a v2 user has **no `keys.json`**, the resolver forces every `auto` stage local (I1) — a byte-for-byte continuation of today's render.

### 2.4 `settingsEnv()` → `resolveConfig(...).toEnv()`

`main/index.ts`'s `sidecarEnv()` (currently `{...settingsEnv()}`, `index.ts:66-68`) becomes `{...keysEnv(), ...resolveConfig(caps, getSettings(), keyStatus()).toEnv()}`. `keysEnv()` (restored keychain) supplies `VB_OPENROUTER_API_KEY` / `REPLICATE_API_TOKEN`; `toEnv()` supplies the resolved backends + slugs + local block. `renderer/vb.d.ts`'s `Settings` mirrors §2.2 in lockstep.

---

## 3. The auto-config resolver — `src/main/autoconfig.ts`

Pure function, no IO — key state and hardware capability are passed as data so the estimator sees the same resolution the render will use.

```ts
export interface KeyState { openrouter: boolean; replicate: boolean; }
export interface ResolvedStage { backend: Backend; reason: 'no-key'|'pinned'|'preference'|'default'; localAvailable: boolean; }
export interface ResolvedConfig { stages: Record<Stage, ResolvedStage>; toEnv(): Record<string, string>; }

const PROVIDER: Record<Stage, keyof KeyState> = {
  STT:'replicate', LLM:'openrouter', VLM:'openrouter', KEYFRAME:'openrouter', VIDEO:'openrouter',
};

function pickBackend(stage: Stage, sel: StageSelection, master: string, keys: KeyState): {backend: Backend; reason: ResolvedStage['reason']} {
  if (!keys[PROVIDER[stage]]) return { backend:'local', reason:'no-key' };  // I1 — hard, first, un-overridable
  if (sel.mode === 'manual') return { backend: sel.backend ?? 'local', reason:'pinned' };
  // mode:'auto' → follow master. TIER IS ABSENT HERE (I3): tier can never flip a stage to cloud.
  if (master === 'prefer-cloud') return { backend:'cloud', reason:'preference' };  // global opt-in + key
  return { backend:'local', reason:'default' };                                    // auto / prefer-local → local (I2)
}
```

**Tier's role (initial scope + M5 dependency, resolving the "resolver depends on non-existent infra" major).** Phase-(a) backend selection above depends on **only** `keyState` + `settings` — both exist today, so the hybrid dispatcher ships **now**. Tier appears **only** in phase-(b): choosing the local variant (`modelId@quant`, `WxH`, `frames`, `steps`, offload) for stages that resolved local. Phase-(b) initially reads the **existing binary** signal — `localCapabilities()` (`localModels.ts:70`, `supported`/`reason`) plus the shipped `localVideoModel`/`localQuality` settings — and emits today's `VB_LOCAL_*` block unchanged. Tier-aware variant selection is a **follow-on gated on LOCAL_PLAN M5** (`hardware.ts` / `tiers.ts` / `DeviceProfile`); until then `resolveConfig`'s third argument is `LocalCapabilities`, later widened to `DeviceProfile`. No design step assumes M5 infra for the backend decision.

**Unsupported-local + partial-key hard-block (major fix).** When a stage resolves **local** but its local model is absent/unrunnable on this machine, `ResolvedStage.localAvailable=false`. `guardRender` (§5) then blocks the render and the UI names the **specific missing provider key per blocked stage** — e.g. a machine that can't run local, with only an OpenRouter key: LLM/VLM/KEYFRAME/VIDEO resolve cloud, but STT resolves local (no Replicate key) and is unavailable ⇒ "STT needs a Replicate key on this machine (on-device STT isn't supported here)." STT is independently gateable on Replicate in the onboarding CTA (§7).

### 3.1 `toEnv()` — the Settings→engine bridge

Per stage, emit `VB_STT_BACKEND / VB_LLM_BACKEND / VB_VLM_BACKEND / VB_KEYFRAME_BACKEND / VB_VIDEO_BACKEND` from `stages[X].backend` (five vars, no `VB_MODERATION_BACKEND`). Always emit the six cloud slugs (`VB_STORY_MODEL, VB_LLM_MODEL, VB_KEYFRAME_MODEL, VB_OR_VIDEO_MODEL, VB_VLM_MODEL, VB_MODERATION_MODEL`). Emit the **timeline resolution** from the resolved VIDEO backend (blocker fix): `VB_W/VB_H = 1280/720` when `VIDEO==='cloud'`, else `832/480`; matching `VB_LOCAL_KEYFRAME_W/H` only when KEYFRAME is local. Emit the `VB_LOCAL_*` block (model/quality/steps/wan-dir) only for local-resolved stages. Force `VB_WORKERS='1'` **only when `VIDEO==='local'`** (the GPU serialization); an all-cloud render keeps `workers`.

### 3.2 Decision table (mode × key × master × tier)

| # | Provider key | Stage `mode`/`backend` | Master | Local runnable? | → Backend | Reason / invariant |
|---|---|---|---|---|---|---|
| 1 | absent | any | any | yes | **local** | I1 |
| 2 | absent | manual/cloud | prefer-cloud | yes | **local** | I1 beats pin + master |
| 3 | absent | any | any | **no** | **local → render BLOCKED**, UI: "add {provider} key" | I1 + I3 (never silent cloud) |
| 4 | present | auto | auto | yes | **local** | I2 (privacy-first default) |
| 5 | present | auto | prefer-local | yes | **local** | I2 |
| 6 | present | auto | prefer-cloud | — | **cloud** | global opt-in + key (I3-allowed) |
| 7 | present | manual/cloud | auto | — | **cloud** | explicit per-stage opt-in |
| 8 | present | manual/local | prefer-cloud | yes | **local** | pin beats master |
| 9 | present | manual/local | any | **no** | **local → BLOCKED**, UI: "unsupported here — pin cloud" | I3 |
| 10 | present | auto | auto | **no** | **local → BLOCKED**, UI: "add a key + opt in / pin cloud" | I3 — never silent cloud |

Fresh install, no keys → rows 1/3 → all-local, offline. Add an OpenRouter key, change nothing → rows 4/5 → still fully local. The only routes to cloud are an explicit per-stage pin (7) or a deliberate `prefer-cloud` master with a key (6). The `(auto × key-present × unsupported-tier)` cell resolves **local-then-blocked** (row 10), never cloud — this is the exact ambiguous cell the audit flagged; I3 wins, no `tier-fallback` reason exists.

---

## 4. Cloud restoration — which `5125093~1` code lands where

| Concern | Restore from `5125093~1` | Lands at | Refit |
|---|---|---|---|
| Shared HTTP plumbing | top of `providers.ts` (`OR`, `orHdr`, `httpJson`, `dataUri`, `sleep`, `HttpErr`) | `src/engine/cloud/http.ts` | extract verbatim |
| LLM (+ story/shot-list split) | `llmComplete` :56, `llmJson` :84 | `cloud/llm.ts` | `role` tag → `VB_STORY_MODEL`/`VB_LLM_MODEL` (§1.4) |
| STT | `transcribeWhisperx` ≈:204, `transcribeWords` :254 | `cloud/stt.ts` | return `{ok,words,error}`, split failure vs instrumental (§1.3) |
| VLM + moderation | `vlmCaption` :332, `moderateImage` :359 | `cloud/vlm.ts` | verbatim; import `TOON_STYLE`/`isContentBlock` from `stages.ts` |
| KEYFRAME | `cloudKeyframe` :277 | `cloud/keyframe.ts` | verbatim + `concurrency()`/`needsGpu()` |
| VIDEO (Kling) | `genVideo` :414 | `cloud/video.ts` | wrapped in `renderScenes`/`refreshScene` loop + `p.videoModel` override |
| `MOTION`, `isContentBlock`, `TOON_STYLE`, schemas | already in current `stages.ts` | — | keep the shared copies; delete provider duplicates |
| Cost tracking | `cost.ts` (`costReset/costAdd/costTotal/orCost`) | `src/engine/cost.ts` | restore verbatim |
| Keychain (2-key `ENV_MAP`) | `keychain.ts` | `src/main/keychain.ts` | restore verbatim |
| Keys IPC (`keys:status`/`keys:set`) | `main/index.ts` + `preload/index.ts` | same | restore |
| `fitToWindow` | `ffmpeg.ts:128` | re-add to current `ffmpeg.ts` | verbatim (`trimToWindow`/`conformClip`/`toMp3_16k`/`moderationUri` already present) |

**Keychain wiring.** Restore `keychain.ts` verbatim; **remove** the boot-time `keys.json` deletion (`main/index.ts:263`) — the keychain owns that file again. `keysEnv()` returns `{}` when no keys exist, so a keyless user injects zero secrets.

**Cost wiring (minor fix).** Call `costReset()` once per op in `engine/index.ts` `runEngine` (right after `setEnv(...)`, `index.ts:110`) — the pivot deleted the old call site, so without this the module-level cents accumulate across renders. Add `costCents` to the engine's `EngineEvent` `'done'` variant (`engine/index.ts:15`) **and** the renderer `SidecarEvent` (`vb.d.ts:29-33`); `assemble` emits `costCents: costTotal()` on `done` (`pipeline.ts:854`). An all-local render ends at `0`.

---

## 5. Pipeline unification — `pipeline.ts` names no backend

**Grounding correction (major fix).** The current `pipeline.ts` has **zero** `VB_VIDEO_BACKEND` reads — the pivot removed all backend branching. The video path is **hardcoded-local**: `import { genVideoLocal, localNativeFps, localMaxFrames } from './localVideo'` (`:27`), `renderLocalScene` (`:393`/called `:439`), `trimToWindow` (`:448`), the `VB_LOCAL_CHAIN` split into `renderScenesLocalChained` (`:548-549`), and the `VB_LOCAL_UPSCALE` gate in `assemble` (`:788`). The transform is **hardcoded-local → resolver-bound `P.video()`** — not "delete env branches."

Edits:

1. **Imports (`:25-27`).** Drop the direct `genVideoLocal, localNativeFps, localMaxFrames` import (they move into `local/video.ts`). Drop `trimToWindow` (now chosen by `finishClip` inside the impl); keep `conformClip`, `FPS`, etc.
2. **`stages.ts` gains `export const video = () => R.video()`** and `export const keyframeConcurrency = () => R.keyframe().concurrency()`.
3. **Segmentation (`:255-260`).** Segmentation profile is **unified** across backends — both use the current `{target:6, max:12, min:3}` (Kling's 3–15 s window comfortably contains a 6 s target; Wan already chains at 6 s). So `segmentSong` is called with the shared profile; `storyboardHash` stays **audio-only** (`audioFingerprint`, `:343`/`:613`) and STT + bible + shot-list remain byte-identical across backends and fully cached across a backend switch (this dissolves the "fold VIDEO into storyboardHash over-invalidates" minor — nothing folds in).
4. **The scene loop (`:529-590`, `:465-513`).** Both `renderScenes` and `renderScenesLocalChained` move **out** of `pipeline.ts` into the two video impls (§1.7). `pipeline.render`/`resume`/`rerenderClips` build a `SceneRenderCtx` and call `await P.video().renderScenes(ctx)`, then the shared `assemble`. `regenerateScene` (`:666`) calls `await P.video().refreshScene(ctx, k, vary)`. The keyframe pool width comes from `P.keyframeConcurrency()`, not `workers()`.
5. **`assemble` finish (`:788`, minor fix).** `if (envBool('VB_LOCAL_UPSCALE', true))` → `if (P.video().needsUpscale())`. Local → ESRGAN sidecar → 1080. Cloud → a light ffmpeg lanczos scale → 1080 (no sidecar), so a paid Kling render finishes at **1080p from a 720p base**, not the 432p collapse the audit found. `grade` + `conformClip` stay shared and unchanged. `costCents` added to the `done` emit.
6. **Mixed-backend timeline (major fix — invalidate, don't mix).** Record `clipsBackend` (resolved VIDEO backend + `timelineRes` signature) on the project when clips render. On render, if the current resolved VIDEO signature ≠ `clipsBackend`, reset every `done` scene to `pending` before `renderScenes` so the whole timeline re-renders under **one** backend at **one** resolution — no 432p-local-next-to-720p-cloud concat, no single global `needsUpscale` applied to the wrong clips. Because segProfile is unified (step 3), scene windows are stable across the switch and the storyboard is fully reused; only clips + finish re-run. The UI confirms "switching the video backend re-renders all clips."

**Divergence ledger (what's unified vs declared-per-backend-hint):**

| Divergence | Decision | Where |
|---|---|---|
| Scene→clip mapping (Kling 1 clip / Wan `ceil(wdur/2.3)` sub-clips) | **irreducible — hidden** | inside each `renderScenes` |
| Continuity (sequential chain / parallel keyframe-morph) | **irreducible — hidden** | each `renderScenes` loop |
| i2v conditioning (Wan single start frame / Kling first+last morph) | **irreducible — hidden** | `renderClip`/`genVideo` call, `endImg` cloud-only, internal |
| Segmentation profile | **UNIFIED** to `{6,12,3}` | shared `segmentSong` call |
| Keyframe identity (refs, anchor, toon, non-empty contract) | **UNIFIED** (byte-identical) | shared `buildKeyframe` |
| Keyframe concurrency (GPU-serial / network-parallel) | **declared, off KEYFRAME backend** | `P.keyframe().concurrency()` |
| Frame-grid conform (trim / fit) | **declared, same grid** | `finishClip` reads the video backend |
| Timeline resolution | **declared** (832×480 / 1280×720) | `timelineRes()` → `VB_W/VB_H` |
| Concat normalization | **UNIFIED** | `conformClip`, unchanged |
| fps → 24; RIFE interp | **local-only compensation, hidden** | inside `genVideoLocal` |
| Upscale → 1080 | **declared finish** | `needsUpscale()` (both reach 1080) |
| Grade (film-grade + grain) | **UNIFIED, both backends** | `assemble`, unchanged |
| STT quality (WhisperX > mlx-whisper) | **irreducible; result type + instrumental policy unified** | `STTResult` |
| Cost | **additive, 0 for local** | `cost.ts` |

---

## 6. Network policy for the hybrid (build now, not deferred to M6)

The three artifacts the LOCAL_PLAN M6 lockdown described as "modify" **do not exist yet** and are **created** as part of cloud restoration (minor fix — without them, I3 is enforced only by a bug-free resolver, with no deny-by-default backstop and no CI grep once provider URLs return):

**`src/shared/netAllowlist.ts` (new).** Single source of truth, per-provider, consumed by the Electron `session` firewall and `check-no-cloud.sh`:

```ts
export const CLOUD_HOSTS = {
  openrouter: ['openrouter.ai'],                                              // LLM, VLM, keyframe, moderation, Kling
  replicate:  ['api.replicate.com', 'replicate.delivery', '*.replicate.delivery'],  // WhisperX submit/poll + result
};
```

**Policy (three rules):**
1. **Local stages never touch the network.** Local inference keeps `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` on its children; the cloud dispatcher runs in-process (main/`cloud/http.ts`), never a child, and those offline vars are never set for it.
2. **Cloud stages talk only to their provider host, only when opted in.** The main-process `session.webRequest.onBeforeRequest` firewall denies by default and allows a host **only if** (a) it is in `CLOUD_HOSTS[provider]`, (b) `keyStatus()[provider]` is true, **and** (c) at least one stage resolved to that provider's cloud backend. Model-download / bootstrap hosts remain the separate LOCAL_PLAN §3.4 download-time allowlist.
3. **No key ⇒ zero inference network.** `keysEnv()` returns `{}` and the resolver forces every stage local (I1), so no cloud host is ever contacted.

**Enforcement + tests:**
- **`scripts/check-no-cloud.sh` (created, inverted, path-keyed).** Assert `https?://` appears **nowhere outside** the allowlist (`src/engine/cloud/**`, `cost.ts`, `keychain.ts`, `netAllowlist.ts`) — i.e. `src/engine/local*.ts`, `pipeline.ts`, `stages.ts` are URL-free — and every host string in `cloud/**` is present in `netAllowlist.ts`.
- **`test/no-cloud-without-optin.test.ts` (new unit test, runs under `npm test`).** `resolveConfig(caps, settings, {openrouter:false, replicate:false})` across all masters ⇒ every stage `backend:'local'`. Keys present but all stages `mode:'auto'` ⇒ still all-local (auto never self-selects cloud — I2). Cloud only for explicit `manual/cloud` or `prefer-cloud`+key.
- **Firewall integration smoke:** a local-only render against a request-blocking mock session asserts zero attempted outbound requests.

---

## 7. UI/UX — Settings, keys, cost, wizard

All in `renderer/App.tsx` unless noted; types in `renderer/vb.d.ts`.

**Posture line (top of Settings):** *"Videoboom runs on your Mac by default — private, no key, no cost. Add a key only to unlock cloud where you want it."* Every cloud affordance is opt-in, gated, visually secondary.

**Card order:** Backend mode → Stages → On-device (Hardware) → API keys → Advanced. Keys sit **below** stages — the optional unlock, not the entry ticket.

- **`BackendModeControl`** (master): 3-segment control bound to `settings.backendPreference` — `Auto · Prefer local · Prefer cloud`. `Auto`/`Prefer local` resolve every `auto` stage local; `Prefer cloud` resolves `auto` stages cloud **only where a provider key exists**. Selecting `Prefer cloud` with no key shows an inline amber note: *"No keys yet — everything still runs locally."*
- **`StageBackendRow` over `STAGE_ROWS` (five rows, UPPERCASE ids `STT/LLM/VLM/KEYFRAME/VIDEO`).** A **tri-state** segmented control `Auto · Local · Cloud` writing `stages[STAGE] = {mode:'auto'}` / `{mode:'manual',backend:'local'}` / `{mode:'manual',backend:'cloud'}`. The **Cloud** segment is disabled with a lock icon and a "Add your {OpenRouter|Replicate} key below" tooltip whenever `!keys[provider]` — making local-default *structural* (cloud is literally unclickable without the key step). The **Local** segment gates on `modelsStatus()[STAGE]==='ready'` (uppercase id) and grows the existing `StageDownloadRow` progress affordance when absent; a Cloud-resolved stage hides its download row. A **resolved badge** under the segments reads off `resolvedBackends()` (`settings:resolved` IPC → `resolveConfig(...).stages`): `🛡 Local · private` or `☁ Cloud · {provider} · leaves this Mac`, prefixed `Auto →` when following the master. The `VIDEO` row, only when it resolves **local**, expands today's `VIDEO_MODES` Fast/Quality (`localVideoModel`/`localQuality`); when it resolves **cloud**, a compact `aspect_ratio` + `generate_audio` pair (`VB_OR_ASPECT`/`VB_OR_GENERATE_AUDIO`).
- **On-device card (`localCapabilities()`), keeps local knobs always-visible (major fix).** The **Lyrics-language** (`sttLang`), **workers**, and **local Wan dir** (`localWanDir`) controls stay in this **non-gated** card — they are on-device knobs a keyless user must still reach (Design 4 buried `sttLang` behind a key-gated Advanced card, which would strip a working zero-key setting). An **unsupported** verdict no longer disables Create; it reads *"On-device video needs an Apple-Silicon Mac with 32 GB+. This machine can make videos via Cloud — add an OpenRouter key below (and a Replicate key for lyric timing)."* — the single place the UI recommends cloud, and only as an explicit CTA.
- **`KeyRow` over `KEY_FIELDS`** (restored verbatim in shape, reframed copy): password input, Save → `vb.setKey`, saved-check, "Get a key" link. Copy: *"Add a key to unlock cloud for any stage. Videoboom works fully without keys. Keys are encrypted with your OS keychain and never leave this machine."* OpenRouter hint: *"unlocks cloud LLM, images & video."* Replicate hint: *"unlocks cloud lyric timing (WhisperX)."* Saving a key **only un-greys** the Cloud segments — it never flips a stage (I2); a toast says *"Cloud is now available on N stages. Switch any stage above to use it."*
- **Advanced — `MODEL_FIELDS`** (cloud slugs `storyModel/llmModel/keyframeModel/videoModel/vlmModel/moderationModel`): rendered only when ≥1 key is present (nothing to configure otherwise) — this card is cloud-only and gating it on a key is correct, unlike the local `sttLang` control.
- **`CostBanner`** (`costCents` on `done`): a pill `≈ $0.42 · cloud stages` shown **only when `costCents > 0`**. An all-local render shows **no** cost UI (no `$0.00` placeholder) — the app reads as free until a stage is opted into cloud. Framed as *estimate, billed by your providers*.
- **Onboarding (`renderer/screens/Onboarding.tsx`, new).** Detect hardware → **Verdict + keys** (primary button **Skip — stay local**, secondary **Add a key**; keyless = "every stage runs on your Mac, nothing leaves this machine") → Storage → Runtime install (skippable if all-cloud) → Download set (a cloud-opted stage shows "skipped — using Cloud" instead of a 54 GB download) → Calibrate (local only) → Done (echoes the five resolved badges). Initial `stages` all `{mode:'auto'}`, `backendPreference:'auto'` ⇒ keyless first run resolves all-local. No screen pre-checks a cloud option.

`renderer/vb.d.ts` additions: `keysStatus()`, `setKey()`, `resolvedBackends(): Promise<Record<Stage,ResolvedStage>>`, `SidecarEvent.costCents?`, and the v3 `Settings`/`StageSelection`/`CloudModels` types (§2.2). The renderer never re-implements the resolver — it renders `resolvedBackends()`, invalidated on every `setSettings`/`setKey`.

---

## 8. Migration — local-only-build users lose nothing (I4)

- **Settings:** v2 → v3 (§2.3) preserves `localVideoModel`/`localQuality`/`sttLang`/`workers`/`localWanDir` verbatim and sets all stages `auto`.
- **No keys on disk** (the local-only build deleted `keys.json` at boot and never wrote one) ⇒ `KeyState` all-false ⇒ resolver forces all-local ⇒ identical render to today.
- **UI:** every control a keyless user had — Fast/Quality, per-stage download, Lyrics-language — stays reachable with zero keys; the new Backend-mode/Stages/Keys cards are additive.
- **Projects:** existing projects render unchanged (all-local); `clipsBackend` is absent → treated as local, no forced re-render.
- **guardRender:** relaxed (§5/§3) — it now only requires local models for stages that resolved local *and* are render prerequisites, so a keyless user's requirement set is exactly today's (`STT/LLM/KEYFRAME/VIDEO`).

---

## 9. Implementation roadmap (each commit keeps `npm test` — typecheck + `segment.test` — green)

`npm test` = `tsc --noEmit && tsx --test test/segment.test.ts`. `segment.test.ts` touches only `segment.ts`, so it stays green throughout; the gate is **typecheck** at every commit. Behavior stays all-local until C5 wires the resolver, and cloud stays inert until a key + opt-in exists.

- **C1 — schema + resolver skeleton (no behavior change).** `config.ts` re-add `stageBackend` (default local); `settings.ts` v3 schema + `migrate` + `DEFAULTS`; `autoconfig.ts` `resolveConfig`/`pickBackend`/`toEnv` (phase-a + existing local block); `vb.d.ts` v3 `Settings`. `settingsEnv` still emits today's local env (wire the resolver at C5). **Accept:** typecheck green; `test/no-cloud-without-optin.test.ts` added and green; `migrate` unit-checks preserve v2 local fields.
- **C2 — keychain + cost + keys IPC (dormant).** Restore `keychain.ts`, `cost.ts`; add `keys:status`/`keys:set` IPC + preload + `vb.d.ts`; `costReset()` per op in `engine/index.ts`; `costCents` on engine `EngineEvent` + renderer `SidecarEvent`; **remove** the `keys.json` boot delete. **Accept:** typecheck green; keyless `keyStatus()` = all-false; `costTotal()` = 0 after a local render.
- **C3 — cloud text/image stages + dispatch.** `backends/types.ts`, `backends/registry.ts`, `backends/local/*` adapters; `cloud/http.ts`, `cloud/llm.ts` (role split), `cloud/stt.ts` (failure-vs-instrumental), `cloud/vlm.ts`, `cloud/keyframe.ts`; `stages.ts` dispatchers delegate to the registry (signatures unchanged); `storyBible` passes `'story'`. **Accept:** typecheck green; with `VB_*_BACKEND` unset everything routes local (default); a forced `VB_LLM_BACKEND=cloud` unit-drives `cloud/llm.ts` against a mock fetch.
- **C4 — video seam + pipeline.** `ffmpeg.ts` re-add `fitToWindow`; `backends/sceneShared.ts` (extract `buildKeyframe`/`decideCutContinue`/`finishClip`/`assemble`); `backends/local/video.ts` (move `renderScenesLocalChained`+`renderLocalScene`), `cloud/video.ts` (`genVideo` + parallel morph loop + `p.videoModel`); `pipeline.ts` route through `P.video().renderScenes`/`refreshScene`, unified segProfile, `needsUpscale()` gate, `clipsBackend` invalidation; `stages.ts` `video()`/`keyframeConcurrency()`. **Accept:** typecheck green; a local render produces byte-equivalent output to pre-C4 (same chain, trim, upscale); `pipeline.ts` contains no `VB_*_BACKEND`/`genVideoLocal`/URL (checked by C6 script dry-run).
- **C5 — wire the resolver + guards.** `settingsEnv` → `resolveConfig(caps, getSettings(), keyStatus()).toEnv()`; `sidecarEnv` += `keysEnv()`; `guardRender` consults the resolver (only local-resolved prerequisite stages need models; name the missing provider key for unavailable-local stages); GPU lock (`gpuBusy`/`guardPortrait`) applies only when the op's VIDEO (render) or KEYFRAME/VLM (portrait) resolve local. **Accept:** typecheck green; keyless render still all-local and unblocked; OpenRouter-only render on unsupported hardware blocks with "STT needs a Replicate key."
- **C6 — network lockdown.** `src/shared/netAllowlist.ts`; `session.webRequest` firewall in `main/index.ts`; created inverted `scripts/check-no-cloud.sh`. **Accept:** `check-no-cloud.sh` green; firewall integration smoke shows zero outbound on a local render; a cloud stage reaches only its provider host.
- **C7 — Settings UI.** `BackendModeControl`, `StageBackendRow`+`STAGE_ROWS`, restored `KeyRow`+`KEY_FIELDS` (optional copy), `MODEL_FIELDS` advanced, resolved badges (`settings:resolved` IPC), `CostBanner` (>0), reframed on-device/Hardware card keeping `sttLang`/`workers`/`localWanDir` non-gated. **Accept:** typecheck + smoke (`VB_SMOKE`) green; keyless UI shows all-Local badges + no cost; Cloud segments locked without a key.
- **C8 — Onboarding wizard** (`renderer/screens/Onboarding.tsx`). **Accept:** typecheck green; keyless first run ends all-local; "Skip — stay local" is primary.

---

## 10. Open questions

1. **Unified 6 s segmentation for Kling.** §5 unifies segProfile to `{6,12,3}` for both backends to keep the storyboard cache backend-independent and dissolve the mixed-timeline problem. Kling's single 3–15 s clip may prefer vocal-phrase-length cuts; if quality testing shows 6 s is wrong for Kling, segProfile becomes a per-backend hint again **and** a VIDEO-backend switch must re-segment (re-running only `segmentSong` + scene-window remap, STT/bible cached). Decide after a cloud A/B.
2. **Cloud finish to 1080.** §5 specifies a light ffmpeg lanczos 720→1080 for cloud so cloud ≥ local quality. Alternative: leave cloud at native 720 (smaller files, faster) and make the timeline resolution user-visible. Which is the default?
3. **STT provider split in onboarding.** STT (Replicate) needs a *second* key OpenRouter doesn't cover. The CTA surfaces this per-stage — but is a two-key ask acceptable, or should an OpenRouter-only machine that can't run local STT be steered to instrumental-only rather than required to add Replicate? (Currently: blocked with a clear per-stage reason.)
4. **M5 tier dependency for local-variant quality.** Phase-(b) local variant selection ships on the binary `localCapabilities()` signal now; tier-aware quant/res/steps selection is gated on LOCAL_PLAN M5 (`hardware.ts`/`tiers.ts`/`DeviceProfile`). Confirm the hybrid ships **before** M5 with the coarse local recipe, or is sequenced after M5.
5. **Per-stage backend change mid-project.** §5 invalidates *clips* on a VIDEO switch. A STT/LLM/KEYFRAME switch changes storyboard/keyframes. Proposed: STT/LLM switch → re-storyboard next render; KEYFRAME switch → re-keyframe; detected via a recorded per-stage signature, never re-running STT unless STT itself changed. Confirm.
6. **`VB_WHISPERX_VERSION` pin.** The restored WhisperX Replicate version hash (`5125093~1:providers.ts`) may be stale by ship time; confirm the pinned Replicate model version before C3.
