// First-run provisioning of the on-device Python engine for the PACKAGED app: uv-managed CPython 3.12 + a
// venv + the pinned MLX deps, all under the writable runtimeDir() (never the read-only bundle). The heavy
// lifting (uv, codesign, real Python) runs only on macOS/Apple-Silicon and can't be exercised in CI —
// detect() is the CI-testable surface; install()/harden()/verify() are hardware-gated (M3h/M3m QA).
//
// The one Apple-Silicon-specific mechanic (§4): a freshly-written Mach-O exec'd from a Developer-ID parent is
// SIGKILLed (Sequoia) / hangs at _dyld_start (Tahoe) unless it carries a fresh signature. The fix is an
// ad-hoc per-Mach-O re-sign of the uv-provisioned interpreter + libpython + wheel dylibs (NOT an xattr strip,
// NOT codesign --deep). A post-harden exec probe turns a silent bad-signature death into a visible error.
// See SIDECAR_BOOTSTRAP_PLAN.md §3–§4.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { runtimeDir, venvPython, uvBin, localEnv } from './paths';
import { localCapabilities } from './localModels';

export type Phase = 'detect' | 'python' | 'venv' | 'deps' | 'harden' | 'verify' | 'done';
export interface BootState { pythonReady: boolean; venvReady: boolean; depsReady: boolean; }
export interface BootEvent { event: 'phase' | 'progress' | 'done' | 'error'; phase?: Phase; pct?: number; error?: string; }
type Emit = (e: BootEvent) => void;

class BootError extends Error {
  phase: Phase;
  constructor(phase: Phase, message: string) { super(message); this.phase = phase; }
}

// ── layout (all under runtimeDir(), = userData/local when packaged, repo/local in dev) ──
const uvPythonDir = () => path.join(runtimeDir(), 'uv', 'python');
const uvCacheDir = () => path.join(runtimeDir(), 'uv', 'cache');
const venvDir = () => path.join(runtimeDir(), '.venv');
const manifestPath = () => path.join(runtimeDir(), 'venv-manifest.json');
const wheelsDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'wheels') : path.join(app.getAppPath(), 'build', 'wheels'));
const lockPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'requirements.macos.lock') : path.join(app.getAppPath(), 'local', 'requirements.macos.lock'));

function shippedLockSha(): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(lockPath())).digest('hex'); } catch { return ''; }
}
function readManifest(): { lockSha256?: string } | null {
  try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch { return null; }
}
function uvPythonPresent(): boolean {
  try { return fs.existsSync(uvPythonDir()) && fs.readdirSync(uvPythonDir()).length > 0; } catch { return false; }
}

/** What's already provisioned. Idempotent + cheap (pure file checks) so it's the CI-testable surface and the
 * per-op readiness gate. Dev has a venv but no shipped lock → treated as provisioned (skips bootstrap). */
export function detect(): BootState {
  const venvReady = fs.existsSync(venvPython());
  const lockSha = shippedLockSha();
  const m = readManifest();
  const depsReady = venvReady && (lockSha === '' || m?.lockSha256 === lockSha);
  return { pythonReady: uvPythonPresent() || venvReady, venvReady, depsReady };
}

let bootChild: ChildProcess | null = null;

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, phase: Phase, emit: Emit): Promise<void> {
  return new Promise((resolve, reject) => {
    emit({ event: 'phase', phase });
    const child = spawn(bin, args, { env });
    bootChild = child;
    let err = '';
    child.stdout?.on('data', (d) => {
      const s = String(d);
      const m = s.match(/(?:Prepared|Installed)\s+(\d+)\/(\d+)/); // uv per-package progress
      if (m && phase === 'deps') emit({ event: 'progress', phase, pct: Math.round((Number(m[1]) / Math.max(1, Number(m[2]))) * 100) });
    });
    child.stderr?.on('data', (d) => { err = (err + String(d)).slice(-2000); });
    child.on('error', (e) => { bootChild = null; reject(new BootError(phase, String(e?.message || e))); });
    child.on('exit', (code, signal) => {
      bootChild = null;
      if (code === 0) resolve();
      else reject(new BootError(phase, `${phase} failed (${signal || 'exit ' + code}): ${err.slice(-400)}`));
    });
  });
}

const execP = (file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ code: number; signal: string | null }> =>
  new Promise((resolve) => execFile(file, args, opts, (e: any) => resolve({ code: e?.code ?? 0, signal: e?.signal ?? null })));

