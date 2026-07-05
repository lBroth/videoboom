// Local VIDEO backend: Wan 2.2 I2V (MLX) via the resident sidecar. Owns the WHOLE keyframe+clip loop for a
// set of scenes (both the continuous-chain path and the parallel per-scene fallback, toggled by
// VB_LOCAL_CHAIN — the pipeline no longer branches on it). Moved verbatim out of pipeline.ts in C4:
// renderScenesLocalChained + the non-chained path + renderLocalScene + renderClip are byte-for-byte the
// pre-C4 local render, only re-homed and threaded through the ctx. Continuity model: a single start frame
// per native sub-clip, chained from the previous clip's real last frame; the clip is TRIMMED to the frame
// grid (never stretched). See DUAL_BACKEND_PLAN.md §1.7.
import { env, envInt, envBool } from '../../config';
import { lastFrame, concatClips } from '../../ffmpeg';
import * as P from '../../stages';
import * as S from '../../storage';
import { genVideoLocal, localNativeFps, localMaxFrames } from '../../localVideo';
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
  kfWorkers,
} from '../sceneShared';
import type { VideoBackend, SceneRenderCtx, Emit, Cancelled } from '../types';

/** Render a local scene as ONE continuous shot: chain native-length sub-clips — each i2v from the previous
 * clip's last frame (the first from the keyframe) — to fill the scene, then concatenate. This fills a long
 * scene with real motion instead of stretching one short clip (slow-motion), so we can use fewer/longer
 * scenes (fewer cuts). A scene that already fits in one native clip just renders directly. */
async function renderLocalScene(pid: string, k: number, kfFirst: string, clipPrompt: string, wdur: number, raw: string, seed: number, emit: Emit): Promise<[boolean, string]> {
  // Native clip budget from the SELECTED model (the 14B is 16fps — assuming 24 here used to overestimate
  // nativeSec, so chained totals could come out SHORTER than the scene window).
  const fps = Math.max(1, localNativeFps());
  const nativeSec = localMaxFrames() / fps; // one native clip (~2.3s)
  const nSub = Math.max(1, Math.ceil(wdur / nativeSec)); // 1 only when the scene fits one native clip
  // Render native clips (snapped to 4n+1 frames) so the total is always >= the window and renderClip
  // can TRIM (never stretch). A single-clip scene also renders a full native clip, then gets trimmed down.
  if (nSub <= 1) return genVideoLocal(kfFirst, clipPrompt, raw, nativeSec, seed);
  // Sub-clips chain (each continues from the prior clip's last frame) so the total covers the scene
  // window — renderClip then TRIMS the excess (no slow-motion). The LAST sub-clip only renders what's
  // left of the window (+ margin for the 4n+1 down-snap): a full native clip there is denoise time the
  // trim just throws away (up to ~1 clip of GPU per scene).
  const subs: string[] = [];
  let startImg = kfFirst;
  for (let i = 0; i < nSub; i++) {
    const remaining = wdur - i * nativeSec;
    const secs = i === nSub - 1 ? Math.max(1, Math.min(nativeSec, remaining + 0.35)) : nativeSec;
    const subOut = S.tmp(`sub_${pid}_${k}_${i}.mp4`);
    const [sok, serr] = await genVideoLocal(startImg, clipPrompt, subOut, secs, seed + i);
    if (!sok) return [false, serr];
    subs.push(subOut);
    emit({ event: 'subclip', index: k, sub: i + 1, total: nSub });
    if (i < nSub - 1) {
      const lf = await lastFrame(subOut, S.tmp(`lf_${pid}_${k}_${i}.png`));
      if (lf) startImg = lf; // continue the motion from the last frame
    }
  }
  return (await concatClips(subs, raw)) ? [true, ''] : [false, 'failed to assemble chained sub-clips'];
}

