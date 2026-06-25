// ffmpeg / ffprobe: bundled static binaries (ffmpeg-static, ffprobe-static), run ASYNC so the main
// process / UI never blocks during an encode. Also the media transforms the pipeline needs: probe,
// thumbnail, ->PNG, frame-grid fit, still-fill clip, and raw-PCM decode for energy windows.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { env, envInt } from './config';
import { tmp, copyIn, fileExists, fileSize } from './storage';

// Resolve a bundled binary path; when packaged inside app.asar the real file lives in app.asar.unpacked.
function bin(p: string | null | undefined, fallback: string): string {
  return (p || fallback).replace('app.asar', 'app.asar.unpacked');
}
const FFMPEG = bin(ffmpegStatic as unknown as string, 'ffmpeg');
const FFPROBE = bin(ffprobeStatic?.path, 'ffprobe');

export const W = envInt('VB_W', 768);
export const H = envInt('VB_H', 432);
export const FPS = 24;

interface RunOut {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function run(cmd: string, args: string[]): Promise<RunOut> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 1, stdout: Buffer.alloc(0), stderr: 'spawn failed' });
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', () => resolve({ code: 1, stdout: Buffer.concat(out), stderr: err || 'spawn error' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
  });
}

/** Run ffmpeg with -y -loglevel error prefixed; resolves true on exit 0. */
export async function ffmpeg(args: string[]): Promise<boolean> {
  const r = await run(FFMPEG, ['-y', '-loglevel', 'error', ...args]);
  return r.code === 0;
}

/** Actual duration (seconds) of a media file, or null if unreadable. */
export async function probeDuration(p: string): Promise<number | null> {
  const r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p]);
  const s = r.stdout.toString().trim();
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

/** HEIC/JPEG/WebP/... -> PNG. Returns dest on success, else null. */
export async function toPng(src: string, dest: string): Promise<string | null> {
  const ok = await ffmpeg(['-i', src, dest]);
  return ok && fileSize(dest) > 0 ? dest : null;
}

/** Downscale an image to a small JPEG and store it under thumbKey. Returns thumbKey or null. */
export async function putThumb(srcImg: string, thumbKey: string, maxPx = 400): Promise<string | null> {
  const t = tmp('_thumb.jpg');
  const ok = await ffmpeg(['-i', srcImg, '-vf', `scale='min(${maxPx},iw)':-2`, '-q:v', '5', t]);
  if (ok && fileSize(t) > 0) {
    copyIn(t, thumbKey);
    return thumbKey;
  }
  return null;
}

/** Downscale to a small JPEG data URI for the safety check (full-res photos 413 / are slow). */
export async function moderationUri(p: string): Promise<string> {
  const small = tmp('mod_small.jpg');
  const ok = await ffmpeg(['-i', p, '-vf', "scale='min(640,iw)':-2", '-q:v', '6', small]);
  if (ok && fileSize(small) > 0) {
    return 'data:image/jpeg;base64,' + fs.readFileSync(small).toString('base64');
  }
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}

/** Conform a generated clip to EXACTLY its scene's frame-grid slot so concatenated scenes stay locked to
 * the song with NO cumulative drift (boundaries snapped to round(t*fps); counts telescope across scenes).
 * Measures the raw clip and retimes (setpts) to the exact frame-count duration. Audio stripped. */
export async function fitToWindow(raw: string, startSec: number, endSec: number, out: string, fps = FPS): Promise<string> {
  fps = Math.trunc(fps || FPS);
  const s0 = Number(startSec || 0);
  const s1 = Number(endSec || 0);
  const nFrames = Math.max(1, Math.round(s1 * fps) - Math.round(s0 * fps));
  const target = nFrames / fps;
  const rawDur = (await probeDuration(raw)) || target;
  let factor = rawDur && rawDur > 0 ? target / rawDur : 1.0;
  factor = Math.min(8.0, Math.max(0.05, factor));
  await ffmpeg(['-i', raw, '-vf', `setpts=${factor.toFixed(6)}*PTS,fps=${fps}`, '-frames:v', String(nFrames), '-an', out]);
  return out;
}

// A TTF for drawtext watermarks (failed-scene fill). macOS ships Arial; Linux often dejavu. '' -> skip.
const FONT =
  ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(
    (p) => fileExists(p),
  ) || '';

/** A held still filling a FAILED scene's exact frame-grid window, so the timeline (and audio sync) stays
 * intact regardless of which scenes failed. Frame count matches fitToWindow (telescopes, no drift). */
export async function stillClip(image: string, startSec: number, endSec: number, out: string, label = '', fps = FPS): Promise<string> {
  fps = Math.trunc(fps || FPS);
  const n = Math.max(1, Math.round(Number(endSec) * fps) - Math.round(Number(startSec) * fps));
  const target = n / fps;
  const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}`;
  let chain = base;
  if (label && FONT) {
    const txt =
      Array.from(label)
        .filter((c) => /[a-zA-Z0-9]/.test(c) || ' ·-'.includes(c))
        .join('')
        .trim() || 'FAILED';
    chain += `,drawbox=x=0:y=ih-96:w=iw:h=96:color=black@0.6:t=fill,drawtext=fontfile=${FONT}:text='${txt}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-64`;
  }
  const src =
    image && fileExists(image)
      ? ['-loop', '1', '-t', target.toFixed(3), '-i', image]
      : ['-f', 'lavfi', '-i', `color=c=0x111418:s=${W}x${H}:r=${fps}`, '-t', target.toFixed(3)];
  await ffmpeg([...src, '-vf', chain, '-frames:v', String(n), '-pix_fmt', 'yuv420p', '-an', out]);
  // The drawtext watermark needs a font + a freetype-enabled ffmpeg; if that combo isn't available the
  // render produces nothing. Fall back to the plain fill so a failed-scene slot is NEVER itself empty.
  if (fileSize(out) === 0 && chain !== base) {
    await ffmpeg([...src, '-vf', base, '-frames:v', String(n), '-pix_fmt', 'yuv420p', '-an', out]);
  }
  return out;
}

/** Decode an audio file to mono float32 PCM samples at `rate` Hz (for RMS energy windows). */
export async function decodePcm(src: string, rate = 8000): Promise<{ data: Float32Array; sr: number }> {
  const r = await run(FFMPEG, ['-v', 'error', '-i', src, '-f', 'f32le', '-ac', '1', '-ar', String(rate), 'pipe:1']);
  if (r.code !== 0 || r.stdout.length < 4) return { data: new Float32Array(0), sr: rate };
  const buf = r.stdout;
  const n = Math.floor(buf.length / 4);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = buf.readFloatLE(i * 4);
  return { data, sr: rate };
}

/** Convert any audio to a 16kHz mono mp3 (small, passes provider upload limits). Returns dest or src. */
export async function toMp3_16k(src: string, dest: string): Promise<string> {
  const ok = await ffmpeg(['-i', src, '-ar', '16000', '-ac', '1', '-b:a', '64k', dest]);
  return ok && fileExists(dest) ? dest : src;
}

/** Convert any audio to a wav (for sample reads / muxing). Returns dest or src. */
export async function toWav(src: string, dest: string): Promise<string> {
  const ok = await ffmpeg(['-i', src, dest]);
  return ok && fileExists(dest) ? dest : src;
}

export { run as rawRun, FFMPEG, FFPROBE };
