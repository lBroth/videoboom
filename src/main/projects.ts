// Read project / character / scene state straight off disk (the sidecar owns writes; the renderer reads).
// Media keys (e.g. '<pid>/output/music_video.mp4') resolve to file:// URLs the renderer can load directly.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dataDir } from '../engine';

function readJSON<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}

/** Absolute file:// URL for a stored media key, or undefined if the file isn't there yet. */
export function mediaUrl(key?: string | null): string | undefined {
  if (!key) return undefined;
  const abs = path.join(dataDir(), key);
  return fs.existsSync(abs) ? pathToFileURL(abs).href : undefined;
}

export function getProject(pid: string): Record<string, unknown> | null {
  return readJSON(path.join(dataDir(), pid, 'project.json'));
}

export function listScenes(pid: string): Record<string, unknown>[] {
  const dir = path.join(dataDir(), pid, 'scenes');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJSON<Record<string, unknown>>(path.join(dir, f)))
      .filter((x): x is Record<string, unknown> => x !== null)
      .sort((a, b) => Number(a.index) - Number(b.index));
  } catch {
    return [];
  }
}

export function listProjects(): Record<string, unknown>[] {
  const root = dataDir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(root); } catch { return []; }
  return entries
    .filter((d) => d !== 'characters' && fs.existsSync(path.join(root, d, 'project.json')))
    .map((d) => getProject(d))
    .filter((p): p is Record<string, unknown> => p !== null)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function listCharacters(): Record<string, unknown>[] {
  const dir = path.join(dataDir(), 'characters');
  try {
    return fs.readdirSync(dir)
      .map((d) => readJSON<Record<string, unknown>>(path.join(dir, d, 'character.json')))
      .filter((c): c is Record<string, unknown> => c !== null);
  } catch {
    return [];
  }
}
