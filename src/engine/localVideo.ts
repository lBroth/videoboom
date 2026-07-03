// Local image-to-video stage: Wan 2.2 I2V-A14B (MLX) via the shared sidecar (see sidecar.ts). Only the
// video-specific bits live here — the model dir, the Lightning LoRA, and the i2v payload; the process
// lifecycle + HTTP are reused from sidecar.ts. Used when VB_VIDEO_BACKEND=local.
import path from 'node:path';
import fs from 'node:fs';
import { env, envInt, envBool } from './config';
import { vW, vH } from './ffmpeg';
import { ensureSidecar, sidecarPost, readMarker } from './sidecar';

/** Which local i2v model:
 * '14b' = Wan2.2-I2V-A14B + Lightning 4-step (default — sharp x16 VAE, best quality, no deform; slow),
 * '5b'  = Wan2.2-TI2V-5B (single start frame, fast, but its x64 VAE deforms people),
 * 'ltx' = LTX-2.3 distilled (896x512, fast, weaker i2v motion; first+last morph opt-in). */
export function videoModel(): 'ltx' | '5b' | '14b' {
  const m = env('VB_LOCAL_VIDEO_MODEL', '14b');
  return m === '5b' || m === 'ltx' ? m : '14b';
}

/** Native output fps of the selected local model. The 14B saves at Wan's config sample_fps=16; the 5B and
 * LTX are 24. The pipeline needs this to budget native clip seconds AND to know when to interpolate — a
 * 16fps clip conformed to the 24fps timeline by `fps=24` alone gets every other frame duplicated (judder). */
export function localNativeFps(): number {
  const m = videoModel();
  if (m === 'ltx') return envInt('VB_LOCAL_LTX_FPS', 24);
  return envInt('VB_LOCAL_WAN_FPS', m === '5b' ? 24 : 16);
}

/** Frame cap of the selected local model (the 48GB Metal working-set ceiling at 480p). */
export function localMaxFrames(): number {
  const m = videoModel();
  if (m === 'ltx') return envInt('VB_LOCAL_LTX_MAX_FRAMES', 97);
  return envInt('VB_LOCAL_MAX_FRAMES', m === '5b' ? 57 : 37);
}

/** Converted MLX model dir for the selected model (explicit override, else the setup.sh marker). */
function modelDir(): string {
  const m = videoModel();
  if (m === 'ltx') return env('VB_LOCAL_LTX_DIR') || readMarker('.model-path-ltx');
  if (m === '5b') return env('VB_LOCAL_WAN_5B_DIR') || readMarker('.model-path-5b');
  return env('VB_LOCAL_WAN_DIR') || readMarker('.model-path');
}

/** Wan2.2-Lightning 4-step LoRA dir (high/low noise safetensors): explicit override, else .lightning-dir.
 * Returns the two paths if both exist. */
function lightningLoras(): { high: string; low: string } | null {
  const dir = env('VB_LOCAL_LIGHTNING_DIR') || readMarker('.lightning-dir');
  if (!dir) return null;
  const high = path.join(dir, 'high_noise_model.safetensors');
  const low = path.join(dir, 'low_noise_model.safetensors');
  return fs.existsSync(high) && fs.existsSync(low) ? { high, low } : null;
}

/** Generate one clip locally. Mirrors providers.genVideo's [ok, err] contract. `endImg` (the next scene's
 * keyframe) is used by the LTX backend as a last-frame morph target for smooth scene-to-scene flow; the Wan
 * backends are single-start-frame and ignore it. */
