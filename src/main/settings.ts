// App settings IO for the local-default HYBRID build. The pure schema (types, DEFAULTS, migrate) lives in
// settingsSchema.ts so the resolver + tests can import it without electron; this file adds the electron IO
// and the VB_* env bridge. Settings become VB_* env vars at spawn time — via the auto-config resolver
// (src/main/autoconfig.ts) from C5 on; until then settingsEnv() emits today's local env directly.
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { SETTINGS_VERSION, DEFAULTS, migrate, type Settings } from './settingsSchema';

export { SETTINGS_VERSION, DEFAULTS };
export type { Settings, Stage, Backend, StageSelection, CloudModels } from './settingsSchema';

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): Settings {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }
  const s = migrate(raw);
  // Persist the migrated shape once so removed fields are dropped on disk (and the version stamped), then
  // never re-migrate.
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

/** Settings -> the VB_* environment the engine/sidecar reads (LOCAL block). Superseded by the resolver's
 * toEnv() at C5; until then this drives today's all-local render unchanged. */
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
