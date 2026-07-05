// Cloud VIDEO backend: Kling image-to-video on the OpenRouter /videos endpoint (first+last-frame morph). No
// backend branch — the registry routed here. `genVideo` is restored from 5125093~1:src/engine/providers.ts
// with its stageBackend/local branch stripped. Continuity model: ONE clip per scene, each morphing toward
// the NEXT scene's keyframe (kf[k+1]); the clip is retimed (fitToWindow) onto the frame grid. renderScenes
// runs the keyframe pass at network-parallel concurrency, then a PARALLEL clip pass. See DUAL_BACKEND_PLAN §1.7.
import fs from 'node:fs';
import { env, envBool } from '../config';
import { costAdd, orCost } from '../cost';
import { OR, orHdr, httpJson, dataUri, fileExists, sleep } from './http';
import * as P from '../stages';
import * as S from '../storage';
import {
  refsForScene,
  buildKeyframe,
  keyframePath,
  stripWrittenText,
  putSceneMerged,
  finishClip,
  mapPool,
  checkCancel,
  workers,
} from '../backends/sceneShared';
import type { VideoBackend, SceneRenderCtx, Emit } from '../backends/types';

const CLIP_MIN_SEC = 3;
const CLIP_MAX_SEC = 15;

/** Image-to-video on the OpenRouter /videos endpoint via Kling (first+last frame). Returns [ok, err].
 * Synchronous submit+poll — a desktop process has no 15-min cap. */
export async function genVideo(
  img: string,
  prompt: string,
  outMp4: string,
  seconds: number,
  lastFrame?: string | null,
  model?: string | null,
  seed = 42,
): Promise<[boolean, string]> {
  model = model || env('VB_OR_VIDEO_MODEL', 'kwaivgi/kling-v3.0-std');
  const dur = Math.max(CLIP_MIN_SEC, Math.min(CLIP_MAX_SEC, Math.trunc(Math.round(seconds || CLIP_MIN_SEC))));
  const genAudio = envBool('VB_OR_GENERATE_AUDIO', false);
  const body: any = {
    model,
    prompt,
    duration: dur,
    seed: Math.trunc(seed),
    aspect_ratio: env('VB_OR_ASPECT', '16:9'),
    generate_audio: genAudio,
    usage: { include: true },
  };
  const frames: any[] = [];
  for (const [path, ftype] of [
    [img, 'first_frame'],
    [lastFrame, 'last_frame'],
  ] as [string | null | undefined, string][]) {
    if (path && fileExists(path)) frames.push({ type: 'image_url', image_url: { url: dataUri(path) }, frame_type: ftype });
  }
  if (frames.length) body.frame_images = frames;
  let lastErr = 'unknown error';
  const deadline = Date.now() + parseFloat(env('VB_VIDEO_DEADLINE_SEC', '600')) * 1000;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (Date.now() > deadline) return [false, 'video provider timed out (no response within budget) — try again'];
    let r: any;
    try {
      r = await httpJson(OR + '/videos', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 60_000);
    } catch (ex: any) {
      if (ex?.status) {
        lastErr = String(ex.body || '').slice(0, 300);
        if (P.isContentBlock(lastErr)) return [false, lastErr];
      } else {
        lastErr = `request error: ${ex?.message || ex}`;
      }
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const jid = r.id;
    const poll = r.polling_url || `${OR}/videos/${r.id}`;
    let status = r.status || 'pending';
    for (let i = 0; i < 100; i++) {
      if (status === 'completed' || status === 'failed') break;
      if (Date.now() > deadline) return [false, 'video provider timed out while rendering — try again'];
      await sleep(6000);
      try {
        r = await httpJson(poll, { headers: orHdr() }, 60_000);
        status = r.status || status;
      } catch {
        /* keep polling */
      }
    }
    if (status === 'completed') {
      costAdd(orCost(r));
      const urls = r.unsigned_urls || [`${OR}/videos/${jid}/content?index=0`];
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 300_000);
        const resp = await fetch(urls[0], { headers: orHdr(), signal: ac.signal });
        clearTimeout(t);
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(outMp4, buf);
        if (fileExists(outMp4)) return [true, ''];
      } catch (ex: any) {
        lastErr = `download error: ${ex?.message || ex}`;
      }
    } else {
      lastErr = String(r.error || 'generation failed');
      if (P.isContentBlock(lastErr)) return [false, lastErr];
    }
    await sleep(2 ** attempt * 1000);
  }
  return [false, lastErr];
}

