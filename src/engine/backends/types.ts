// The per-stage backend interfaces. Each method carries the exact signature stages.ts already exposes, so
// pipeline.ts's call sites are untouched. Five stages — STT, LLM, VLM, KEYFRAME, VIDEO — with moderation a
// method on the VLM interface (same provider, no sixth stage). The VIDEO interface lands in C4.
// See DUAL_BACKEND_PLAN.md §1.1.
import type { Word } from '../stages';

export type Backend = 'cloud' | 'local';
export type Stage = 'STT' | 'LLM' | 'VLM' | 'KEYFRAME' | 'VIDEO';   // moderation ⊂ VLM

export interface LlmBackend {
  // `role` tags the call so cloud picks VB_STORY_MODEL (role='story') vs VB_LLM_MODEL; local ignores it.
  llmJson(system: string, user: string, schema: any,
          role: string | undefined, maxTokens: number, temperature: number): Promise<any | null>;
}

export interface SttBackend {
  // {ok:true, words:[]} = legitimate instrumental; {ok:false} = genuine failure. Same contract both sides.
  transcribeWords(audioPath: string): Promise<{ ok: boolean; words: Word[]; error?: string }>;
}

export interface VlmBackend {
  vlmCaption(imgPath: string): Promise<string>;
  moderateImage(path: string): Promise<[boolean, string[]]>;         // fails OPEN
}

export interface KeyframeBackend {
  keyframe(prompt: string, out: string, refs: [string, string][], toon: boolean): Promise<boolean>;
  concurrency(): number;   // local → GPU-serial (workers()); cloud → network-parallel (max(workers, VB_KF_WORKERS))
  needsGpu(): boolean;     // local → true; cloud → false (used by the GPU lock, C5)
}
