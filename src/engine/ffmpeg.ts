// ffmpeg / ffprobe: bundled static binaries (ffmpeg-static, ffprobe-static), run ASYNC so the main
// process / UI never blocks during an encode. Also the media transforms the pipeline needs: probe,
// thumbnail, ->PNG, frame-grid fit, still-fill clip, and raw-PCM decode for energy windows.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { env, envInt, envBool } from './config';
import { tmp, copyIn, fileExists, fileSize } from './storage';

// Resolve a bundled binary path; when packaged inside app.asar the real file lives in app.asar.unpacked.
function bin(p: string | null | undefined, fallback: string): string {
  return (p || fallback).replace('app.asar', 'app.asar.unpacked');
}
const FFMPEG = bin(ffmpegStatic as unknown as string, 'ffmpeg');
const FFPROBE = bin(ffprobeStatic?.path, 'ffprobe');

// Render resolution — read live (not a load-time const) so a per-run setting injection (e.g. the local
// 720p backend setting VB_W=1280/VB_H=704) takes effect. Used by stillClip + the failed-scene color fill;
// the local Wan backend also generates at exactly these dims so every clip + fill shares one size.
export const vW = (): number => envInt('VB_W', 768);
export const vH = (): number => envInt('VB_H', 432);
export const FPS = 24;

// x264 encode args for every re-encode hop. Bare `-c:v libx264` means CRF 23 / preset medium — at 480p
// that visibly smears texture, and clips go through 2-3 encode generations (sub-clip concat → trim →
// assemble), so the loss compounds. CRF 14 keeps the intermediates visually lossless for pennies of disk.
export const x264 = (crf = envInt('VB_CRF_INTER', 14), preset = 'medium'): string[] =>
  ['-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p'];

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

/** Grab a clip's final frame as a PNG — used to chain a follow-on i2v clip that continues the motion (so a
 * long scene is one continuous shot of native sub-clips, no slow-motion). */
export async function lastFrame(video: string, out: string): Promise<string | null> {
  // Seek ~0.4s before the end, then decode to EOF with -update 1 overwriting `out` each frame — the TRUE
  // last frame wins. (With -frames:v 1 the FIRST frame at -0.4s wins, so every chained clip restarted
  // ~0.4s early and motion visibly jumped backwards at each seam.)
  const ok = await ffmpeg(['-sseof', '-0.4', '-i', video, '-update', '1', out]);
  return ok && fileExists(out) ? out : null;
}

