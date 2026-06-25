// Offline self-test for the ffmpeg engine path — NO network, NO API keys. Synthesizes media and runs the
// real transform helpers (probe, decode/energy, frame-grid fit, still-fill, concat) so the port can be
// validated end-to-end before a keyed render. Run via VB_ENGINE_TEST=1 (see main/index.ts).
import { tmp } from './storage';
import { ffmpeg, probeDuration, decodePcm, fitToWindow, stillClip, FPS } from './ffmpeg';
import { segmentSong, windowEnergy } from './segment';

export async function runSelfTest(): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
  const checks: Record<string, unknown> = {};

  // 1. synth a 6s tone -> probe + decode + energy windows
  const wav = tmp('st_tone.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ac', '2', wav]);
  const dur = await probeDuration(wav);
  checks.duration = dur;
  const { data, sr } = await decodePcm(wav);
  checks.pcmSamples = data.length;
  checks.pcmRate = sr;
  const wins: [number, number][] = [
    [0, 3],
    [3, 6],
  ];
  checks.energy = await windowEnergy(wav, wins);

  // 2. segmentation on synthetic word timings -> contiguous, tiling [0, dur]
  const words = [
    { start: 0.2, end: 0.6, word: 'hello' },
    { start: 0.7, end: 1.1, word: 'world' },
    { start: 4.0, end: 4.4, word: 'again' },
  ];
  const segs = segmentSong(words, dur || 6);
  checks.segCount = segs.length;
  checks.segContiguous = segs.every((s, i) => i === 0 || Math.abs(s[0] - segs[i - 1][1]) < 1e-6);
  checks.segLast = segs.length ? Math.round(segs[segs.length - 1][1] * 100) / 100 : 0;

  // 3. fit-to-window: a 2s clip retimed to a 1.5s frame-grid slot -> exact frame count
  const rawV = tmp('st_src.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', rawV]);
  const fitOut = tmp('st_fit.mp4');
  await fitToWindow(rawV, 0, 1.5, fitOut);
  checks.fitDuration = await probeDuration(fitOut);
  checks.fitExpectedFrames = Math.round(1.5 * FPS);

  // 4. still-fill clip from a solid frame
  const png = tmp('st_frame.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', png]);
  const still = tmp('st_still.mp4');
  await stillClip(png, 0, 1.0, still, 'SCENE FAILED');
  checks.stillDuration = await probeDuration(still);

  // 5. concat the two clips (the assemble path)
  const list = tmp('st_concat.txt');
  const fs = await import('node:fs');
  fs.writeFileSync(list, `file '${fitOut.replace(/\\/g, '/')}'\nfile '${still.replace(/\\/g, '/')}'\n`);
  const cat = tmp('st_cat.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), cat]);
  checks.concatDuration = await probeDuration(cat);

  const ok =
    !!dur && dur > 5.5 &&
    data.length > 1000 &&
    Array.isArray(checks.energy) &&
    segs.length > 0 &&
    checks.segContiguous === true &&
    !!checks.fitDuration && Math.abs((checks.fitDuration as number) - 1.5) < 0.15 &&
    !!checks.stillDuration &&
    !!checks.concatDuration && (checks.concatDuration as number) > 2.0;
  return { ok, checks };
}