async function renderClip(pid: string, k: number, p: any, kfFirst: string, kfLast: string | null, emit: Emit, seed = 42): Promise<[boolean, string]> {
  const sc = S.getScene(pid, k) || {};
  const wdur = Math.max(0.4, Number(sc.endSec || 0) - Number(sc.startSec || 0) || 4);
  // The storyboard's per-scene motion direction (explicit camera move + chained subject action) leads the
  // prompt — i2v models default to a timid push-in without an explicit camera instruction, and appearance
  // text is redundant (the start image already fixes the look). Fallback: the generic per-energy phrase.
  const motion = String(sc.motion || '').trim() || P.MOTION[sc.energy || 'medium'] || P.MOTION.medium;
  const vmodel = p.videoModel || null;
  const raw = S.tmp(`raw_${pid}_${k}.mp4`);
  // Carry the look into the video prompt so the model keeps it (esp. toon — otherwise it can drift realistic).
  const vstyle = p.videoStyle === 'toon'
    ? '3D animated cartoon, Pixar/DreamWorks style, clearly animated, NOT photorealistic'
    : env('VB_VISUAL_STYLE', '');
  const clipPrompt = stripWrittenText(`${motion}. ${sc.prompt || ''}, cinematic${vstyle ? ', ' + vstyle : ''}`);
  // Kling makes one clip per scene, morphing from this keyframe toward the NEXT scene's keyframe (last_frame).
  const [ok, err] = await genVideo(kfFirst, clipPrompt, raw, wdur, kfLast, vmodel, seed);
  if (!ok) {
    const reason = P.isContentBlock(err) ? "This scene was blocked by the model's safety filter." : `Scene render failed: ${(err || '').slice(0, 160)}`;
    putSceneMerged(pid, k, sc, { status: 'failed', error: reason });
    emit({ event: 'scene', index: k, status: 'failed', error: reason });
    return [false, reason];
  }
  // Cloud clips can be shorter/longer than the window → finishClip fitToWindow retimes to the frame grid.
  return finishClip(pid, k, sc, raw, true, emit);
}

export const cloudVideo: VideoBackend = {
  async renderScenes(ctx: SceneRenderCtx): Promise<void> {
    const { pid, p, toRender, target, toon, emit, cancelled } = ctx;
    const n = Number(p.sceneCount || 0);
    // keyframe pass — each scene we render + its morph target (next scene's keyframe). Order so all no-ref
    // (txt2img) scenes run together and all ref scenes run together, so a cast-mixed project swaps the heavy
    // keyframe model at most once. Generation order doesn't affect which keyframes exist, so this is safe.
    const hasRef = (k: number) => refsForScene(p, S.getScene(pid, k) || {}).length > 0;
    const needed = Array.from(new Set([...toRender, ...toRender.filter((k) => k + 1 < n).map((k) => k + 1)])).sort(
      (a, b) => (hasRef(a) ? 1 : 0) - (hasRef(b) ? 1 : 0) || a - b,
    );
    emit({ event: 'stage', stage: 'keyframes', total: needed.length });
    const kfPaths: Record<number, string | null> = {};
    let kfDone = 0;
    await mapPool(needed, P.keyframeConcurrency(), async (k) => {
      checkCancel(cancelled);
      const path = await buildKeyframe(pid, k, p, toon);
      kfPaths[k] = path;
      kfDone++;
      // Keyframe phase fills 0.3 -> 0.5 so the bar moves while keyframes generate (the clip pass takes 0.5->1).
      S.updateProject(pid, { progress: Math.round((0.3 + (0.2 * kfDone) / Math.max(1, needed.length)) * 1000) / 1000 });
      emit({ event: 'keyframe', index: k, ok: Boolean(path) });
    });

    for (const k of toRender) {
      if (!kfPaths[k]) {
        const sc = S.getScene(pid, k) || {};
        putSceneMerged(pid, k, sc, { status: 'failed', error: 'Keyframe generation failed.' });
        emit({ event: 'scene', index: k, status: 'failed', error: 'keyframe failed' });
      }
    }

    // clip pass — render each scene whose keyframe exists, in PARALLEL. last_frame = next keyframe (morph).
    const renderable = toRender.filter((k) => kfPaths[k]);
    emit({ event: 'stage', stage: 'clips', total: renderable.length });
    await mapPool(renderable, workers(), async (k) => {
      checkCancel(cancelled);
      await renderClip(pid, k, p, kfPaths[k]!, kfPaths[k + 1] || null, emit);
      const d = S.listScenes(pid).filter((s) => s.status === 'done').length;
      // Clip pass fills 0.5 -> 1 (the keyframe pass took 0.3 -> 0.5).
      S.updateProject(pid, { scenesDone: d, progress: Math.round((0.5 + (0.5 * Math.min(d, target)) / Math.max(1, target)) * 1000) / 1000 });
    });
  },

  async refreshScene(ctx: SceneRenderCtx, k: number, vary: string): Promise<[boolean, string]> {
    const { pid, p, toon, emit } = ctx;
    const n = Number(p.sceneCount || 0);
    const fk = await buildKeyframe(pid, k, p, toon, vary);
    if (!fk) {
      putSceneMerged(pid, k, S.getScene(pid, k) || {}, { status: 'failed', error: 'Keyframe generation failed.' });
      return [false, 'Keyframe generation failed.'];
    }
    const lastK = k + 1 < n && S.mediaExists(`${pid}/keyframes/scene_${k + 1}.png`) ? keyframePath(pid, k + 1) : null;
    emit({ event: 'stage', stage: 'clips', total: 1 });
    const [ok, err] = await renderClip(pid, k, p, fk, lastK, emit);
    if (!ok) return [false, err];
    // Re-render the neighbour k-1 with the fresh keyframe as ITS last_frame, so both boundaries morph correctly.
    if (k > 0 && S.mediaExists(`${pid}/keyframes/scene_${k - 1}.png`)) {
      await renderClip(pid, k - 1, p, keyframePath(pid, k - 1), fk, emit);
    }
    return [true, ''];
  },

  timelineRes: () => ({ w: 1280, h: 720 }),
  needsUpscale: () => false,
  needsGpu: () => false,
};
