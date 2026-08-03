// Render orchestration: storyboard -> P.video().renderScenes (keyframe + clip loop) -> assemble. This module
// names NO backend — the resolved VIDEO backend (local Wan chain / cloud Kling morph) owns the whole scene
// loop behind the VideoBackend interface; the pipeline only builds the SceneRenderCtx and runs assemble.
// Progress is reported through an `emit(event)` callback the engine turns into IPC events.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { env, envInt, envBool } from './config';
import { costTotal } from './cost';
import * as S from './storage';

/** Read up to the first + last 256KB of a file into one buffer (cheap content fingerprint for large media). */
function fsReadHeadTail(path: string, size: number): Buffer {
  const cap = 256 * 1024;
  if (size <= cap * 2) return fs.readFileSync(path);
  const fd = fs.openSync(path, 'r');
  try {
    const head = Buffer.alloc(cap);
    const tail = Buffer.alloc(cap);
    fs.readSync(fd, head, 0, cap, 0);
    fs.readSync(fd, tail, 0, cap, size - cap);
    return Buffer.concat([head, tail]);
  } finally {
    fs.closeSync(fd);
  }
}
import { FPS, probeDuration, toPng, putThumb, stillClip, ffmpeg, toWav, x264, conformClip, concatClips } from './ffmpeg';
import * as P from './stages';
import { assertCastExists } from './backends/sceneShared';
import { ensureSidecar, sidecarPost } from './sidecar';
import { segmentSong, windowVocalCoverage, windowEnergy } from './segment';
import type { Emit, Cancelled, SceneRenderCtx } from './backends/types';

export type { Emit, Cancelled };
const noop: Emit = () => {};
const never: Cancelled = () => false;

const MIN_SCENES = 4;
const MAX_SCENES = 60;

// ── prompts ──────────────────────────────────────────────────────────────────--
const SYS = 'You are an award-winning music-video director. Output ONLY one valid JSON object.';
const SYS_AD = 'You are an award-winning commercial/ad director. Output ONLY one valid JSON object.';

// Hard rules injected into BOTH shot lists (ad + music-video). Small local LLMs ignore soft phrasing and
// re-introduce close-ups inside the MOTION field and readable UI/text on screens — these are the non-negotiable
// backstops, repeated verbatim in each prompt so the model can't route around them.
const HARD_FRAMING =
  '- FRAMING (HARD RULE, no exceptions): NO CLOSE-UPS anywhere — not as a shot, not as a camera end-point in "motion". Never fill the frame with a face, eyes, hands or a single object; never "push in / zoom in / crane to" a close-up. Keep EVERY shot AND every camera move at MEDIUM-to-WIDE distance, the figure roughly full-body and the surrounding scene always visible.';
const HARD_SCREENS =
  '- SCREENS & TEXT (HARD RULE — the image model cannot spell, any readable mark comes out garbled): nothing readable may appear anywhere. Monitors, screens, phones, signs and surfaces show ONLY abstract glowing light, soft colour fields or blurred geometric shapes — NEVER readable code, logs, error messages, badges, checkmarks, status bars, dashboards, charts, UI, numbers, labels, captions, a brand/product name, or any letters or symbols. No "Merged" badge, no "error logs", no status text. Render tech, data and energy as light and colour, never as characters.';

