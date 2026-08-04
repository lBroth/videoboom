// App settings IO for the local-default HYBRID build. The pure schema (types, DEFAULTS, migrate) lives in
// settingsSchema.ts so the resolver + tests can import it without electron; this file adds the electron IO
// (read/write/migrate). Settings become VB_* env vars at spawn time via the auto-config resolver's toEnv()
// (src/main/autoconfig.ts), wired into sidecarEnv() in main/index.ts.
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
