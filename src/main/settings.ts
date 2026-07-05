// Non-secret app settings for the local-only build: on-device video model choice + a couple of render
// options. Plain JSON under userData (there are no secrets — everything runs on-device). They become VB_*
// env vars for the engine/sidecar at spawn time. Schema is versioned so an old cloud-build settings.json
// migrates cleanly on first read.
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export const SETTINGS_VERSION = 2;

export interface Settings {
  settingsVersion: number;
  sttLang: string;          // VB_STT_LANG — '' = auto-detect
  workers: number;          // parallel scene render concurrency (video is GPU-serialized, so effectively 1)
  localVideoModel: '5b' | '14b'; // VB_LOCAL_VIDEO_MODEL — Fast = FastWan-5B (DMD 3-step) / Quality = Wan 14B (default)
  localQuality: 'fast' | 'hd';   // within-model speed knob (14B: fast = Lightning 4-step, hd = full-step)
  localWanDir: string;      // VB_LOCAL_WAN_DIR — '' = read local/.model-path
}

export const DEFAULTS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  sttLang: '',
  workers: 4,
  // 14b = the project's measured quality champion (sharp x16 VAE, no people-deform); 5b is the fast tier.
  localVideoModel: '14b',
  localQuality: 'fast',
  localWanDir: '',
};

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Coerce any stored blob (incl. a v1 cloud-build settings.json) into the current local-only schema:
 * LTX is gone (localVideoModel:'ltx' -> '14b'), and the removed cloud key/provider/model + per-stage
 * backend fields are dropped by simply not carrying them across. */
function migrate(raw: any): Settings {
  const lvm = raw?.localVideoModel;
  return {
    settingsVersion: SETTINGS_VERSION,
    sttLang: typeof raw?.sttLang === 'string' ? raw.sttLang : DEFAULTS.sttLang,
    workers: Number.isFinite(raw?.workers) ? Number(raw.workers) : DEFAULTS.workers,
    localVideoModel: lvm === '5b' ? '5b' : '14b',
    localQuality: raw?.localQuality === 'hd' ? 'hd' : 'fast',
    localWanDir: typeof raw?.localWanDir === 'string' ? raw.localWanDir : DEFAULTS.localWanDir,
  };
}

export function getSettings(): Settings {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }
  const s = migrate(raw);
  // Persist the migrated shape once so the removed fields are actually dropped on disk (and the version
  // stamped), then never re-migrate.
  if (raw?.settingsVersion !== SETTINGS_VERSION) {
    try {
      fs.writeFileSync(file(), JSON.stringify(s, null, 2));
    } catch {
      /* best effort — in-memory migration still applies this run */
    }
  }
  return s;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch, settingsVersion: SETTINGS_VERSION };
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

/** Settings -> the VB_* environment the engine/sidecar reads. Everything is on-device. */
export function settingsEnv(): Record<string, string> {
  const s = getSettings();
  const model: '5b' | '14b' = s.localVideoModel === '5b' ? '5b' : '14b';
  const hd = s.localQuality === 'hd';
  const env: Record<string, string> = {
    // One GPU generation at a time — a single Wan run already saturates unified memory. Keyframes share the
    // GPU, so the pipeline keyframe pool follows this too.
    VB_WORKERS: '1',
    VB_LOCAL_VIDEO_MODEL: model,
    VB_LOCAL_QUALITY: hd ? 'hd' : 'fast',
    // Both Wan paths render 480p (720p OOMs on 48GB). The keyframe (Kontext) matches so it isn't resized
    // into the video, and a failed-scene fill is the same size as the clips (clean concat).
    VB_W: '832',
    VB_H: '480',
    VB_LOCAL_KEYFRAME_W: '832',
    VB_LOCAL_KEYFRAME_H: '480',
  };
  if (s.sttLang) env.VB_STT_LANG = s.sttLang;
  // 5B ONLY: quality = native diffusion steps (fast=10, hd=20). The 14B keeps its Lightning 4-step default
  // (a steps override there would defeat it, ~2.5x slower), so it must NOT get VB_LOCAL_WAN_STEPS.
  if (model === '5b') env.VB_LOCAL_WAN_STEPS = hd ? '20' : '10';
  if (s.localWanDir) {
    env.VB_LOCAL_WAN_DIR = s.localWanDir;
    env.VB_LOCAL_WAN_5B_DIR = s.localWanDir;
  }
  return env;
}
