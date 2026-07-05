// The bridge the preload exposes (see desktop/src/preload/index.ts). Renderer code talks to the sidecar
// only through window.vb — never Node, never the network directly.
export interface Project {
  id: string; name: string; status: string; style?: string;
  cast?: { id: string; role?: string }[];
  videoStyle?: 'realistic' | 'toon'; quality?: 'fast' | 'hd';
  sceneCount?: number; scenesPlanned?: number; scenesDone?: number; scenesFailed?: number;
  previewScenes?: number; renderTarget?: number; durationSec?: number; renderSeconds?: number;
  progress?: number; stage?: string; videoKey?: string; error?: string; createdAt?: number;
}
export interface Character {
  id: string; name: string; style?: string; description?: string; status?: string; error?: string;
  primaryKey?: string; thumbKey?: string; aiGenerated?: boolean;
}
export interface Scene {
  index: number; status?: string; title?: string; lyric?: string; error?: string;
  startSec?: number; endSec?: number;
}
export type Stage = 'STT' | 'LLM' | 'VLM' | 'KEYFRAME' | 'VIDEO';
export type Backend = 'cloud' | 'local';
export interface StageSelection { mode: 'auto' | 'manual'; backend?: Backend; }
export interface CloudModels {
  storyModel: string; llmModel: string; keyframeModel: string;
  videoModel: string; vlmModel: string; moderationModel: string;
}
export interface Settings {
  settingsVersion: number;                                     // 3
  backendPreference: 'auto' | 'prefer-local' | 'prefer-cloud'; // master control
  stages: Record<Stage, StageSelection>;                       // per-stage auto/pin
  cloud: CloudModels;                                          // OpenRouter/Replicate slugs (advanced)
  // ── on-device knobs. Fast = FastWan-5B (DMD 3-step), Quality = Wan 14B (bf16-relay); both finish 1080p.
  sttLang: string; workers: number;
  localVideoModel: '5b' | '14b'; localQuality: 'fast' | 'hd'; localWanDir: string;
}
export interface LocalCapabilities {
  platform: string; arch: string; ramGB: number; isAppleSilicon: boolean;
  minRamGB: number; recommendedRamGB: number; depsInstalled: boolean; supported: boolean; reason: string;
}
export interface SidecarEvent {
  event: string; stage?: string; total?: number; index?: number; status?: string;
  ok?: boolean; error?: string; videoKey?: string; scenesDone?: number; scenesFailed?: number;
  costCents?: number; message?: string; projectId?: string; characterId?: string;
}

export interface VBApi {
  listProjects(): Promise<Project[]>;
  getProject(pid: string): Promise<Project | null>;
  listScenes(pid: string): Promise<Scene[]>;
  listCharacters(): Promise<Character[]>;
  mediaUrl(key?: string | null): Promise<string | null>;
  dataDir(): Promise<string>;
  deleteProject(pid: string): Promise<boolean>;
  downloadVideo(pid: string): Promise<string | null>;
  deleteCharacter(cid: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  keysStatus(): Promise<Record<string, boolean>>;
  setKey(name: string, value: string): Promise<Record<string, boolean>>;
  pickAudio(): Promise<string | null>;
  pickImage(): Promise<string | null>;
  createProject(o: { audio: string; name: string; style: string; cast: string; quality: string; mode: string; format?: string }): Promise<{ projectId: string }>;
  createCharacter(o: { name: string; style?: string }): Promise<{ characterId: string }>;
  characterPortrait(o: { character: string; photo?: string; prompt?: string }): Promise<Record<string, unknown>>;
  render(pid: string, preview: boolean, regenStory?: boolean): Promise<Record<string, unknown>>;
  resume(pid: string): Promise<Record<string, unknown>>;
  requality(pid: string): Promise<Record<string, unknown>>;
  regenerateScene(pid: string, index: number): Promise<Record<string, unknown>>;
  cancel(opId: string): Promise<boolean>;
  localCapabilities(): Promise<LocalCapabilities>;
  modelsStatus(): Promise<Record<string, 'ready' | 'absent'>>;
  downloadModel(stage: string): Promise<void>;
  cancelDownload(stage: string): Promise<boolean>;
  onDownload(stage: string, cb: (e: SidecarEvent & { pct?: number; mb?: number }) => void): () => void;
  on(opId: string, cb: (e: SidecarEvent) => void): () => void;
}

declare global {
  interface Window { vb: VBApi }
}
