// Vocal-aligned segmentation (verbatim timing math from the proven pipeline). Splits the song into
// contiguous scene segments aligned to sung PHRASES (+ standalone INSTRUMENTAL spans) so each clip is
// generated at its EXACT length (no time-stretch) and the visuals sync to the singing.
import { decodePcm } from './ffmpeg';
import type { Word } from './providers';

export const MAX_WORD_SEC = 4.0;

/** [start, end, lyric, instrumental] tiling [0, dur] with no gaps. */
export type Seg = [number, number, string, boolean];

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function chunkInstrumental(a: number, b: number, target: number, mx: number): Seg[] {
  const out: Seg[] = [];
  a = Math.max(0, a);
  while (b - a > mx) {
    out.push([a, a + target, '', true]);
    a += target;
  }
  if (b - a >= 1.0) out.push([a, b, '', true]);
  return out;
}

/** Fraction (0..1) of each window actually covered by sung words (word ends clamped). */
export function windowVocalCoverage(words: Word[], wins: [number, number][]): number[] {
  const cov: number[] = [];
  for (const [s, e] of wins) {
    const span = Math.max(1e-6, e - s);
    let covered = 0;
    for (const w of words) {
      const ws = Number(w.start || 0);
      const we = Math.min(Number(w.end ?? ws), ws + MAX_WORD_SEC);
      const lo = Math.max(s, ws);
      const hi = Math.min(e, we);
      if (hi > lo) covered += hi - lo;
    }
    cov.push(Math.min(1.0, covered / span));
  }
  return cov;
}

export function segmentSong(words: Word[], dur: number): Seg[] {
  const MIN_SEC = 3.0;
  const MAX_SEC = 12.0;
  const TARGET = 6.0;
  const PHRASE_GAP = 0.5;
  const toks: [number, number, string][] = words
    .filter((w) => (w.word || '').trim())
    .map((w) => [Number(w.start), Number(w.end ?? w.start), (w.word || '').trim()] as [number, number, string])
    .sort((p, q) => p[0] - q[0] || p[1] - q[1] || (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : 0));
  if (!toks.length) return chunkInstrumental(0, dur, TARGET, MAX_SEC);

  const cuts: number[] = [0.0];
  let prevEnd = Math.min(toks[0][1], toks[0][0] + MAX_WORD_SEC);
  for (let i = 1; i < toks.length; i++) {
    const [s, e] = toks[i];
    if (s - prevEnd > PHRASE_GAP) {
      cuts.push(r3(prevEnd));
      cuts.push(s);
    }
    prevEnd = Math.max(prevEnd, Math.min(e, s + MAX_WORD_SEC));
  }
  cuts.push(dur);
  const uniq = Array.from(new Set(cuts.map(r3).filter((c) => c >= 0 && c <= dur))).sort((a, b) => a - b);

  const raw: Seg[] = [];
  for (let i = 0; i + 1 < uniq.length; i++) {
    const a = uniq[i];
    const b = uniq[i + 1];
    const lyr = toks
      .filter(([s]) => a <= s && s < b)
      .map(([, , w]) => w)
      .join(' ')
      .trim();
    let cov = 0;
    for (const [s, e] of toks) {
      const we = Math.min(e, s + MAX_WORD_SEC);
      if (s < b && we > a) cov += Math.min(we, b) - Math.max(s, a);
    }
    raw.push([a, b, lyr, cov / Math.max(1e-6, b - a) < 0.15]);
  }

  const merged: Seg[] = [];
  for (const seg of raw) {
    if (merged.length && seg[1] - seg[0] < MIN_SEC) {
      const m = merged[merged.length - 1];
      m[1] = seg[1];
      m[2] = (m[2] + ' ' + seg[2]).trim();
      m[3] = m[3] && seg[3];
    } else {
      merged.push([...seg] as Seg);
    }
  }
  if (merged.length > 1 && merged[0][1] - merged[0][0] < MIN_SEC) {
    merged[1][0] = merged[0][0];
    merged[1][2] = (merged[0][2] + ' ' + merged[1][2]).trim();
    merged[1][3] = merged[0][3] && merged[1][3];
    merged.shift();
  }

  const out: Seg[] = [];
  for (const [a, b, lyr, instr] of merged) {
    if (b - a <= MAX_SEC) {
      out.push([a, b, lyr, instr]);
      continue;
    }
    let x = a;
    while (b - x > MAX_SEC) {
      const sb = x + TARGET;
      const sl = toks
        .filter(([s]) => x <= s && s < sb)
        .map(([, , w]) => w)
        .join(' ')
        .trim();
      out.push([x, sb, sl, instr || !sl]);
      x = sb;
    }
    const sl = toks
      .filter(([s]) => x <= s && s < b)
      .map(([, , w]) => w)
      .join(' ')
      .trim();
    out.push([x, b, sl, instr || !sl]);
  }

  // SNAP each sung scene's start to its FIRST sung word (vocal lead-in), extending the previous scene so
  // the timeline stays contiguous. Only when the lead-in is real (>0.4s) and the scene stays >= MIN_SEC.
  for (let i = 1; i < out.length; i++) {
    const [a, b, lyr, instr] = out[i];
    if (instr || !lyr) continue;
    const starts = toks.filter(([s]) => a <= s && s < b).map(([s]) => s);
    if (!starts.length) continue;
    const first = Math.min(...starts);
    if (first - a > 0.4 && first < b - MIN_SEC) {
      out[i][0] = r3(first);
      out[i - 1][1] = r3(first);
    }
  }
  return out;
}

/** Per-window loudness class ('calm'|'medium'|'intense') from RMS energy vs the song's mean. */
export async function windowEnergy(songWav: string, wins: [number, number][]): Promise<string[]> {
  try {
    const { data, sr } = await decodePcm(songWav);
    if (!data.length) return wins.map(() => 'medium');
    const rmss: number[] = [];
    for (const [s, e] of wins) {
      const i0 = Math.trunc(s * sr);
      const i1 = Math.max(Math.trunc(e * sr), i0 + 1);
      let sum = 0;
      let n = 0;
      for (let i = i0; i < i1 && i < data.length; i++) {
        sum += data[i] * data[i];
        n++;
      }
      rmss.push(n ? Math.sqrt(sum / n) : 0);
    }
    let g = rmss.length ? rmss.reduce((a, b) => a + b, 0) / rmss.length : 1e-6;
    g = g || 1e-6;
    return rmss.map((rv) => {
      const ratio = rv / g;
      return ratio > 1.25 ? 'intense' : ratio < 0.7 ? 'calm' : 'medium';
    });
  } catch {
    return wins.map(() => 'medium');
  }
}
