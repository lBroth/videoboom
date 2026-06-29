// Local VLM stage via the shared sidecar (mlx-vlm, gemma-3). Portrait captioning + a fail-open image-safety
// check, both reusing the same on-device vision model. Used when VB_VLM_BACKEND=local.
import { env, envInt } from './config';
import { ensureSidecar, sidecarPost } from './sidecar';

function vlmModel(): string {
  return env('VB_LOCAL_VLM_MODEL', 'mlx-community/gemma-3-12b-it-4bit');
}

async function callVlm(image: string, prompt: string, maxTokens: number): Promise<string> {
  await ensureSidecar();
  const r = await sidecarPost(
    '/vlm',
    { model: vlmModel(), image, prompt, max_tokens: maxTokens },
    envInt('VB_LOCAL_VLM_DEADLINE_SEC', 300) * 1000,
  );
  return r?.ok && typeof r.text === 'string' ? r.text.trim() : '';
}

export async function vlmCaptionLocal(imgPath: string): Promise<string> {
  try {
    return await callVlm(
      imgPath,
      'Describe this person for consistent re-generation: face, hair, build, age, distinctive features, clothing style. One concise vivid sentence, no names.',
      200,
    );
  } catch {
    return '';
  }
}

/** Fail-open safety check (mirrors providers.moderateImage). Returns [safe, codes]. */
export async function moderateImageLocal(path: string): Promise<[boolean, string[]]> {
  let out: string;
  try {
    out = await callVlm(
      path,
      "You are a strict image safety classifier. Reply with ONE word only: 'UNSAFE' if the image contains sexual content, child sexual content, or graphic gore/violence; otherwise 'SAFE'. Innocent photos of minors are SAFE.",
      16,
    );
  } catch {
    return [true, []];
  }
  const unsafe = out.toLowerCase().includes('unsafe');
  return [!unsafe, unsafe ? ['UNSAFE'] : []];
}
