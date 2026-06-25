// Local filesystem state + media (replaces the cloud pipeline's DynamoDB + S3). A project lives in one
// directory tree under the data dir: <pid>/project.json, <pid>/scenes/<i>.json, <pid>/clips, keyframes,
// output; characters under characters/<cid>/. State is plain JSON. Reads/writes are SYNCHRONOUS so a
// read-modify-write (e.g. update_project from parallel clip tasks) is atomic within the single-threaded
// event loop — no torn writes, no lock needed.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { env } from './config';

/** The per-user data directory (projects/characters/media). Survives app updates.
 * electron is required lazily so the engine modules can be imported (e.g. in unit tests) outside Electron. */
export function dataDir(): string {
  let base = process.env.VB_DATA_DIR;
  if (!base) {
    const { app } = require('electron') as typeof import('electron');
    base = path.join(app.getPath('userData'), 'data');
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function mediaRoot(): string {
  return env('VB_DATA_DIR') || dataDir();
}

/** Resolve a storage key (e.g. '<pid>/clips/scene_3.mp4') to its absolute path under the data dir. */
export function mediaPath(key: string): string {
  return path.join(mediaRoot(), key);
}

/** A scratch path under the OS temp dir (cross-platform — never hardcode /tmp). */
export function tmp(name: string): string {
  const d = path.join(os.tmpdir(), 'videoboom');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
}

function readJson<T = any>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmpPath = p + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(obj));
  fs.renameSync(tmpPath, p); // atomic — a reader never sees a half-written file
}

// ── project + scene state ──────────────────────────────────────────────────────
function projectPath(pid: string): string {
  return path.join(mediaRoot(), pid, 'project.json');
}

export function getProject(pid: string): any | null {
  return readJson(projectPath(pid));
}

export function updateProject(pid: string, patch: Record<string, unknown>): any {
  const item = getProject(pid) || { id: pid };
  Object.assign(item, patch);
  writeJson(projectPath(pid), item);
  return item;
}

export function putProject(item: any): any {
  writeJson(projectPath(item.id), item);
  return item;
}

function scenePath(pid: string, index: number): string {
  return path.join(mediaRoot(), pid, 'scenes', `${Math.trunc(index)}.json`);
}

export function putScene(pid: string, index: number, fields: Record<string, unknown>): any {
  const item = { projectId: pid, index: Math.trunc(index), ...fields };
  writeJson(scenePath(pid, index), item);
  return item;
}

export function getScene(pid: string, index: number): any | null {
  return readJson(scenePath(pid, index));
}

export function listScenes(pid: string): any[] {
  const d = path.join(mediaRoot(), pid, 'scenes');
  let files: string[];
  try {
    files = fs.readdirSync(d);
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const fn of files) {
    if (!fn.endsWith('.json')) continue;
    const it = readJson(path.join(d, fn));
    if (it != null) out.push(it);
  }
  return out.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
}

// ── character state ─────────────────────────────────────────────────────────────
function characterPath(cid: string): string {
  return path.join(mediaRoot(), 'characters', cid, 'character.json');
}

export function getCharacter(cid: string): any | null {
  return readJson(characterPath(cid));
}

export function putCharacter(item: any): any {
  writeJson(characterPath(item.id), item);
  return item;
}

export function updateCharacter(cid: string, patch: Record<string, unknown>): any {
  const item = getCharacter(cid) || { id: cid };
  Object.assign(item, patch);
  writeJson(characterPath(cid), item);
  return item;
}

// ── media (local filesystem) ──────────────────────────────────────────────────
/** Copy a stored object out to a working path (keeps the handlers' /tmp working-file flow). */
export function copyOut(key: string, dest: string): string {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(mediaPath(key), dest);
  return dest;
}

/** Store a working file under a storage key. */
export function copyIn(src: string, key: string): string {
  const dst = mediaPath(key);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return key;
}

export function mediaExists(key: string): boolean {
  return fs.existsSync(mediaPath(key));
}

export function copyFileIn(src: string, dstAbs: string): void {
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(src, dstAbs);
}

export function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function readBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

export function writeBytes(p: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

export function writeText(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

export function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
