// Shared client for the local-model Python sidecar (local/server.py). One warm process serves every
// on-device stage (i2v, STT, LLM, VLM, keyframes) over localhost; a ModelManager inside it keeps a single
// model resident and unloads it when another stage needs the GPU. Each request carries the model path(s)
// it needs, so this client is model-agnostic — per-stage callers (localVideo.ts, localStt.ts, …) build
// their own payloads and reuse ensureSidecar() + sidecarPost() here. No duplication across stages.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { env, envInt } from './config';
import { FFMPEG, FFPROBE } from './ffmpeg';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function localDir(): string {
  return env('VB_LOCAL_DIR', path.resolve(process.cwd(), 'local'));
}
export function sidecarPort(): number {
  return envInt('VB_LOCAL_PORT', 8765);
}
export function localPython(): string {
  return env('VB_LOCAL_PYTHON', path.join(localDir(), '.venv', 'bin', 'python'));
}
/** Read a path marker setup.sh wrote under local/ (e.g. .model-path, .lightning-dir), '' if absent. */
export function readMarker(name: string): string {
  try {
    // Markers live in the WRITABLE marker dir (userData when packaged), not next to the read-only code.
    const base = env('VB_LOCAL_MARKER_DIR', localDir());
    return fs.readFileSync(path.join(base, name), 'utf8').trim();
  } catch {
    return '';
  }
}

function ping(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: sidecarPort(), path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

let server: ChildProcess | null = null;
let starting: Promise<void> | null = null;

/** Terminate the sidecar we spawned. Idempotent and safe to call when none is running.
 *
 * SIGTERM first so the HTTP server can unwind; a sidecar mid-diffusion holds the GPU lock and will not
 * answer promptly, so escalate to SIGKILL. The child also watches our pid and exits on its own if we die
 * without getting here (hard kill, crash) — see `--parent-pid` in local/server.py. */
export function stopSidecar(): void {
  const child = server;
  if (!child) return;
  server = null;
  try {
    child.kill('SIGTERM');
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    t.unref?.();
  } catch {
    /* already gone */
  }
}

/** Ensure the sidecar process is up: reuse a running one, else spawn `server.py` and wait for /health.
 * Model-agnostic — the per-request payload names the model. Throws if the venv isn't installed. */
export async function ensureSidecar(): Promise<void> {
  if (await ping()) return;
  if (starting) return starting;
  starting = (async () => {
    const py = localPython();
    if (!fs.existsSync(py)) {
      throw new Error("The on-device engine isn't installed yet — open Settings → On-device and click Install.");
    }
    const dir = localDir();
    // config.setEnv() writes the injected paths into a module CFG map, NOT process.env, so the Python child
    // wouldn't inherit them — forward the ones the handlers read (HF cache, marker + models dirs), skipping
    // empties so we never override a child default with ''.
    const passthru: Record<string, string> = {};
    for (const k of ['HUGGINGFACE_HUB_CACHE', 'VB_LOCAL_MARKER_DIR', 'VB_LOCAL_MODELS_DIR']) {
      const v = env(k);
      if (v) passthru[k] = v;
    }
    server = spawn(py, [path.join(dir, 'server.py'), '--port', String(sidecarPort()), '--parent-pid', String(process.pid)], {
      cwd: dir,
      stdio: ['ignore', 'inherit', 'inherit'], // sidecar logs flow to the app's stdout/stderr
      // Hand the bundled ffmpeg/ffprobe to the python handlers (interp/upscale extract + mux frames) so
      // they never depend on a system ffmpeg being installed.
      env: { ...process.env, VB_FFMPEG: FFMPEG, VB_FFPROBE: FFPROBE, ...passthru },
    });
    server.on('exit', () => {
      server = null;
    });
    // Without this the sidecar outlives the app. It is a plain child of the Electron main process, so on
    // macOS it is re-parented to launchd at quit and keeps running — and manager.py holds the last heavy
    // model resident (unload_all() only runs at the head of /i2v), so a session that ended on a storyboard
    // or a portrait leaves FLUX Kontext (~10GB) or the 35B LLM (~19GB) pinned in unified memory until
    // reboot. Only the GUI path was affected: `npm run dev` from a terminal signals the whole process
    // group on Ctrl-C, which is why this never showed up in development.
    process.once('exit', stopSidecar);
    process.once('SIGINT', stopSidecar);
    process.once('SIGTERM', stopSidecar);
    // /health answers as soon as the HTTP server binds (weights load lazily per request), so this is quick.
    const deadline = Date.now() + envInt('VB_LOCAL_START_SEC', 120) * 1000;
    while (Date.now() < deadline) {
      if (await ping()) return;
      if (!server) throw new Error('Local model sidecar exited on startup (see logs above).');
      await sleep(500);
    }
    throw new Error('Local model sidecar did not become ready in time.');
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** POST a JSON job to the sidecar and return its parsed JSON reply. Long timeouts are expected (a clip is
 * minutes). Rejects on socket/timeout errors; resolves with the body (which may carry {ok:false,error}). */
export function sidecarPost(routePath: string, payload: unknown, timeoutMs: number): Promise<any> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: sidecarPort(),
        path: routePath,
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve({ ok: false, error: `bad sidecar response (${res.statusCode})` });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`sidecar ${routePath} timed out`)));
    req.write(body);
    req.end();
  });
}
