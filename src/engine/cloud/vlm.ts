// Cloud VLM stage (OpenRouter vision): portrait caption + upload moderation (fails OPEN). No backend branch
// — the registry routed here. Restored + refit from 5125093~1:src/engine/providers.ts.
import { env } from '../config';
import { costAdd, orCost } from '../cost';
import { moderationUri } from '../ffmpeg';
import { OR, orHdr, httpJson, dataUri } from './http';
import type { VlmBackend } from '../backends/types';

export const cloudVlm: VlmBackend = {
  async vlmCaption(imgPath: string): Promise<string> {
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
  },

  async moderateImage(path: string): Promise<[boolean, string[]]> {
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
  },
};
