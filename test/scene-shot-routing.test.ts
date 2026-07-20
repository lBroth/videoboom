// Shot-aware keyframe routing, unit-tested at refsForScene — the single seam both the local and the cloud
// keyframe backends go through. Guards the bug this was written for: an identity model's job is to PLACE the
// reference person, so handing it a scene the storyboard describes as empty ("no characters are visible yet")
// put the lead in it anyway — and paid the identity model's price (36.7s vs 8.0s measured) to do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// refsForScene reads character media from the data dir; point it at the checked-in test fixtures.
process.env.VB_DATA_DIR = path.join(__dirname, '..', '.vbdata-test');

const { refsForScene } = require('../src/engine/backends/sceneShared');

const LEAD = 'AGPPB6ZHAUH2OH32S5DWTWB6SQ'; // .vbdata-test/characters/<id>/primary.png
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
