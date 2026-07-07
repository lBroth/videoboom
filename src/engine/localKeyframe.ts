// Local keyframe stage via the shared sidecar (mflux FLUX). Backs stages.keyframe's
// (prompt, outPath, refs, toon) -> boolean contract. A single identity reference (the lead) routes through
// FLUX Kontext; no reference -> FLUX schnell text->image.
import fs from 'node:fs';
import { env, envInt } from './config';
import { ensureSidecar, sidecarPost } from './sidecar';

// Positive phrasing first ("blank, unbranded") — FLUX follows scene description far better than trailing
// negations, and schnell has no negative-prompt channel at all.
const NOSIGN =
  '16:9 widescreen, medium-to-wide framing with the whole scene visible — never a close-up, no face or single object filling the frame. Every surface, screen, monitor, sign and package is blank, glowing and unbranded — zero readable text anywhere: no letters, words, numbers, code, logs, badges, checkmarks, status bars, charts, UI, captions, watermark or logo. Screens show only abstract glowing colour. No Asian/Chinese/Japanese/Korean signage.';
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
  let text: string;
  if (ref && toon) {
    // Toon + cast: the reference is a real photo, so "preserve identity" + the photo overpower a trailing
    // toon tag → keep identity but make the toon style DOMINATE (convert the character to animated).
    // A flat/pastel reference (e.g. a logo mascot) also drags the WHOLE frame into a monochrome logo-style
    // wash — demand a fully rendered world around the character.
    text = `${TOON}. Redraw the SAME character as the reference photo as a fully animated cartoon character — keep their identity (face shape, hair, build, age) but render them clearly stylized/cartoon, NOT photorealistic. The character is INSIDE a fully rendered, detailed 3D environment with rich BALANCED cinematic colors and proper lighting — never a flat monochrome logo-style illustration, never a single-color wash. Scene: ${prompt}. ${NOSIGN}`;
  } else if (ref) {
    text = `Place this EXACT person into a new cinematic scene, preserving their identity (face, hair, age, build). Scene: ${prompt}. ${vstyle}. ${NOSIGN}`;
  } else {
    text = `${vstyle ? vstyle + '. ' : ''}${prompt}. Cinematic. ${NOSIGN}`;
  }
  const payload: Record<string, unknown> = {
    out: outPath,
    prompt: text,
    // Match the video model's input size so the keyframe isn't up/downscaled (saves Kontext time + avoids a
    // resize). settingsEnv sets these per model (LTX 896x512, Wan 832x480); default to LTX.
    width: envInt('VB_LOCAL_KEYFRAME_W', 896),
    height: envInt('VB_LOCAL_KEYFRAME_H', 512),
    // Deterministic per-scene seed from the output path (so a plain rebuild is stable), UNLESS the editor's
    // keyframe re-roll set VB_LOCAL_KEYFRAME_SEED to force a genuinely different image.
    seed: envInt('VB_LOCAL_KEYFRAME_SEED', seedFor(outPath)),
    model: env('VB_LOCAL_KEYFRAME_MODEL', 'dhairyashil/FLUX.1-schnell-mflux-4bit'), // ungated mirror; BFL schnell is HF-gated
  };
  if (ref) {
    payload.ref = ref;
    payload.kontext_steps = envInt('VB_LOCAL_KONTEXT_STEPS', 8); // FLUX Kontext holds identity at 8 steps (anchored to the ref photo); ~33% faster than 12
  }
  try {
    const r = await sidecarPost('/keyframe', payload, envInt('VB_LOCAL_KEYFRAME_DEADLINE_SEC', 1200) * 1000);
    return Boolean(r?.ok) && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch {
    return false;
  }
}
