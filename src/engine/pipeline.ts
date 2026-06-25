// Render orchestration: storyboard -> keyframe pass -> clip pass -> assemble. Async + local. Each scene's
// clip renders via providers.genVideo (submit + poll) inside a bounded concurrency pool. Progress is
// reported through an `emit(event)` callback the engine turns into IPC events. Segmentation / shot-list /
// frame-grid logic is a verbatim port of the proven pipeline.
import { env, envInt } from './config';
import { costTotal } from './cost';
import * as S from './storage';
import { FPS, W, H, probeDuration, toPng, putThumb, fitToWindow, stillClip, ffmpeg, toWav } from './ffmpeg';
import * as P from './providers';
import { segmentSong, windowVocalCoverage, windowEnergy } from './segment';

export type Emit = (e: any) => void;
export type Cancelled = () => boolean;
const noop: Emit = () => {};
const never: Cancelled = () => false;

const MIN_SCENES = 4;
const MAX_SCENES = 60;
const workers = () => Math.max(1, envInt('VB_WORKERS', 4));

class Cancel extends Error {}
function checkCancel(cancelled: Cancelled): void {
  if (cancelled()) throw new Cancel('cancelled');
}

/** Run fn over items with a bounded concurrency (mirrors the old ThreadPoolExecutor(max_workers)). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) break;
        ret[i] = await fn(items[i], i);
      }
    }),
  );
  return ret;
}

// ── cast / refs ───────────────────────────────────────────────────────────────
function castRoles(p: any): Record<string, string> {
  const roles: Record<string, string> = {};
  (p.cast || []).forEach((c: any, i: number) => {
    const cid = typeof c === 'object' ? c.id : c;
    if (cid) roles[cid] = (typeof c === 'object' ? c.role : null) || (i === 0 ? 'lead' : 'supporting');
  });
  return roles;
}

function refsForScene(p: any, scene: any): [string, string][] {
  const roles = castRoles(p);
  const leadId = Object.keys(roles)[0] || null;
  let cids: string[] = (scene.characters || []).filter(Boolean);
  if (!cids.length && leadId) cids = [leadId];
  const cap = envInt('VB_MAX_SUBJECTS', 4);
  const out: [string, string][] = [];
  for (const cid of cids.slice(0, cap)) {
    const rk = `characters/${cid}/primary.png`;
    if (!S.mediaExists(rk)) continue;
    const lp = S.mediaPath(rk);
    const ch = S.getCharacter(cid) || {};
    let label = ch.name || 'character';
    const role = roles[cid];
    if (role && role !== 'lead') label = `${label} (the ${role})`;
    out.push([lp, label]);
  }
  return out;
}

// ── prompts ──────────────────────────────────────────────────────────────────--
const SYS = 'You are an award-winning music-video director. Output ONLY one valid JSON object.';

function shotListPrompt(style: string, _look: string, bibleBlock: string, momentsBlock: string, n: number, castBlock = ''): string {
  return `STYLE: ${style}${bibleBlock}${castBlock}

You are turning the STORY BIBLE above into the actual shot list. For EACH timed moment below, write ONE
vivid cinematic shot that DEPICTS WHAT THAT MOMENT'S OWN LYRIC IS ABOUT — the literal subject of those
exact words — staged inside the bible's world. The shots play as ONE continuous narrative, but each shot
must match ITS OWN words, NEVER the words of a later moment.
RULES:
- SYNC TO THE VOCALS (critical): match the visual to each moment's VOCAL-COVERAGE tag.
  - INSTRUMENTAL (no vocals — intro, solo, break, outro): ATMOSPHERIC / mood ONLY — light, texture,
    environment, anticipation. Do NOT depict ANY lyric imagery — not this line, and ESPECIALLY not a line
    sung LATER (no previewing the story: no cribs/school/office in a guitar-only intro).
  - SPARSE (a word or two over mostly instrumental): LIGHT / atmospheric, hold the moment — no full beat.
  - SUNG (real singing): DEPICT THE LITERAL SUBJECT of THESE words. If the line names a place, age, object
    or action ("nido/asilo/scuola" -> a nursery, kindergarten, schoolroom; "lavori/ufficio" -> a
    workplace), SHOW THAT — do NOT skip ahead to a later life-stage for the sake of "flow". Keep the
    bible's tone/palette consistent, but the SETTING must match the words being sung. When a line lists
    several stages, show the FIRST / dominant one.
  Save each beat for WHEN its words are sung; never pull a later beat earlier or park it in the intro.
- The LEAD (cast member 0) is the hero — present in most shots, always the focus. Their reference photo
  defines their exact look AND AGE — honor it: if the lead is a baby/child they STAY that age in every
  shot (never age them up into an adult); a dog stays a dog. Frame the action for their real age/type.
- CAST: if a CAST roster is given, cast each shot from it. For EVERY scene set "characters" to the list
  of cast indices that appear in that shot (the lead is index 0). Bring in secondary cast (e.g. family)
  where the story/lyrics support it; keep it to at most 3 people in one shot. In the prompt refer to a
  present character ONLY by name + role (e.g. "Debora, the mother") — NEVER invent, age, or alter their
  face, hair, age, skin or clothing; the reference photo defines their look. If no roster, use [0].
- CINEMATIC FILM, NOT A PERFORMANCE (critical for a real, non-fake look): shoot it like cinema, not a
  stage. The subject does NOT dance, lip-sync, or perform to camera. Energy comes from the CAMERA and the
  ENVIRONMENT (camera movement, light, weather, location, atmosphere) while the person stays natural —
  understated real behaviour: walking, turning, looking, a small honest gesture. Realistic people doing big
  dance moves look fake; keep it grounded and let the world move.
- BACKGROUND people only if the location naturally has them (a street, a bar, a crowd), behaving normally —
  NEVER backup dancers, never moving "to the beat". They are NOT cast and must never replace or age-up the lead.
- EXPRESSION: carry the FEELING through subtle face + body acting and the mood/light of the shot, not theatrics.
- VARY framing, camera move and location each scene (wide, medium, tracking, static) — never repeat the same
  setup, and NEVER default to dancing. No extreme close-ups.
- FLOW: keep a consistent PALETTE / film-grade / tone across the video so shots morph smoothly — but the
  SETTING follows the words: change location whenever the lyric does (the lyric ALWAYS wins over location
  stability). Never hold a location past the line that justified it.
- Do NOT render readable words/logos/captions (garbage). NEVER Asian/foreign signage.
MOMENTS:
${momentsBlock}

Output EXACTLY ${n} scenes in the same order, indices 0..${n - 1}, each with its "characters" list.`;
}

function previewTarget(n: number, preview: boolean): number {
  if (!preview) return n;
  return Math.max(1, Math.min(n, Math.max(MIN_SCENES, Math.ceil(n * 0.25))));
}

// ── storyboard ──────────────────────────────────────────────────────────────--
async function storyboard(pid: string, emit: Emit, preview: boolean): Promise<void> {
  const p = S.getProject(pid) || {};
  const style = (p.style || 'cinematic music video').trim();
  const look = env('VB_LOOK', 'attractive, stylish, fashionable, glamorous Western/European adults, viral looks');
  const cast: any[] = [];
  (p.cast || []).forEach((c: any, i: number) => {
    const cid = typeof c === 'object' ? c.id : c;
    const role = (typeof c === 'object' ? c.role : null) || (i === 0 ? 'lead' : 'supporting');
    const ch = S.getCharacter(cid) || {};
    cast.push({ id: cid, role, name: ch.name || 'Character', desc: ch.description || '' });
  });
  let castBlock = '';
  if (cast.length) {
    const lines = cast
      .map((c, i) => {
        const desc = (c.desc || '').trim();
        return `  ${i}: ${c.name} — role: ${c.role}` + (desc ? ` — who they are: ${desc.slice(0, 140)}` : '');
      })
      .join('\n');
    castBlock =
      `\n\nCAST (index 0 = lead). The 'who they are' note tells you each one's AGE / TYPE so you frame them correctly (a baby is a baby, a dog is a dog) — use it ONLY for framing. In the scene prompts refer to each ONLY by name + role (e.g. "Ian, the lead"); NEVER copy that note or invent/age/alter their face, hair, age, skin or clothing — their reference photo defines their exact look:\n${lines}`;
  }

  S.updateProject(pid, { status: 'storyboarding', stage: 'storyboard', progress: 0.05, renderStartedAt: Date.now() / 1000 });
  emit({ event: 'stage', stage: 'transcribe' });
  const inPath = S.tmp(`in_${pid}`);
  S.copyOut(p.audioKey, inPath);
  const song = S.tmp(`song_${pid}.wav`);
  await toWav(inPath, song);
  const dur = (await probeDuration(song)) || 0;
  const words = await P.transcribeWords(song);
  const whisperText = (words || [])
    .map((w) => w.word || '')
    .join(' ')
    .trim();
  if (whisperText.length < 40) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: "Could not read the song's words (no audible vocals)." });
    throw new Error('no lyrics');
  }
  const segs = segmentSong(words, dur).slice(0, MAX_SCENES);
  const n = segs.length;
  const renderTargetN = previewTarget(n, preview);
  const wins: [number, number][] = segs.map((s) => [Number(s[0]), Number(s[1])]);
  const snippets = segs.map((s) => s[2]);
  const covered = renderTargetN <= n ? wins[renderTargetN - 1][1] : dur;
  const energies = await windowEnergy(song, wins);

  emit({ event: 'stage', stage: 'story' });
  const bible = await P.storyBible(whisperText, style, dur, castBlock);
  if (!bible || !(bible.acts || []).length) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: 'Story generation failed. Retry.' });
    throw new Error('no bible');
  }
  const acts = bible.acts
    .map((a: any) => `  - [${a.section || ''}] location="${a.location || ''}" beat="${a.beat || ''}" emotion="${a.emotion || ''}"`)
    .join('\n');
  const bibleBlock =
    `\n\nSTORY BIBLE (the video must TELL THIS STORY):\nLOGLINE: ${bible.logline || ''}\nPROTAGONIST: ${bible.protagonist || ''}\nWORLD: ${bible.world || ''}\nARC: ${bible.arc || ''}\nACTS:\n${acts}\n`;
  S.updateProject(pid, { stage: 'scenes', progress: 0.2 });

  emit({ event: 'stage', stage: 'shotlist' });
  const coverage = windowVocalCoverage(words, wins);
  const moment = (k: number): string => {
    const lyric = (snippets[k] || '').trim();
    const cv = coverage[k];
    let tag: string;
    if (!lyric || cv < 0.15) tag = 'INSTRUMENTAL (no vocals — atmospheric/mood shot, NO plot)';
    else if (cv < 0.45) tag = `SPARSE vocals (${Math.trunc(cv * 100)}% sung — mostly instrumental: light/atmospheric, no big beat) lyric="${lyric}"`;
    else tag = `SUNG (${Math.trunc(cv * 100)}%) lyric="${lyric}"`;
    return `${k}: t=${Math.round(wins[k][0] * 10) / 10}s dur=${Math.round((wins[k][1] - wins[k][0]) * 10) / 10}s energy=${energies[k]} ${tag}`;
  };
  const moments = Array.from({ length: n }, (_, k) => moment(k)).join('\n');
  const user = shotListPrompt(style, look, bibleBlock, moments, n, castBlock);
  let scenes: any[] = [];
  for (let i = 0; i < 3; i++) {
    const out = await P.llmJson(SYS, user, P.SCENES_SCHEMA, undefined, Math.min(60000, 1200 + n * 260), 0.4);
    scenes = out ? out.scenes || [] : [];
    if (scenes.length >= n) break;
  }
  if (scenes.length < n || scenes.slice(0, n).some((s) => !(s.prompt || '').trim())) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: `Storyboard incomplete (${scenes.length}/${n}). Retry.` });
    throw new Error('shot list incomplete');
  }
  scenes = scenes.slice(0, n);
  scenes.forEach((s, k) => {
    const st = Math.round(wins[k][0] * 100) / 100;
    const en = Math.round(wins[k][1] * 100) / 100;
    const idxs: number[] = s.characters || [0];
    let ids = idxs.filter((i) => Number.isInteger(i) && i >= 0 && i < cast.length).map((i) => cast[i].id);
    if (!ids.length && cast.length) ids = [cast[0].id];
    S.putScene(pid, k, {
      title: s.title || `Scene ${k + 1}`,
      prompt: s.prompt,
      startSec: st,
      endSec: en,
      energy: energies[k],
      lyric: (snippets[k] || '').slice(0, 200),
      characters: ids,
      status: 'pending',
    });
  });
  S.updateProject(pid, {
    sceneCount: n,
    scenesPlanned: n,
    previewScenes: renderTargetN,
    renderTarget: renderTargetN,
    durationSec: Math.round(covered * 100) / 100,
    stage: 'rendering',
    progress: 0.3,
  });
}

// ── keyframe + clip passes ──────────────────────────────────────────────────--
function keyframePath(pid: string, k: number): string {
  return S.mediaPath(`${pid}/keyframes/scene_${k}.png`);
}

function putSceneMerged(pid: string, k: number, sc: any, updates: Record<string, unknown>): void {
  const cur = { ...sc, ...updates };
  delete cur.projectId;
  delete cur.index;
  S.putScene(pid, k, cur);
}

async function buildKeyframe(pid: string, k: number, p: any, toon: boolean, refresh = ''): Promise<string | null> {
  const key = `${pid}/keyframes/scene_${k}.png`;
  const out = keyframePath(pid, k);
  const sc = S.getScene(pid, k) || {};
  if (!refresh && S.mediaExists(key)) {
    await putThumb(out, `${pid}/keyframes/scene_${k}_thumb.jpg`);
    return out;
  }
  let prompt = sc.prompt || '';
  if (refresh) prompt = `${prompt}, ${refresh}, no extreme close-up`;
  S.mkdirp(S.mediaPath(`${pid}/keyframes`));
  if (!(await P.cloudKeyframe(prompt, out, refsForScene(p, sc), toon))) return null;
  await putThumb(out, `${pid}/keyframes/scene_${k}_thumb.jpg`);
  return out;
}

async function renderClip(pid: string, k: number, p: any, kfFirst: string, kfLast: string | null, emit: Emit, seed = 42): Promise<[boolean, string]> {
  const sc = S.getScene(pid, k) || {};
  const wdur = Math.max(0.4, Number(sc.endSec || 0) - Number(sc.startSec || 0) || 4);
  const motion = P.MOTION[sc.energy || 'medium'] || P.MOTION.medium;
  const vmodel = p.videoModel || null;
  const raw = S.tmp(`raw_${pid}_${k}.mp4`);
  const [ok, err] = await P.genVideo(kfFirst, `${sc.prompt || ''}, ${motion}, cinematic`, raw, wdur, kfLast, vmodel, seed);
  if (!ok) {
    const reason = P.isContentBlock(err) ? "This scene was blocked by the model's safety filter." : `Scene render failed: ${(err || '').slice(0, 160)}`;
    putSceneMerged(pid, k, sc, { status: 'failed', error: reason });
    emit({ event: 'scene', index: k, status: 'failed', error: reason });
    return [false, reason];
  }
  const fit = await fitToWindow(raw, sc.startSec || 0, sc.endSec || 0, S.tmp(`scene_${pid}_${k}.mp4`));
  S.copyIn(fit, `${pid}/clips/scene_${k}.mp4`);
  putSceneMerged(pid, k, sc, { status: 'done', error: '', clipKey: `${pid}/clips/scene_${k}.mp4` });
  emit({ event: 'scene', index: k, status: 'done' });
  return [true, ''];
}

async function renderScenes(pid: string, emit: Emit, cancelled: Cancelled): Promise<{ projectId: string; videoKey: string }> {
  const p = S.getProject(pid) || {};
  const n = Number(p.sceneCount || 0);
  const target = Math.min(Number(p.renderTarget || n), n);
  const toon = p.videoStyle === 'toon';
  const scenes = S.listScenes(pid);
  const done = new Set(scenes.filter((s) => s.status === 'done').map((s) => Number(s.index)));
  const toRender = scenes
    .filter((s) => Number(s.index) < target && s.status !== 'done')
    .map((s) => Number(s.index))
    .sort((a, b) => a - b);
  if (!toRender.length) return assemble(pid, emit);
  S.updateProject(pid, { status: 'rendering', stage: 'rendering', previewScenes: done.size + toRender.length, renderStartedAt: Date.now() / 1000 });

  // keyframe pass — each scene we render + its morph target (next scene's keyframe). Parallel; reused.
  const needed = Array.from(new Set([...toRender, ...toRender.filter((k) => k + 1 < n).map((k) => k + 1)])).sort((a, b) => a - b);
  emit({ event: 'stage', stage: 'keyframes', total: needed.length });
  const kfPaths: Record<number, string | null> = {};
  await mapPool(needed, workers(), async (k) => {
    checkCancel(cancelled);
    const path = await buildKeyframe(pid, k, p, toon);
    kfPaths[k] = path;
    emit({ event: 'keyframe', index: k, ok: Boolean(path) });
  });

  for (const k of toRender) {
    if (!kfPaths[k]) {
      const sc = S.getScene(pid, k) || {};
      putSceneMerged(pid, k, sc, { status: 'failed', error: 'Keyframe generation failed.' });
      emit({ event: 'scene', index: k, status: 'failed', error: 'keyframe failed' });
    }
  }

  // clip pass — render each scene whose keyframe exists. last_frame = next keyframe (morph).
  const renderable = toRender.filter((k) => kfPaths[k]);
  emit({ event: 'stage', stage: 'clips', total: renderable.length });
  await mapPool(renderable, workers(), async (k) => {
    checkCancel(cancelled);
    await renderClip(pid, k, p, kfPaths[k]!, kfPaths[k + 1] || null, emit);
    const d = S.listScenes(pid).filter((s) => s.status === 'done').length;
    S.updateProject(pid, { scenesDone: d, progress: Math.round((0.3 + (0.6 * Math.min(d, target)) / Math.max(1, target)) * 1000) / 1000 });
  });

  return assemble(pid, emit);
}

export async function render(pid: string, emit: Emit, preview: boolean, cancelled: Cancelled = never): Promise<{ projectId: string; videoKey: string }> {
  await storyboard(pid, emit, preview);
  return renderScenes(pid, emit, cancelled);
}

export async function resume(pid: string, emit: Emit, cancelled: Cancelled = never): Promise<{ projectId: string; videoKey: string }> {
  const p = S.getProject(pid) || {};
  const n = Number(p.scenesPlanned || p.sceneCount || 0);
  S.updateProject(pid, { renderTarget: n });
  return renderScenes(pid, emit, cancelled);
}

// ── single-scene refresh ────────────────────────────────────────────────────--
const REFRESH_VARIATIONS = [
  'a different camera angle and framing',
  'a wider shot showing more of the environment',
  'a tighter medium shot from a fresh angle',
  'different lighting and mood, fresh composition',
  'a new perspective and background detail',
];

export async function regenerateScene(pid: string, k: number, emit: Emit): Promise<{ projectId: string; videoKey: string }> {
  const p = S.getProject(pid) || {};
  const n = Number(p.sceneCount || 0);
  const sc = S.getScene(pid, k);
  if (!sc) throw new Error(`scene ${k} not found`);
  const toon = p.videoStyle === 'toon';
  S.updateProject(pid, { status: 'rendering', stage: 'refresh', progress: 0.3, renderStartedAt: Date.now() / 1000 });
  const keep: Record<string, unknown> = {};
  for (const x of ['title', 'prompt', 'startSec', 'endSec', 'energy', 'lyric', 'characters']) if (x in sc) keep[x] = sc[x];
  S.putScene(pid, k, { status: 'pending', ...keep });

  const vary = REFRESH_VARIATIONS[Math.trunc(Date.now() / 1000) % REFRESH_VARIATIONS.length];
  emit({ event: 'stage', stage: 'keyframes', total: 1 });
  const fk = await buildKeyframe(pid, k, p, toon, vary);
  if (!fk) {
    S.putScene(pid, k, { status: 'failed', error: 'Keyframe generation failed.', ...keep });
    throw new Error(`keyframe generation failed for scene ${k}`);
  }
  const lastK = k + 1 < n && S.mediaExists(`${pid}/keyframes/scene_${k + 1}.png`) ? keyframePath(pid, k + 1) : null;
  emit({ event: 'stage', stage: 'clips', total: 1 });
  const [ok, err] = await renderClip(pid, k, p, fk, lastK, emit);
  if (!ok) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: err });
    throw new Error(err);
  }
  if (k > 0 && S.mediaExists(`${pid}/keyframes/scene_${k - 1}.png`)) {
    await renderClip(pid, k - 1, p, keyframePath(pid, k - 1), fk, emit);
  }
  return assemble(pid, emit);
}

// ── character portrait ──────────────────────────────────────────────────────--
export async function characterPortrait(cid: string, uploadKey: string, prompt: string, _emit: Emit): Promise<any> {
  uploadKey = (uploadKey || '').trim();
  prompt = (prompt || '').trim();
  const c = S.getCharacter(cid);
  if (!c) throw new Error(`character ${cid} not found`);
  let src: string | null = null;
  if (uploadKey) {
    const raw = S.copyOut(uploadKey, S.tmp(`char_in_${cid}`));
    src = (await toPng(raw, S.tmp(`char_src_${cid}.png`))) || raw;
    const [safe, codes] = await P.moderateImage(src);
    if (!safe) {
      S.updateCharacter(cid, { status: 'rejected', error: 'This image was blocked by safety moderation (sexual, graphic, or prohibited content). Please use a different photo.' });
      return { characterId: cid, rejected: true, codes };
    }
  }
  const out = S.tmp(`char_ai_${cid}.png`);
  const base = 'polished cinematic character portrait, studio lighting, neutral background, head and shoulders, looking at camera, photorealistic, no text or letters';
  let ok: boolean;
  if (src != null) {
    const desc = prompt ? ', ' + prompt : '';
    ok = await P.cloudKeyframe(
      `${base}. This is the SAME person as the reference photo — reproduce their EXACT face (face shape, eyes, nose, mouth, jawline, eyebrows, skin tone), hair, facial hair and apparent age faithfully; do NOT beautify, slim, de-age or alter the face${desc}`,
      out,
      [[src, 'this exact person']],
    );
  } else {
    ok = await P.cloudKeyframe(`${prompt}, ${base}`, out);
  }
  const primary = ok ? out : src;
  if (primary == null) {
    S.updateCharacter(cid, { status: 'failed', error: 'Could not create the portrait. Please try a different description.' });
    throw new Error('portrait generation failed');
  }
  const caption = await P.vlmCaption(primary);
  const pkey = `characters/${cid}/primary.png`;
  const primaryPng = (await toPng(primary, S.tmp(`char_primary_${cid}.png`))) || primary;
  S.copyIn(primaryPng, pkey);
  const tkey = await putThumb(primaryPng, `characters/${cid}/primary_thumb.jpg`);
  const images = [pkey, ...((c.images || []) as string[]).filter((i) => i !== pkey)];
  S.updateCharacter(cid, { images, primaryKey: pkey, thumbKey: tkey, description: caption || c.description || '', status: 'ready', aiGenerated: Boolean(ok), error: '' });
  return { characterId: cid, primaryKey: pkey, aiGenerated: Boolean(ok) };
}

// ── assemble ─────────────────────────────────────────────────────────────────-
async function assemble(pid: string, emit: Emit): Promise<{ projectId: string; videoKey: string }> {
  const p = S.getProject(pid) || {};
  emit({ event: 'stage', stage: 'assemble' });
  S.updateProject(pid, { stage: 'assemble', progress: 0.92 });
  const work = S.tmp(`asm_${pid}`);
  S.mkdirp(`${work}/clips`);
  S.mkdirp(`${work}/output`);
  const clips: string[] = [];
  let hasReal = false;
  for (const s of S.listScenes(pid).sort((a, b) => Number(a.index || 0) - Number(b.index || 0))) {
    if (s.status !== 'done' && s.status !== 'failed') continue;
    const k = Number(s.index || 0);
    const key = `${pid}/clips/scene_${k}.mp4`;
    const dst = `${work}/clips/scene_${k}.mp4`;
    if (s.status === 'done' && S.mediaExists(key)) {
      S.copyOut(key, dst);
      clips.push(dst);
      hasReal = true;
    } else {
      const kkey = `${pid}/keyframes/scene_${k}.png`;
      const kf = S.mediaExists(kkey) ? S.copyOut(kkey, `${work}/clips/kf_${k}.png`) : '';
      clips.push(await stillClip(kf, s.startSec || 0, s.endSec || 0, dst, 'SCENE FAILED'));
    }
  }
  if (!hasReal) {
    S.updateProject(pid, { status: 'failed', error: 'no clips' });
    throw new Error('no clips');
  }
  S.copyOut(p.audioKey, `${work}/output/song_in`);
  await toWav(`${work}/output/song_in`, `${work}/output/song.wav`);
  const concat = `${work}/concat.txt`;
  S.writeText(concat, clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n') + '\n');
  const silent = `${work}/output/silent.mp4`;
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', concat, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), silent]);
  const vdur = await probeDuration(silent);
  if (vdur && vdur > 0) {
    const trimmed = `${work}/output/song_trim.wav`;
    await ffmpeg(['-i', `${work}/output/song.wav`, '-t', String(vdur), trimmed]);
    if (S.fileSize(trimmed) > 0) {
      try {
        S.copyFileIn(trimmed, `${work}/output/song.wav`);
      } catch {
        /* keep original */
      }
    }
  }
  const final = `${work}/output/music_video.mp4`;
  await ffmpeg([
    '-i', silent, '-i', `${work}/output/song.wav`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    '-metadata', 'comment=AI-generated music video — made with Videoboom',
    '-metadata', 'generator=Videoboom (open-source, AI-generated)',
    '-movflags', '+faststart', final,
  ]);
  const key = `${pid}/output/music_video.mp4`;
  S.copyIn(final, key);
  const poster = `${work}/output/poster.jpg`;
  await ffmpeg(['-i', final, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4', poster]);
  if (S.fileSize(poster) > 0) S.copyIn(poster, `${pid}/output/poster.jpg`);

  const scenes = S.listScenes(pid);
  const failed = scenes.filter((s) => s.status === 'failed').length;
  const doneN = scenes.filter((s) => s.status === 'done').length;
  const pending = scenes.filter((s) => s.status === 'pending').length;
  const doneStatus = pending ? 'preview' : 'done';
  const patch: Record<string, unknown> = { status: doneStatus, stage: doneStatus, progress: 1, videoKey: key, scenesFailed: failed, previewScenes: doneN };
  if (vdur && vdur > 0) patch.durationSec = Math.round(vdur * 100) / 100;
  const started = Number(p.renderStartedAt || 0);
  if (started) patch.renderSeconds = Math.round(Math.max(0, Date.now() / 1000 - started) * 10) / 10;
  S.updateProject(pid, patch);
  emit({ event: 'done', status: doneStatus, videoKey: key, scenesFailed: failed, scenesDone: doneN, costCents: costTotal() });
  return { projectId: pid, videoKey: key };
}

// ── create / character (from the old CLI commands) ──────────────────────────────
function newId(): string {
  let s = '';
  for (let i = 0; i < 26; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s.toUpperCase();
}

function parseCast(spec: string): { id: string; role: string | null }[] {
  const cast: { id: string; role: string | null }[] = [];
  for (let part of (spec || '').split(',')) {
    part = part.trim();
    if (!part) continue;
    if (part.includes(':')) {
      const [cid, role] = part.split(/:(.*)/s);
      cast.push({ id: cid.trim(), role: role.trim() || null });
    } else {
      cast.push({ id: part, role: null });
    }
  }
  return cast;
}

export function createProject(o: { audio: string; name?: string; style?: string; cast?: string; quality?: string; mode?: string; videoModel?: string; id?: string }): { projectId: string } {
  const pid = o.id || newId();
  const ext = (o.audio.match(/\.[^.\/\\]+$/)?.[0] || '.mp3').toLowerCase();
  const audioKey = `${pid}/audio${ext}`;
  S.copyFileIn(o.audio, S.mediaPath(audioKey));
  const item: any = {
    id: pid,
    name: o.name || 'Untitled',
    status: 'ready',
    style: o.style || 'cinematic music video',
    cast: parseCast(o.cast || ''),
    quality: o.quality || 'fast',
    videoStyle: o.mode || 'realistic',
    audioKey,
    createdAt: Date.now() / 1000,
  };
  if (o.videoModel) item.videoModel = o.videoModel;
  S.putProject(item);
  return { projectId: pid };
}

export function characterCreate(o: { name?: string; style?: string; id?: string }): { characterId: string } {
  const cid = o.id || newId();
  S.putCharacter({ id: cid, name: o.name || 'Character', style: o.style || '', description: '', images: [], status: 'empty', createdAt: Date.now() / 1000 });
  return { characterId: cid };
}
