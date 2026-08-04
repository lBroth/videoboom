// Shot-aware keyframe routing, unit-tested at refsForScene — the single seam both the local and the cloud
// keyframe backends go through. Guards the bug this was written for: an identity model's job is to PLACE the
// reference person, so handing it a scene the storyboard describes as empty ("no characters are visible yet")
// put the lead in it anyway — and paid the identity model's price (36.7s vs 8.0s measured) to do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEAD = 'TESTLEAD00000000000000000';

// refsForScene resolves a cast member by checking that `characters/<id>/primary.png` EXISTS under the data
// dir — it never opens the file, so any bytes will do. This used to point at `.vbdata-test/`, which
// .gitignore excludes: green in a working copy that happened to have it, red in every fresh clone, in CI
// and in a git worktree, where the missing file made every ref resolve to zero. Build the fixture instead.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-shot-routing-'));
fs.mkdirSync(path.join(DATA, 'characters', LEAD), { recursive: true });
fs.writeFileSync(path.join(DATA, 'characters', LEAD, 'primary.png'), 'not a real png');
process.env.VB_DATA_DIR = DATA;

const { refsForScene } = require('../src/engine/backends/sceneShared');

const project = { cast: [{ id: LEAD, role: 'lead' }] };

test('environment shot gets NO refs — even when characters is populated', () => {
  // The real failure mode: the storyboard listed the lead on a shot it described as empty, so filtering on
  // `characters` alone would not have helped. `shot` is what decides.
  assert.deepEqual(refsForScene(project, { shot: 'environment', characters: [LEAD] }), []);
  assert.deepEqual(refsForScene(project, { shot: 'environment', characters: [] }), []);
});

test('character shot still resolves the cast ref', () => {
  assert.equal(refsForScene(project, { shot: 'character', characters: [LEAD] }).length, 1);
});

test('character shot with an empty cast list still falls back to the lead', () => {
  // Unchanged behavior: a character shot that forgot to list anyone still gets the hero.
  assert.equal(refsForScene(project, { shot: 'character', characters: [] }).length, 1);
});

test('projects stored before `shot` existed keep the old behavior exactly', () => {
  // Backward compatibility is the whole reason routing keys off an explicit field rather than an empty
  // `characters` array: absent means "old project", not "empty scene".
  assert.equal(refsForScene(project, { characters: [LEAD] }).length, 1);
  assert.equal(refsForScene(project, { characters: [] }).length, 1);
  assert.equal(refsForScene(project, {}).length, 1);
});
