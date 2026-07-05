// Main process: window lifecycle + the IPC surface the renderer calls. The renderer never spawns
// processes — it asks main, main composes the on-device model env (settings) and runs the engine/sidecar,
// streaming progress events back over a channel. Everything runs locally; there are no secrets.
import { app, BrowserWindow, ipcMain, dialog, screen, shell, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { runEngine, dataDir, EngineEvent } from '../engine';

// App icon — bundled under icons/ (inside app.asar when packaged). Used for the window (win/linux) and
// the macOS dock in dev (packaged macOS gets its icon from the .app bundle automatically).
const ICON = path.join(app.getAppPath(), 'icons', 'icon.png');
import { getSettings, setSettings, Settings } from './settings';
import { keyStatus, setKey, keysEnv } from './keychain';
import { resolveConfig, type KeyState } from './autoconfig';
import { CLOUD_HOSTS, hostAllowed } from '../shared/netAllowlist';
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
        try { out.caps = await window.vb.localCapabilities(); } catch (e) { out.capsErr = String(e); }
        try { const p = await window.vb.listProjects(); out.projectCount = p.length; out.firstProject = p[0] && p[0].name; } catch (e) { out.projectsErr = String(e); }
        try { const s = await window.vb.getSettings(); out.localVideoModel = s.localVideoModel; } catch (e) { out.settingsErr = String(e); }
        return out;
      })()`);
      const ok = r.hasBridge && r.rendered && r.createForm && r.tabs && r.caps && r.localVideoModel && !r.projectsErr;
      console.log('SMOKE: ' + JSON.stringify({ ok, ...r }));
      app.exit(ok ? 0 : 1);
    } catch (e) {
      fail(String(e));
    }
  });
}

// The environment for every engine op: the on-device model settings (no secrets — everything runs locally).
function keyState(): KeyState {
  const s = keyStatus();
  return { openrouter: Boolean(s.openrouter), replicate: Boolean(s.replicate) };
}

/** The resolver's decision for the current settings + hardware + keys — the single source of truth for
 * which backend each stage uses (and the VB_* env the engine reads). Recomputed per op so a mid-session
 * settings/key change takes effect on the next render. */
function resolvedConfig() {
  return resolveConfig(localCapabilities(), getSettings(), keyState());
}

function sidecarEnv(): Record<string, string> {
  // Optional cloud keys (decrypted, main-process only) + the resolved per-stage backends / slugs / local block.
  return { ...keysEnv(), ...resolvedConfig().toEnv() };
}

// ── network firewall (deny-by-default) ───────────────────────────────────────────
// Host patterns the Electron session may reach right now: a provider's hosts ONLY when it's keyed AND at
// least one stage actually resolved to its cloud backend. Recomputed on boot + whenever keys/settings change.
let FW_HOSTS: string[] = [];
function refreshFirewall(): void {
  const keys = keyState();
  const stages = resolvedConfig().stages;
  const inUse = { openrouter: false, replicate: false };
  for (const [stage, rs] of Object.entries(stages)) {
    if (rs.backend === 'cloud') { if (stage === 'STT') inUse.replicate = true; else inUse.openrouter = true; }
  }
  FW_HOSTS = [
    ...(keys.openrouter && inUse.openrouter ? CLOUD_HOSTS.openrouter : []),
    ...(keys.replicate && inUse.replicate ? CLOUD_HOSTS.replicate : []),
  ];
}
/** Install the deny-by-default firewall on the default session: local schemes + localhost (dev renderer +
 * the on-device sidecar) always pass; external http(s)/ws only to a currently-opted-in cloud host; everything
 * else is cancelled. No key / no opt-in ⇒ FW_HOSTS is empty ⇒ zero external requests. */
function setupFirewall(): void {
  refreshFirewall();
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    let u: URL;
    try { u = new URL(details.url); } catch { return cb({}); }
    const scheme = u.protocol.replace(':', '');
    if (!['http', 'https', 'ws', 'wss'].includes(scheme)) return cb({});        // file/devtools/data/blob/chrome
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return cb({});
    if (hostAllowed(host, FW_HOSTS)) return cb({});                             // opted-in cloud provider
    console.error('[firewall] blocked outbound:', host);
    cb({ cancel: true });
  });
}

// Run a streaming engine op: forward each event to the renderer on `sidecar:<opId>`, resolve on result.
// (Channel name kept as `sidecar:` so the preload/renderer contract is unchanged.) `usesGpu` marks ops that
// hold the on-device GPU (a render whose video/keyframe resolves local, or a local portrait) so an all-cloud
// op never blocks or is blocked by the GPU lock.
function streamOp(opId: string, command: string, args: string[], extraEnv?: Record<string, string>, usesGpu = false) {
  if (usesGpu) GPU_OPS.add(opId);
  const run = runEngine(command, args, { ...sidecarEnv(), ...(extraEnv || {}) }, (e: EngineEvent) => {
    win?.webContents.send(`sidecar:${opId}`, e);
  });
  RUNS.set(opId, run);
  run.done.finally(() => { RUNS.delete(opId); GPU_OPS.delete(opId); });
  return run.done;
}
const RUNS = new Map<string, ReturnType<typeof runEngine>>();
const DOWNLOADS = new Map<string, DownloadRun>();
// Ops currently holding the on-device GPU (see streamOp `usesGpu`). An all-cloud render/portrait is NOT here,
// so it neither blocks nor is blocked by the GPU lock.
const GPU_OPS = new Set<string>();

// The stages a render needs + a friendly label + the cloud provider that gates each. VLM (face caption) is
// portrait-only, so it isn't a render prerequisite.
const RENDER_STAGES: { key: 'STT' | 'LLM' | 'KEYFRAME' | 'VIDEO'; label: string; provider: keyof KeyState }[] = [
  { key: 'STT', label: 'Lyric timing', provider: 'replicate' },
  { key: 'LLM', label: 'Story & shots', provider: 'openrouter' },
  { key: 'KEYFRAME', label: 'Keyframes', provider: 'openrouter' },
  { key: 'VIDEO', label: 'Video (Wan)', provider: 'openrouter' },
];

// Refuse an op and surface the reason on its own progress channel (the renderer is listening there).
function refuse(opId: string, message: string): Promise<never> {
  win?.webContents.send(`sidecar:${opId}`, { event: 'error', message });
  return Promise.reject(new Error(message));
}

function gpuBusy(): boolean {
  return GPU_OPS.size > 0;
}

/** Does this op actually drive the on-device GPU under the current resolution? A render uses it if VIDEO or
 * KEYFRAME resolve local; a portrait if KEYFRAME or VLM resolve local. All-cloud ops use no GPU. */
function renderNeedsGpu(): boolean {
  const s = resolvedConfig().stages;
  return s.VIDEO.backend === 'local' || s.KEYFRAME.backend === 'local';
}
function portraitNeedsGpu(): boolean {
  const s = resolvedConfig().stages;
  return s.KEYFRAME.backend === 'local' || s.VLM.backend === 'local';
}

/** Guard render starts. Only stages that RESOLVE LOCAL need their model on disk; a stage resolved cloud needs
 * no download (the resolver guarantees its key). A stage resolved local on a machine that can't run it is
 * blocked with the specific missing-key / opt-in nudge — never silently sent to cloud (I3). */
function guardRender(pid: string): Promise<never> | null {
  const opId = `render:${pid}`;
  if (DOWNLOADS.size) return refuse(opId, 'A model download is in progress — wait for it to finish, then render.');
  const resolved = resolvedConfig();
  const st = modelStatus();
  const missing: string[] = [];
  for (const { key, label, provider } of RENDER_STAGES) {
    const rs = resolved.stages[key];
    if (rs.backend !== 'local') continue;            // cloud-resolved → no local model needed
    if (!rs.localAvailable) {                         // machine can't run this stage on-device
      const provLabel = provider === 'replicate' ? 'Replicate' : 'OpenRouter';
      return refuse(opId, keyState()[provider]
        ? `This machine can't run ${label} on-device — pick Cloud for it in Settings → Models.`
        : `${label} needs a ${provLabel} key on this machine (on-device isn't supported here). Add one in Settings.`);
    }
    if (st[key] !== 'ready') missing.push(label);     // supported, but the model isn't downloaded yet
  }
  if (missing.length) return refuse(opId, `Download the local model(s) first in Settings → On-device: ${missing.join(', ')}.`);
  if (renderNeedsGpu() && gpuBusy()) return refuse(opId, 'A generation is already running — only one runs at a time.');
  return null;
}

