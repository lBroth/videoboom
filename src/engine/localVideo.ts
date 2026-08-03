// Local image-to-video stage: Wan 2.2 I2V-A14B (MLX) via the shared sidecar (see sidecar.ts). Only the
// video-specific bits live here — the model dir, the Lightning LoRA, and the i2v payload; the process
// lifecycle + HTTP are reused from sidecar.ts. Video is always on-device (local-only build).
import path from 'node:path';
import fs from 'node:fs';
import { env, envInt, envBool } from './config';
import { vW, vH, FPS } from './ffmpeg';
import { ensureSidecar, sidecarPost, readMarker } from './sidecar';

/** Which local i2v model (the Fast/Quality choice in Settings):
 * '14b' = Quality — Wan2.2-I2V-A14B + Lightning 4-step (sharp x16 VAE, best quality, no deform; slow),
 * '5b'  = Fast — FastWan2.2-TI2V-5B DMD 3-step draft (single start frame, ~4-5 min/clip; x64 VAE,
 *         ghosting in camera transitions). Both finish at 1080p via the interpolate+upscale pass. */
export function videoModel(): '5b' | '14b' {
  return env('VB_LOCAL_VIDEO_MODEL', '14b') === '5b' ? '5b' : '14b';
}

/** Native output fps of the selected local model. The 14B saves at Wan's config sample_fps=16; the 5B is
 * 24. The pipeline needs this to budget native clip seconds AND to know when to interpolate — a 16fps clip
 * conformed to the 24fps timeline by `fps=24` alone gets every other frame duplicated (judder). */
export function localNativeFps(): number {
  const m = videoModel();
  return envInt('VB_LOCAL_WAN_FPS', m === '5b' ? 24 : 16);
}

/** Frame cap of the selected local model (the 48GB Metal working-set ceiling at 480p). */
export function localMaxFrames(): number {
  return envInt('VB_LOCAL_MAX_FRAMES', videoModel() === '5b' ? 57 : 37);
}

/** Converted MLX model dir for the selected model (explicit override, else the setup.sh marker). */
function modelDir(): string {
  if (videoModel() === '5b') return env('VB_LOCAL_WAN_5B_DIR') || readMarker('.model-path-5b');
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

/** Generate one clip locally (Wan 2.2 5B/14B). Returns an [ok, err] tuple. */
export async function genVideoLocal(img: string, prompt: string, outMp4: string, seconds: number, seed = 42): Promise<[boolean, string]> {
  const model = videoModel();
  const md = modelDir();
  if (!md || !fs.existsSync(md)) {
    return [false, 'Download the on-device video model in Settings → On-device.'];
  }
  try {
    await ensureSidecar();
  } catch (e: any) {
    return [false, e?.message || String(e)];
  }

  // ── Wan 2.2 (5B / 14B) ─────────────────────────────────────────────────────────────────────────
  const is5b = model === '5b';
  const nativeFps = localNativeFps();
  // HD is a pure QUALITY-setting question. It used to also require "no explicit step override", which made
  // any injected VB_LOCAL_WAN_STEPS (rerender-clips, or a 5B run before setEnv gained replace semantics)
  // silently demote an HD render to the fast VAE + the short deadline while ALSO skipping the Lightning
  // LoRA — the worst of both paths. The step override still applies below; it just no longer redefines HD.
  const isHd = !is5b && env('VB_LOCAL_QUALITY', 'fast') === 'hd';
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
        // Lightning is a 4-step distillation — WITHOUT this the sidecar falls back to its 20-step default,
        // which is ~5x slower AND over-denoises (flat, slow-mo motion). Force 4 unless explicitly overridden.
        payload.steps = envInt('VB_LOCAL_WAN_STEPS', 4);
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

/** Smallest interpolation factor that lands a sub-timeline clip on an EXACT multiple of the timeline fps.
 *
 * This is the difference between smooth and merely "less bad". The 14B saves at Wan's native 16fps; a plain
 * 2x lands on 32fps, and the timeline conform (`fps=24`) then has to drop 1 frame in 4 at uneven phase — a
 * repeating 4-frame cadence break that reads as micro-judder. 3x lands on 48fps, which decimates to 24 as a
 * clean 2:1 (every second frame, perfectly even). RIFE v4.x is timestep-conditioned, so a 3x pass costs one
 * extra synthesized frame per gap, not a second full pass.
 * Returns 1 when the clip is already at/above the timeline rate (no interpolation needed). Falls back to 2
 * when no clean factor exists within `maxFactor` — still better than leaving it at native. */
export function rifeFactor(nativeFps: number, timelineFps: number = FPS, maxFactor = 4): number {
  if (!(nativeFps > 0) || nativeFps >= timelineFps) return 1;
  for (let f = 2; f <= maxFactor; f++) if ((nativeFps * f) % timelineFps === 0) return f;
  return 2;
}

/** Interpolate a sub-timeline clip up to an exact multiple of the 24fps timeline (see rifeFactor), so the
 * conform decimates evenly instead of duplicating or dropping frames at an uneven phase. ~3-5s per clip on
 * the Apple GPU (ncnn/MoltenVK). Best-effort: on any failure the raw clip stands — but the failure is now
 * LOGGED, because a silent fallback means every clip in that render conforms 16→24 by duplicating one frame
 * in two (constant judder) with nothing in the UI or logs to explain why the result looks worse.
 * Per-clip ONLY — interpolating an assembled timeline would synthesize morph frames across scene cuts. */
async function rifeSmooth(clip: string, nativeFps: number, deadlineMs: number): Promise<void> {
  if (!envBool('VB_LOCAL_RIFE', true)) return;
  const factor = rifeFactor(nativeFps);
  if (factor < 2) return;
  const interp = clip.replace(/\.mp4$/, '_rife.mp4');
  try {
    // timeout_sec: the sidecar kills its worker subprocess just before our HTTP deadline, so an abandoned
    // job can never sit on the GPU lock after we've given up (that would starve the next clip's /i2v).
    const r = await sidecarPost(
      '/interp',
      { video: clip, out: interp, factor, out_fps: nativeFps * factor, timeout_sec: Math.max(60, Math.floor(deadlineMs / 1000) - 60) },
      deadlineMs,
    );
    if (r.ok && fs.existsSync(interp) && fs.statSync(interp).size > 0) {
      fs.renameSync(interp, clip);
      return;
    }
    console.error(`[rife] interpolation did not produce output (${nativeFps}→${nativeFps * factor}fps): ${r?.error || 'unknown'} — clip stays at ${nativeFps}fps and will judder on the ${FPS}fps timeline`);
  } catch (e: any) {
    console.error(`[rife] interpolation failed (${nativeFps}→${nativeFps * factor}fps): ${e?.message || e} — clip stays at ${nativeFps}fps and will judder on the ${FPS}fps timeline`);
  }
}