/** Shot-list rules for an ad/spot: the product is the hero, benefit-driven, punchy, ends on a CTA. */
function adShotListPrompt(style: string, bibleBlock: string, momentsBlock: string, n: number, castBlock = ''): string {
  return `BRAND / STYLE: ${style}${bibleBlock}${castBlock}

You are turning the SPOT BIBLE above into the actual shot list — a punchy commercial cut to the music.
For EACH timed moment below, write ONE vivid, on-brand shot that sells.
RULES:
- THE PRODUCT IS THE HERO. If a SUBJECT/PRODUCT reference is given (cast index 0), it appears in EVERY
  SINGLE shot — include index 0 in every scene's "characters" list. Hero framing, the product/mascot in
  action, the result it delivers. Refer to it ONLY by its name/role; its reference photo defines its EXACT
  look — never invent, alter, or restyle it.
- EVERY SHOT NEEDS BIG, READABLE MOTION (critical — static shots kill the spot): the mascot dashes, leaps,
  spins, sweeps ACROSS the frame; objects visibly transform, fly, or cascade; the camera moves decisively
  (fast dolly, whip pan, orbit, crane). This is an animated commercial — exaggerated cartoon motion is
  GOOD. Never a posed character just standing; something must be traveling through the frame in every shot.
- STAY IN THE PRODUCT'S REAL DOMAIN (critical): the bible says what the product IS — every shot lives in
  THAT world. Lyric metaphors are visual ideas INSIDE that domain, never literal objects: a software tool
  that "cleans up" code shows screens, dashboards, developers, terminals, transforming codebases — NEVER a
  physical cleaning product, spray bottle or mop. If no reference image is given, do NOT invent physical
  packaging (bottles, boxes, labels) — sell through the product's world, its users and its effect.
- ARC (follow the music's energy): open with a HOOK (an attention-grabbing image), reveal the PRODUCT
  clearly, show its BENEFIT and an aspirational LIFESTYLE/feeling, and BUILD to a final CALL-TO-ACTION shot
  (product + brand moment, confident and clean). The LAST shot is the CTA / hero product beat.
- Ads CAN be punchy and energetic — quick, bold, beat-synced framings, dynamic camera, striking light.
- People (if any) are aspirational lifestyle talent using/enjoying the product, looking natural and desirable.
- VARY framing each shot (product-in-context, lifestyle wide, detail macro, dramatic angle) — medium to wide, no close-ups.
- For EVERY shot also write "motion": ONE sentence of pure MOTION direction for the video model — an
  EXPLICIT camera move (dolly in/out, tracking, pan left/right, orbital arc, crane up/down, whip pan) with a
  pace word (slow/steady/brisk/rapid), plus what physically CHANGES across the clip as 2-3 chained beats
  (e.g. "steady dolly in on the bottle, condensation beads run down, light flares across the glass").
  Concrete and physical. NEVER "slow motion", never "static shot", no appearance/branding description.
- ABSOLUTELY NO WRITTEN TEXT IN ANY SHOT (the image model cannot spell — every rendered word comes out
  garbled and ruins the spot): never describe labels, packaging text, signs with words, on-screen captions,
  UI text, lettering or brand names as VISIBLE WRITING. The product's name must NEVER appear written
  anywhere — the reference image is the ONLY carrier of branding. Describe every surface, screen, sign and
  package as clean/blank/unbranded. NEVER Asian/foreign signage.
${HARD_FRAMING}
${HARD_SCREENS}
MOMENTS:
${momentsBlock}

Output EXACTLY ${n} scenes in the same order, indices 0..${n - 1}, each with its "characters" list.`;
}

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
  setup, and NEVER default to dancing. NO CLOSE-UPS: no face-filling or extreme close-up shots — hold the
  camera at MEDIUM-to-WIDE distance so a face is never large in the frame (close-up faces render poorly).
- FLOW: keep a consistent PALETTE / film-grade / tone across the video so shots morph smoothly — but the
  SETTING follows the words: change location whenever the lyric does (the lyric ALWAYS wins over location
  stability). Never hold a location past the line that justified it.
- EDITING — set "transition" for each shot (you are the editor, cut to the music + story):
  - "continue" = this shot FLOWS straight out of the previous one in the SAME place/moment — the camera
    keeps moving, the action continues, NO cut. The previous shot's last frame becomes this shot's start, so
    keep the same subject/location/lighting and just evolve the motion. Use it for smooth connected sequences.
  - "cut" = a real cut to a NEW shot: the location changes, a new act/section/lyric begins, a big energy
    jump, or you want a fresh framing/subject. The FIRST shot is ALWAYS "cut".
  Prefer "continue" for consecutive shots in one setting (fewer, smoother cuts); "cut" whenever the words or
  place change. Don't make every shot a cut — flow where the music/story flows.