/** Mean luma + saturation of a still (signalstats), or null if unreadable. */
export async function frameLevels(img: string): Promise<{ y: number; sat: number } | null> {
  const r = await run(FFMPEG, ['-v', 'error', '-i', img, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const s = r.stdout.toString();
  const y = parseFloat((s.match(/lavfi\.signalstats\.YAVG=([\d.]+)/) || [])[1] || '');
  const sat = parseFloat((s.match(/lavfi\.signalstats\.SATAVG=([\d.]+)/) || [])[1] || '');
  return Number.isFinite(y) && Number.isFinite(sat) ? { y, sat } : null;
}

// How far a single level-match may push exposure / saturation. Deliberately small: the correction must be
// able to cancel accumulated drift without ever overriding a scene's INTENTIONAL lighting change.
const MATCH_MAX_BRIGHT = 0.08; // eq brightness units (~±20 of 255)
const MATCH_MAX_SAT = 0.06;    // ±6% saturation

/** Nudge a chained start frame's exposure/saturation back toward its anchor keyframe, by a CLAMPED amount.
 *
 * Chained i2v drifts: each sub-clip is generated FROM the previous clip's last frame, so per-generation
 * exposure/saturation error compounds with nothing pulling it back — a 12s scene is 6 links at the 14B's
 * ~2.3s native clip, and the cross-scene chain adds more on top. The clamp is what makes this safe to apply
 * unconditionally: with no drift the correction rounds to nothing and the source frame is returned
 * untouched, and it can never move a frame far enough to fight a deliberate lighting change.
 * Best-effort — any probe/encode failure returns the source frame. */
export async function matchLevels(src: string, ref: string, out: string): Promise<string> {
  const [a, b] = await Promise.all([frameLevels(src), frameLevels(ref)]);
  if (!a || !b || !(a.sat > 0)) return src;
  const bright = Math.max(-MATCH_MAX_BRIGHT, Math.min(MATCH_MAX_BRIGHT, (b.y - a.y) / 255));
  const sat = Math.max(1 - MATCH_MAX_SAT, Math.min(1 + MATCH_MAX_SAT, b.sat / a.sat));
  if (Math.abs(bright) < 0.004 && Math.abs(sat - 1) < 0.01) return src; // below visibility — don't re-encode
  const ok = await ffmpeg(['-i', src, '-vf', `eq=brightness=${bright.toFixed(4)}:saturation=${sat.toFixed(4)}`, out]);
  return ok && fileSize(out) > 0 ? out : src;
}

/** Write a concat-demuxer list file for `clips` and return its path. */
function concatList(clips: string[], tag: string): string {
  const list = tmp(`concat_${tag}.txt`);
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n') + '\n');
  return list;
}

/** Concatenate clips into one video, audio stripped — STREAM-COPY when the inputs are compatible, else
 * re-encode.
 *
 * Saving this hop matters: a local clip already goes through sub-clip concat -> window conform -> timeline
 * concat -> upscale -> grade, and every x264 generation erodes the 480p texture that the upscaler then
 * amplifies. Sub-clips of one scene come from the same model at the same settings, so `-c copy` is the
 * normal case and it is bit-exact.
 *
 * The copy is VERIFIED, not assumed: the concat demuxer can exit 0 while producing a broken or truncated
 * file when the inputs' codec parameters differ subtly, so the result is only accepted when its duration
 * matches the sum of the inputs. Anything else falls back to the re-encode that was always here. */
export async function concatClips(clips: string[], out: string, opts: { fps?: number } = {}): Promise<string | null> {
  if (!clips.length) return null;
  const tag = String(Math.abs(out.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)));
  const list = concatList(clips, tag);
  if (envBool('VB_CONCAT_COPY', true)) {
    const durs = await Promise.all(clips.map((c) => probeDuration(c)));
    if (durs.every((d) => d != null && d > 0)) {
      const want = (durs as number[]).reduce((a, b) => a + b, 0);
      const copyOut = out.replace(/\.mp4$/, '') + '_copy.mp4';
      if (await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', copyOut])) {
        const got = await probeDuration(copyOut);
        // 1 frame of slack: container rounding, not a dropped segment.
        if (got != null && Math.abs(got - want) < 1 / FPS && fileSize(copyOut) > 0) {
          try {
            fs.renameSync(copyOut, out);
            return out;
          } catch {
            /* cross-device or locked — fall through to the re-encode */
          }
        }
      }
      try {
        fs.rmSync(copyOut, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  const rate = opts.fps ? ['-r', String(Math.trunc(opts.fps))] : [];
  const ok = await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, ...x264(), ...rate, '-an', out]);
  return ok && fileExists(out) ? out : null;
}

/** TRIM a clip to its scene's exact frame-grid slot by cutting excess frames — NO setpts retime — so motion
 * plays at real speed (never slow-motion or sped-up). Requires the raw to already be >= the window length
 * (the local clip-chaining guarantees this). Used for the local backend; cloud uses fitToWindow. */
export async function trimToWindow(raw: string, startSec: number, endSec: number, out: string, fps = FPS): Promise<string> {
  fps = Math.trunc(fps || FPS);
  const nFrames = Math.max(1, Math.round(Number(endSec) * fps) - Math.round(Number(startSec) * fps));
  await ffmpeg(['-i', raw, '-vf', `fps=${fps}`, '-frames:v', String(nFrames), ...x264(), '-an', out]);
  return out;
}

/** Conform a generated clip to EXACTLY its scene's frame-grid slot so concatenated scenes stay locked to
 * the song with NO cumulative drift (boundaries snapped to round(t*fps); counts telescope across scenes).
 * Measures the raw clip and retimes (setpts) to the exact frame-count duration. Audio stripped. Used for the
 * cloud backend (clips may be shorter/longer than the window); local uses trimToWindow. */
export async function fitToWindow(raw: string, startSec: number, endSec: number, out: string, fps = FPS): Promise<string> {
  fps = Math.trunc(fps || FPS);
  const s0 = Number(startSec || 0);
  const s1 = Number(endSec || 0);
  const nFrames = Math.max(1, Math.round(s1 * fps) - Math.round(s0 * fps));
  const target = nFrames / fps;
  const rawDur = (await probeDuration(raw)) || target;
  let factor = rawDur && rawDur > 0 ? target / rawDur : 1.0;
  factor = Math.min(8.0, Math.max(0.05, factor));
  const setpts = `setpts=${factor.toFixed(6)}*PTS`;

  // `setpts,fps=` resamples time by DUPLICATING or DROPPING whole frames — no motion compensation. The
  // cloud provider only accepts whole-second durations, so a scene window is almost never an exact match
  // and this retime happens on essentially every cloud clip: at factor 1.13 that is one duplicated frame in
  // eight, which reads as steady judder. When the deviation is big enough to see, synthesize the in-between
  // frames instead (same job RIFE does for the local path, which has no cloud equivalent).
  // Gated: minterpolate is CPU-heavy at 720p, so it is skipped for deviations too small to notice.
  const dev = Math.abs(factor - 1);
  if (envBool('VB_SMOOTH_RETIME', true) && dev > (parseFloat(env('VB_SMOOTH_RETIME_MIN', '0.06')) || 0.06)) {
    const mci = `${setpts},minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
    if (await ffmpeg(['-i', raw, '-vf', mci, '-frames:v', String(nFrames), ...x264(), '-an', out])) {
      // Accept ONLY at the exact frame-grid length. The whole point of this conform is that scene lengths
      // telescope with no drift, so a clip one frame short would desync the song — better to spend the
      // encode twice than to let motion smoothing cost frame accuracy.
      const got = await probeDuration(out);
      if (got != null && fileSize(out) > 0 && Math.abs(got - target) < 0.5 / fps) return out;
    }
  }
  await ffmpeg(['-i', raw, '-vf', `${setpts},fps=${fps}`, '-frames:v', String(nFrames), ...x264(), '-an', out]);
  return out;
}

/** Pixel dimensions [w, h] of a video's first video stream, or null if unreadable. */
export async function probeDimensions(p: string): Promise<[number, number] | null> {
  const r = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', p]);
  const m = r.stdout.toString().trim().match(/(\d+)x(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

/** Conform a clip to EXACTLY vW×vH (scale-to-fit + centered pad) so mixed-resolution clips — e.g. a legacy
 * project's cloud clips saved at 1280×720 next to local 832×480 — concatenate cleanly (the concat demuxer
 * corrupts output on differing dimensions). A NO-OP (returns src, no re-encode) when the clip is already
 * vW×vH, so the common single-resolution timeline stays lossless. */
export async function conformClip(src: string, out: string): Promise<string> {
  const w = vW(), h = vH();
  const dim = await probeDimensions(src);
  if (dim && dim[0] === w && dim[1] === h) return src;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const ok = await ffmpeg(['-i', src, '-vf', vf, ...x264(), '-an', out]);
  return ok && fileSize(out) > 0 ? out : src;
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
  const w = vW(), h = vH();
  const base = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}`;
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
      : ['-f', 'lavfi', '-i', `color=c=0x111418:s=${w}x${h}:r=${fps}`, '-t', target.toFixed(3)];
  await ffmpeg([...src, '-vf', chain, '-frames:v', String(n), ...x264(), '-an', out]);
  // The drawtext watermark needs a font + a freetype-enabled ffmpeg; if that combo isn't available the
  // render produces nothing. Fall back to the plain fill so a failed-scene slot is NEVER itself empty.
  if (fileSize(out) === 0 && chain !== base) {
    await ffmpeg([...src, '-vf', base, '-frames:v', String(n), ...x264(), '-an', out]);
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
