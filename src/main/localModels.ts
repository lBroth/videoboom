// On-device model availability + downloads, for the Settings "Download" button. A stage's Local backend
// stays gated until its model(s) are present in the HF cache (or, for video, converted by setup.sh). The
// download streams progress (parsed from local/download.py) back to the renderer.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';

// Mirror of local/download.py STAGE_REPOS (status only — the python side owns the actual download).
const STAGE_REPOS: Record<string, string[]> = {
  STT: ['mlx-community/whisper-large-v3-turbo'],
  LLM: ['lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit'],
  VLM: ['mlx-community/gemma-3-12b-it-4bit'],
  KEYFRAME: ['dhairyashil/FLUX.1-schnell-mflux-4bit', 'akx/FLUX.1-Kontext-dev-mflux-4bit'],
};

function localDir(): string {
  return process.env.VB_LOCAL_DIR || path.resolve(process.cwd(), 'local');
}
function localPython(): string {
  return process.env.VB_LOCAL_PYTHON || path.join(localDir(), '.venv', 'bin', 'python');
}
function hfCache(): string {
  if (process.env.HUGGINGFACE_HUB_CACHE) return process.env.HUGGINGFACE_HUB_CACHE;
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function repoReady(repo: string): boolean {
  const snaps = path.join(hfCache(), 'models--' + repo.replace(/\//g, '--'), 'snapshots');
  try {
    return fs.existsSync(snaps) && fs.readdirSync(snaps).some((s) => fs.readdirSync(path.join(snaps, s)).length > 0);
  } catch {
    return false;
  }
}

function videoReady(): boolean {
  try {
    const dir = (process.env.VB_LOCAL_WAN_DIR || fs.readFileSync(path.join(localDir(), '.model-path'), 'utf8')).trim();
    return Boolean(dir) && fs.existsSync(path.join(dir, 't5_encoder.safetensors'));
  } catch {
    return false;
  }
}

const MIN_RAM_GB = 32; // biggest single stage (Wan i2v ~24GB) + macOS/app overhead
const RECOMMENDED_RAM_GB = 48;

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
  const depsInstalled = fs.existsSync(localPython());
  let reason = '';
  if (platform !== 'darwin') reason = 'On-device models currently require macOS (Apple Silicon).';
  else if (arch !== 'arm64') reason = 'On-device models require an Apple Silicon Mac (M-series).';
  else if (ramGB < MIN_RAM_GB) reason = `Needs ${MIN_RAM_GB}GB+ unified memory — this Mac has ${ramGB}GB.`;
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

/** Per-stage model availability. VIDEO (Wan) is provisioned by setup.sh; the rest by the Download button. */
export function modelStatus(): Record<string, StageState> {
  const out: Record<string, StageState> = {};
  for (const [stage, repos] of Object.entries(STAGE_REPOS)) out[stage] = repos.every(repoReady) ? 'ready' : 'absent';
  out.VIDEO = videoReady() ? 'ready' : 'absent';
  return out;
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
  const py = localPython();
  if (!fs.existsSync(py)) {
    return { done: Promise.reject(new Error('Local sidecar not installed — run `bash local/setup.sh` first.')), cancel: () => {} };
  }
  let child: ChildProcess;
  try {
    child = spawn(py, [path.join(localDir(), 'download.py'), stage], { cwd: localDir(), env: { ...process.env, HF_HUB_DISABLE_XET: '1' } });
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
