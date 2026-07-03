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
  videoBackend: 'cloud' | 'local'; // VB_VIDEO_BACKEND — cloud i2v vs on-device MLX video
  localVideoModel: 'ltx' | '5b' | '14b'; // VB_LOCAL_VIDEO_MODEL — LTX-2.3 (first+last morph) / Wan 5B / Wan 14B
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
  // 14b = the project's own measured quality champion (sharp x16 VAE, no people-deform); 'ltx' is the
  // explicit fast choice, '5b' the deprecated fast tier (x64 VAE deforms people).
  localVideoModel: '14b',
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
    env.VB_VIDEO_BACKEND = 'local';
    // Serialise GPU stages — one video model run already saturates unified memory. Network-bound stages
    // (cloud keyframes) get their own pool width in the pipeline (VB_KF_WORKERS), NOT this one.
    env.VB_WORKERS = '1';
    env.VB_LOCAL_VIDEO_MODEL = s.localVideoModel || '14b';
    if (s.localVideoModel === 'ltx') {
      // LTX renders 896x512; match VB_W/VB_H so a failed-scene fill is the same size as the clips (concat),
      // and the keyframe (Kontext) so it isn't resized into the video.
      env.VB_W = '896';
      env.VB_H = '512';
      env.VB_LOCAL_KEYFRAME_W = '896';
      env.VB_LOCAL_KEYFRAME_H = '512';
      return env;
    }
    env.VB_LOCAL_KEYFRAME_W = '832'; // Wan paths render 480p — keyframe matches
    env.VB_LOCAL_KEYFRAME_H = '480';
    // ── Wan 5B / 14B ──
    const hd = s.localQuality === 'hd';
    env.VB_LOCAL_QUALITY = hd ? 'hd' : 'fast';
    // 480p (832×480) for both Wan paths; 720p OOMs on 48GB. Per-model frame caps live in localVideo
    // (5B=57 @24fps ≈ 2.4s, 14B=37 @16fps). fast/hd on the 14B = Lightning 4-step vs full 40-step.
    env.VB_W = '832';
    env.VB_H = '480';
    env.VB_WORKERS = '1';
    // 5B ONLY: quality = native diffusion steps (fast=10 ≈ 2min/clip, hd=20). The 14B must NOT get a
    // steps override here — it would defeat the Lightning 4-step default (10 steps ≈ 2.5x slower).
    if (s.localVideoModel === '5b') env.VB_LOCAL_WAN_STEPS = hd ? '20' : '10';
    if (s.localWanDir) {
      env.VB_LOCAL_WAN_DIR = s.localWanDir;
      env.VB_LOCAL_WAN_5B_DIR = s.localWanDir;
    }
  }
  return env;
}
