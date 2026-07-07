// Pure settings schema for the local-default HYBRID build: types, defaults, and migration — no electron,
// no filesystem, so the resolver (autoconfig.ts) and unit tests can import it. The electron-backed IO
// (read/write/env) lives in settings.ts. Schema is versioned; an old cloud build (v1) or the shipped
// local-only build (v2) migrates cleanly. See DUAL_BACKEND_PLAN.md §2.

export const SETTINGS_VERSION = 3;

export type Stage = 'STT' | 'LLM' | 'VLM' | 'KEYFRAME' | 'VIDEO';   // moderation rides VLM
export type Backend = 'cloud' | 'local';
export const STAGES: Stage[] = ['STT', 'LLM', 'VLM', 'KEYFRAME', 'VIDEO'];

/** Per-stage choice: 'auto' follows the master control; 'manual' pins the explicit `backend`. */
export interface StageSelection { mode: 'auto' | 'manual'; backend?: Backend; }
export interface CloudModels {
  storyModel: string; llmModel: string; keyframeModel: string;
  videoModel: string; vlmModel: string; moderationModel: string;
}

export interface Settings {
  settingsVersion: number;                                     // 3
  backendPreference: 'auto' | 'prefer-local' | 'prefer-cloud'; // master control
  stages: Record<Stage, StageSelection>;                       // per-stage auto/pin
  cloud: CloudModels;                                          // OpenRouter/Replicate slugs (advanced)
  // ── on-device knobs (preserved from v2; still emitted for local-resolved stages) ──
  sttLang: string;          // VB_STT_LANG — '' = auto-detect
  workers: number;          // parallel scene render concurrency (video is GPU-serialized, so effectively 1)
  localVideoModel: '5b' | '14b'; // always '14b' now — FastWan-5B retired (x64 VAE deformed people); field kept for schema/back-compat
  localQuality: 'fast' | 'hd';   // the user-facing Fast/Quality: fast = 14B Lightning 4-step + tiny-VAE (~2 min/clip), hd = 14B full 40-step master
  localWanDir: string;      // VB_LOCAL_WAN_DIR — '' = read local/.model-path
  onboarded: boolean;       // first-run wizard completed/skipped
}

export const DEFAULTS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  backendPreference: 'auto',
  stages: { STT: { mode: 'auto' }, LLM: { mode: 'auto' }, VLM: { mode: 'auto' }, KEYFRAME: { mode: 'auto' }, VIDEO: { mode: 'auto' } },
  cloud: {
    storyModel: 'anthropic/claude-sonnet-4.6', llmModel: 'google/gemini-3.5-flash',
    keyframeModel: 'google/gemini-3.1-flash-image', videoModel: 'kwaivgi/kling-v3.0-std',
    vlmModel: 'google/gemma-3-12b-it', moderationModel: 'google/gemini-3.5-flash',
  },
  sttLang: '', workers: 4, localVideoModel: '14b', localQuality: 'fast', localWanDir: '',
  onboarded: false,
};

/** Coerce any stored blob into the v3 schema. Handles v2 (local-only, current), v1 (pre-pivot flat cloud),
 * and unknown blobs. INVARIANT (I2): an old per-stage 'cloud' choice migrates to 'auto', NOT a cloud pin —
 * a present key must never silently re-enable cloud; the user re-opts-in explicitly. A v2 blob (no keys on
 * disk) therefore resolves all-local, a byte-for-byte continuation of today's render. */
export function migrate(raw: any): Settings {
  const str = (x: any, d: string) => (typeof x === 'string' && x ? x : d);
  // A stored 'local' becomes a manual local pin; 'cloud'/absent → 'auto' (no silent cloud).
  const sel = (b: any): StageSelection => (b === 'local' ? { mode: 'manual', backend: 'local' } : { mode: 'auto' });
  const flat: Record<Stage, any> = {
    STT: raw?.sttBackend, LLM: raw?.llmBackend, VLM: raw?.vlmBackend,
    KEYFRAME: raw?.keyframeBackend, VIDEO: raw?.videoBackend,
  };
  const stages = {} as Record<Stage, StageSelection>;
  for (const s of STAGES) {
    const stored = raw?.stages?.[s];
    stages[s] = stored && (stored.mode === 'auto' || stored.mode === 'manual') ? stored : sel(flat[s]);
  }
  const c = raw?.cloud || {};
  return {
    settingsVersion: SETTINGS_VERSION,
    backendPreference: raw?.backendPreference === 'prefer-local' || raw?.backendPreference === 'prefer-cloud'
      ? raw.backendPreference : 'auto',
    stages,
    cloud: {
      storyModel: str(c.storyModel ?? raw?.storyModel, DEFAULTS.cloud.storyModel),
      llmModel: str(c.llmModel ?? raw?.llmModel, DEFAULTS.cloud.llmModel),
      keyframeModel: str(c.keyframeModel ?? raw?.keyframeModel, DEFAULTS.cloud.keyframeModel),
      videoModel: str(c.videoModel ?? raw?.videoModel, DEFAULTS.cloud.videoModel),
      vlmModel: str(c.vlmModel ?? raw?.vlmModel, DEFAULTS.cloud.vlmModel),
      moderationModel: str(c.moderationModel ?? raw?.moderationModel, DEFAULTS.cloud.moderationModel),
    },
    // ── preserved v2 local fields, verbatim (I4) ──
    sttLang: str(raw?.sttLang, ''),
    workers: Number.isFinite(raw?.workers) ? Number(raw.workers) : DEFAULTS.workers,
    // FastWan-5B retired → always Wan 14B, even for a stored '5b' (the x64-VAE 5B deformed people). The
    // Fast/Quality choice is now the WITHIN-14B localQuality knob below.
    localVideoModel: '14b',
    localQuality: raw?.localQuality === 'hd' ? 'hd' : 'fast',
    localWanDir: str(raw?.localWanDir, ''),
    onboarded: raw?.onboarded === true,
  };
}
