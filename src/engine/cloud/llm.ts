// Cloud LLM stage (OpenRouter). No backend branch — the registry already routed here. The `role` tag picks
// the story-bible model (VB_STORY_MODEL) vs the shot-list model (VB_LLM_MODEL). Restored + refit from
// 5125093~1:src/engine/providers.ts (llmJson / llmComplete).
import { env } from '../config';
import { costAdd, orCost } from '../cost';
import { OR, orHdr, httpJson, sleep } from './http';
import type { LlmBackend } from '../backends/types';

function modelFor(role: string | undefined): string {
  return role === 'story'
    ? env('VB_STORY_MODEL', 'anthropic/claude-sonnet-4.6')
    : env('VB_LLM_MODEL', 'google/gemini-3.5-flash');
}

export const cloudLlm: LlmBackend = {
  async llmJson(system, user, schema, role, maxTokens = 4000, temperature = 0.7) {
    const body = {
      model: modelFor(role),
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
  },
};

/** Free-text completion — restored for parity; the pipeline uses only llmJson. */
export async function llmComplete(system: string, user: string, maxTokens = 2000, model?: string, temperature = 0.9): Promise<string> {
  const body = {
    model: model || env('VB_LLM_MODEL', 'google/gemini-3.5-flash'),
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