export async function genVideoLocal(img: string, prompt: string, outMp4: string, seconds: number, seed = 42, endImg: string | null = null): Promise<[boolean, string]> {
  const model = videoModel();
  const md = modelDir();
  if (!md || !fs.existsSync(md)) {
    return [false, 'Local video model not found. Run `bash local/setup.sh` (or set the model dir env).'];
  }
  try {
    await ensureSidecar();
  } catch (e: any) {
    return [false, e?.message || String(e)];
  }

  // ── LTX-2.3: first+last frame morph, 896x512, two-stage distilled ──────────────────────────────
  if (model === 'ltx') {
    const payload: Record<string, unknown> = {
      engine: 'ltx',
      model_dir: md,
      image: img,
      prompt,
      out: outMp4,
      seconds,
      fps: envInt('VB_LOCAL_LTX_FPS', 24),
      width: envInt('VB_LOCAL_LTX_W', 896),   // /64
      height: envInt('VB_LOCAL_LTX_H', 512),  // /64
      seed: Math.trunc(seed),
      max_frames: envInt('VB_LOCAL_LTX_MAX_FRAMES', 97),
      min_frames: envInt('VB_LOCAL_LTX_MIN_FRAMES', 25),
    };
    // Single-image by default (freer, more natural motion). The first+last morph anchors identity at both
    // ends but reads as slow-motion when the keyframes are close — opt in with VB_LOCAL_LTX_MORPH=1. Identity
    // is still anchored per-scene by the Kontext keyframe either way. (envBool: '0'/'false' must stay OFF.)
    if (envBool('VB_LOCAL_LTX_MORPH') && endImg && fs.existsSync(endImg)) payload.end_image = endImg;
    const dl = envInt('VB_LOCAL_DEADLINE_SEC', 1800) * 1000;
    try {
      const r = await sidecarPost('/i2v', payload, dl);
      if (r.ok && fs.existsSync(outMp4) && fs.statSync(outMp4).size > 0) return [true, ''];
      return [false, r.error || 'local LTX i2v produced no output'];
    } catch (e: any) {
      return [false, `local LTX i2v error: ${e?.message || e}`];
    }
  }

  // ── Wan 2.2 (5B / 14B) ─────────────────────────────────────────────────────────────────────────
  const is5b = model === '5b';
  const nativeFps = localNativeFps();
  const isHd = !is5b && env('VB_LOCAL_QUALITY', 'fast') === 'hd' && !env('VB_LOCAL_WAN_STEPS');
  const payload: Record<string, unknown> = {
    model_dir: md,
    image: img,
    prompt,
    out: outMp4,
    seconds,
    // 5B is native 24fps; the 14B path is budgeted at 16fps. Frame cap keeps the VAE-decode peak in 48GB.
    fps: nativeFps,
    width: vW(),
    height: vH(),
    seed: Math.trunc(seed),
    max_frames: localMaxFrames(),
    min_frames: envInt('VB_LOCAL_MIN_FRAMES', 21),
  };
  // VAE tiling stays 'auto': 'none' was benchmarked on this 48GB Mac (2026-07-02) and the 14B run died
  // with Metal "Insufficient Memory" even at 832×480/37f — the untiled working set does NOT fit alongside
  // the transformers. VB_LOCAL_VAE_TILING remains as an experiment override for bigger-memory Macs.
  payload.tiling = env('VB_LOCAL_VAE_TILING', 'auto');
  // Tiny-VAE decode (TAEHV taew2_1, torch-MPS): 62s → 2.7s measured, quality user-approved (2026-07-02).
  // Default ON for the fast path; 'hd' keeps the official VAE (its whole point is maximum fidelity).
  // Only the 16ch (14B) VAE is ever replaced — see local/tiny_vae.py. VB_LOCAL_TINY_VAE=0 to disable.
  payload.tiny_vae = envBool('VB_LOCAL_TINY_VAE', !isHd) ? 1 : 0;
  if (is5b) {
    // Single-DiT 5B: no Lightning LoRA (incompatible); run native steps (10 ≈ best speed/quality) with the
    // model's config CFG (guide 5). Override with VB_LOCAL_WAN_STEPS.
    payload.steps = envInt('VB_LOCAL_WAN_STEPS', 10);
  } else {
    // 14B 'fast' uses the Wan2.2-Lightning 4-step LoRA (4 steps + CFG off); 'hd' = full 40-step, no LoRA.
    if (env('VB_LOCAL_QUALITY', 'fast') !== 'hd') {
      const ln = lightningLoras();
      if (ln) {
        payload.lora_high = ln.high;
        payload.lora_low = ln.low;
        // Full-strength Lightning on the HIGH-noise expert flattens motion (slow-mo look). 0.6 restores
        // motion amplitude at the same 4 steps (user-picked in the 0.75-vs-0.6 overnight A/B, 2026-07-03);
        // low-noise stays 1.0 for detail. VB_LOCAL_LORA_HIGH=1 reverts to the flat-but-safest look.
        payload.lora_strength_high = parseFloat(env('VB_LOCAL_LORA_HIGH', '0.6')) || 0.6;
        payload.lora_strength_low = parseFloat(env('VB_LOCAL_LORA_LOW', '1')) || 1.0;
      }
    }
    if (env('VB_LOCAL_WAN_STEPS')) payload.steps = envInt('VB_LOCAL_WAN_STEPS', 40);
  }
  // 14B 'hd' runs the model-config 40 steps (~38 min/clip measured) — the 30-min default deadline would
  // time out EVERY clip while the sidecar keeps denoising and holds the GPU lock (cascading failures).
  const deadline = envInt('VB_LOCAL_DEADLINE_SEC', isHd ? 5400 : 1800) * 1000;
  try {
    const r = await sidecarPost('/i2v', payload, deadline);
    if (!(r.ok && fs.existsSync(outMp4) && fs.statSync(outMp4).size > 0)) {
      return [false, r.error || 'local i2v produced no output'];
    }
    await rifeSmooth(outMp4, nativeFps, deadline);
    return [true, ''];
  } catch (e: any) {
    return [false, `local i2v error: ${e?.message || e}`];
  }
}

/** RIFE 2x a sub-24fps clip (the 14B saves at Wan's native 16fps) so the 24fps timeline conform DECIMATES
 * (32→24 drops 1 frame in 4) instead of duplicating every other frame — the duplication reads as constant
 * judder. ~3s per clip on the Apple GPU (ncnn/MoltenVK). Best-effort: on any failure the raw clip stands.
 * Per-clip ONLY — interpolating an assembled timeline would synthesize morph frames across scene cuts. */
async function rifeSmooth(clip: string, nativeFps: number, deadlineMs: number): Promise<void> {
  if (nativeFps >= 24 || !envBool('VB_LOCAL_RIFE', true)) return;
  const interp = clip.replace(/\.mp4$/, '_rife.mp4');
  try {
    // timeout_sec: the sidecar kills its worker subprocess just before our HTTP deadline, so an abandoned
    // job can never sit on the GPU lock after we've given up (that would starve the next clip's /i2v).
    const r = await sidecarPost('/interp', { video: clip, out: interp, out_fps: nativeFps * 2, timeout_sec: Math.max(60, Math.floor(deadlineMs / 1000) - 60) }, deadlineMs);
    if (r.ok && fs.existsSync(interp) && fs.statSync(interp).size > 0) fs.renameSync(interp, clip);
  } catch {
    /* interpolation is optional polish — the 16fps clip still plays */
  }
}