- For EVERY shot also write "motion": ONE sentence of pure MOTION direction for the video model — an
  EXPLICIT camera move (dolly in/out, tracking, pan left/right, tilt, orbital arc, crane up/down, handheld
  drift) with a pace word (slow/steady/brisk/rapid), plus what the subject DOES across the clip as 2-3
  chained physical beats (e.g. "she walks toward camera, stops at the window, turns her head to the light").
  Without an explicit camera instruction the video model defaults to a dead push-in. Concrete and physical.
  NEVER "slow motion", never "static shot", no appearance/wardrobe description (the image fixes the look).
- ABSOLUTELY NO WRITTEN TEXT OR SYMBOLS IN ANY SHOT (the image model cannot spell — rendered words/code come
  out garbled): never describe words, labels, captions, lettering, names, CODE, digits, glyphs or symbols as
  visible marks — not on signs or screens, not floating in the air, not as smoke, particles or texture. NO
  "streams of text", NO "lines of code", NO error messages, NO readable UI. Render code/tech/data ABSTRACTLY
  — glowing particles, light trails, geometric shapes, colour fields — never actual characters. Describe
  every surface, sign, screen and terminal as clean/blank/glowing-without-text. NEVER Asian/foreign signage.
${HARD_FRAMING}
${HARD_SCREENS}
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
  const format = p.format === 'ad' ? 'ad' : 'music-video';
  const style = (p.style || (format === 'ad' ? 'modern product commercial' : 'cinematic music video')).trim();
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
    castBlock = format === 'ad'
      ? `\n\nSUBJECT / PRODUCT (index 0 = the hero product/brand). Feature it; its reference photo defines its EXACT look — never invent, alter or restyle it. Refer to it ONLY by name/role in the prompts:\n${lines}`
      : `\n\nCAST (index 0 = lead). The 'who they are' note tells you each one's AGE / TYPE so you frame them correctly (a baby is a baby, a dog is a dog) — use it ONLY for framing. In the scene prompts refer to each ONLY by name + role (e.g. "Ian, the lead"); NEVER copy that note or invent/age/alter their face, hair, age, skin or clothing — their reference photo defines their exact look:\n${lines}`;
  }

  S.updateProject(pid, { status: 'storyboarding', stage: 'storyboard', progress: 0.05, renderStartedAt: Date.now() / 1000 });
  emit({ event: 'stage', stage: 'transcribe' });
  const inPath = S.tmp(`in_${pid}`);
  S.copyOut(p.audioKey, inPath);
  const song = S.tmp(`song_${pid}.wav`);
  await toWav(inPath, song);
  const dur = (await probeDuration(song)) || 0;
  // Only a genuine STT failure stops the render. An instrumental track transcribes fine to zero words —
  // that's legitimate (the storyboard runs in instrumental mode off the energy windows), so empty words
  // must NOT be treated as an error for music videos or ads.
  const stt = await P.transcribe(song);
  if (!stt.ok) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: `Could not read the song's audio (transcription failed): ${stt.error}` });
    throw new Error('transcription failed');
  }
  const words = stt.words;
  const whisperText = words
    .map((w) => w.word || '')
    .join(' ')
    .trim();
  // Scenes follow the vocal phrasing (~6s). The Wan model renders each scene as one continuous shot of
  // chained native sub-clips (renderClip), so longer scenes no longer mean slow-motion — and the video has
  // fewer cuts. VB_LOCAL_SCENE_SEC can tune the target.
  const sceneSec = parseFloat(env('VB_LOCAL_SCENE_SEC', '6')) || 6;
  const segOpts = { target: sceneSec, maxSec: sceneSec * 2, minSec: Math.max(2, sceneSec * 0.5) };
  const segs = segmentSong(words, dur, segOpts).slice(0, MAX_SCENES);
  const n = segs.length;
  const renderTargetN = previewTarget(n, preview);
  const wins: [number, number][] = segs.map((s) => [Number(s[0]), Number(s[1])]);
  const snippets = segs.map((s) => s[2]);
  const covered = renderTargetN <= n ? wins[renderTargetN - 1][1] : dur;
  const energies = await windowEnergy(song, wins);

  emit({ event: 'stage', stage: 'story' });
  // The local LLM is nondeterministic — a single malformed JSON reply must not kill the render (the shot
  // list below already retries 3x for the same reason).
  let bible: any = null;
  for (let i = 0; i < 3 && !bible; i++) {
    bible = await P.storyBible(whisperText, style, dur, castBlock, format);
    if (bible && !(bible.acts || []).length) bible = null;
  }
  if (!bible) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: 'Story generation failed. Retry.' });
    throw new Error('no bible');
  }
  const acts = bible.acts
    .map((a: any) => `  - [${a.section || ''}] location="${a.location || ''}" beat="${a.beat || ''}" emotion="${a.emotion || ''}"`)
    .join('\n');
  const bibleBlock = format === 'ad'
    ? `\n\nSPOT BIBLE (the commercial must deliver THIS):\nLOGLINE: ${bible.logline || ''}\nHERO PRODUCT/BRAND: ${bible.protagonist || ''}\nWORLD: ${bible.world || ''}\nARC: ${bible.arc || ''}\nACTS:\n${acts}\n`
    : `\n\nSTORY BIBLE (the video must TELL THIS STORY):\nLOGLINE: ${bible.logline || ''}\nPROTAGONIST: ${bible.protagonist || ''}\nWORLD: ${bible.world || ''}\nARC: ${bible.arc || ''}\nACTS:\n${acts}\n`;
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
  const user = format === 'ad'
    ? adShotListPrompt(style, bibleBlock, moments, n, castBlock)
    : shotListPrompt(style, look, bibleBlock, moments, n, castBlock);
  const sys = format === 'ad' ? SYS_AD : SYS;
  let scenes: any[] = [];
  for (let i = 0; i < 3; i++) {
    const out = await P.llmJson(sys, user, P.SCENES_SCHEMA, undefined, Math.min(60000, 1200 + n * 260), 0.4);
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
      motion: String(s.motion || '').trim().slice(0, 300),
      startSec: st,
      endSec: en,
      energy: energies[k],
      lyric: (snippets[k] || '').slice(0, 200),
      characters: ids,
      transition: k === 0 ? 'cut' : s.transition === 'continue' ? 'continue' : 'cut',
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
    // Fingerprint the audio so a later re-render reuses this storyboard while the song is unchanged.
    storyboardHash: audioFingerprint(p),
  });
}

