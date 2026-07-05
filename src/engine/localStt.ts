// Local speech-to-text stage: mlx-whisper via the shared sidecar (sidecar.ts). Returns a typed result so
// the pipeline can tell a genuine instrumental (ok, empty words) apart from a real transcription failure
// (not ok). stages.transcribe wraps this.
import { env, envInt } from './config';
import { ensureSidecar, sidecarPost } from './sidecar';
import type { Word } from './stages';

export async function transcribeWordsLocal(audioPath: string): Promise<{ ok: boolean; words: Word[]; error?: string }> {
  await ensureSidecar();
  const payload = {
    audio: audioPath,
    model: env('VB_LOCAL_STT_MODEL', 'mlx-community/whisper-large-v3-turbo'),
    language: env('VB_STT_LANG') || undefined,
  };
  const r = await sidecarPost('/stt', payload, envInt('VB_LOCAL_STT_DEADLINE_SEC', 900) * 1000);
  // r.ok distinguishes a successful transcription (words may still be empty for an instrumental) from a
  // sidecar/model failure — the pipeline treats the two very differently.
  if (!r?.ok) return { ok: false, words: [], error: r?.error || 'local STT failed' };
  const words: Word[] = Array.isArray(r.words)
    ? r.words
        .filter((w: any) => w && typeof w.start === 'number' && typeof w.end === 'number' && (w.word || '').trim())
        .map((w: any) => ({ start: Number(w.start), end: Number(w.end), word: String(w.word).trim() }))
    : [];
  return { ok: true, words };
}
