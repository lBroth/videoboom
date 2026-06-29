// Local speech-to-text stage: mlx-whisper via the shared sidecar (sidecar.ts). Returns the same Word[]
// shape as the cloud WhisperX path so providers.transcribeWords swaps cloud<->local with no pipeline
// change. Used when VB_STT_BACKEND=local.
import { env, envInt } from './config';
import { ensureSidecar, sidecarPost } from './sidecar';
import type { Word } from './providers';

export async function transcribeWordsLocal(audioPath: string): Promise<Word[]> {
  await ensureSidecar();
  const payload = {
    audio: audioPath,
    model: env('VB_LOCAL_STT_MODEL', 'mlx-community/whisper-large-v3-turbo'),
    language: env('VB_STT_LANG') || undefined,
  };
  const r = await sidecarPost('/stt', payload, envInt('VB_LOCAL_STT_DEADLINE_SEC', 900) * 1000);
  if (!r?.ok || !Array.isArray(r.words)) return [];
  return r.words
    .filter((w: any) => w && typeof w.start === 'number' && typeof w.end === 'number' && (w.word || '').trim())
    .map((w: any) => ({ start: Number(w.start), end: Number(w.end), word: String(w.word).trim() }));
}