// ── scene render (backend-agnostic) ────────────────────────────────────────────
async function renderScenes(pid: string, emit: Emit, cancelled: Cancelled): Promise<{ projectId: string; videoKey: string }> {
  const p = S.getProject(pid) || {};
  assertCastExists(pid, p);
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
  // Reset progress to the keyframe-phase baseline so a resume/re-render doesn't show the previous run's 100%.
  S.updateProject(pid, { status: 'rendering', stage: 'rendering', progress: 0.3, previewScenes: done.size + toRender.length, renderStartedAt: Date.now() / 1000 });

  // The resolved VIDEO backend owns the entire keyframe+clip loop for these scenes (local Wan continuous
  // chain vs cloud Kling first+last morph). The pipeline names no backend — it just hands over the ctx and
  // runs the shared `assemble` afterward, once, for either backend.
  const ctx: SceneRenderCtx = { pid, p, toRender, target, toon, emit, cancelled };
  await P.video().renderScenes(ctx);
  return assemble(pid, emit);
}

/** A cheap, stable fingerprint of the project's audio (size + a content hash of head+tail), so a cached
 * storyboard is reused only while the audio is unchanged — re-uploading the song invalidates it. */
function audioFingerprint(p: any): string {
  try {
    const path = S.mediaPath(p.audioKey);
    const size = S.fileSize(path);
    const fd = fsReadHeadTail(path, size);
    return `${size}:${crypto.createHash('sha1').update(fd).digest('hex').slice(0, 16)}`;
  } catch {
    return '';
  }
}