/** Guard an AI character-portrait gen: blocked mid-download, or (only when it uses the GPU) while another
 * GPU op runs. A cloud-keyframe portrait can run alongside a local render. */
function guardPortrait(cid: string): Promise<never> | null {
  const opId = `portrait:${cid}`;
  if (DOWNLOADS.size) return refuse(opId, 'A model download is in progress — wait for it to finish.');
  if (portraitNeedsGpu() && gpuBusy()) return refuse(opId, 'A generation is already running — wait for it to finish, then try again.');
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
  ipcMain.handle('character:delete', (_e, cid: string) => {
    const ok = rmUnder(path.join('characters', cid));
    // Scrub the id from every project's cast: a dangling cast id used to be skipped SILENTLY at render
    // time, so keyframes lost their reference with no error (e.g. the director invented a product).
    for (const entry of fs.readdirSync(dataDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'characters') continue;
      const pj = path.join(dataDir(), entry.name, 'project.json');
      try {
        const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const before = (p.cast || []).length;
        p.cast = (p.cast || []).filter((c: any) => (typeof c === 'object' ? c.id : c) !== cid);
        if (p.cast.length !== before) fs.writeFileSync(pj, JSON.stringify(p, null, 2));
      } catch {
        /* not a project dir */
      }
    }
    return ok;
  });

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
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => { const s = setSettings(patch); refreshFirewall(); return s; });

  // ── optional cloud keys (safeStorage; the app works fully with none) ──
  ipcMain.handle('keys:status', () => keyStatus());
  ipcMain.handle('keys:set', (_e, name: string, value: string) => { setKey(name, value); refreshFirewall(); return keyStatus(); });

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
      ['--character', o.character, ...(o.photo ? ['--photo', o.photo] : []), ...(o.prompt ? ['--prompt', o.prompt] : [])], undefined, portraitNeedsGpu()));

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
      ['--project', o.pid, ...(o.preview ? ['--preview'] : []), ...(o.regenStory ? ['--regen-story'] : [])], undefined, renderNeedsGpu()));
  ipcMain.handle('render:resume', (_e, pid: string) => guardRender(pid) ?? streamOp('render:' + pid, 'resume', ['--project', pid], undefined, renderNeedsGpu()));
  // Re-render the existing clips at quality (20 steps), reusing storyboard + keyframes — only the video step.
  ipcMain.handle('render:requality', (_e, pid: string) =>
    guardRender(pid) ?? streamOp('render:' + pid, 'rerender-clips', ['--project', pid], { VB_LOCAL_WAN_STEPS: '20' }, renderNeedsGpu()));
  ipcMain.handle('scene:regenerate', (_e, o: { pid: string; index: number }) =>
    guardRender(o.pid) ?? streamOp('render:' + o.pid, 'regenerate-scene', ['--project', o.pid, '--index', String(o.index)], undefined, renderNeedsGpu()));
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
  setupFirewall();
  registerIpc();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
