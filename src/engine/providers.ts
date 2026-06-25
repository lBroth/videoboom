// Cloud model calls via the user's own keys (BYOK). OpenRouter for the LLM storyboard, image keyframes,
// portrait captioning, moderation, and image-to-video; Replicate (WhisperX forced alignment) for accurate
// word timings. Ported from the proven pipeline core; algorithms unchanged.
import fs from 'node:fs';
import { env, envBool } from './config';
import { costAdd, orCost } from './cost';
import { tmp } from './storage';
import { toMp3_16k, moderationUri } from './ffmpeg';

const OR = 'https://openrouter.ai/api/v1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function orHdr(): Record<string, string> {
  return { Authorization: 'Bearer ' + env('VB_OPENROUTER_API_KEY'), 'Content-Type': 'application/json', 'User-Agent': UA };
}

interface HttpErr extends Error {
  status?: number;
  body?: string;
}

async function httpJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) {
      const e: HttpErr = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      e.body = text;
      throw e;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

function dataUri(path: string, mime = 'image/png'): string {
  return `data:${mime};base64,` + fs.readFileSync(path).toString('base64');
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

// ── LLM ─────────────────────────────────────────────────────────────────────────
export async function llmComplete(system: string, user: string, maxTokens = 2000, model?: string, temperature = 0.9): Promise<string> {
  model = model || env('VB_LLM_MODEL', 'google/gemini-3.5-flash');
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    usage: { include: true },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  for (let i = 0; i < 4; i++) {
    try {
      const r = await httpJson(OR + '/chat/completions', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 240_000);
      costAdd(orCost(r));
      return r?.choices?.[0]?.message?.content || '';
    } catch {
      await sleep(2000);
    }
  }
  return '';
}

export async function llmJson(system: string, user: string, schema: any, model?: string, maxTokens = 4000, temperature = 0.7): Promise<any | null> {
  model = model || env('VB_LLM_MODEL', 'google/gemini-3.5-flash');
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    usage: { include: true },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: schema.name || 'out', strict: true, schema: schema.schema } },
  };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await httpJson(OR + '/chat/completions', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 240_000);
      costAdd(orCost(r));
      let txt: string = r?.choices?.[0]?.message?.content || '';
      txt = txt.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      try {
        return JSON.parse(txt);
      } catch {
        const i0 = txt.indexOf('{');
        const j0 = txt.lastIndexOf('}');
        if (i0 >= 0) return JSON.parse(txt.slice(i0, j0 + 1));
      }
    } catch {
      await sleep(2000);
    }
  }
  return null;
}

export const BIBLE_SCHEMA = {
  name: 'story_bible',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      logline: { type: 'string' },
      protagonist: { type: 'string' },
      world: { type: 'string' },
      arc: { type: 'string' },
      acts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { section: { type: 'string' }, location: { type: 'string' }, beat: { type: 'string' }, emotion: { type: 'string' } },
          required: ['section', 'location', 'beat', 'emotion'],
        },
      },
    },
    required: ['logline', 'protagonist', 'world', 'arc', 'acts'],
  },
};

export const SCENES_SCHEMA = {
  name: 'shot_list',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer' },
            title: { type: 'string' },
            prompt: { type: 'string' },
            characters: { type: 'array', items: { type: 'integer' } },
          },
          required: ['index', 'title', 'prompt', 'characters'],
        },
      },
    },
    required: ['scenes'],
  },
};

export async function storyBible(lyrics: string, style: string, dur: number, castBlock = ''): Promise<any | null> {
  const model = env('VB_STORY_MODEL', 'anthropic/claude-sonnet-4.6');
  const system =
    'You are a visionary music-video director and screenwriter. You read a song\'s actual lyrics and design the MUSIC VIDEO that tells ITS story: a coherent visual narrative with a clear lead, an emotional arc, and acts that track the song\'s structure. The story MUST come from these specific lyrics — never a generic unrelated story.';
  const user =
    `SONG STYLE: ${style}\nDURATION: ~${Math.trunc(dur || 0)}s${castBlock}\n\nLYRICS (the actual sung words):\n${lyrics}\n\n` +
    'Design the video\'s STORY strictly FROM THESE LYRICS. Find the real narrative / emotional journey (even if metaphorical — translate into a concrete visual story with a faithful lead). If a CAST is given, weave those people in according to their roles (e.g. family) where the lyrics support it. Break it into ACTS following the song sections; each act = one location + one story beat that moves the lead forward + one emotion. CRITICAL: the ACTS must follow the lyrics IN ORDER — the first sung line maps to the first act, the last to the last. Never introduce a later place/life-stage/beat before the lyric that names it (e.g. if the words go nido -> scuola -> lavoro, the acts go in that same order, not work-first). The acts are a TIMELINE of the song, not a thematic summary.';
  const mt = Math.min(20000, Math.max(2500, Math.trunc((dur || 150) * 35)));
  return llmJson(system, user, BIBLE_SCHEMA, model, mt, 0.5);
}