/** Has this project already got a valid storyboard for its CURRENT audio? (scenes with prompts + matching
 * audio fingerprint). When true, a re-render can skip STT + the LLM story/shot-list passes entirely. */
function hasValidStoryboard(pid: string): boolean {
  const p = S.getProject(pid) || {};
  const n = Number(p.sceneCount || 0);
  if (n <= 0 || !p.storyboardHash) return false;
  const s0 = S.getScene(pid, 0);
  if (!s0 || !(s0.prompt || '').trim()) return false;
  return p.storyboardHash === audioFingerprint(p);
}

export async function render(pid: string, emit: Emit, preview: boolean, cancelled: Cancelled = never, regenStory = false): Promise<{ projectId: string; videoKey: string }> {
  // Reuse the cached storyboard (STT + LLM story/shot-list + keyframes are the slow pre-video steps) when the
  // audio is unchanged and we're not explicitly regenerating — just re-point renderTarget for preview/full.
  if (!regenStory && hasValidStoryboard(pid)) {
    const p = S.getProject(pid) || {};
    const n = Number(p.sceneCount || 0);
    const target = previewTarget(n, preview);
    emit({ event: 'stage', stage: 'story-cached' });
    S.updateProject(pid, { renderTarget: target, status: 'rendering', stage: 'rendering', renderStartedAt: Date.now() / 1000 });
  } else {
    await storyboard(pid, emit, preview);
  }
  return renderScenes(pid, emit, cancelled);
}

export async function resume(pid: string, emit: Emit, cancelled: Cancelled = never): Promise<{ projectId: string; videoKey: string }> {
  const p = S.getProject(pid) || {};
  const n = Number(p.scenesPlanned || p.sceneCount || 0);
  S.updateProject(pid, { renderTarget: n });
  return renderScenes(pid, emit, cancelled);
}

/** Re-render the already-rendered clips, reusing the storyboard + keyframes (no LLM, no keyframe regen) —
 * e.g. to upgrade a fast 10-step preview to a 20-step quality pass. Resets the done scenes' clip status to
 * pending (keeping their prompt/timing/keyframe), then re-runs the clip pass at the current step setting
 * (the caller passes VB_LOCAL_WAN_STEPS, e.g. 20). buildKeyframe reuses the on-disk keyframes as-is. */
