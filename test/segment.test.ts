// Pure unit tests for the vocal-aligned segmentation math (the highest-risk part of the port).
// No Electron, no ffmpeg — run with `npm run test:unit` (tsx + node:test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentSong, windowVocalCoverage, type Seg } from '../src/engine/segment';

const MAX_SEC = 12.0;
const EPS = 1e-6;

function assertTiles(segs: Seg[], dur: number) {
  assert.ok(segs.length > 0, 'has segments');
  assert.equal(segs[0][0], 0, 'starts at 0');
  for (let i = 1; i < segs.length; i++) {
    assert.ok(Math.abs(segs[i][0] - segs[i - 1][1]) < EPS, `contiguous at ${i} (${segs[i - 1][1]} -> ${segs[i][0]})`);
  }
  assert.ok(Math.abs(segs[segs.length - 1][1] - dur) < 1e-3, `ends at dur (${segs[segs.length - 1][1]} vs ${dur})`);
  for (const s of segs) assert.ok(s[1] - s[0] <= MAX_SEC + 1e-3, `segment <= ${MAX_SEC}s (got ${s[1] - s[0]})`);
}

test('empty words -> instrumental chunks tiling [0, dur]', () => {
  const dur = 20;
  const segs = segmentSong([], dur);
  assertTiles(segs, dur);
  assert.ok(segs.every((s) => s[3] === true), 'all instrumental');
  assert.ok(segs.every((s) => s[2] === ''), 'no lyric text');
});

test('sung words -> contiguous tiling, lyric captured, lengths bounded', () => {
  const dur = 30;
  const words = [
    { start: 0.2, end: 0.6, word: 'hold' },
    { start: 0.7, end: 1.1, word: 'on' },
    { start: 1.2, end: 1.6, word: 'tight' },
    { start: 8.0, end: 8.4, word: 'never' },
    { start: 8.5, end: 8.9, word: 'let' },
    { start: 9.0, end: 9.4, word: 'go' },
    { start: 20.0, end: 20.4, word: 'again' },
  ];
  const segs = segmentSong(words, dur);
  assertTiles(segs, dur);
  const allLyrics = segs.map((s) => s[2]).join(' ');
  for (const w of ['hold', 'tight', 'never', 'go', 'again']) assert.ok(allLyrics.includes(w), `lyric "${w}" present`);
});

test('long instrumental gap is chunked, not one giant scene', () => {
  const dur = 40;
  const words = [{ start: 1.0, end: 1.4, word: 'start' }];
  const segs = segmentSong(words, dur);
  assertTiles(segs, dur);
  assert.ok(segs.length >= 3, 'a 40s song splits into several scenes');
});

test('every sung scene contains its own first word (words never leak past a boundary)', () => {
  const dur = 30;
  const words = Array.from({ length: 40 }, (_, i) => ({ start: 1 + i * 0.7, end: 1 + i * 0.7 + 0.4, word: `w${i}` }));
  const segs = segmentSong(words, dur);
  assertTiles(segs, dur);
  for (const [a, b, lyr] of segs) {
    if (!lyr) continue;
    const inside = words.filter((w) => a <= w.start && w.start < b);
    assert.ok(inside.length > 0, `sung scene [${a},${b}] actually has words in range`);
  }
});

test('property: tiling + bounds hold across many synthetic songs', () => {
  // deterministic pseudo-random inputs (no Math.random) — vary density, gaps, duration
  for (let seed = 1; seed <= 12; seed++) {
    const dur = 12 + seed * 4;
    const words: { start: number; end: number; word: string }[] = [];
    let t = (seed % 3) * 2; // some start at 0, some after an intro
    while (t < dur - 1) {
      words.push({ start: Math.round(t * 100) / 100, end: Math.round((t + 0.4) * 100) / 100, word: 'x' });
      t += 0.4 + ((seed * 7 + words.length * 3) % 11) / 10; // gaps 0.4..1.4
    }
    const segs = segmentSong(words, dur);
    assertTiles(segs, dur); // contiguous, starts 0, ends dur, every scene <= 12s
  }
});

test('windowVocalCoverage returns fractions in [0,1]', () => {
  const words = [
    { start: 0.0, end: 1.0, word: 'a' },
    { start: 1.0, end: 2.0, word: 'b' },
  ];
  const wins: [number, number][] = [
    [0, 2],
    [2, 4],
  ];
  const cov = windowVocalCoverage(words, wins);
  assert.equal(cov.length, 2);
  assert.ok(cov[0] > 0.8 && cov[0] <= 1.0, 'fully-sung window ~1');
  assert.ok(cov[1] >= 0 && cov[1] < 0.2, 'silent window ~0');
});
