// The single source of truth for where the local sidecar's CODE, runtime (Python/venv), models, markers and
// HF cache live — dev vs packaged. Electron-aware (main only). The engine stays electron-free: main computes
// these and injects them as env (localEnv()) into every sidecar / download / bootstrap spawn.
//
// Two roots:
//   codeDir()    — read-only sidecar CODE (server.py, *.py, requirements). Packaged: process.resourcesPath
//                  (extraResources, signed). Dev: the repo's local/.
//   runtimeDir() — the WRITABLE runtime (venv, models, markers, hf-cache). Packaged: userData (outside the
//                  notarized bundle, so staple stays valid). Dev: the repo's local/ (so the existing
//                  .venv/models/markers resolve unchanged — zero dev disruption).
// See SIDECAR_BOOTSTRAP_PLAN.md §1–§2.
import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';

const repoLocal = () => path.join(app.getAppPath(), 'local'); // dev: getAppPath() == repo root

export function codeDir(): string {
  if (process.env.VB_LOCAL_DIR) return process.env.VB_LOCAL_DIR;
  return app.isPackaged ? path.join(process.resourcesPath, 'local') : repoLocal();
}
export function runtimeDir(): string {
  if (process.env.VB_LOCAL_RUNTIME_DIR) return process.env.VB_LOCAL_RUNTIME_DIR;
  return app.isPackaged ? path.join(app.getPath('userData'), 'local') : repoLocal();
}
export const venvPython = (): string => process.env.VB_LOCAL_PYTHON || path.join(runtimeDir(), '.venv', 'bin', 'python');
export const modelsDir = (): string => process.env.VB_LOCAL_MODELS_DIR || path.join(runtimeDir(), 'models');
export const markerDir = (): string => process.env.VB_LOCAL_MARKER_DIR || runtimeDir();

/** HuggingFace cache. Packaged → a writable dir under userData. Dev → the machine's existing default
 * (~/.cache/huggingface or HF_HOME), so a developer's already-downloaded models keep resolving. */
export function hfCacheDir(): string {
  if (process.env.HUGGINGFACE_HUB_CACHE) return process.env.HUGGINGFACE_HUB_CACHE;
  if (app.isPackaged) return path.join(app.getPath('userData'), 'local', 'hf-cache');
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

/** The bootstrap tool: a Developer-ID-signed uv shipped in Resources/bin when packaged; the PATH `uv` in dev. */
export const uvBin = (): string => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'uv') : 'uv');

/** The env block injected into EVERY sidecar / download / bootstrap spawn so the Python side resolves the
 * same paths main does. In dev these equal today's implicit values (repo local/, ~/.cache/huggingface), so
 * behavior is byte-identical; in packaged they redirect to the bundled code + writable userData runtime. */
export function localEnv(): Record<string, string> {
  return {
    VB_LOCAL_DIR: codeDir(),
    VB_LOCAL_PYTHON: venvPython(),
    VB_LOCAL_MODELS_DIR: modelsDir(),
    VB_LOCAL_MARKER_DIR: markerDir(),
    HUGGINGFACE_HUB_CACHE: hfCacheDir(),
  };
}
