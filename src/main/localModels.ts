// On-device model availability + downloads, for the Settings "Download" button. A stage's Local backend
// stays gated until its model(s) are present in the HF cache (or, for video, converted by setup.sh). The
// download streams progress (parsed from local/download.py) back to the renderer.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { codeDir, venvPython, hfCacheDir, markerDir, localEnv } from './paths';
import { getSettings } from './settings';

// Mirror of local/download.py STAGE_REPOS (status only — the python side owns the actual download). VIDEO
// lists the Wan-AI source repo; download.py snapshots + converts it to MLX (readiness is the setup marker,
// see videoReady/modelStatus — not a raw repo-cache check).
const STAGE_REPOS: Record<string, string[]> = {
  STT: ['mlx-community/whisper-large-v3-turbo'],
  LLM: ['lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit'],
  VLM: ['mlx-community/gemma-3-12b-it-4bit'],
  KEYFRAME: ['dhairyashil/FLUX.1-schnell-mflux-4bit'], // schnell = render prereq; Kontext is optional (portrait)
  VIDEO: ['pre-converted MLX, per engine'],            // readiness = per-engine marker (videoReady), not repoReady
};

// Path resolution (dev vs packaged) lives in paths.ts; this module consumes it (no duplicate resolvers).

function repoReady(repo: string): boolean {
  const snaps = path.join(hfCacheDir(), 'models--' + repo.replace(/\//g, '--'), 'snapshots');
  try {
    return fs.existsSync(snaps) && fs.readdirSync(snaps).some((s) => fs.readdirSync(path.join(snaps, s)).length > 0);
  } catch {
    return false;
  }
}

/** Engine-aware VIDEO readiness: Fast (5b/FastWan) uses the .model-path-5b marker, Quality (14b) uses
 * .model-path. Each is written only after a complete download/convert, so its presence + a sentinel file
 * in the target dir means the model is usable. */
function videoReady(): boolean {
  const s = getSettings();
  const is5b = s.localVideoModel === '5b';
  const marker = is5b ? '.model-path-5b' : '.model-path';
  // Resolve the override the way the engine does (localVideo.ts modelDir()), which honors the user's
  // "Local Wan folder" setting. Reading only process.env made the setting invisible here: autoconfig emits
  // it into the RENDER spawn env, never into main's own environment, so a user pointing at an existing
  // weights folder (external SSD, another checkout) stayed blocked at "absent" with no way to unblock.
  const override = (is5b ? process.env.VB_LOCAL_WAN_5B_DIR : process.env.VB_LOCAL_WAN_DIR) || s.localWanDir;
  // Both shipped repos carry a real t5_encoder written with the model, so its presence = a complete download.
  const sentinel = 't5_encoder.safetensors';
  try {
    const dir = (override || fs.readFileSync(path.join(markerDir(), marker), 'utf8')).trim();
    if (!dir || !fs.existsSync(path.join(dir, sentinel))) return false;
  } catch {
    return false;
  }
  // The 14B's default Fast path is the Lightning 4-step LoRA. Without it lightningLoras() returns null,
  // no `steps` is sent, and the sidecar falls back to its 20-step default: ~5x the denoise time and
  // over-denoised, flat motion. The model download alone used to report "ready", so a run that lost the
  // LoRA (interrupted fetch, moved models dir) degraded silently instead of prompting a re-download.
  if (is5b) return true;
  try {
    const ld = (process.env.VB_LOCAL_LIGHTNING_DIR || fs.readFileSync(path.join(markerDir(), '.lightning-dir'), 'utf8')).trim();
    return Boolean(ld) && ['high_noise_model.safetensors', 'low_noise_model.safetensors'].every((f) => fs.existsSync(path.join(ld, f)));
  } catch {
    return false;
  }
}

// Measured on-device peaks (M5 Pro bench, 2026-07-05): bf16-relay 32.6GB, FastWan-5b 54.8GB@121f, Q4 67.7GB.
// The realistic floor is 48GB (bf16-relay fits; 32GB swaps/OOMs). 64GB recommended for headroom / larger clips.
const MIN_RAM_GB = 48;
const RECOMMENDED_RAM_GB = 64;

// The ONE place the required-hardware spec is written — reused by every "this machine can't run it" message.
export const HARDWARE_SPEC = `an Apple Silicon Mac (M-series) with ${MIN_RAM_GB}GB+ unified memory (${RECOMMENDED_RAM_GB}GB recommended)`;

export interface LocalCapabilities {
  platform: string; // 'darwin' | 'win32' | 'linux'
  arch: string; // 'arm64' | 'x64'
  ramGB: number;
  isAppleSilicon: boolean;
  minRamGB: number;
  recommendedRamGB: number;
  depsInstalled: boolean; // local/.venv present (setup.sh ran)
  supported: boolean; // Apple Silicon + enough RAM
  reason: string; // why unsupported, '' if supported
}

/** Can this machine run on-device models? On-device = Apple Silicon + enough unified memory. Used to hide
 * the whole On-device Settings section on unsupported machines and gate it on the minimum RAM. */
export function localCapabilities(): LocalCapabilities {
  const platform = process.platform;
  const arch = process.arch;
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';
  const depsInstalled = fs.existsSync(venvPython());
  let reason = '';
  if (platform !== 'darwin') reason = `Videoboom needs ${HARDWARE_SPEC}. This is not macOS.`;
  else if (arch !== 'arm64') reason = `Videoboom needs ${HARDWARE_SPEC}. This Mac isn't Apple Silicon.`;
  else if (ramGB < MIN_RAM_GB) reason = `Videoboom needs ${HARDWARE_SPEC}. This Mac has ${ramGB}GB.`;
  return {
    platform,
    arch,
    ramGB,
    isAppleSilicon,
    minRamGB: MIN_RAM_GB,
    recommendedRamGB: RECOMMENDED_RAM_GB,
    depsInstalled,
    supported: isAppleSilicon && ramGB >= MIN_RAM_GB,
    reason,
  };
}

export type StageState = 'ready' | 'absent';

/** Per-stage model availability. VIDEO (Wan) readiness is the converted-model setup marker (download.py or
 * setup.sh provisions it); the rest are ready once their HF repos are in the cache (Download button). */
export function modelStatus(): Record<string, StageState> {
  const out: Record<string, StageState> = {};
  for (const [stage, repos] of Object.entries(STAGE_REPOS)) {
    out[stage] = stage === 'VIDEO' ? (videoReady() ? 'ready' : 'absent') : repos.every(repoReady) ? 'ready' : 'absent';
  }
  return out;
}

export type EngineState = 'unsupported' | 'not-bootstrapped' | 'partial' | 'ready';
// Render-required local stages (VLM is portrait-only, not a render prerequisite).
const RENDER_STAGE_KEYS = ['STT', 'LLM', 'KEYFRAME', 'VIDEO'] as const;

/** Tri-state (+unsupported) engine readiness for the UI + guardRender. Only considers stages the caller's
 * resolver put on the LOCAL backend — a stage opted into cloud needs neither the engine nor its local model,
 * so it never makes the engine look 'partial'. */
export function engineState(stages: Record<string, { backend: 'cloud' | 'local' }>): EngineState {
  if (!localCapabilities().supported) return 'unsupported';
  if (!fs.existsSync(venvPython())) return 'not-bootstrapped';
  const st = modelStatus();
  for (const key of RENDER_STAGE_KEYS) {
    if (stages[key]?.backend === 'local' && st[key] !== 'ready') return 'partial';
  }
  return 'ready';
}

export interface DownloadRun {
  done: Promise<void>;
  cancel: () => void;
}

/** Spawn local/download.py for a stage, forwarding its JSON progress lines to onEvent. */
export function downloadModel(stage: string, onEvent: (e: any) => void): DownloadRun {
  stage = stage.toUpperCase();
  if (!(stage in STAGE_REPOS)) {
    return { done: Promise.reject(new Error(`stage ${stage} is not downloadable here`)), cancel: () => {} };
  }
  const py = venvPython();
  if (!fs.existsSync(py)) {
    return { done: Promise.reject(new Error('Install the on-device engine first (Settings → On-device).')), cancel: () => {} };
  }
  let child: ChildProcess;
  try {
    // download.py picks the VIDEO engine off VB_LOCAL_VIDEO_MODEL and falls back to '5b'. That var is
    // emitted by autoconfig.toEnv(), which only ever builds the RENDER spawn env (index.ts) — it never
    // reaches process.env. Without it here, the Download button fetched the retired FastWan-5B (~24GB)
    // and wrote .model-path-5b, while videoReady() looked for the '14b' marker .model-path, so the VIDEO
    // stage never went ready and every re-click re-downloaded. Pass the setting the app actually runs.
    const env = { ...process.env, ...localEnv(), VB_LOCAL_VIDEO_MODEL: getSettings().localVideoModel, HF_HUB_DISABLE_XET: '1' };
    child = spawn(py, [path.join(codeDir(), 'download.py'), stage], { cwd: codeDir(), env });
  } catch (e: any) {
    return { done: Promise.reject(e), cancel: () => {} };
  }
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line));
        } catch {
          /* ignore non-JSON noise */
        }
      }
    }
  });
  child.stderr?.on('data', () => {}); // hf transfer progress goes to stderr — ignore
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`download failed (exit ${code})`))));
  });
  return { done, cancel: () => child.kill() };
}
