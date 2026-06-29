// Local keyframe stage via the shared sidecar (mflux FLUX). Mirrors providers.cloudKeyframe's
// (prompt, outPath, refs, toon) -> boolean contract. A single identity reference (the lead) routes through
// FLUX Kontext; no reference -> FLUX schnell text->image. Used when VB_KEYFRAME_BACKEND=local.
import fs from 'node:fs';
import { env, envInt } from './config';
import { ensureSidecar, sidecarPost } from './sidecar';

const NOSIGN =
  '16:9 widescreen. No readable text, no letters, no words, no captions, no watermark, no logo. No Asian/Chinese/Japanese/Korean signage.';
const TOON = '3D animated movie still, Pixar/DreamWorks style, vibrant stylized cartoon, clearly animated, NOT photorealistic';

/** Stable per-scene seed from the output path so each scene differs but re-renders are deterministic. */
function seedFor(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2_000_000;
}

export async function keyframeLocal(prompt: string, outPath: string, refs: [string, string][] = [], toon = false): Promise<boolean> {
  try {
    await ensureSidecar();
  } catch {
    return false;
  }
  const vstyle = toon ? TOON : env('VB_VISUAL_STYLE', '');
  const ref = (refs.find(([p]) => p && fs.existsSync(p)) || [])[0];
  const text = ref
    ? `Place this EXACT person into a new cinematic scene, preserving their identity (face, hair, age, build). Scene: ${prompt}. ${vstyle}. ${NOSIGN}`
    : `${vstyle ? vstyle + '. ' : ''}${prompt}. Cinematic. ${NOSIGN}`;
  const payload: Record<string, unknown> = {
    out: outPath,
    prompt: text,
    width: envInt('VB_LOCAL_KEYFRAME_W', 1024),
    height: envInt('VB_LOCAL_KEYFRAME_H', 576),
    seed: seedFor(outPath),
    model: env('VB_LOCAL_KEYFRAME_MODEL', 'dhairyashil/FLUX.1-schnell-mflux-4bit'), // ungated mirror; BFL schnell is HF-gated
  };
  if (ref) payload.ref = ref;
  try {
    const r = await sidecarPost('/keyframe', payload, envInt('VB_LOCAL_KEYFRAME_DEADLINE_SEC', 1200) * 1000);
    return Boolean(r?.ok) && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch {
    return false;
  }
}
