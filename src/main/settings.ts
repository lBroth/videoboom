// Non-secret app settings: per-stage model choices + a few render options. Plain JSON under userData
// (no secrets here — API keys live encrypted in keychain.ts). The renderer's Settings pane edits these;
// they become VB_* env vars for the sidecar at spawn time.
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface Settings {
  storyModel: string;       // VB_STORY_MODEL — narrative bible (strong LLM)
  llmModel: string;         // VB_LLM_MODEL — shot list (structured JSON)
  keyframeModel: string;    // VB_KEYFRAME_MODEL — image keyframes
  videoModel: string;       // VB_OR_VIDEO_MODEL — cloud image-to-video
  vlmModel: string;         // VB_VLM_MODEL — portrait captioning
  moderationModel: string;  // VB_MODERATION_MODEL — upload safety
  sttLang: string;          // VB_STT_LANG — '' = auto-detect
  workers: number;          // VB_WORKERS — parallel scene render concurrency
  videoBackend: 'cloud' | 'local'; // VB_VIDEO_BACKEND — cloud i2v vs on-device Wan 2.2 MLX
  localQuality: 'fast' | 'hd'; // local Wan: fast = 480p Lightning 4-step, hd = 720p 40-step
  localWanDir: string;      // VB_LOCAL_WAN_DIR — '' = read local/.model-path
  sttBackend: 'cloud' | 'local'; // VB_STT_BACKEND — cloud WhisperX (Replicate) vs on-device mlx-whisper
  llmBackend: 'cloud' | 'local'; // VB_LLM_BACKEND — cloud Claude/Gemini vs on-device Qwen (mlx-lm)
  vlmBackend: 'cloud' | 'local'; // VB_VLM_BACKEND — cloud gemma vs on-device gemma-3 (mlx-vlm); also moderation
  keyframeBackend: 'cloud' | 'local'; // VB_KEYFRAME_BACKEND — cloud gemini-image vs on-device FLUX (mflux)
}

export const DEFAULTS: Settings = {
  storyModel: 'anthropic/claude-sonnet-4.6',
  llmModel: 'google/gemini-3.5-flash',
  keyframeModel: 'google/gemini-3.1-flash-image',
  videoModel: 'kwaivgi/kling-v3.0-std',
  vlmModel: 'google/gemma-3-12b-it',
  moderationModel: 'google/gemini-3.5-flash',
  sttLang: '',
  workers: 4,
  videoBackend: 'cloud',
  localQuality: 'fast',
  localWanDir: '',
  sttBackend: 'cloud',
  llmBackend: 'cloud',
  vlmBackend: 'cloud',
  keyframeBackend: 'cloud',
};

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

/** Settings -> the VB_* environment the sidecar reads (only non-empty overrides). */
export function settingsEnv(): Record<string, string> {
  const s = getSettings();
  const env: Record<string, string> = {
    VB_STORY_MODEL: s.storyModel,
    VB_LLM_MODEL: s.llmModel,
    VB_KEYFRAME_MODEL: s.keyframeModel,
    VB_OR_VIDEO_MODEL: s.videoModel,
    VB_VLM_MODEL: s.vlmModel,
    VB_MODERATION_MODEL: s.moderationModel,
    VB_WORKERS: String(s.workers || 4),
  };
  if (s.sttLang) env.VB_STT_LANG = s.sttLang;
  if (s.sttBackend === 'local') env.VB_STT_BACKEND = 'local';
  if (s.llmBackend === 'local') env.VB_LLM_BACKEND = 'local';
  if (s.vlmBackend === 'local') env.VB_VLM_BACKEND = 'local';
  if (s.keyframeBackend === 'local') env.VB_KEYFRAME_BACKEND = 'local';
  if (s.videoBackend === 'local') {
    // On-device Wan 2.2 MLX. Serialise scenes (one 14B run already saturates unified memory). Resolution
    // is the #1 speed lever: 'fast' = 480p (Lightning 4-step, ~3min/clip) for tests; 'hd' = 720p, 40-step.
    // Both set VB_W/VB_H so every clip + failed-scene fill share one size (concat needs uniform frames).
    const hd = s.localQuality === 'hd';
    env.VB_VIDEO_BACKEND = 'local';
    env.VB_LOCAL_QUALITY = hd ? 'hd' : 'fast';
    // 480p (832×480). The default local i2v model is Wan2.2-TI2V-5B (~2.6x faster than the 14B, native
    // ~10 steps); per-model frame caps live in localVideo (5B=57 @24fps ≈ 2.4s, 14B=37 @16fps). Keep 480p
    // for the 5B's ~49GB peak; 720p risks OOM on 48GB. fast/hd only changes the 14B path (Lightning vs 40-step).
    env.VB_W = '832';
    env.VB_H = '480';
    env.VB_WORKERS = '1';
    // 5B (default) quality = native diffusion steps: fast=10 (~2min/clip), 'hd' label = 20 (~4min, sharper).
    // Both 480p; 720p OOMs the 5B on 48GB. (The 14B path, env-only, ignores this and uses Lightning/40-step.)
    env.VB_LOCAL_WAN_STEPS = hd ? '20' : '10';
    if (s.localWanDir) {
      env.VB_LOCAL_WAN_DIR = s.localWanDir;
      env.VB_LOCAL_WAN_5B_DIR = s.localWanDir;
    }
  }
  return env;
}
