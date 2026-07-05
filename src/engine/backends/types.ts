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

// Progress + cancellation plumbing. Defined here (not in pipeline) so the video impls and the scene helpers
// can share the exact same types the pipeline builds them from. `emit` turns into an IPC event upstream.
export type Emit = (e: any) => void;
export type Cancelled = () => boolean;

// Everything a video backend needs to render (or refresh) a project's scenes. The pipeline builds this and
// hands it to whichever backend the resolver picked — it names no backend itself. See DUAL_BACKEND_PLAN §1.1.
export interface SceneRenderCtx {
  pid: string;
  p: any;
  toRender: number[];
  target: number;
  toon: boolean;
  emit: Emit;
  cancelled: Cancelled;
}

export interface VideoBackend {
  // ONE entry point owns the WHOLE keyframe+clip loop for these scenes (both continuity models). Returns
  // void — the pipeline calls the shared `assemble` afterward.
  renderScenes(ctx: SceneRenderCtx): Promise<void>;
  // Single-scene refresh (+ neighbour re-render for the cloud morph); used by regenerateScene. Returns [ok, err].
  refreshScene(ctx: SceneRenderCtx, k: number, vary: string): Promise<[boolean, string]>;
  timelineRes(): { w: number; h: number };  // local 832×480 · cloud 1280×720 — drives VB_W/VB_H (C5)
  needsUpscale(): boolean;                   // local → ESRGAN→1080 · cloud → light scale→1080
  needsGpu(): boolean;                       // local → true · cloud → false (GPU lock, C5)
}
