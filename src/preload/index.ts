// Secure bridge: the only surface the renderer can touch. No Node, no ipcRenderer leak — just typed calls.
// Streaming ops (render/create/portrait) emit on `sidecar:<opId>`; subscribe with on(opId, cb).
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface VBApi {
  // read-only state
  listProjects(): Promise<any[]>;
  getProject(pid: string): Promise<any>;
  listScenes(pid: string): Promise<any[]>;
  listCharacters(): Promise<any[]>;
  mediaUrl(key?: string | null): Promise<string | null>;
  dataDir(): Promise<string>;
  deleteProject(pid: string): Promise<boolean>;
  deleteCharacter(cid: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  // config
  keysStatus(): Promise<Record<string, boolean>>;
  setKey(name: string, value: string): Promise<Record<string, boolean>>;
  getSettings(): Promise<any>;
  setSettings(patch: any): Promise<any>;
  // native pickers
  pickAudio(): Promise<string | null>;
  pickImage(): Promise<string | null>;
  // ops (resolve with the sidecar's terminal result)
  createProject(o: { audio: string; name: string; style: string; cast: string; quality: string; mode: string }): Promise<any>;
  createCharacter(o: { name: string; style?: string }): Promise<any>;
  characterPortrait(o: { character: string; photo?: string; prompt?: string }): Promise<any>;
  render(pid: string, preview: boolean): Promise<any>;
  resume(pid: string): Promise<any>;
  regenerateScene(pid: string, index: number): Promise<any>;
  cancel(opId: string): Promise<boolean>;
  // live progress for a streaming op; returns an unsubscribe fn
  on(opId: string, cb: (e: any) => void): () => void;
}

const api: VBApi = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (pid) => ipcRenderer.invoke('project:get', pid),
  listScenes: (pid) => ipcRenderer.invoke('scenes:list', pid),
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  mediaUrl: (key) => ipcRenderer.invoke('media:url', key),
  dataDir: () => ipcRenderer.invoke('app:dataDir'),
  deleteProject: (pid) => ipcRenderer.invoke('project:delete', pid),
  deleteCharacter: (cid) => ipcRenderer.invoke('character:delete', cid),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  keysStatus: () => ipcRenderer.invoke('keys:status'),
  setKey: (name, value) => ipcRenderer.invoke('keys:set', name, value),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  pickAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  pickImage: () => ipcRenderer.invoke('dialog:openImage'),

  createProject: (o) => ipcRenderer.invoke('project:create', o),
  createCharacter: (o) => ipcRenderer.invoke('character:create', o),
  characterPortrait: (o) => ipcRenderer.invoke('character:portrait', o),
  render: (pid, preview) => ipcRenderer.invoke('render:start', { pid, preview }),
  resume: (pid) => ipcRenderer.invoke('render:resume', pid),
  regenerateScene: (pid, index) => ipcRenderer.invoke('scene:regenerate', { pid, index }),
  cancel: (opId) => ipcRenderer.invoke('op:cancel', opId),

  on: (opId, cb) => {
    const ch = `sidecar:${opId}`;
    const handler = (_e: IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
};

contextBridge.exposeInMainWorld('vb', api);
