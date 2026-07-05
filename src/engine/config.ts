// Runtime config for the engine: VB_* backend selection + model choices + render options, injected per run
// from the main process (resolver output + optional cloud keys). Reads fall back to process.env so the
// values are also usable in dev/tests.
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

/** Per-stage backend: 'local' (default) or 'cloud'. Read as VB_<STAGE>_BACKEND, e.g. stageBackend('LLM')
 * -> VB_LLM_BACKEND. The auto-config resolver always emits an explicit value, so this default is only a
 * failsafe — and the failsafe is LOCAL (a missing env can never route to cloud; defense-in-depth for the
 * no-key/no-opt-in invariants). The pipeline never reads this; only backends/registry.ts does. */
export function stageBackend(stage: string, d: 'cloud' | 'local' = 'local'): 'cloud' | 'local' {
  return env('VB_' + stage + '_BACKEND', d) === 'cloud' ? 'cloud' : 'local';
}