// ── transcription ────────────────────────────────────────────────────────────────
const WHISPERX_VERSION = '655845d6190ef70573c669245f245892cd039df4b880a1e3a65852c09252f5cc';

export interface Word {
  start: number;
  end: number;
  word: string;
}

async function transcribeWhisperx(audioPath: string): Promise<Word[] | null> {
  const tok = env('REPLICATE_API_TOKEN');
  if (!tok) return null;
  const src = await toMp3_16k(audioPath, tmp('wx16.mp3'));
  const dataUriAudio = 'data:audio/mpeg;base64,' + fs.readFileSync(src).toString('base64');
  const hdr = { Authorization: 'Token ' + tok, 'Content-Type': 'application/json', 'User-Agent': UA };
  const inp: any = { audio_file: dataUriAudio, align_output: true, batch_size: 16 };
  if (env('VB_STT_LANG')) inp.language = env('VB_STT_LANG');
  const body = { version: env('VB_WHISPERX_VERSION', WHISPERX_VERSION), input: inp };
  let pred: any;
  try {
    pred = await httpJson('https://api.replicate.com/v1/predictions', { method: 'POST', headers: hdr, body: JSON.stringify(body) }, 60_000);
  } catch (ex) {
    console.error('whisperx submit error:', String(ex));
    return null;
  }
  const pid = pred.id;
  const deadline = Date.now() + 300_000;
  while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    if (Date.now() > deadline) {
      console.error('whisperx poll timeout');
      return null;
    }
    await sleep(4000);
    try {
      pred = await httpJson(`https://api.replicate.com/v1/predictions/${pid}`, { headers: hdr }, 60_000);
    } catch {
      /* keep polling */
    }
  }
  if (pred.status !== 'succeeded') {
    console.error('whisperx failed:', String(pred.error).slice(0, 200));
    return null;
  }
  const out = pred.output || {};
  const segs = Array.isArray(out) ? out : out.segments;
  const words: Word[] = [];
  for (const s of segs || []) {
    for (const w of s.words || []) {
      const st = w.start;
      const en = w.end;
      const wd = (w.word || '').trim();
      if (st != null && en != null && Number(en) > Number(st) && wd) words.push({ start: Number(st), end: Number(en), word: wd });
    }
  }
  if (!words.length) return null;
  costAdd(parseFloat(env('VB_WHISPERX_CENTS', '1.5')));
  return words;
}

export async function transcribeWords(audioPath: string): Promise<Word[]> {
  const wx = await transcribeWhisperx(audioPath);
  if (wx) return wx;
  console.error('whisperx transcription unavailable (check the Replicate token)');
  return [];
}

// ── images ────────────────────────────────────────────────────────────────────--
export const TOON_STYLE =
  '3D animated movie still, Pixar/DreamWorks style, vibrant stylized cartoon animation, soft toon shading, expressive cartoon features, clearly animated and NOT photorealistic';

