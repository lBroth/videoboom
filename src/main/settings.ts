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
  videoModel: string;       // VB_OR_VIDEO_MODEL — image-to-video
  vlmModel: string;         // VB_VLM_MODEL — portrait captioning
  moderationModel: string;  // VB_MODERATION_MODEL — upload safety
  sttLang: string;          // VB_STT_LANG — '' = auto-detect
  workers: number;          // VB_WORKERS — parallel scene render concurrency
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
  return env;
}