/** Every Mach-O under the provisioned dirs (interpreter + libpython + wheel .so/.dylib), by magic bytes. */
async function collectMachOs(dirs: string[]): Promise<string[]> {
  const MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe]);
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(p); continue; }
      const isLib = /\.(so|dylib)$/.test(e.name);
      let execBit = false;
      try { execBit = (fs.statSync(p).mode & 0o111) !== 0; } catch { /* skip */ }
      if (!isLib && !execBit) continue;
      try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (MAGICS.has(buf.readUInt32BE(0)) || MAGICS.has(buf.readUInt32LE(0))) out.push(p);
      } catch { /* skip unreadable */ }
    }
  };
  dirs.forEach(walk);
  return out;
}

/** THE fix: ad-hoc re-sign every Mach-O so AMFI lets the uv-provisioned interpreter exec on Apple Silicon.
 * Ad-hoc only (never --options runtime,library — that re-enables library validation and blocks unsigned
 * mlx/ncnn). The xattr strips are harmless best-effort (quarantine is removable; provenance is a SIP no-op). */
async function hardenProvisionedTree(...dirs: string[]): Promise<void> {
  for (const d of dirs) {
    await execP('xattr', ['-rd', 'com.apple.quarantine', d]).catch(() => {});
    await execP('xattr', ['-rd', 'com.apple.provenance', d]).catch(() => {}); // expected no-op (SIP)
  }
  const machos = await collectMachOs(dirs);
  for (const f of machos) {
    const r = await execP('codesign', ['--force', '--sign', '-', f]);
    if (r.code) throw new BootError('harden', `could not ad-hoc sign ${path.basename(f)} (codesign exit ${r.code})`);
  }
}

/** Post-harden exec probe with the REAL spawn env: a bad signature kills a posix_spawn'd child silently, so
 * we turn that into a visible, phase-attributed error instead of a mysterious "sidecar never started". */
async function verifyRuntime(): Promise<void> {
  const env = { ...process.env, ...localEnv() };
  const r = await execP(venvPython(), ['-c', 'import mlx.core, sys; sys.stdout.write(sys.version)'], { env, timeout: 30_000 });
  if (r.signal || r.code) {
    throw new BootError('verify', 'The on-device runtime could not be signed to run on this Mac (see the signing step in the logs).');
  }
}

function writeManifest(): void {
  fs.writeFileSync(manifestPath(), JSON.stringify({
    schema: 1, python: '3.12', lockSha256: shippedLockSha(),
    platform: 'macos-arm64',
  }, null, 2));
}

/** Provision the engine end-to-end. macOS/Apple-Silicon only; streams phase/progress via emit. Idempotent:
 * each uv step is skipped when already satisfied, and `uv pip sync` reconverges the venv from any partial. */
export async function install(emit: Emit): Promise<void> {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new BootError('detect', 'On-device engine setup runs on Apple-Silicon macOS only.');
    }
    const caps = localCapabilities();
    if (!caps.supported) throw new BootError('detect', caps.reason || 'This Mac cannot run the on-device engine.');
    const st = detect();
    fs.mkdirSync(uvPythonDir(), { recursive: true });
    fs.mkdirSync(uvCacheDir(), { recursive: true });
    const uvEnv = { ...process.env, ...localEnv(), UV_PYTHON_INSTALL_DIR: uvPythonDir(), UV_CACHE_DIR: uvCacheDir() };
    if (!st.pythonReady) await run(uvBin(), ['python', 'install', '3.12'], uvEnv, 'python', emit);
    if (!st.venvReady) await run(uvBin(), ['venv', venvDir(), '--python', '3.12'], uvEnv, 'venv', emit);
    await run(uvBin(), ['pip', 'sync', '--python', venvPython(), '--require-hashes', '--find-links', wheelsDir(), lockPath()], uvEnv, 'deps', emit);
    emit({ event: 'phase', phase: 'harden' });
    await hardenProvisionedTree(venvDir(), uvPythonDir());
    emit({ event: 'phase', phase: 'verify' });
    await verifyRuntime();
    writeManifest();
    emit({ event: 'done', phase: 'done', pct: 100 });
  } catch (e: any) {
    emit({ event: 'error', phase: e?.phase || 'detect', error: String(e?.message || e) });
    throw e;
  }
}

export function cancelBootstrap(): boolean {
  bootChild?.kill();
  bootChild = null;
  return true;
}