export async function cloudKeyframe(prompt: string, outPath: string, refs: [string, string][] = [], toon = false): Promise<boolean> {
  const model = env('VB_KEYFRAME_MODEL', 'google/gemini-3.1-flash-image');
  const vstyle = toon ? TOON_STYLE : env('VB_VISUAL_STYLE', '');
  const nosign =
    '16:9 widescreen. No readable text, no letters, no words, no captions, no watermark, no logo. NO neon signs with writing, NO Asian/Chinese/Japanese/Korean signage anywhere.';
  const imgs: [string, string][] = [];
  for (const [path, label] of refs || []) {
    if (path && fileExists(path)) {
      try {
        imgs.push([dataUri(path), label]);
      } catch {
        /* skip unreadable ref */
      }
    }
  }
  let content: any[];
  if (imgs.length) {
    const roster = imgs.map(([, lbl], i) => `reference ${i + 1} = ${lbl}`).join('; ');
    let text: string;
    if (toon) {
      text =
        `Redraw the SAME subjects as 3D animated cartoon characters. Reference photos in order: ${roster}. CRITICAL — keep each subject unmistakably recognizable: preserve their exact facial features and proportions (face shape, eyes, nose, mouth, jaw, eyebrows), hair, age and build; for animals keep the exact breed, coat color and markings. Do NOT blend or swap identities. Place them together in a new scene: ${prompt}. ${TOON_STYLE}. ${nosign}`;
    } else {
      text =
        `Place these EXACT real subjects into a new cinematic scene. Reference photos in order: ${roster}. CRITICAL — preserve each subject's identity PERFECTLY: faithfully reproduce every facial feature from their own reference photo (face shape, eyes, nose, mouth, jawline, eyebrows, skin tone, facial hair, hairstyle and apparent age) so each person is unmistakably the SAME individual; for any animal keep the exact breed, coat color and markings. Do NOT blend, average, beautify, de-age or otherwise alter any face. The reference photos OVERRIDE any physical description in the text. Scene: ${prompt}. ${vstyle}. ${nosign}`;
    }
    content = [{ type: 'text', text }, ...imgs.map(([u]) => ({ type: 'image_url', image_url: { url: u } }))];
  } else {
    content = [{ type: 'text', text: `${vstyle}. ${prompt}. Cinematic. ${nosign}` }];
  }
  const body: any = { model, messages: [{ role: 'user', content }], modalities: ['image', 'text'], usage: { include: true } };
  if (model.toLowerCase().includes('gpt')) body.input_fidelity = 'high';
  for (let i = 0; i < 4; i++) {
    let r: any;
    try {
      r = await httpJson(OR + '/chat/completions', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 180_000);
    } catch {
      await sleep(2000);
      continue;
    }
    costAdd(orCost(r));
    const out = r?.choices?.[0]?.message?.images || [];
    const url: string = out.length ? out[0]?.image_url?.url || '' : '';
    if (url.includes(',')) {
      fs.writeFileSync(outPath, Buffer.from(url.split(',', 2)[1], 'base64'));
      if (fileExists(outPath)) return true;
    }
  }
  return false;
}

export async function vlmCaption(imgPath: string): Promise<string> {
  const model = env('VB_VLM_MODEL', 'google/gemma-3-12b-it');
  let uri: string;
  try {
    uri = dataUri(imgPath);
  } catch {
    return '';
  }
  const content = [
    { type: 'text', text: 'Describe this person for consistent re-generation: face, hair, build, age, distinctive features, clothing style. One concise vivid sentence, no names.' },
    { type: 'image_url', image_url: { url: uri } },
  ];
  const body = { model, max_tokens: 200, temperature: 0.4, usage: { include: true }, messages: [{ role: 'user', content }] };
  try {
    const r = await httpJson(OR + '/chat/completions', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 120_000);
    costAdd(orCost(r));
    return (r?.choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

/** Safety check on an uploaded photo via an OpenRouter VISION model. Returns [safe, codes]. Fails OPEN. */
export async function moderateImage(path: string): Promise<[boolean, string[]]> {
  if (!env('VB_OPENROUTER_API_KEY')) return [true, []];
  let uri: string;
  try {
    uri = await moderationUri(path);
  } catch {
    return [true, []];
  }
  const prompt =
    "You are a strict image safety classifier for a consumer app. Reply with ONE word only: 'UNSAFE' if the image contains sexual content, child sexual content, or graphic gore/violence; otherwise 'SAFE'. Innocent photos of minors are SAFE. Do not describe the image.";
  const body = {
    model: env('VB_MODERATION_MODEL', 'google/gemini-3.5-flash'),
    max_tokens: 16,
    usage: { include: true },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: uri } }] }],
  };
  let out: string;
  try {
    const r = await httpJson(OR + '/chat/completions', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 60_000);
    out = (r?.choices?.[0]?.message?.content || '').trim();
    costAdd(orCost(r));
  } catch (ex) {
    console.error('moderation error (fail-open):', String(ex));
    return [true, []];
  }
  const unsafe = out.toLowerCase().includes('unsafe');
  return [!unsafe, unsafe ? ['UNSAFE'] : []];
}

/** A DETERMINISTIC content/safety block (retrying the same input won't help). Transient gateway/timeout
 * errors are excluded first — those should be retried, not failed permanently. */
