// Backend-agnostic scene helpers, shared by BOTH video impls (local/video.ts + cloud/video.ts) so the
// keyframe identity, ref roster, prompt-text stripping, cancellation, concurrency and frame-grid finish are
// byte-identical no matter which backend renders. Moved verbatim out of pipeline.ts in C4 (the pipeline now
// names no backend). See DUAL_BACKEND_PLAN.md §1.7. `finishClip` is the tail of the old renderClip — it
// picks trim-vs-fit from the backend, both targeting the same telescoping frame grid.
import { envInt } from '../config';
import { putThumb, fitToWindow, trimToWindow, ffmpeg } from '../ffmpeg';
import * as P from '../stages';
import * as S from '../storage';
import type { Emit, Cancelled } from './types';

// ── concurrency ────────────────────────────────────────────────────────────────
export const workers = () => Math.max(1, envInt('VB_WORKERS', 4));
// Keyframe pool width for the local path. Keyframes are on-device (FLUX/Kontext) and share the GPU, so they
// use the same serialized pool as the rest of the render (VB_WORKERS, forced to 1 for the local video guard).
export const kfWorkers = () => workers();

// ── cancellation ────────────────────────────────────────────────────────────────
export class Cancel extends Error {}
export function checkCancel(cancelled: Cancelled): void {
  if (cancelled()) throw new Cancel('cancelled');
}

/** Run fn over items with a bounded concurrency (mirrors the old ThreadPoolExecutor(max_workers)). */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) break;
        ret[i] = await fn(items[i], i);
      }
    }),
  );
  return ret;
}

// ── cast / refs ───────────────────────────────────────────────────────────────
function castRoles(p: any): Record<string, string> {
  const roles: Record<string, string> = {};
  (p.cast || []).forEach((c: any, i: number) => {
    const cid = typeof c === 'object' ? c.id : c;
    if (cid) roles[cid] = (typeof c === 'object' ? c.role : null) || (i === 0 ? 'lead' : 'supporting');
  });
  return roles;
}

export function refsForScene(p: any, scene: any): [string, string][] {
  const roles = castRoles(p);
  const leadId = Object.keys(roles)[0] || null;
  let cids: string[] = (scene.characters || []).filter(Boolean);
  if (!cids.length && leadId) cids = [leadId];
  const cap = envInt('VB_MAX_SUBJECTS', 4);
  const out: [string, string][] = [];
  for (const cid of cids.slice(0, cap)) {
    const rk = `characters/${cid}/primary.png`;
    if (!S.mediaExists(rk)) continue;
    const lp = S.mediaPath(rk);
    const ch = S.getCharacter(cid) || {};
    let label = ch.name || 'character';
    const role = roles[cid];
    if (role && role !== 'lead') label = `${label} (the ${role})`;
    out.push([lp, label]);
  }
  return out;
}

// ── keyframe pass ──────────────────────────────────────────────────────────────
export function keyframePath(pid: string, k: number): string {
  return S.mediaPath(`${pid}/keyframes/scene_${k}.png`);
}

/** The LLM still sneaks renderable text into shot descriptions as quoted literals (a green 'SHIP IT'
 * button) despite the no-text rules — and the image model then draws it garbled. Deterministic last line
 * of defense: strip quoted literals and "that says/labeled ..." phrasings before the prompt reaches any
 * image/video model. The composition survives; the lettering never gets asked for. */
export function stripWrittenText(s: string): string {
  return String(s || '')
    .replace(/"[^"]{1,40}"/g, '')                     // double-quoted literals
    .replace(/[“”‘’][^“”‘’]{1,40}[“”‘’]/g, '')        // curly-quoted literals
    .replace(/'[A-Z0-9][A-Z0-9 !._-]{1,30}'/g, '')    // single-quoted ALL-CAPS labels ('SHIP IT') — not apostrophes
    .replace(/\b(?:that (?:says|reads)|which (?:says|reads)|reading|labell?ed|with the words?|text saying|saying)\b[^,.;]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1');
}

export function putSceneMerged(pid: string, k: number, sc: any, updates: Record<string, unknown>): void {
  const cur = { ...sc, ...updates };
  delete cur.projectId;
  delete cur.index;
  S.putScene(pid, k, cur);
}

export async function buildKeyframe(pid: string, k: number, p: any, toon: boolean, refresh = ''): Promise<string | null> {
  const key = `${pid}/keyframes/scene_${k}.png`;
  const out = keyframePath(pid, k);
  const sc = S.getScene(pid, k) || {};
  if (!refresh && S.mediaExists(key)) {
    await putThumb(out, `${pid}/keyframes/scene_${k}_thumb.jpg`);
    return out;
  }
  let prompt = stripWrittenText(sc.prompt || '');
  if (refresh) prompt = `${prompt}, ${refresh}, no extreme close-up`;
  S.mkdirp(S.mediaPath(`${pid}/keyframes`));
  if (!(await P.keyframe(prompt, out, refsForScene(p, sc), toon))) return null;
  await putThumb(out, `${pid}/keyframes/scene_${k}_thumb.jpg`);
  return out;
}

/** A cast id whose character was deleted must FAIL the render loudly — silently dropping the reference
 * (the old behavior) produces confidently wrong videos: keyframes lose the identity/product anchor and
 * the director invents its own subject. */
export function assertCastExists(pid: string, p: any): void {
  const missing = (p.cast || [])
    .map((c: any) => (typeof c === 'object' ? c.id : c))
    .filter((cid: string) => cid && !S.mediaExists(`characters/${cid}/primary.png`));
  if (missing.length) {
    const msg = 'A cast member of this project no longer exists (deleted character). Re-select the cast in Studio, then render again.';
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: msg });
    throw new Error('cast member missing');
  }
}

// ── clip finish ────────────────────────────────────────────────────────────────
/** The tail of the old renderClip, shared by both backends. `useFit` picks the frame-grid conform: cloud
 * clips can be shorter/longer than the window → fitToWindow retimes them; local chained clips are already
 * ≥ the window → trimToWindow cuts the excess (real speed, never slow-motion). Both target the identical
 * telescoping grid round(end·fps)−round(start·fps). Then a first-frame thumbnail for chained scenes with no
 * keyframe file, and the scene status/emit. */
export async function finishClip(pid: string, k: number, sc: any, raw: string, useFit: boolean, emit: Emit): Promise<[boolean, string]> {
  const sceneOut = S.tmp(`scene_${pid}_${k}.mp4`);
  const fit = useFit
    ? await fitToWindow(raw, sc.startSec || 0, sc.endSec || 0, sceneOut)
    : await trimToWindow(raw, sc.startSec || 0, sc.endSec || 0, sceneOut);
  S.copyIn(fit, `${pid}/clips/scene_${k}.mp4`);
  // Chained 'continue' scenes have no keyframe file (they start from the previous clip's last frame) —
  // give the UI a real thumbnail by grabbing the finished clip's first frame.
  if (!S.mediaExists(`${pid}/keyframes/scene_${k}.png`)) {
    S.mkdirp(S.mediaPath(`${pid}/keyframes`));
    const kfOut = keyframePath(pid, k);
    if (await ffmpeg(['-i', fit, '-frames:v', '1', kfOut])) await putThumb(kfOut, `${pid}/keyframes/scene_${k}_thumb.jpg`);
  }
  putSceneMerged(pid, k, sc, { status: 'done', error: '', clipKey: `${pid}/clips/scene_${k}.mp4` });
  emit({ event: 'scene', index: k, status: 'done' });
  return [true, ''];
}