export async function rerenderClips(pid: string, emit: Emit, cancelled: Cancelled = never): Promise<{ projectId: string; videoKey: string }> {
  const scenes = S.listScenes(pid);
  const doneIdx = scenes.filter((s) => s.status === 'done').map((s) => Number(s.index));
  if (!doneIdx.length) throw new Error('No rendered scenes to re-render. Render a preview first.');
  for (const s of scenes) {
    if (s.status !== 'done') continue;
    const keep: Record<string, unknown> = {};
    for (const x of ['title', 'prompt', 'motion', 'startSec', 'endSec', 'energy', 'lyric', 'characters', 'transition']) if (x in s) keep[x] = s[x];
    S.putScene(pid, Number(s.index), { status: 'pending', ...keep }); // keep keyframe + meta; clip will redo
  }
  const target = Math.max(...doneIdx) + 1;
  S.updateProject(pid, { renderTarget: target, status: 'rendering', stage: 'rendering', renderStartedAt: Date.now() / 1000 });
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
  const sc = S.getScene(pid, k);
  if (!sc) throw new Error(`scene ${k} not found`);
  const toon = p.videoStyle === 'toon';
  S.updateProject(pid, { status: 'rendering', stage: 'refresh', progress: 0.3, renderStartedAt: Date.now() / 1000 });
  const keep: Record<string, unknown> = {};
  for (const x of ['title', 'prompt', 'motion', 'startSec', 'endSec', 'energy', 'lyric', 'characters', 'transition']) if (x in sc) keep[x] = sc[x];
  S.putScene(pid, k, { status: 'pending', ...keep });

  const vary = REFRESH_VARIATIONS[Math.trunc(Date.now() / 1000) % REFRESH_VARIATIONS.length];
  emit({ event: 'stage', stage: 'keyframes', total: 1 });
  // The resolved VIDEO backend owns the fresh keyframe + clip and any neighbour re-render (the cloud morph
  // re-renders scene k-1 with the new keyframe as its last_frame); it sets the scene status itself on failure.
  const ctx: SceneRenderCtx = { pid, p, toRender: [k], target: Number(p.sceneCount || 0), toon, emit, cancelled: never };
  const [ok, err] = await P.video().refreshScene(ctx, k, vary);
  if (!ok) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: err });
    throw new Error(err);
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
    // uploadKey may be an absolute path the user picked OR a media key — copyInput handles both.
    const raw = S.copyInput(uploadKey, S.tmp(`char_in_${cid}`));
    src = (await toPng(raw, S.tmp(`char_src_${cid}.png`))) || raw;
    const [safe, codes] = await P.moderateImage(src);
    if (!safe) {
      S.updateCharacter(cid, { status: 'rejected', error: 'This image was blocked by safety moderation (sexual, graphic, or prohibited content). Please use a different photo.' });
      return { characterId: cid, rejected: true, codes };
    }
  }
  let primary: string | null;
  let aiGenerated: boolean;
  if (src != null) {
    // Uploaded photo → use it EXACTLY as the character (just moderated above + captioned below). Do NOT
    // run it through the image model: regenerating "the same face" alters the identity. The cast pipeline
    // (Kontext) places this real photo into scenes, so the user gets the person they uploaded.
    primary = src;
    aiGenerated = false;
  } else {
    // Description-only character → generate a portrait from the text.
    const base = 'polished cinematic character portrait, studio lighting, neutral background, head and shoulders, looking at camera, photorealistic, no text or letters';
    const out = S.tmp(`char_ai_${cid}.png`);
    const ok = await P.keyframe(`${prompt}, ${base}`, out);
    primary = ok ? out : null;
    aiGenerated = ok;
  }
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
  S.updateCharacter(cid, { images, primaryKey: pkey, thumbKey: tkey, description: caption || c.description || '', status: 'ready', aiGenerated, error: '' });
  return { characterId: cid, primaryKey: pkey, aiGenerated };
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
  // Conform every clip to vW×vH before the concat. Local Wan clips + failed-scene fills are already this
  // size (conformClip is a no-op, no re-encode, for those), but archived projects can hold clips saved at a
  // different native resolution — concatenating mixed dimensions corrupts the output, so normalize first.
  const normalized: string[] = [];
  for (let i = 0; i < clips.length; i++) normalized.push(await conformClip(clips[i], `${work}/clips/norm_${i}.mp4`));
  const silent = `${work}/output/silent.mp4`;
  // Stream-copy the timeline when the conformed clips are compatible — they all come out of the same
  // window conform at the same size and rate, so this is the normal case and it removes one full x264
  // generation from every clip's path (render -> sub-clip concat -> conform -> HERE -> upscale -> grade).
  // concatClips verifies the copy against the summed input duration and re-encodes at FPS if it doesn't fit.
  await concatClips(normalized, silent, { fps: FPS });

  // ── finish chain (both steps best-effort — on any failure the plain concat plays) ──────────────
  let master = silent;
  let upscaled = false;
  // 1) Upscale: the local backend emits 832×480/896×512 — watched fullscreen that reads soft no matter how
  //    good the denoise was. One Real-ESRGAN pass (sidecar /upscale, Apple GPU — idle by assemble time)
  //    to 1080p. Runs once on the whole timeline: every clip + failed-scene fill shares one size here. The
  //    resolved VIDEO backend decides whether this runs (local → true; cloud already near-HD → false).
  if (P.video().needsUpscale()) {
    try {
      await ensureSidecar();
      const up = `${work}/output/upscaled.mp4`;
      const upSec = envInt('VB_UPSCALE_DEADLINE_SEC', 5400);
      const r = await sidecarPost('/upscale', { video: silent, out: up, target_h: envInt('VB_UPSCALE_H', 1080), timeout_sec: Math.max(60, upSec - 60) }, upSec * 1000);
      if (r.ok && S.fileSize(up) > 0) {
        master = up;
        upscaled = true;
      }
    } catch {
      /* upscale is polish, never fail the render for it */
    }
  }
  // 2) Grade: light deband/denoise → filmic S-curve + gentle saturation → micro-contrast sharpen →
  //    temporal luma grain LAST (grain perceptually masks upscaler shimmer + AI over-smoothness).
  //    VB_FINISH: off | subtle (default) | filmic (adds vignette + heavier grain).
  const finish = env('VB_FINISH', 'subtle');
  if (finish !== 'off') {
    const graded = `${work}/output/graded.mp4`;
    // On an UPSCALED master the two motion-hostile steps come off. hqdn3d's last two numbers are its
    // TEMPORAL strength: it averages a pixel against the same pixel in neighbouring frames, which on a
    // timeline whose in-between frames RIFE just synthesized smears real motion and can ghost fast pans —
    // exactly the fluidity the interpolation pass was there to buy. And Real-ESRGAN already resolves edge
    // detail, so a second unsharp on top rings them. Spatial denoise, grade and grain still run.
    // VB_FINISH_TEMPORAL=1 / VB_FINISH_SHARPEN=1 restore the old chain.
    const temporal = !upscaled || envBool('VB_FINISH_TEMPORAL', false);
    const vf = [
      temporal ? 'hqdn3d=1.5:1.5:3:3' : 'hqdn3d=1.5:1.5:0:0',
      "curves=master='0/0 0.25/0.22 0.5/0.5 0.75/0.79 1/1'",
      'eq=saturation=1.06',
      ...(!upscaled || envBool('VB_FINISH_SHARPEN', false) ? ['unsharp=5:5:0.35:5:5:0.0'] : []),
      ...(finish === 'filmic' ? ['vignette=PI/5'] : []),
      `noise=c0s=${finish === 'filmic' ? 7 : 4}:c0f=t+u`,
    ].join(',');
    const okG = await ffmpeg(['-i', master, '-vf', vf, ...x264(envInt('VB_CRF_FINAL', 16)), '-an', graded]);
    if (okG && S.fileSize(graded) > 0) master = graded;
  }

  const vdur = await probeDuration(master);
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
    '-i', master, '-i', `${work}/output/song.wav`,
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
  // error: '' — a stale failure message from an earlier attempt must not survive a successful render.
  const patch: Record<string, unknown> = { status: doneStatus, stage: doneStatus, progress: 1, videoKey: key, scenesFailed: failed, previewScenes: doneN, error: '' };
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

export function createProject(o: { audio: string; name?: string; style?: string; cast?: string; quality?: string; mode?: string; format?: string; videoModel?: string; id?: string }): { projectId: string } {
  const pid = o.id || newId();
  const ext = (o.audio.match(/\.[^.\/\\]+$/)?.[0] || '.mp3').toLowerCase();
  const audioKey = `${pid}/audio${ext}`;
  S.copyFileIn(o.audio, S.mediaPath(audioKey));
  const format = o.format === 'ad' ? 'ad' : 'music-video';
  const item: any = {
    id: pid,
    name: o.name || 'Untitled',
    status: 'ready',
    format,
    style: o.style || (format === 'ad' ? 'modern product commercial' : 'cinematic music video'),
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