export function isContentBlock(err: string): boolean {
  const e = (err || '').toUpperCase();
  if (['502', '503', '504', 'GATEWAY', 'TIMEOUT', 'TIMED OUT', 'TEMPORARILY', 'UNAVAILABLE', 'TRY AGAIN', 'RATE LIMIT', 'OVERLOAD'].some((t) => e.includes(t))) return false;
  return (
    e.includes('PROHIBITED') ||
    e.includes('SENSITIVE') ||
    e.includes('BLOCKED') ||
    e.includes('PERSON/FACE') ||
    e.includes('SAFETY') ||
    e.includes('MODERATION') ||
    e.includes('CONTENT POLICY') ||
    e.includes('FLAGGED')
  );
}

const CLIP_MIN_SEC = 3;
const CLIP_MAX_SEC = 15;

/** Image-to-video on the OpenRouter /videos endpoint via Kling (first+last frame). Returns [ok, err].
 * Synchronous submit+poll — a desktop process has no 15-min cap. */
export async function genVideo(
  img: string,
  prompt: string,
  outMp4: string,
  seconds: number,
  lastFrame?: string | null,
  model?: string | null,
  seed = 42,
): Promise<[boolean, string]> {
  model = model || env('VB_OR_VIDEO_MODEL', 'kwaivgi/kling-v3.0-std');
  const dur = Math.max(CLIP_MIN_SEC, Math.min(CLIP_MAX_SEC, Math.trunc(Math.round(seconds || CLIP_MIN_SEC))));
  const genAudio = envBool('VB_OR_GENERATE_AUDIO', false);
  const body: any = {
    model,
    prompt,
    duration: dur,
    seed: Math.trunc(seed),
    aspect_ratio: env('VB_OR_ASPECT', '16:9'),
    generate_audio: genAudio,
    usage: { include: true },
  };
  const frames: any[] = [];
  for (const [path, ftype] of [
    [img, 'first_frame'],
    [lastFrame, 'last_frame'],
  ] as [string | null | undefined, string][]) {
    if (path && fileExists(path)) frames.push({ type: 'image_url', image_url: { url: dataUri(path) }, frame_type: ftype });
  }
  if (frames.length) body.frame_images = frames;
  let lastErr = 'unknown error';
  const deadline = Date.now() + parseFloat(env('VB_VIDEO_DEADLINE_SEC', '600')) * 1000;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (Date.now() > deadline) return [false, 'video provider timed out (no response within budget) — try again'];
    let r: any;
    try {
      r = await httpJson(OR + '/videos', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 60_000);
    } catch (ex: any) {
      if (ex?.status) {
        lastErr = String(ex.body || '').slice(0, 300);
        if (isContentBlock(lastErr)) return [false, lastErr];
      } else {
        lastErr = `request error: ${ex?.message || ex}`;
      }
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const jid = r.id;
    const poll = r.polling_url || `${OR}/videos/${r.id}`;
    let status = r.status || 'pending';
    for (let i = 0; i < 100; i++) {
      if (status === 'completed' || status === 'failed') break;
      if (Date.now() > deadline) return [false, 'video provider timed out while rendering — try again'];
      await sleep(6000);
      try {
        r = await httpJson(poll, { headers: orHdr() }, 60_000);
        status = r.status || status;
      } catch {
        /* keep polling */
      }
    }
    if (status === 'completed') {
      costAdd(orCost(r));
      const urls = r.unsigned_urls || [`${OR}/videos/${jid}/content?index=0`];
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 300_000);
        const resp = await fetch(urls[0], { headers: orHdr(), signal: ac.signal });
        clearTimeout(t);
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(outMp4, buf);
        if (fileExists(outMp4)) return [true, ''];
      } catch (ex: any) {
        lastErr = `download error: ${ex?.message || ex}`;
      }
    } else {
      lastErr = String(r.error || 'generation failed');
      if (isContentBlock(lastErr)) return [false, lastErr];
    }
    await sleep(2 ** attempt * 1000);
  }
  return [false, lastErr];
}

export const MOTION: Record<string, string> = {
  calm: 'slow cinematic push-in, subject nearly still — a breath, a slow glance, hair drifting; soft light, quiet atmosphere',
  medium: 'steady tracking/dolly shot, subject moves naturally and unhurried (a walk, a turn, a real gesture), cinematic shallow depth of field',
  intense:
    'dynamic camera energy — quicker dolly or handheld move, wind, drifting light and particles; subject stays grounded and natural, momentum from camera and environment, never exaggerated dancing',
};
