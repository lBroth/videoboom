// Cloud STT stage: WhisperX forced alignment on Replicate. Two changes vs 5125093~1:
//  1. Typed result — {ok:true, words:[]} is a legitimate INSTRUMENTAL (successful transcript, no vocals);
//     {ok:false, error} is a genuine failure. The pre code collapsed both to null. (DUAL_BACKEND_PLAN §1.3)
//  2. OQ6 — call the model-scoped endpoint /v1/models/{owner}/{name}/predictions, which runs the model's
//     LATEST version, instead of pinning a version hash that can go stale. Owner/name is env-overridable.
import fs from 'node:fs';
import { env } from '../config';
import { costAdd } from '../cost';
import { tmp } from '../storage';
import { toMp3_16k } from '../ffmpeg';
import { UA, httpJson, sleep } from './http';
import type { SttBackend } from '../backends/types';
import type { Word } from '../stages';

const REPLICATE = 'https://api.replicate.com/v1';

export const cloudStt: SttBackend = {
  async transcribeWords(audioPath: string) {
    const tok = env('REPLICATE_API_TOKEN');
    if (!tok) return { ok: false, words: [], error: 'Replicate token missing' };
    const modelPath = env('VB_WHISPERX_MODEL', 'victor-upmeet/whisperx');
    const hdr = { Authorization: 'Token ' + tok, 'Content-Type': 'application/json', 'User-Agent': UA };
    let dataUriAudio: string;
    try {
      const src = await toMp3_16k(audioPath, tmp('wx16.mp3'));
      dataUriAudio = 'data:audio/mpeg;base64,' + fs.readFileSync(src).toString('base64');
    } catch (ex) {
      return { ok: false, words: [], error: 'audio prep failed: ' + String(ex).slice(0, 160) };
    }
    const inp: any = { audio_file: dataUriAudio, align_output: true, batch_size: 16 };
    if (env('VB_STT_LANG')) inp.language = env('VB_STT_LANG');
    let pred: any;
    try {
      // model-scoped endpoint → latest version, no `version` hash in the body (OQ6).
      pred = await httpJson(`${REPLICATE}/models/${modelPath}/predictions`, { method: 'POST', headers: hdr, body: JSON.stringify({ input: inp }) }, 60_000);
    } catch (ex) {
      return { ok: false, words: [], error: 'WhisperX submit failed: ' + String(ex).slice(0, 160) };
    }
    const pid = pred.id;
    const deadline = Date.now() + 300_000;
    while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
      if (Date.now() > deadline) return { ok: false, words: [], error: 'WhisperX poll timeout' };
      await sleep(4000);
      try {
        pred = await httpJson(`${REPLICATE}/predictions/${pid}`, { headers: hdr }, 60_000);
      } catch {
        /* transient — keep polling until the deadline */
      }
    }
    if (pred.status !== 'succeeded') {
      return { ok: false, words: [], error: `WhisperX ${pred.status}: ${String(pred.error || '').slice(0, 160)}` };
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
    costAdd(parseFloat(env('VB_WHISPERX_CENTS', '1.5')));   // the prediction ran (and billed) even if instrumental
    return { ok: true, words };   // words:[] here = a real instrumental, NOT a failure
  },
};
