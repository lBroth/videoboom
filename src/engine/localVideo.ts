// Local image-to-video stage: Wan 2.2 I2V-A14B (MLX) via the shared sidecar (see sidecar.ts). Only the
// video-specific bits live here — the model dir, the Lightning LoRA, and the i2v payload; the process
// lifecycle + HTTP are reused from sidecar.ts. Used when VB_VIDEO_BACKEND=local.
import path from 'node:path';
import fs from 'node:fs';
import { env, envInt } from './config';
import { vW, vH } from './ffmpeg';
import { ensureSidecar, sidecarPost, readMarker } from './sidecar';

/** Which local i2v model: '5b' = Wan2.2-TI2V-5B (default — ~2.6x faster than the 14B at 480p, single-DiT,
 * x64 VAE, native ~10 steps, no Lightning LoRA), '14b' = Wan2.2-I2V-A14B + Lightning 4-step. */
function videoModel(): '5b' | '14b' {
  return env('VB_LOCAL_VIDEO_MODEL', '5b') === '14b' ? '14b' : '5b';
}

/** Converted MLX model dir for the selected model (explicit override, else the setup.sh marker). */
function modelDir(): string {
  return videoModel() === '5b'
    ? env('VB_LOCAL_WAN_5B_DIR') || readMarker('.model-path-5b')
    : env('VB_LOCAL_WAN_DIR') || readMarker('.model-path');
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

/** Generate one clip locally. Mirrors providers.genVideo's [ok, err] contract. Wan i2v is conditioned on a
 * single start frame, so the cloud path's last-frame morph is not used here. */
export async function genVideoLocal(img: string, prompt: string, outMp4: string, seconds: number, seed = 42): Promise<[boolean, string]> {
  const is5b = videoModel() === '5b';
  const md = modelDir();
  if (!md || !fs.existsSync(md)) {
    return [false, 'Local video model not found. Run `bash local/setup.sh` (or set VB_LOCAL_WAN_5B_DIR / VB_LOCAL_WAN_DIR).'];
  }
  try {
    await ensureSidecar();
  } catch (e: any) {
    return [false, e?.message || String(e)];
  }
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
