// Unit tests for the render-quality/fluidity invariants (pure — no electron, no ffmpeg, no sidecar).
// Each test here pins a defect that was silent in production: nothing crashed, the video just came out
// worse, which is exactly the class of bug a unit test has to catch instead of a human eye.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv, env, envInt } from '../src/engine/config';
import { rifeFactor } from '../src/engine/localVideo';
import { FPS } from '../src/engine/ffmpeg';
import { TIMELINE_RES } from '../src/shared/videoRes';
import { DEFAULTS, type Settings } from '../src/main/settingsSchema';
import { resolveConfig, type KeyState } from '../src/main/autoconfig';
import type { LocalCapabilities } from '../src/main/localModels';

const mk = (over: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULTS), ...over });
const CAPS = (supported: boolean): LocalCapabilities => ({ supported, depsInstalled: true } as LocalCapabilities);
const NO_KEYS: KeyState = { openrouter: false, replicate: false };
const BOTH: KeyState = { openrouter: true, replicate: true };

// ── setEnv: per-op REPLACE, not merge ──────────────────────────────────────────
// The bug this pins: CFG was merge-only, so any key emitted for one model/op survived into the next one.
// `rerender-clips` injects VB_LOCAL_WAN_STEPS=20 and the resolver emits it for the 5B — either one used to
// poison every later 14B render in the same process: 20 steps forced through a 4-step Lightning
// distillation (flat, slow-motion output) and, worse, `isHd` read the leftover key and silently demoted an
// HD render to the fast VAE + short deadline while ALSO skipping the LoRA.

test('setEnv replaces the previous op env — a one-shot override cannot leak into the next render', () => {
  setEnv({ VB_LOCAL_VIDEO_MODEL: '5b', VB_LOCAL_WAN_STEPS: '20' });
  assert.equal(env('VB_LOCAL_WAN_STEPS'), '20');
  // Next op resolves a 14B render and emits no step override at all.
  setEnv({ VB_LOCAL_VIDEO_MODEL: '14b', VB_LOCAL_QUALITY: 'hd' });
  assert.equal(env('VB_LOCAL_WAN_STEPS'), '', 'stale step override must not survive into the next op');
  assert.equal(env('VB_LOCAL_VIDEO_MODEL'), '14b');
  assert.equal(env('VB_LOCAL_QUALITY'), 'hd');
});

test('setEnv clears every key, not just the ones the new map mentions', () => {
  setEnv({ VB_LOCAL_WAN_DIR: '/old/model', VB_STT_LANG: 'it', VB_W: '832' });
  setEnv({ VB_W: '1280' });
  assert.equal(env('VB_LOCAL_WAN_DIR'), '', 'a cleared setting must not keep its old value');
  assert.equal(env('VB_STT_LANG'), '');
  assert.equal(env('VB_W'), '1280');
});

test('setEnv drops empty values rather than storing them (defaults must win)', () => {
  setEnv({ VB_WORKERS: '4' });
  setEnv({ VB_WORKERS: '' });
  assert.equal(envInt('VB_WORKERS', 7), 7, 'an empty injected value falls through to the caller default');
});

// ── RIFE factor: land on an EXACT multiple of the timeline rate ────────────────
// The bug this pins: a fixed 2x took the 14B's native 16fps to 32fps, and the 24fps conform then had to
// drop 1 frame in 4 at uneven phase — a repeating cadence break. 3x lands on 48fps, an exact 2:1.

test('rifeFactor lands sub-timeline rates on an exact multiple of the timeline fps', () => {
  for (const native of [8, 12, 16]) {
    const f = rifeFactor(native);
    assert.ok(f >= 2, `${native}fps must be interpolated (got factor ${f})`);
    assert.equal((native * f) % FPS, 0, `${native}fps x${f} = ${native * f} must divide evenly into ${FPS}`);
  }
});

test('rifeFactor picks 3 for the 14B native 16fps (48→24 is a clean 2:1, 32→24 is not)', () => {
  assert.equal(rifeFactor(16), 3);
  assert.notEqual(rifeFactor(16), 2, 'the old fixed 2x left an uneven 32→24 decimation');
});

test('rifeFactor is a no-op at or above the timeline rate (the 5B is already 24fps)', () => {
  assert.equal(rifeFactor(24), 1);
  assert.equal(rifeFactor(30), 1);
});

test('rifeFactor never returns a factor that would cost more than one extra frame per gap', () => {
  for (const native of [8, 10, 12, 15, 16, 20, 23]) assert.ok(rifeFactor(native) <= 4, `${native}fps`);
});

test('rifeFactor falls back to 2 (never 0/1) when no clean factor exists in range', () => {
  const f = rifeFactor(23); // 23*n is never a multiple of 24 for n<=4
  assert.equal(f, 2, 'still interpolate — a sub-timeline clip must never be left to duplicate frames');
});

test('rifeFactor tolerates a nonsense native rate instead of dividing by zero', () => {
  assert.equal(rifeFactor(0), 1);
  assert.equal(rifeFactor(-5), 1);
});

// ── timeline resolution: ONE definition ───────────────────────────────────────
// The bug this pins: the resolver and the backend interface each carried their own hand-copied literals.
// A mismatch is silent — clips still render, conformClip just scales and pads them at assemble time, so
// the render quietly loses resolution with nothing to point at.

test('the resolver emits the shared timeline resolution for a local VIDEO stage', () => {
  const e = resolveConfig(CAPS(true), mk(), NO_KEYS).toEnv();
  assert.equal(e.VB_VIDEO_BACKEND, 'local');
  assert.equal(e.VB_W, String(TIMELINE_RES.local.w));
  assert.equal(e.VB_H, String(TIMELINE_RES.local.h));
});

test('the resolver emits the shared timeline resolution for a cloud VIDEO stage', () => {
  const e = resolveConfig(CAPS(true), mk({ backendPreference: 'prefer-cloud' }), BOTH).toEnv();
  assert.equal(e.VB_VIDEO_BACKEND, 'cloud');
  assert.equal(e.VB_W, String(TIMELINE_RES.cloud.w));
  assert.equal(e.VB_H, String(TIMELINE_RES.cloud.h));
});

test('a local keyframe is generated at the timeline size (never resized into the clip)', () => {
  const e = resolveConfig(CAPS(true), mk(), NO_KEYS).toEnv();
  assert.equal(e.VB_LOCAL_KEYFRAME_W, e.VB_W);
  assert.equal(e.VB_LOCAL_KEYFRAME_H, e.VB_H);
});
