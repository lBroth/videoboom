// Main process: window lifecycle + the IPC surface the renderer calls. The renderer never spawns
// processes or touches secrets — it asks main, main composes the BYOK env (keychain + settings) and runs
// the sidecar, streaming progress events back over a channel.
import { app, BrowserWindow, ipcMain, dialog, screen, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { runEngine, dataDir, EngineEvent } from '../engine';

// App icon — bundled under icons/ (inside app.asar when packaged). Used for the window (win/linux) and
// the macOS dock in dev (packaged macOS gets its icon from the .app bundle automatically).
const ICON = path.join(app.getAppPath(), 'icons', 'icon.png');
import { keysEnv, keyStatus, setKey } from './keychain';
import { settingsEnv, getSettings, setSettings, Settings } from './settings';
import { modelStatus, downloadModel, localCapabilities, DownloadRun } from './localModels';
import { getProject, listScenes, listProjects, listCharacters, mediaUrl } from './projects';

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5273';
let win: BrowserWindow | null = null;

function createWindow() {
  // open large by default (fit ~92% of the screen's work area, capped) so content doesn't scroll
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, Math.round(wa.width * 0.92));
  const height = Math.min(980, Math.round(wa.height * 0.92));
  win = new BrowserWindow({
    width, height, minWidth: 900, minHeight: 640, center: true,
    backgroundColor: '#0b0d12',
    icon: ICON,
    show: !process.env.VB_SMOKE,            // headless when smoke-testing
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (app.isPackaged || process.env.VB_LOAD_FILE || process.env.VB_SMOKE) win.loadFile(path.join(__dirname, '../../renderer-dist/index.html'));
  else win.loadURL(DEV_URL);
  if (process.env.VB_SMOKE) runSmokeTest();
}

// Autonomous GUI verification: load the real renderer in Electron, then check the bridge + that React
// rendered + state reads work end-to-end. Prints SMOKE: <json> and exits (0 ok / 1 fail). No human clicks.
function runSmokeTest() {
  const fail = (msg: string) => { console.log('SMOKE: ' + JSON.stringify({ ok: false, error: msg })); app.exit(1); };
  setTimeout(() => fail('timeout — renderer never settled'), 20_000);
  win!.webContents.on('did-finish-load', async () => {
    try {
      // give React a tick to mount, then introspect from inside the renderer context
      const r = await win!.webContents.executeJavaScript(`(async () => {
        await new Promise(res => setTimeout(res, 600));
        const body = document.body.innerText || '';
        const out = { hasBridge: typeof window.vb === 'object' && !!window.vb };
        out.rendered = body.includes('Videoboom');
        out.createForm = body.includes('Generate video') || body.includes('Choose a song');
        out.tabs = ['Create','Videos','Cast','Settings'].every(t => body.includes(t));
        try { out.keys = await window.vb.keysStatus(); } catch (e) { out.keysErr = String(e); }
        try { const p = await window.vb.listProjects(); out.projectCount = p.length; out.firstProject = p[0] && p[0].name; } catch (e) { out.projectsErr = String(e); }
        try { const s = await window.vb.getSettings(); out.videoModel = s.videoModel; } catch (e) { out.settingsErr = String(e); }
        return out;
      })()`);
      const ok = r.hasBridge && r.rendered && r.createForm && r.tabs && r.keys && r.videoModel && !r.projectsErr;
      console.log('SMOKE: ' + JSON.stringify({ ok, ...r }));
      app.exit(ok ? 0 : 1);
    } catch (e) {
      fail(String(e));
    }
  });
}

// The combined BYOK environment for every sidecar call: decrypted keys + model settings.
function sidecarEnv(): Record<string, string> {
  return { ...keysEnv(), ...settingsEnv() };
}

// Run a streaming engine op: forward each event to the renderer on `sidecar:<opId>`, resolve on result.
// (Channel name kept as `sidecar:` so the preload/renderer contract is unchanged.)
function streamOp(opId: string, command: string, args: string[], extraEnv?: Record<string, string>) {
  const run = runEngine(command, args, { ...sidecarEnv(), ...(extraEnv || {}) }, (e: EngineEvent) => {
    win?.webContents.send(`sidecar:${opId}`, e);
  });
  RUNS.set(opId, run);
  run.done.finally(() => RUNS.delete(opId));
  return run.done;
}
const RUNS = new Map<string, ReturnType<typeof runEngine>>();
const DOWNLOADS = new Map<string, DownloadRun>();

// Stages whose Local backend is selected but whose model isn't installed yet — render is blocked until
// they're downloaded (in Settings). Maps each backend setting to its model-status key + a friendly label.
function missingLocalModels(): string[] {
  const s = getSettings();
  const st = modelStatus();
  const map: [keyof Settings, string, string][] = [
    ['videoBackend', 'VIDEO', 'Video (Wan)'],
    ['sttBackend', 'STT', 'Lyric timing'],
    ['llmBackend', 'LLM', 'Story & shots'],
    ['vlmBackend', 'VLM', 'Face caption'],
    ['keyframeBackend', 'KEYFRAME', 'Keyframes'],
  ];
  return map.filter(([field, key]) => (s as any)[field] === 'local' && st[key] !== 'ready').map(([, , label]) => label);
}

// Refuse an op and surface the reason on its own progress channel (the renderer is listening there).
function refuse(opId: string, message: string): Promise<never> {
  win?.webContents.send(`sidecar:${opId}`, { event: 'error', message });
  return Promise.reject(new Error(message));
}

// One GPU generation at a time: a render OR a character portrait (both drive the model sidecar). They block
// each other so a video render and an AI image gen can't run concurrently and fight for memory.
function gpuBusy(): boolean {
  return [...RUNS.keys()].some((k) => k.startsWith('render:') || k.startsWith('portrait:'));
}

/** Guard render starts: one generation at a time, no render mid-download, required local models present. */
function guardRender(pid: string): Promise<never> | null {
  const opId = `render:${pid}`;
  if (DOWNLOADS.size) return refuse(opId, 'A model download is in progress — wait for it to finish, then render.');
  const miss = missingLocalModels();
  if (miss.length) return refuse(opId, `Download the local model(s) first in Settings → On-device: ${miss.join(', ')}.`);
  if (gpuBusy()) return refuse(opId, 'A generation is already running — only one runs at a time.');
  return null;
}

/** Guard an AI character-portrait gen: blocked while a render or another portrait runs, or mid-download. */
function guardPortrait(cid: string): Promise<never> | null {
  const opId = `portrait:${cid}`;
  if (DOWNLOADS.size) return refuse(opId, 'A model download is in progress — wait for it to finish.');
  if (gpuBusy()) return refuse(opId, 'A generation is already running — wait for it to finish, then try again.');
  return null;
}

function registerIpc() {
  // ── read-only state (renderer reads JSON straight off disk via main) ──
  ipcMain.handle('projects:list', () => listProjects());
  ipcMain.handle('project:get', (_e, pid: string) => getProject(pid));
  ipcMain.handle('scenes:list', (_e, pid: string) => listScenes(pid));
  ipcMain.handle('characters:list', () => listCharacters());
  ipcMain.handle('media:url', (_e, key?: string) => mediaUrl(key) ?? null);
  ipcMain.handle('app:dataDir', () => dataDir());
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);   // only real web links — never file:/app: schemes
  });

  // ── delete (main owns the filesystem; rm the dir, guard against path escape) ──
  const rmUnder = (rel: string) => {
    const root = dataDir();
    const abs = path.resolve(root, rel);
    if (abs === root || !abs.startsWith(root + path.sep)) throw new Error('refused');
    fs.rmSync(abs, { recursive: true, force: true });
    return true;
  };
  ipcMain.handle('project:delete', (_e, pid: string) => rmUnder(pid));
  ipcMain.handle('character:delete', (_e, cid: string) => rmUnder(path.join('characters', cid)));

  // Save the finished video to a user-chosen location (Save As). Returns the saved path or null if cancelled.
  ipcMain.handle('video:download', async (_e, pid: string) => {
    const p = getProject(pid) as any;
    const key = (p?.videoKey as string) || `${pid}/output/music_video.mp4`;
    const src = path.join(dataDir(), key);
    if (!fs.existsSync(src)) throw new Error('No finished video to download yet.');
    const safeName = String(p?.name || 'video').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('downloads'), `${safeName}.mp4`),
      filters: [{ name: 'Video', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(src, r.filePath);
    return r.filePath;
  });

  // ── config ──
  ipcMain.handle('keys:status', () => keyStatus());
  ipcMain.handle('keys:set', (_e, name: string, value: string) => { setKey(name, value); return keyStatus(); });
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => setSettings(patch));

  // ── native pickers ──
  ipcMain.handle('dialog:openAudio', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:openImage', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ── one-shot sidecar ops (no streaming needed) ──
  ipcMain.handle('project:create', (_e, o: { audio: string; name: string; style: string; cast: string; quality: string; mode: string; format?: string }) =>
    streamOp('create', 'create-project', [
      '--audio', o.audio, '--name', o.name || '', '--style', o.style || '',
      '--cast', o.cast || '', '--quality', o.quality || 'fast', '--mode', o.mode || 'realistic',
      '--format', o.format || 'music-video',
    ]));
  ipcMain.handle('character:create', (_e, o: { name: string; style?: string }) =>
    streamOp('charcreate', 'character-create', ['--name', o.name || '', '--style', o.style || '']));
  ipcMain.handle('character:portrait', (_e, o: { character: string; photo?: string; prompt?: string }) =>
    guardPortrait(o.character) ?? streamOp('portrait:' + o.character, 'character-portrait',
      ['--character', o.character, ...(o.photo ? ['--photo', o.photo] : []), ...(o.prompt ? ['--prompt', o.prompt] : [])]));

  // ── on-device model availability + downloads (renderer subscribes to download:<STAGE>) ──
  ipcMain.handle('local:capabilities', () => localCapabilities());
  ipcMain.handle('models:status', () => modelStatus());
  ipcMain.handle('models:download', (_e, stage: string) => {
    if (DOWNLOADS.has(stage)) return DOWNLOADS.get(stage)!.done; // already downloading — join it
    const run = downloadModel(stage, (ev) => win?.webContents.send(`download:${stage}`, ev));
    DOWNLOADS.set(stage, run);
    run.done.finally(() => {
      DOWNLOADS.delete(stage);
      win?.webContents.send(`download:${stage}`, { event: 'closed' });
    });
    return run.done;
  });
  ipcMain.handle('models:downloadCancel', (_e, stage: string) => {
    DOWNLOADS.get(stage)?.cancel();
    return true;
  });

  // ── streaming render ops (renderer subscribes to sidecar:<opId>) ──
  ipcMain.handle('render:start', (_e, o: { pid: string; preview: boolean; regenStory?: boolean }) =>
    guardRender(o.pid) ?? streamOp('render:' + o.pid, 'render',
      ['--project', o.pid, ...(o.preview ? ['--preview'] : []), ...(o.regenStory ? ['--regen-story'] : [])]));
  ipcMain.handle('render:resume', (_e, pid: string) => guardRender(pid) ?? streamOp('render:' + pid, 'resume', ['--project', pid]));
  // Re-render the existing clips at quality (20 steps), reusing storyboard + keyframes — only the video step.
  ipcMain.handle('render:requality', (_e, pid: string) =>
    guardRender(pid) ?? streamOp('render:' + pid, 'rerender-clips', ['--project', pid], { VB_LOCAL_WAN_STEPS: '20' }));
  ipcMain.handle('scene:regenerate', (_e, o: { pid: string; index: number }) =>
    guardRender(o.pid) ?? streamOp('render:' + o.pid, 'regenerate-scene', ['--project', o.pid, '--index', String(o.index)]));
  ipcMain.handle('op:cancel', (_e, opId: string) => { RUNS.get(opId)?.cancel(); return true; });
}

app.whenReady().then(async () => {
  // Offline engine self-test (no keys/network): exercises the ffmpeg transform path end-to-end.
  if (process.env.VB_ENGINE_TEST) {
    try {
      const { runSelfTest } = await import('../engine/selftest');
      const r = await runSelfTest();
      console.log('ENGINE_TEST: ' + JSON.stringify(r));
      app.exit(r.ok ? 0 : 1);
    } catch (e) {
      console.log('ENGINE_TEST: ' + JSON.stringify({ ok: false, error: String(e) }));
      app.exit(1);
    }
    return;
  }
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON)) app.dock.setIcon(ICON);   // dock icon in dev
  registerIpc();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
