// Render orchestration: storyboard -> keyframe pass -> clip pass -> assemble. Async + local. Each scene's
// clip renders via providers.genVideo (submit + poll) inside a bounded concurrency pool. Progress is
// reported through an `emit(event)` callback the engine turns into IPC events. Segmentation / shot-list /
// frame-grid logic is a verbatim port of the proven pipeline.
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
import { FPS, probeDuration, toPng, putThumb, fitToWindow, trimToWindow, stillClip, ffmpeg, toWav, lastFrame, concatClips } from './ffmpeg';
import * as P from './providers';
import { genVideoLocal } from './localVideo';
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
const SYS_AD = 'You are an award-winning commercial/ad director. Output ONLY one valid JSON object.';

/** Shot-list rules for an ad/spot: the product is the hero, benefit-driven, punchy, ends on a CTA. */
function adShotListPrompt(style: string, bibleBlock: string, momentsBlock: string, n: number, castBlock = ''): string {
  return `BRAND / STYLE: ${style}${bibleBlock}${castBlock}

You are turning the SPOT BIBLE above into the actual shot list — a punchy commercial cut to the music.
For EACH timed moment below, write ONE vivid, on-brand shot that sells.
RULES:
- THE PRODUCT IS THE HERO. If a SUBJECT/PRODUCT reference is given (cast index 0), it appears in most shots
  — hero framing, clean product close-ups, the product in use, the result it delivers. Refer to it ONLY by
  its name/role; its reference photo defines its EXACT look — never invent, alter, or restyle it.
- ARC (follow the music's energy): open with a HOOK (an attention-grabbing image), reveal the PRODUCT
  clearly, show its BENEFIT and an aspirational LIFESTYLE/feeling, and BUILD to a final CALL-TO-ACTION shot
  (product + brand moment, confident and clean). The LAST shot is the CTA / hero product beat.
- Ads CAN be punchy and energetic — quick, bold, beat-synced framings, dynamic camera, striking light.
- People (if any) are aspirational lifestyle talent using/enjoying the product, looking natural and desirable.
- VARY framing each shot (hero close-up, product-in-context, lifestyle wide, detail macro, dramatic angle).
- Do NOT render readable words/logos/captions as garbled text (the model can't spell). Imply the brand via
  product + mood, not fake on-screen text. NEVER Asian/foreign signage.
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
  setup, and NEVER default to dancing. No extreme close-ups.
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
  const words = await P.transcribeWords(song);
  const whisperText = (words || [])
    .map((w) => w.word || '')
    .join(' ')
    .trim();
  // Music videos need lyrics to drive the story; ads can run on an instrumental track (the spot's beats
  // come from the energy windows + the product brief), so don't require words there.
  if (format !== 'ad' && whisperText.length < 40) {
    S.updateProject(pid, { status: 'failed', stage: 'failed', error: "Could not read the song's words (no audible vocals)." });
    throw new Error('no lyrics');
  }
  // Scenes follow the vocal phrasing (~6s) for BOTH backends. The local model renders each scene as one
  // continuous shot of chained native sub-clips (renderClip), so longer scenes no longer mean slow-motion —
  // and the video has fewer cuts. VB_LOCAL_SCENE_SEC can tune the local target.
  let segOpts = undefined;
  if (env('VB_VIDEO_BACKEND', 'cloud') === 'local') {
    // LTX makes one full clip per scene (max ~4s native), morphing first→last keyframe — keep scenes under
    // that so trimToWindow fits. Wan chains sub-clips, so it can take longer scenes (default 6s).
    const isLtx = env('VB_LOCAL_VIDEO_MODEL', 'ltx') === 'ltx';
    const t = parseFloat(env('VB_LOCAL_SCENE_SEC', isLtx ? '3.5' : '6')) || (isLtx ? 3.5 : 6);
    segOpts = isLtx ? { target: t, maxSec: 3.9, minSec: 2 } : { target: t, maxSec: t * 2, minSec: Math.max(2, t * 0.5) };
  }
  const segs = segmentSong(words, dur, segOpts).slice(0, MAX_SCENES);
  const n = segs.length;
  const renderTargetN = previewTarget(n, preview);
  const wins: [number, number][] = segs.map((s) => [Number(s[0]), Number(s[1])]);
  const snippets = segs.map((s) => s[2]);
  const covered = renderTargetN <= n ? wins[renderTargetN - 1][1] : dur;
  const energies = await windowEnergy(song, wins);

  emit({ event: 'stage', stage: 'story' });
  const bible = await P.storyBible(whisperText, style, dur, castBlock, format);
  if (!bible || !(bible.acts || []).length) {
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

/** Render a local scene as ONE continuous shot: chain native-length sub-clips — each i2v from the previous
 * clip's last frame (the first from the keyframe) — to fill the scene, then concatenate. This fills a long
 * scene with real motion instead of stretching one short clip (slow-motion), so we can use fewer/longer
 * scenes (fewer cuts). A scene that already fits in one native clip just renders directly. */
async function renderLocalScene(pid: string, k: number, kfFirst: string, clipPrompt: string, wdur: number, raw: string, seed: number, emit: Emit): Promise<[boolean, string]> {
  const fps = Math.max(1, envInt('VB_LOCAL_WAN_FPS', 24));
  const nativeSec = envInt('VB_LOCAL_MAX_FRAMES', 57) / fps; // ~2.4s — one native clip
  const nSub = Math.max(1, Math.ceil(wdur / nativeSec)); // 1 only when the scene fits one native clip
  // Render full native clips (snapped to 4n+1 frames), so the total is always >= the window and renderClip
  // can TRIM (never stretch). A single-clip scene also renders a full native clip, then gets trimmed down.
  if (nSub <= 1) return genVideoLocal(kfFirst, clipPrompt, raw, nativeSec, seed);
  // Every sub-clip is a FULL native clip, so the chained total (nSub × nativeSec) is always >= the scene
  // window — renderClip then TRIMS the excess (no slow-motion). Each continues the motion from the prior
  // clip's last frame.
  const subs: string[] = [];
  let startImg = kfFirst;
  for (let i = 0; i < nSub; i++) {
    const subOut = S.tmp(`sub_${pid}_${k}_${i}.mp4`);
    const [sok, serr] = await genVideoLocal(startImg, clipPrompt, subOut, nativeSec, seed + i);
    if (!sok) return [false, serr];
    subs.push(subOut);
    emit({ event: 'subclip', index: k, sub: i + 1, total: nSub });
    if (i < nSub - 1) {
      const lf = await lastFrame(subOut, S.tmp(`lf_${pid}_${k}_${i}.png`));
      if (lf) startImg = lf; // continue the motion from the last frame
    }
  }
  return (await concatClips(subs, raw)) ? [true, ''] : [false, 'failed to assemble chained sub-clips'];
}

async function renderClip(pid: string, k: number, p: any, kfFirst: string, kfLast: string | null, emit: Emit, seed = 42): Promise<[boolean, string]> {
  const sc = S.getScene(pid, k) || {};
  const wdur = Math.max(0.4, Number(sc.endSec || 0) - Number(sc.startSec || 0) || 4);
  const motion = P.MOTION[sc.energy || 'medium'] || P.MOTION.medium;
  const vmodel = p.videoModel || null;
  const raw = S.tmp(`raw_${pid}_${k}.mp4`);
  const clipPrompt = `${sc.prompt || ''}, ${motion}, cinematic`;
  // Three i2v paths: LTX local (first+last-frame morph → smooth flow toward the next keyframe, no sub-clip
  // chaining needed); Wan local (single start frame → chain sub-clips for a long continuous shot); cloud.
  const local = env('VB_VIDEO_BACKEND', 'cloud') === 'local';
  const isLtx = local && env('VB_LOCAL_VIDEO_MODEL', 'ltx') === 'ltx';
  const [ok, err] = isLtx
    ? await genVideoLocal(kfFirst, clipPrompt, raw, wdur, seed, kfLast)
    : local
      ? await renderLocalScene(pid, k, kfFirst, clipPrompt, wdur, raw, seed, emit)
      : await P.genVideo(kfFirst, clipPrompt, raw, wdur, kfLast, vmodel, seed);
  if (!ok) {
    const reason = P.isContentBlock(err) ? "This scene was blocked by the model's safety filter." : `Scene render failed: ${(err || '').slice(0, 160)}`;
    putSceneMerged(pid, k, sc, { status: 'failed', error: reason });
    emit({ event: 'scene', index: k, status: 'failed', error: reason });
    return [false, reason];
  }
  // Local chained clips are already >= the window → TRIM to the exact slot (real speed, never slow-motion).
  // Cloud clips can be shorter/longer than the window → fitToWindow retimes them to the frame grid.
  const isLocal = env('VB_VIDEO_BACKEND', 'cloud') === 'local';
  const sceneOut = S.tmp(`scene_${pid}_${k}.mp4`);
  const fit = isLocal
    ? await trimToWindow(raw, sc.startSec || 0, sc.endSec || 0, sceneOut)
    : await fitToWindow(raw, sc.startSec || 0, sc.endSec || 0, sceneOut);
  S.copyIn(fit, `${pid}/clips/scene_${k}.mp4`);
  putSceneMerged(pid, k, sc, { status: 'done', error: '', clipKey: `${pid}/clips/scene_${k}.mp4` });
  emit({ event: 'scene', index: k, status: 'done' });
  return [true, ''];
}

/** Local continuous-chain render: keyframes only for CUT scenes (the LLM decides cut/continue, an anti-drift
 * cap forces a cut every VB_LOCAL_CHAIN_MAX scenes); clips render SEQUENTIALLY so a 'continue' scene starts
 * from the previous scene's last frame. Fewer keyframes (faster) + seamless motion between scenes. */
async function renderScenesLocalChained(pid: string, p: any, toRender: number[], target: number, toon: boolean, emit: Emit, cancelled: Cancelled): Promise<{ projectId: string; videoKey: string }> {
  const MAX = Math.max(1, envInt('VB_LOCAL_CHAIN_MAX', 4));
  // Decide cut vs continue in render order (first scene + LLM 'cut' + anti-drift cap force a fresh keyframe).
  const cut: Record<number, boolean> = {};
  let run = 0;
  toRender.forEach((k, i) => {
    const sc = S.getScene(pid, k) || {};
    const isCut = i === 0 || sc.transition === 'cut' || run >= MAX;
    cut[k] = isCut;
    run = isCut ? 0 : run + 1;
  });

  // keyframe pass — CUT scenes only; group by ref variant so the heavy keyframe model swaps at most once.
  const cutScenes = toRender.filter((k) => cut[k]);
  const hasRef = (k: number) => refsForScene(p, S.getScene(pid, k) || {}).length > 0;
  const ordered = [...cutScenes].sort((a, b) => (hasRef(a) ? 1 : 0) - (hasRef(b) ? 1 : 0) || a - b);
  emit({ event: 'stage', stage: 'keyframes', total: ordered.length });
  const kfPaths: Record<number, string | null> = {};
  await mapPool(ordered, workers(), async (k) => {
    checkCancel(cancelled);
    kfPaths[k] = await buildKeyframe(pid, k, p, toon);
    emit({ event: 'keyframe', index: k, ok: Boolean(kfPaths[k]) });
  });

  // clip pass — SEQUENTIAL: a continue scene starts from the previous scene's last frame.
  emit({ event: 'stage', stage: 'clips', total: toRender.length });
  let prevLast: string | null = null;
  for (const k of toRender) {
    checkCancel(cancelled);
    let start = cut[k] ? kfPaths[k] : prevLast;
    if (!start) start = await buildKeyframe(pid, k, p, toon); // chain broke (or keyframe failed) → fresh keyframe
    const sc = S.getScene(pid, k) || {};
    if (!start) {
      putSceneMerged(pid, k, sc, { status: 'failed', error: 'Could not get a start frame for this scene.' });
      emit({ event: 'scene', index: k, status: 'failed', error: 'no start frame' });
      prevLast = null;
      continue;
    }
    const [ok] = await renderClip(pid, k, p, start, null, emit);
    prevLast = null;
    if (ok) {
      const clipKey = `${pid}/clips/scene_${k}.mp4`;
      if (S.mediaExists(clipKey)) prevLast = await lastFrame(S.mediaPath(clipKey), S.tmp(`chain_last_${pid}_${k}.png`));
    }
    const d = S.listScenes(pid).filter((s) => s.status === 'done').length;
    S.updateProject(pid, { scenesDone: d, progress: Math.round((0.3 + (0.6 * Math.min(d, target)) / Math.max(1, target)) * 1000) / 1000 });
  }
  return assemble(pid, emit);
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
  // Reset progress to the keyframe-phase baseline so a resume/re-render doesn't show the previous run's 100%.
  S.updateProject(pid, { status: 'rendering', stage: 'rendering', progress: 0.3, previewScenes: done.size + toRender.length, renderStartedAt: Date.now() / 1000 });

  // Local Wan backends render as a (mostly) continuous chain — the LLM marks each scene cut/continue, a
  // 'continue' scene starts from the previous scene's last frame, an anti-drift cap forces a fresh keyframe.
  // LTX is NOT chained that way: it morphs first→last keyframe per scene, so it uses the standard path below
  // (a keyframe per scene + renderClip gets the next scene's keyframe as the end-image).
  const isLtxLocal = env('VB_VIDEO_BACKEND', 'cloud') === 'local' && env('VB_LOCAL_VIDEO_MODEL', 'ltx') === 'ltx';
  if (env('VB_VIDEO_BACKEND', 'cloud') === 'local' && !isLtxLocal && envBool('VB_LOCAL_CHAIN', true)) {
    return renderScenesLocalChained(pid, p, toRender, target, toon, emit, cancelled);
  }

  // keyframe pass — each scene we render + its morph target (next scene's keyframe). Order so all no-ref
  // (FLUX txt2img) scenes run together and all ref (FLUX Kontext) scenes run together, so a cast-mixed
  // project swaps the heavy keyframe model at most once instead of thrashing it per scene. Generation
  // order doesn't affect which keyframes exist, so this is safe for the morph chaining.
  const hasRef = (k: number) => refsForScene(p, S.getScene(pid, k) || {}).length > 0;
  const needed = Array.from(new Set([...toRender, ...toRender.filter((k) => k + 1 < n).map((k) => k + 1)])).sort(
    (a, b) => (hasRef(a) ? 1 : 0) - (hasRef(b) ? 1 : 0) || a - b,
  );
  emit({ event: 'stage', stage: 'keyframes', total: needed.length });
  const kfPaths: Record<number, string | null> = {};
  let kfDone = 0;
  await mapPool(needed, workers(), async (k) => {
    checkCancel(cancelled);
    const path = await buildKeyframe(pid, k, p, toon);
    kfPaths[k] = path;
    kfDone++;
    // Keyframe phase fills 0.3 -> 0.5 so the bar moves while keyframes generate (the clip pass takes 0.5->1).
    S.updateProject(pid, { progress: Math.round((0.3 + (0.2 * kfDone) / Math.max(1, needed.length)) * 1000) / 1000 });
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
    // Clip pass fills 0.5 -> 1 (the keyframe pass took 0.3 -> 0.5).
    S.updateProject(pid, { scenesDone: d, progress: Math.round((0.5 + (0.5 * Math.min(d, target)) / Math.max(1, target)) * 1000) / 1000 });
  });

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
    for (const x of ['title', 'prompt', 'startSec', 'endSec', 'energy', 'lyric', 'characters']) if (x in s) keep[x] = s[x];
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
    const ok = await P.cloudKeyframe(`${prompt}, ${base}`, out);
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
