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
function streamOp(opId: string, command: string, args: string[]) {
  const run = runEngine(command, args, sidecarEnv(), (e: EngineEvent) => {
    win?.webContents.send(`sidecar:${opId}`, e);
  });
  RUNS.set(opId, run);
  run.done.finally(() => RUNS.delete(opId));
  return run.done;
}
const RUNS = new Map<string, ReturnType<typeof runEngine>>();

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
  ipcMain.handle('project:create', (_e, o: { audio: string; name: string; style: string; cast: string; quality: string; mode: string }) =>
    streamOp('create', 'create-project', [
      '--audio', o.audio, '--name', o.name || '', '--style', o.style || '',
      '--cast', o.cast || '', '--quality', o.quality || 'fast', '--mode', o.mode || 'realistic',
    ]));
  ipcMain.handle('character:create', (_e, o: { name: string; style?: string }) =>
    streamOp('charcreate', 'character-create', ['--name', o.name || '', '--style', o.style || '']));
  ipcMain.handle('character:portrait', (_e, o: { character: string; photo?: string; prompt?: string }) =>
    streamOp('portrait:' + o.character, 'character-portrait',
      ['--character', o.character, ...(o.photo ? ['--photo', o.photo] : []), ...(o.prompt ? ['--prompt', o.prompt] : [])]));

  // ── streaming render ops (renderer subscribes to sidecar:<opId>) ──
  ipcMain.handle('render:start', (_e, o: { pid: string; preview: boolean }) =>
    streamOp('render:' + o.pid, 'render', ['--project', o.pid, ...(o.preview ? ['--preview'] : [])]));
  ipcMain.handle('render:resume', (_e, pid: string) => streamOp('render:' + pid, 'resume', ['--project', pid]));
  ipcMain.handle('scene:regenerate', (_e, o: { pid: string; index: number }) =>
    streamOp('render:' + o.pid, 'regenerate-scene', ['--project', o.pid, '--index', String(o.index)]));
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
