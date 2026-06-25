// Engine entry: the in-process replacement for the old Python sidecar. Same contract as before —
// runEngine(command, args, env, onEvent) streams progress events and resolves with the terminal `result`
// — so the main process and renderer are unchanged. No child Python, no PyInstaller: the render engine is
// TypeScript, ffmpeg is the bundled static binary, and all generation is the user's own cloud API calls.
import { setEnv } from './config';
import { costReset, costTotal } from './cost';
import { dataDir, getProject } from './storage';
import * as PL from './pipeline';

export { dataDir };

export type EngineEvent =
  | { event: 'stage'; stage: string; total?: number }
  | { event: 'keyframe'; index: number; ok: boolean }
  | { event: 'scene'; index: number; status: 'done' | 'failed'; error?: string }
  | { event: 'done'; status: string; videoKey: string; scenesFailed: number; scenesDone: number; costCents: number }
  | { event: 'result'; [k: string]: unknown }
  | { event: 'error'; message: string; trace?: string }
  | { event: string; [k: string]: unknown };

export interface EngineRun {
  done: Promise<Record<string, unknown>>;
  cancel: () => void;
}

/** CLI-style arg array (['--key','val','--flag',...]) -> a flag map. Bare flags become true. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
const str = (v: string | boolean | undefined, d = ''): string => (typeof v === 'string' ? v : d);

async function dispatch(command: string, f: Record<string, string | boolean>, emit: PL.Emit, cancelled: PL.Cancelled): Promise<Record<string, unknown>> {
  switch (command) {
    case 'create-project':
      return PL.createProject({
        audio: str(f.audio),
        name: str(f.name),
        style: str(f.style),
        cast: str(f.cast),
        quality: str(f.quality, 'fast'),
        mode: str(f.mode, 'realistic'),
        videoModel: str(f['video-model']),
        id: str(f.id),
      });
    case 'character-create':
      return PL.characterCreate({ name: str(f.name), style: str(f.style), id: str(f.id) });
    case 'character-portrait': {
      const r = await PL.characterPortrait(str(f.character), str(f.photo), str(f.prompt), emit);
      return { ...r, costCents: costTotal() };
    }
    case 'render': {
      const pid = str(f.project);
      await PL.render(pid, emit, Boolean(f.preview), cancelled);
      const p = getProject(pid) || {};
      return { projectId: pid, status: p.status, videoKey: p.videoKey, costCents: costTotal() };
    }
    case 'resume': {
      const pid = str(f.project);
      await PL.resume(pid, emit, cancelled);
      const p = getProject(pid) || {};
      return { projectId: pid, status: p.status, videoKey: p.videoKey, costCents: costTotal() };
    }
    case 'regenerate-scene': {
      const pid = str(f.project);
      const index = parseInt(str(f.index, '0'), 10);
      await PL.regenerateScene(pid, index, emit);
      return { projectId: pid, index, costCents: costTotal() };
    }
    case 'get-project':
      return { project: getProject(str(f.project)) };
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/**
 * Run one engine operation. `extraEnv` carries the BYOK keys + model overrides (keychain + settings).
 * `onEvent` receives every progress event live; the returned promise resolves with the terminal `result`
 * (or rejects on error) — identical to the old sidecar contract.
 */
export function runEngine(command: string, args: string[], extraEnv: Record<string, string>, onEvent: (e: EngineEvent) => void): EngineRun {
  let cancelled = false;
  const emit = (e: EngineEvent) => {
    try {
      onEvent(e);
    } catch {
      /* a renderer that went away must not crash a render */
    }
  };
  const done = (async () => {
    setEnv({ ...extraEnv, VB_DATA_DIR: dataDir() });
    costReset();
    const f = parseFlags(args);
    try {
      const payload = await dispatch(command, f, emit, () => cancelled);
      const result = { event: 'result', ...payload } as Record<string, unknown>;
      emit(result as EngineEvent);
      return result;
    } catch (err: any) {
      const message = `${err?.name || 'Error'}: ${err?.message ?? err}`;
      emit({ event: 'error', message, trace: String(err?.stack || '').slice(-1200) });
      throw new Error(message);
    }
  })();
  return { done, cancel: () => { cancelled = true; } };
}
