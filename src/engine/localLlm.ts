// Local LLM stage (story bible + shot list) via the shared sidecar (mlx-lm). Mirrors providers.llmComplete
// / llmJson: plain text, and JSON via the same tolerant extraction. The cloud model slug is ignored — local
// always uses VB_LOCAL_LLM_MODEL. Used when VB_LLM_BACKEND=local.
import { env, envInt } from './config';
import { ensureSidecar, sidecarPost } from './sidecar';

async function callLlm(system: string, user: string, maxTokens: number, temperature: number): Promise<string> {
  await ensureSidecar();
  const payload = {
    model: env('VB_LOCAL_LLM_MODEL', 'lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit'),
    system,
    prompt: user,
    max_tokens: maxTokens,
    temperature,
  };
  const r = await sidecarPost('/llm', payload, envInt('VB_LOCAL_LLM_DEADLINE_SEC', 600) * 1000);
  return r?.ok && typeof r.text === 'string' ? r.text : '';
}

export async function llmCompleteLocal(system: string, user: string, maxTokens = 2000, temperature = 0.9): Promise<string> {
  try {
    return await callLlm(system, user, maxTokens, temperature);
  } catch {
    return '';
  }
}

export async function llmJsonLocal(system: string, user: string, schema: any, maxTokens = 4000, temperature = 0.7): Promise<any | null> {
  const sys = `${system}\n\nOutput ONLY one valid JSON object — no markdown fences, no prose — matching this JSON schema:\n${JSON.stringify(
    schema?.schema || schema,
  )}`;
  let txt: string;
  try {
    txt = await callLlm(sys, user, maxTokens, temperature);
  } catch {
    return null;
  }
  if (!txt) return null;
  txt = txt.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(txt);
  } catch {
    const i0 = txt.indexOf('{');
    const j0 = txt.lastIndexOf('}');
    if (i0 >= 0 && j0 > i0) {
      try {
        return JSON.parse(txt.slice(i0, j0 + 1));
      } catch {
        /* give up */
      }
    }
  }
  return null;
}