async function renderClip(pid: string, k: number, p: any, kfFirst: string, emit: Emit, seed = 42): Promise<[boolean, string]> {
  const sc = S.getScene(pid, k) || {};
  const wdur = Math.max(0.4, Number(sc.endSec || 0) - Number(sc.startSec || 0) || 4);
  // The storyboard's per-scene motion direction (explicit camera move + chained subject action) leads the
  // prompt — i2v models default to a timid push-in without an explicit camera instruction, and appearance
  // text is redundant (the start image already fixes the look). Fallback: the generic per-energy phrase.
  const motion = String(sc.motion || '').trim() || P.MOTION[sc.energy || 'medium'] || P.MOTION.medium;
  const raw = S.tmp(`raw_${pid}_${k}.mp4`);
  // Carry the look into the video prompt so the model keeps it (esp. toon — otherwise it can drift realistic).
  const vstyle = p.videoStyle === 'toon'
    ? '3D animated cartoon, Pixar/DreamWorks style, clearly animated, NOT photorealistic'
    : env('VB_VISUAL_STYLE', '');
  const clipPrompt = stripWrittenText(`${motion}. ${sc.prompt || ''}, cinematic${vstyle ? ', ' + vstyle : ''}`);
  // Wan renders each scene as one continuous shot: a single start frame per native clip, chained into a
  // long shot (renderLocalScene) so a long scene has real motion instead of one stretched slow-mo clip.
  const [ok, err] = await renderLocalScene(pid, k, kfFirst, clipPrompt, wdur, raw, seed, emit);
  if (!ok) {
    const reason = P.isContentBlock(err) ? "This scene was blocked by the model's safety filter." : `Scene render failed: ${(err || '').slice(0, 160)}`;
    putSceneMerged(pid, k, sc, { status: 'failed', error: reason });
    emit({ event: 'scene', index: k, status: 'failed', error: reason });
    return [false, reason];
  }
  // Chained clips are already >= the window → finishClip TRIMS to the exact frame-grid slot (real speed).
  return finishClip(pid, k, sc, raw, false, emit);
}

/** Local continuous-chain render: keyframes only for CUT scenes (the LLM decides cut/continue, an anti-drift
 * cap forces a cut every VB_LOCAL_CHAIN_MAX scenes); clips render SEQUENTIALLY so a 'continue' scene starts
 * from the previous scene's last frame. Fewer keyframes (faster) + seamless motion between scenes. */
async function renderScenesLocalChained(pid: string, p: any, toRender: number[], target: number, toon: boolean, emit: Emit, cancelled: Cancelled): Promise<void> {
  const MAX = Math.max(1, envInt('VB_LOCAL_CHAIN_MAX', 4));
  // Decide cut vs continue in render order (first scene + LLM 'cut' + anti-drift cap force a fresh keyframe).
  const cut: Record<number, boolean> = {};
  let run = 0;
  toRender.forEach((k, i) => {
    const sc = S.getScene(pid, k) || {};
    const isCut = i === 0 || sc.transition === 'cut' || run >= MAX;
    cut[k] = isCut;
    run = isCut ? 0 : run + 1;
  });

  // keyframe pass — CUT scenes only; group by ref variant so the heavy keyframe model swaps at most once.
  const cutScenes = toRender.filter((k) => cut[k]);
  const hasRef = (k: number) => refsForScene(p, S.getScene(pid, k) || {}).length > 0;
  const ordered = [...cutScenes].sort((a, b) => (hasRef(a) ? 1 : 0) - (hasRef(b) ? 1 : 0) || a - b);
  emit({ event: 'stage', stage: 'keyframes', total: ordered.length });
  const kfPaths: Record<number, string | null> = {};
  await mapPool(ordered, kfWorkers(), async (k) => {
    checkCancel(cancelled);
    kfPaths[k] = await buildKeyframe(pid, k, p, toon);
    emit({ event: 'keyframe', index: k, ok: Boolean(kfPaths[k]) });
  });

  // clip pass — SEQUENTIAL: a continue scene starts from the previous scene's last frame.
  emit({ event: 'stage', stage: 'clips', total: toRender.length });
  let prevLast: string | null = null;
  for (const k of toRender) {
    checkCancel(cancelled);
    let start = cut[k] ? kfPaths[k] : prevLast;
    if (!start) start = await buildKeyframe(pid, k, p, toon); // chain broke (or keyframe failed) → fresh keyframe
    const sc = S.getScene(pid, k) || {};
    if (!start) {
      putSceneMerged(pid, k, sc, { status: 'failed', error: 'Could not get a start frame for this scene.' });
      emit({ event: 'scene', index: k, status: 'failed', error: 'no start frame' });
      prevLast = null;
      continue;
    }
    const [ok] = await renderClip(pid, k, p, start, emit);
    prevLast = null;
    if (ok) {
      const clipKey = `${pid}/clips/scene_${k}.mp4`;
      if (S.mediaExists(clipKey)) prevLast = await lastFrame(S.mediaPath(clipKey), S.tmp(`chain_last_${pid}_${k}.png`));
    }
    const d = S.listScenes(pid).filter((s) => s.status === 'done').length;
    S.updateProject(pid, { scenesDone: d, progress: Math.round((0.3 + (0.6 * Math.min(d, target)) / Math.max(1, target)) * 1000) / 1000 });
  }
}

