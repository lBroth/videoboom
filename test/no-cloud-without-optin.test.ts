// The hybrid's hard invariants, unit-tested at the resolver (pure, no electron). Guards against a regression
// that would send data to the cloud without an explicit opt-in. See DUAL_BACKEND_PLAN.md §3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, DEFAULTS, STAGES, type Settings } from '../src/main/settingsSchema';
import { resolveConfig, pickBackend, type KeyState } from '../src/main/autoconfig';
import type { LocalCapabilities } from '../src/main/localModels';

const mk = (over: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULTS), ...over });
const CAPS = (supported: boolean): LocalCapabilities => ({ supported, depsInstalled: true } as LocalCapabilities);
const NO_KEYS: KeyState = { openrouter: false, replicate: false };
const BOTH: KeyState = { openrouter: true, replicate: true };

test('I1 — no key ⇒ every stage local, even with a cloud pin + prefer-cloud master', () => {
  const s = mk({ backendPreference: 'prefer-cloud',
    stages: { ...DEFAULTS.stages, VIDEO: { mode: 'manual', backend: 'cloud' }, LLM: { mode: 'manual', backend: 'cloud' } } });
  const r = resolveConfig(CAPS(true), s, NO_KEYS);
  for (const st of STAGES) {
    assert.equal(r.stages[st].backend, 'local', `${st} must be local with no key`);
    assert.equal(r.stages[st].reason, 'no-key');
  }
});

test('I2 — key present but auto/prefer-local ⇒ still local (privacy-first default)', () => {
  for (const master of ['auto', 'prefer-local'] as const) {
    const r = resolveConfig(CAPS(true), mk({ backendPreference: master }), BOTH);
    for (const st of STAGES) assert.equal(r.stages[st].backend, 'local', `${st} @ ${master}`);
  }
});

test('explicit opt-in routes cloud: prefer-cloud master, and per-stage manual pin', () => {
  const pc = resolveConfig(CAPS(true), mk({ backendPreference: 'prefer-cloud' }), BOTH);
  for (const st of STAGES) {
    assert.equal(pc.stages[st].backend, 'cloud');
    assert.equal(pc.stages[st].reason, 'preference');
  }
  const pin = resolveConfig(CAPS(true), mk({ stages: { ...DEFAULTS.stages, LLM: { mode: 'manual', backend: 'cloud' } } }), BOTH);
  assert.equal(pin.stages.LLM.backend, 'cloud');
  assert.equal(pin.stages.LLM.reason, 'pinned');
  assert.equal(pin.stages.VIDEO.backend, 'local'); // untouched stages stay local
});

test('a local pin beats a prefer-cloud master (pin is explicit user intent)', () => {
  const r = resolveConfig(CAPS(true), mk({ backendPreference: 'prefer-cloud',
    stages: { ...DEFAULTS.stages, VIDEO: { mode: 'manual', backend: 'local' } } }), BOTH);
  assert.equal(r.stages.VIDEO.backend, 'local');
  assert.equal(r.stages.LLM.backend, 'cloud'); // others still follow prefer-cloud
});

test('I3 — tier/capability never flips a stage to cloud; unsupported+local = blocked, not cloud', () => {
  const r = resolveConfig(CAPS(false), mk(), BOTH); // unsupported machine, keys present, all auto
  for (const st of STAGES) {
    assert.equal(r.stages[st].backend, 'local', `${st} stays local (I2), never auto-cloud`);
    assert.equal(r.stages[st].localAvailable, false, `${st} flagged unavailable → render blocks, no silent cloud`);
  }
});

test('toEnv — no keys: every VB_<STAGE>_BACKEND is local, 480p timeline, GPU-serial', () => {
  const env = resolveConfig(CAPS(true), mk(), NO_KEYS).toEnv();
  for (const st of STAGES) assert.equal(env[`VB_${st}_BACKEND`], 'local');
  assert.ok(!Object.entries(env).some(([k, v]) => k.endsWith('_BACKEND') && v === 'cloud'), 'no backend var is cloud');
  assert.equal(env.VB_W, '832'); assert.equal(env.VB_H, '480');
  assert.equal(env.VB_WORKERS, '1');
});

test('toEnv — prefer-cloud + keys: cloud video ⇒ 720p timeline, keeps worker parallelism', () => {
  const env = resolveConfig(CAPS(true), mk({ backendPreference: 'prefer-cloud', workers: 4 }), BOTH).toEnv();
  assert.equal(env.VB_VIDEO_BACKEND, 'cloud');
  assert.equal(env.VB_W, '1280'); assert.equal(env.VB_H, '720');
  assert.equal(env.VB_WORKERS, '4');
  assert.ok(!('VB_LOCAL_VIDEO_MODEL' in env), 'no local video block when video is cloud');
});

test('pickBackend decision table spot-checks', () => {
  assert.deepEqual(pickBackend('STT', { mode: 'auto' }, 'prefer-cloud', { openrouter: true, replicate: false }),
    { backend: 'local', reason: 'no-key' }); // STT gated on Replicate
  assert.deepEqual(pickBackend('LLM', { mode: 'auto' }, 'prefer-cloud', { openrouter: true, replicate: false }),
    { backend: 'cloud', reason: 'preference' }); // LLM gated on OpenRouter
});

test('migrate — v2 local-only blob preserves local fields, all stages auto, no cloud pins', () => {
  const v2 = { settingsVersion: 2, sttLang: 'it', workers: 2, localVideoModel: '5b', localQuality: 'hd', localWanDir: '/x' };
  const s = migrate(v2);
  assert.equal(s.settingsVersion, 3);
  assert.equal(s.sttLang, 'it'); assert.equal(s.workers, 2);
  assert.equal(s.localVideoModel, '5b'); assert.equal(s.localQuality, 'hd'); assert.equal(s.localWanDir, '/x');
  for (const st of STAGES) assert.equal(s.stages[st].mode, 'auto', `${st} migrates to auto`);
  // a v2 user has no keys ⇒ resolver forces all-local
  const r = resolveConfig(CAPS(true), s, NO_KEYS);
  for (const st of STAGES) assert.equal(r.stages[st].backend, 'local');
});

test('migrate — v1 flat cloud choice does NOT become a cloud pin (I2), local choice becomes a local pin', () => {
  const v1 = { settingsVersion: 1, sttBackend: 'local', llmBackend: 'cloud', videoBackend: 'cloud', storyModel: 'x/y' };
  const s = migrate(v1);
  assert.deepEqual(s.stages.STT, { mode: 'manual', backend: 'local' }); // local pin survives
  assert.equal(s.stages.LLM.mode, 'auto');   // cloud → auto, NOT a cloud pin
  assert.equal(s.stages.VIDEO.mode, 'auto');
  assert.equal(s.cloud.storyModel, 'x/y');   // legacy flat slug carried into nested cloud
  assert.equal(s.localVideoModel, '14b');    // absent → default
});
