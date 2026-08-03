// Auto-config resolver: the SINGLE choke point mapping (hardware capability + settings + key state) → a
// per-stage backend + the VB_* env the engine reads. Pure (all inputs passed as data) so the ETA estimator
// and the render see the same resolution. Encodes the four hard invariants (DUAL_BACKEND_PLAN.md §3):
//   I1 no key ⇒ local (first, un-overridable)   I2 key ⇒ still local by default (cloud is explicit opt-in)
//   I3 tier never enables cloud                  I4 zero-key users stay fully local
// Types are imported type-only, so this module has no runtime deps (no electron) and is unit-testable.
// Wired into sidecarEnv() in main/index.ts — every engine op is spawned with the env this resolver emits.
import { STAGES } from './settingsSchema';
import { TIMELINE_RES } from '../shared/videoRes';
import type { Settings, Stage, StageSelection, Backend } from './settingsSchema';
import type { LocalCapabilities } from './localModels';

export interface KeyState { openrouter: boolean; replicate: boolean; }
export interface ResolvedStage {
  backend: Backend;
  reason: 'no-key' | 'pinned' | 'preference' | 'default';
  localAvailable: boolean; // false when this stage resolved local but the machine can't run it (→ blocked, never silent cloud)
}
export interface ResolvedConfig {
  stages: Record<Stage, ResolvedStage>;
  toEnv(): Record<string, string>;
}

// Which provider key gates each stage. STT = Replicate (WhisperX); the rest = OpenRouter.
const PROVIDER: Record<Stage, keyof KeyState> = {
  STT: 'replicate', LLM: 'openrouter', VLM: 'openrouter', KEYFRAME: 'openrouter', VIDEO: 'openrouter',
};

/** The whole invariant surface, one stage. TIER IS ABSENT here (I3): hardware never flips a stage to cloud. */
export function pickBackend(
  stage: Stage,
  sel: StageSelection,
  master: Settings['backendPreference'],
  keys: KeyState,
): { backend: Backend; reason: ResolvedStage['reason'] } {
  if (!keys[PROVIDER[stage]]) return { backend: 'local', reason: 'no-key' };            // I1 — hard, first
  if (sel.mode === 'manual') return { backend: sel.backend ?? 'local', reason: 'pinned' };
  if (master === 'prefer-cloud') return { backend: 'cloud', reason: 'preference' };      // global opt-in + key
  return { backend: 'local', reason: 'default' };                                        // auto / prefer-local → local (I2)
}

/** Resolve every stage. `caps` gives the binary local-runnable signal (tier-aware variant choice is a
 * LOCAL_PLAN-M5 follow-on; the backend decision never depends on it — I3). */
export function resolveConfig(caps: LocalCapabilities, settings: Settings, keys: KeyState): ResolvedConfig {
  // HARDWARE only. Bootstrapping the engine + downloading a model are separate, in-app-fixable steps (M3) —
  // a supported-but-unprovisioned Mac must be told to install the engine, NOT nudged to cloud. So the
  // resolver's "can this Mac run local?" is caps.supported; readiness is engineState()/guardRender's job.
  const localRunnable = Boolean(caps.supported);
  const stages = {} as Record<Stage, ResolvedStage>;
  for (const s of STAGES) {
    const { backend, reason } = pickBackend(s, settings.stages[s], settings.backendPreference, keys);
    stages[s] = { backend, reason, localAvailable: backend === 'local' ? localRunnable : true };
  }
  return { stages, toEnv: () => toEnv(stages, settings) };
}

/** Resolved stages + settings → the VB_* engine env. */
function toEnv(stages: Record<Stage, ResolvedStage>, settings: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of STAGES) env['VB_' + s + '_BACKEND'] = stages[s].backend;
  // Cloud model slugs — always emitted; harmless when the stage is local (the local impl ignores them).
  env.VB_STORY_MODEL = settings.cloud.storyModel;
  env.VB_LLM_MODEL = settings.cloud.llmModel;
  env.VB_KEYFRAME_MODEL = settings.cloud.keyframeModel;
  env.VB_OR_VIDEO_MODEL = settings.cloud.videoModel;
  env.VB_VLM_MODEL = settings.cloud.vlmModel;
  env.VB_MODERATION_MODEL = settings.cloud.moderationModel;
  // Timeline resolution follows the VIDEO backend. The numbers live in shared/videoRes.ts, which the engine
  // backends' timelineRes() reads too — the two must not drift apart.
  const videoLocal = stages.VIDEO.backend === 'local';
  const res = videoLocal ? TIMELINE_RES.local : TIMELINE_RES.cloud;
  env.VB_W = String(res.w);
  env.VB_H = String(res.h);
  // GPU serialization only when the video stage runs locally (one Wan run saturates unified memory).
  env.VB_WORKERS = videoLocal ? '1' : String(settings.workers || 4);
  // A local keyframe matches the timeline so it isn't resized into the clip.
  if (stages.KEYFRAME.backend === 'local') {
    env.VB_LOCAL_KEYFRAME_W = env.VB_W;
    env.VB_LOCAL_KEYFRAME_H = env.VB_H;
  }
  // Local video render block — only when the video stage is local.
  if (videoLocal) {
    const model: '5b' | '14b' = settings.localVideoModel === '5b' ? '5b' : '14b';
    const hd = settings.localQuality === 'hd';
    env.VB_LOCAL_VIDEO_MODEL = model;
    env.VB_LOCAL_QUALITY = hd ? 'hd' : 'fast';
    if (model === '5b') env.VB_LOCAL_WAN_STEPS = hd ? '20' : '10';
    if (settings.localWanDir) { env.VB_LOCAL_WAN_DIR = settings.localWanDir; env.VB_LOCAL_WAN_5B_DIR = settings.localWanDir; }
  }
  if (settings.sttLang) env.VB_STT_LANG = settings.sttLang;
  return env;
}
