// Shared pipeline-stage helpers + the per-stage dispatchers. This module owns the JSON schemas, the
// storyboard prompt construction, and the policy constants (TOON_STYLE, MOTION, isContentBlock). Each stage
// call delegates to backends/registry, which picks the cloud or local impl from the resolved config. The
// signatures are unchanged so pipeline.ts's call sites are untouched.
import * as R from './backends/registry';

// ── LLM (story bible + shot list) ─────────────────────────────────────────────────
// `role` tags the call so the cloud impl picks the story-bible model vs the shot-list model; local ignores it.
export async function llmJson(system: string, user: string, schema: any, role?: string, maxTokens = 4000, temperature = 0.7): Promise<any | null> {
  return R.llm().llmJson(system, user, schema, role, maxTokens, temperature);
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
            motion: { type: 'string' },
            characters: { type: 'array', items: { type: 'integer' } },
            shot: { type: 'string', enum: ['character', 'environment'] },
            transition: { type: 'string', enum: ['cut', 'continue'] },
          },
          required: ['index', 'title', 'prompt', 'motion', 'characters', 'shot', 'transition'],
        },
      },
    },
    required: ['scenes'],
  },
};

export async function storyBible(lyrics: string, style: string, dur: number, castBlock = '', format = 'music-video'): Promise<any | null> {
  let system: string;
  let user: string;
  if (format === 'ad') {
    system =
      'You are an award-winning creative director at a top ad agency. You design a short, punchy COMMERCIAL / SPOT built around a PRODUCT (or brand/service), set to this music track. The product is the HERO. ' +
      'FIRST, IDENTIFY WHAT THE PRODUCT ACTUALLY IS from the reference/brief and the LYRICS AS A WHOLE — never from one word taken literally. Marketing language is metaphorical: a dev-tool jingle may say "mop up / clean it up" about CODE (repos, PRs, Node versions, lint) — that is a SOFTWARE product, and the spot lives in ITS world (developers, screens, dashboards, terminals, CI pipelines, abstract data imagery), NEVER household objects like detergent bottles or mops. Same for any domain: finance, fitness, food — the imagery comes from the product\'s REAL domain, the metaphors become visual ideas INSIDE that domain. ' +
      'Structure: a HOOK that grabs attention -> reveal the product -> show its key BENEFIT and an aspirational lifestyle/feeling -> a clear CALL TO ACTION (the product + brand moment). Modern, desirable, it SELLS.';
    user =
      `BRAND / STYLE: ${style}\nSPOT LENGTH: ~${Math.trunc(dur || 0)}s${castBlock}\n\nSOUNDTRACK (the music for the spot${lyrics.trim().length > 40 ? ', with these words' : ' — likely instrumental'}):\n${lyrics || '(instrumental)'}\n\n` +
      'Design the SPOT. If a SUBJECT/PRODUCT reference is given, IT is the hero — feature it. Break into ACTS that track the music\'s energy: ACT 1 = HOOK (attention-grabbing opening, mood/teaser), ACT 2 = PRODUCT reveal (show it clearly, hero framing), ACT 3 = BENEFIT / lifestyle (the product in use, the feeling/result it delivers, aspirational), ACT 4 = CALL TO ACTION (product + brand close, a confident final beat). Each act = one setting + one beat + one emotion. Keep it punchy and on-brand; this is advertising, not a narrative film.';
  } else {
    system =
      'You are a visionary music-video director and screenwriter. You read a song\'s actual lyrics and design the MUSIC VIDEO that tells ITS story: a coherent visual narrative with a clear lead, an emotional arc, and acts that track the song\'s structure. The story MUST come from these specific lyrics — never a generic unrelated story.';
    user =
      `SONG STYLE: ${style}\nDURATION: ~${Math.trunc(dur || 0)}s${castBlock}\n\nLYRICS (the actual sung words):\n${lyrics}\n\n` +
      'Design the video\'s STORY strictly FROM THESE LYRICS. Find the real narrative / emotional journey (even if metaphorical — translate into a concrete visual story with a faithful lead). If a CAST is given, weave those people in according to their roles (e.g. family) where the lyrics support it. Break it into ACTS following the song sections; each act = one location + one story beat that moves the lead forward + one emotion. CRITICAL: the ACTS must follow the lyrics IN ORDER — the first sung line maps to the first act, the last to the last. Never introduce a later place/life-stage/beat before the lyric that names it (e.g. if the words go nido -> scuola -> lavoro, the acts go in that same order, not work-first). The acts are a TIMELINE of the song, not a thematic summary.';
  }
  const mt = Math.min(20000, Math.max(2500, Math.trunc((dur || 150) * 35)));
  return llmJson(system, user, BIBLE_SCHEMA, 'story', mt, 0.5);
}

// ── transcription (on-device whisper) ──────────────────────────────────────────────
export interface Word {
  start: number;
  end: number;
  word: string;
}

/** Typed STT result. `{ok:true, words:[]}` is a legitimate instrumental (no vocals) — the pipeline proceeds
 * in instrumental mode. `{ok:false}` is a genuine transcription failure and surfaces an error to the user. */
export type STTResult = { ok: true; words: Word[] } | { ok: false; error: string };

export async function transcribe(audioPath: string): Promise<STTResult> {
  try {
    const r = await R.stt().transcribeWords(audioPath);
    if (!r.ok) return { ok: false, error: r.error || 'transcription failed' };
    return { ok: true, words: r.words };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── keyframe images (on-device FLUX / Kontext) ─────────────────────────────────────
export const TOON_STYLE =
  '3D animated movie still, Pixar/DreamWorks style, vibrant stylized cartoon animation, soft toon shading, expressive cartoon features, clearly animated and NOT photorealistic';

export async function keyframe(prompt: string, outPath: string, refs: [string, string][] = [], toon = false): Promise<boolean> {
  return R.keyframe().keyframe(prompt, outPath, refs, toon);
}

/** Keyframe-pass concurrency for the current backend: local = GPU-serial, cloud = network-parallel. */
export function keyframeConcurrency(): number {
  return R.keyframe().concurrency();
}

// ── video (on-device Wan chain / cloud Kling morph) ────────────────────────────────
/** The resolved VIDEO backend — owns the whole keyframe+clip loop (renderScenes / refreshScene) plus the
 * timeline-resolution / upscale / GPU signals the pipeline reads. */
export function video(): import('./backends/types').VideoBackend {
  return R.video();
}

// ── VLM (portrait caption + upload safety) ─────────────────────────────────────────
export async function vlmCaption(imgPath: string): Promise<string> {
  return R.vlm().vlmCaption(imgPath);
}

/** Safety check on an uploaded photo. Returns [safe, codes]. Fails OPEN. */
export async function moderateImage(path: string): Promise<[boolean, string[]]> {
  return R.vlm().moderateImage(path);
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

export const MOTION: Record<string, string> = {
  calm: 'slow cinematic push-in, subject nearly still — a breath, a slow glance, hair drifting; soft light, quiet atmosphere',
  medium: 'steady tracking/dolly shot, subject moves naturally and unhurried (a walk, a turn, a real gesture), cinematic shallow depth of field',
  intense:
    'dynamic camera energy — quicker dolly or handheld move, wind, drifting light and particles; subject stays grounded and natural, momentum from camera and environment, never exaggerated dancing',
};
