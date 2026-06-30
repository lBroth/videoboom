// Local image-to-video stage: Wan 2.2 I2V-A14B (MLX) via the shared sidecar (see sidecar.ts). Only the
// video-specific bits live here — the model dir, the Lightning LoRA, and the i2v payload; the process
// lifecycle + HTTP are reused from sidecar.ts. Used when VB_VIDEO_BACKEND=local.
import path from 'node:path';
import fs from 'node:fs';
import { env, envInt } from './config';
import { vW, vH } from './ffmpeg';
import { ensureSidecar, sidecarPost, readMarker } from './sidecar';

/** Which local i2v model:
 * 'ltx'  = LTX-2.3 distilled (default — first+last-frame morph for smooth scene-to-scene flow, 896x512, fast),
 * '5b'   = Wan2.2-TI2V-5B (single start frame, x64 VAE softer/deforms),
 * '14b'  = Wan2.2-I2V-A14B + Lightning 4-step (sharp x16 VAE, slow). */
function videoModel(): 'ltx' | '5b' | '14b' {
  const m = env('VB_LOCAL_VIDEO_MODEL', 'ltx');
  return m === '5b' || m === '14b' ? m : 'ltx';
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
    if (endImg && fs.existsSync(endImg)) payload.end_image = endImg;
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
  const payload: Record<string, unknown> = {
    model_dir: md,
    image: img,
    prompt,
    out: outMp4,
    seconds,
    // 5B is native 24fps; the 14B path is budgeted at 16fps. Frame cap keeps the VAE-decode peak in 48GB.
    fps: envInt('VB_LOCAL_WAN_FPS', is5b ? 24 : 16),
    width: vW(),
    height: vH(),
    seed: Math.trunc(seed),
    max_frames: envInt('VB_LOCAL_MAX_FRAMES', is5b ? 57 : 37),
    min_frames: envInt('VB_LOCAL_MIN_FRAMES', 21),
  };
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
      }
    }
    if (env('VB_LOCAL_WAN_STEPS')) payload.steps = envInt('VB_LOCAL_WAN_STEPS', 40);
  }
  const deadline = envInt('VB_LOCAL_DEADLINE_SEC', 1800) * 1000;
  try {
    const r = await sidecarPost('/i2v', payload, deadline);
    if (r.ok && fs.existsSync(outMp4) && fs.statSync(outMp4).size > 0) return [true, ''];
    return [false, r.error || 'local i2v produced no output'];
  } catch (e: any) {
    return [false, `local i2v error: ${e?.message || e}`];
  }
}
