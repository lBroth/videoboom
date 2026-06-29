// Runtime config for the engine: BYOK keys + VB_* model choices, injected per run from the main process
// (keychain + settings). Reads fall back to process.env so the values are also usable in dev/tests.
const CFG: Record<string, string> = {};

/** Merge an injected env map (decrypted keys + settings) into the runtime config. Last write wins. */
export function setEnv(map: Record<string, string | undefined | null>): void {
  for (const [k, v] of Object.entries(map)) {
    if (v != null && v !== '') CFG[k] = String(v);
  }
}

/** Read a config value (API key / model choice / option), '' if unset — mirrors the old storage.env(). */
export function env(k: string, d = ''): string {
  const v = CFG[k] ?? process.env[k];
  return v ? v : d;
}

export function envInt(k: string, d: number): number {
  const v = parseInt(env(k, ''), 10);
  return Number.isFinite(v) ? v : d;
}

export function envBool(k: string, d = false): boolean {
  const v = env(k, '').toLowerCase();
  if (!v) return d;
  return v === '1' || v === 'true' || v === 'yes';
}

/** Per-stage backend: 'cloud' (default) or 'local'. Read as VB_<STAGE>_BACKEND, e.g. stageBackend('STT')
 * -> VB_STT_BACKEND. Lets each pipeline stage route cloud<->local independently; the pipeline code itself
 * is unchanged — only the provider functions branch on this. */
export function stageBackend(stage: string, d = 'cloud'): string {
  return env(`VB_${stage}_BACKEND`, d);
}