/** Non-chained local path (VB_LOCAL_CHAIN=0): one keyframe per scene, PARALLEL clip pass, each scene from its
 * own fresh keyframe (no continuity between scenes). */
async function renderScenesLocalParallel(pid: string, p: any, toRender: number[], target: number, toon: boolean, emit: Emit, cancelled: Cancelled): Promise<void> {
  // keyframe pass — one keyframe per scene we render. Order so all no-ref (FLUX txt2img) scenes run together
  // and all ref (FLUX Kontext) scenes run together, so a cast-mixed project swaps the heavy keyframe model
  // at most once instead of thrashing it per scene.
  const hasRef = (k: number) => refsForScene(p, S.getScene(pid, k) || {}).length > 0;
  const needed = [...toRender].sort((a, b) => (hasRef(a) ? 1 : 0) - (hasRef(b) ? 1 : 0) || a - b);
  emit({ event: 'stage', stage: 'keyframes', total: needed.length });
  const kfPaths: Record<number, string | null> = {};
  let kfDone = 0;
  await mapPool(needed, kfWorkers(), async (k) => {
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

  // clip pass — render each scene whose keyframe exists.
  const renderable = toRender.filter((k) => kfPaths[k]);
  emit({ event: 'stage', stage: 'clips', total: renderable.length });
  await mapPool(renderable, workers(), async (k) => {
    checkCancel(cancelled);
    await renderClip(pid, k, p, kfPaths[k]!, emit);
    const d = S.listScenes(pid).filter((s) => s.status === 'done').length;
    // Clip pass fills 0.5 -> 1 (the keyframe pass took 0.3 -> 0.5).
    S.updateProject(pid, { scenesDone: d, progress: Math.round((0.5 + (0.5 * Math.min(d, target)) / Math.max(1, target)) * 1000) / 1000 });
  });
}

export const localVideo: VideoBackend = {
  async renderScenes(ctx: SceneRenderCtx): Promise<void> {
    const { pid, p, toRender, target, toon, emit, cancelled } = ctx;
    // Wan renders as a (mostly) continuous chain — the LLM marks each scene cut/continue, a 'continue' scene
    // starts from the previous scene's last frame, an anti-drift cap forces a fresh keyframe. VB_LOCAL_CHAIN=0
    // falls back to the parallel per-scene path (each scene from its own fresh keyframe, no continuity).
    if (envBool('VB_LOCAL_CHAIN', true)) {
      await renderScenesLocalChained(pid, p, toRender, target, toon, emit, cancelled);
    } else {
      await renderScenesLocalParallel(pid, p, toRender, target, toon, emit, cancelled);
    }
  },

  async refreshScene(ctx: SceneRenderCtx, k: number, vary: string): Promise<[boolean, string]> {
    const { pid, p, toon, emit } = ctx;
    const fk = await buildKeyframe(pid, k, p, toon, vary);
    if (!fk) {
      putSceneMerged(pid, k, S.getScene(pid, k) || {}, { status: 'failed', error: 'Keyframe generation failed.' });
      return [false, 'Keyframe generation failed.'];
    }
    emit({ event: 'stage', stage: 'clips', total: 1 });
    const [ok, err] = await renderClip(pid, k, p, fk, emit);
    if (!ok) return [false, err];
    // Re-render the previous scene's clip so its boundary re-flows from its keyframe.
    if (k > 0 && S.mediaExists(`${pid}/keyframes/scene_${k - 1}.png`)) {
      await renderClip(pid, k - 1, p, keyframePath(pid, k - 1), emit);
    }
    return [true, ''];
  },

  timelineRes: () => ({ w: 832, h: 480 }),
  // Real-ESRGAN → 1080 finish. VB_LOCAL_UPSCALE=0 opts a power user out (preserves the pre-C4 gate).
  needsUpscale: () => envBool('VB_LOCAL_UPSCALE', true),
  needsGpu: () => true,
};
