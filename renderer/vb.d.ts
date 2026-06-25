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
export interface Settings {
  storyModel: string; llmModel: string; keyframeModel: string; videoModel: string;
  vlmModel: string; moderationModel: string; sttLang: string; workers: number;
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
  deleteCharacter(cid: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  keysStatus(): Promise<Record<string, boolean>>;
  setKey(name: string, value: string): Promise<Record<string, boolean>>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  pickAudio(): Promise<string | null>;
  pickImage(): Promise<string | null>;
  createProject(o: { audio: string; name: string; style: string; cast: string; quality: string; mode: string }): Promise<{ projectId: string }>;
  createCharacter(o: { name: string; style?: string }): Promise<{ characterId: string }>;
  characterPortrait(o: { character: string; photo?: string; prompt?: string }): Promise<Record<string, unknown>>;
  render(pid: string, preview: boolean): Promise<Record<string, unknown>>;
  resume(pid: string): Promise<Record<string, unknown>>;
  regenerateScene(pid: string, index: number): Promise<Record<string, unknown>>;
  cancel(opId: string): Promise<boolean>;
  on(opId: string, cb: (e: SidecarEvent) => void): () => void;
}

declare global {
  interface Window { vb: VBApi }
}
