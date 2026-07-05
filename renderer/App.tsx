import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Film, UserRound, Settings as SettingsIcon, Music, Plus, RotateCcw, Trash2,
  Image as ImageIcon, Wand2, AlertTriangle, CheckCircle2, Download,
} from 'lucide-react';
import {
  Button, IconButton, Card, Field, Segmented, ProgressBar, Spinner, StatusDot, EmptyState,
  Img, inputCls, cx, useConfirm,
} from './components/ui';
import type { Project, Character, Scene, Settings, SidecarEvent } from './vb';
import logo from './logo.png';

const vb = window.vb;

// ── media resolver (file:// from a stored key; re-resolves when `bust` changes) ──
function useMedia(key?: string | null, bust?: unknown): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    if (!key) { setUrl(null); return; }
    vb.mediaUrl(key).then((u) => { if (on) setUrl(u); });
    return () => { on = false; };
  }, [key, bust]);
  return url;
}

// ── live render runs (one per project; driven by the sidecar event stream) ──
interface RunState { active: boolean; label: string; stage?: string; total?: number; done: number; finished?: boolean; error?: string }
const RenderCtx = createContext<{
  runs: Record<string, RunState>;
  startRender: (pid: string, preview: boolean) => void;
  startResume: (pid: string) => void;
  startRequality: (pid: string) => void;
  startRegen: (pid: string, index: number) => void;
}>({ runs: {}, startRender: () => {}, startResume: () => {}, startRequality: () => {}, startRegen: () => {} });
const useRender = () => useContext(RenderCtx);

function RenderProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const qc = useQueryClient();

  const launch = useCallback((pid: string, label: string, opId: string, op: () => Promise<unknown>) => {
    setRuns((r) => ({ ...r, [pid]: { active: true, label, done: 0 } }));
    const off = vb.on(opId, (e: SidecarEvent) => {
      setRuns((r) => {
        const cur = r[pid] || { active: true, label, done: 0 };
        const next: RunState = { ...cur };
        if (e.event === 'stage') { next.stage = e.stage; if (e.total != null) next.total = e.total; if (e.stage === 'clips') next.done = 0; }
        else if (e.event === 'scene') next.done = (cur.done || 0) + 1;
        else if (e.event === 'done') next.finished = true;
        else if (e.event === 'error') next.error = e.message;
        return { ...r, [pid]: next };
      });
      if (e.event === 'scene' || e.event === 'done') { qc.invalidateQueries({ queryKey: ['scenes', pid] }); qc.invalidateQueries({ queryKey: ['projects'] }); }
    });
    op()
      .catch((err: Error) => setRuns((r) => ({ ...r, [pid]: { ...(r[pid] || { label, done: 0 }), active: true, error: String(err?.message || err) } })))
      .finally(() => {
        off();
        setRuns((r) => ({ ...r, [pid]: { ...(r[pid] || { label, done: 0 }), active: false } }));
        qc.invalidateQueries({ queryKey: ['projects'] });
        qc.invalidateQueries({ queryKey: ['scenes', pid] });
      });
  }, [qc]);

  const value = useMemo(() => ({
    runs,
    startRender: (pid: string, preview: boolean) => launch(pid, preview ? 'Preview' : 'Full video', `render:${pid}`, () => vb.render(pid, preview)),
    startResume: (pid: string) => launch(pid, 'Full song', `render:${pid}`, () => vb.resume(pid)),
    startRequality: (pid: string) => launch(pid, 'Re-render · Quality', `render:${pid}`, () => vb.requality(pid)),
    startRegen: (pid: string, index: number) => launch(pid, `Scene ${index + 1}`, `render:${pid}`, () => vb.regenerateScene(pid, index)),
  }), [runs, launch]);

  return <RenderCtx.Provider value={value}>{children}</RenderCtx.Provider>;
}

function runMessage(run?: RunState): string {
  if (!run) return 'Working…';
  if (run.error) return run.error;
  switch (run.stage) {
    case 'transcribe': return 'Listening to the song…';
    case 'story': return 'Writing the story…';
    case 'shotlist': return 'Designing the shots…';
    case 'keyframes': return 'Painting keyframes…';
    case 'clips': return `Rendering clips ${run.done || 0}/${run.total || '?'}…`;
    case 'assemble': return 'Assembling the video…';
    default: return 'Starting…';
  }
}

const IN_PROGRESS = new Set(['queued', 'storyboarding', 'storyboard', 'rendering', 'refresh']);

// ── tabs ──
type TabKey = 'create' | 'videos' | 'characters' | 'settings';
const TABS: { key: TabKey; label: string; icon: typeof Sparkles }[] = [
  { key: 'create', label: 'Create', icon: Sparkles },
  { key: 'videos', label: 'Videos', icon: Film },
  { key: 'characters', label: 'Cast', icon: UserRound },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

export default function App() {
  const [tab, setTab] = useState<TabKey>('create');

  return (
    <RenderProvider>
      <div className="min-h-full flex flex-col">
        <header className="sticky top-0 z-30 backdrop-blur-xl bg-[#07090f]/70 border-b border-white/10">
          <div className="max-w-5xl mx-auto px-4 h-16 flex items-center gap-3">
            <div className="flex items-center gap-2 mr-2">
              <img src={logo} alt="Videoboom" className="w-8 h-8 rounded-xl shadow-glow" />
              <span className="font-extrabold tracking-tight text-lg brand-text">Videoboom</span>
            </div>
            <nav className="flex items-center gap-1 ml-auto">
              {TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={cx('inline-flex items-center gap-1.5 h-10 px-3 rounded-xl text-sm font-semibold transition-colors',
                    tab === t.key ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5')}>
                  <t.icon className="w-4 h-4" />{t.label}
                </button>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-6">
          <div className={cx(tab !== 'create' && 'hidden')}><CreateVideo onDone={() => setTab('videos')} /></div>
          <div className={cx(tab !== 'videos' && 'hidden')}><Videos /></div>
          <div className={cx(tab !== 'characters' && 'hidden')}><Characters /></div>
          <div className={cx(tab !== 'settings' && 'hidden')}><SettingsScreen /></div>
        </main>
      </div>
    </RenderProvider>
  );
}

// ── Create ──
function CreateVideo({ onDone }: { onDone: () => void }) {
  const chars = useQuery({ queryKey: ['chars'], queryFn: () => vb.listCharacters() });
  const { startRender } = useRender();
  const [audio, setAudio] = useState<string>('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'music-video' | 'ad'>('music-video');
  const [style, setStyle] = useState('cinematic photorealistic music video, dramatic lighting, film grade, shallow depth of field');
  const [mode, setMode] = useState<'realistic' | 'toon'>('realistic');
  const [scope, setScope] = useState<'preview' | 'full'>('preview');
  const [cast, setCast] = useState<string[]>([]);   // ordered; [0] = lead
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = (chars.data || []).filter((c) => c.status === 'ready');
  const basename = (p: string) => p.split('/').pop() || p;

  const pick = async () => {
    const p = await vb.pickAudio();
    if (p) { setAudio(p); if (!name) setName(basename(p).replace(/\.[^.]+$/, '')); }
  };
  const toggleCast = (id: string) => setCast((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const makeLead = (id: string) => setCast((c) => [id, ...c.filter((x) => x !== id)]);

  const go = async () => {
    if (!audio) { setErr('Choose a song first.'); return; }
    setBusy(true); setErr(null);
    try {
      const castSpec = cast.map((id, i) => `${id}:${i === 0 ? 'lead' : 'supporting'}`).join(',');
      const { projectId } = await vb.createProject({ audio, name: name || 'Untitled', style, cast: castSpec, quality: 'fast', mode, format });
      startRender(projectId, scope === 'preview');
      onDone();
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  };

  const pickFormat = (f: 'music-video' | 'ad') => {
    setFormat(f);
    setStyle(f === 'ad'
      ? 'modern product commercial, clean studio + lifestyle, vibrant, premium brand look, crisp lighting'
      : 'cinematic photorealistic music video, dramatic lighting, film grade, shallow depth of field');
  };

  return (
    <div className="grid lg:grid-cols-[1.3fr_1fr] gap-5 animate-fade-up">
      <Card className="p-5 space-y-5">
        <Field label="Format">
          <div className="grid grid-cols-2 gap-2">
            {([['music-video', 'Music video', 'A story cut to the lyrics'], ['ad', 'Ad / Spot', 'A product commercial']] as const).map(([f, t, sub]) => (
              <button key={f} onClick={() => pickFormat(f)}
                className={cx('rounded-xl border px-4 py-3 text-left transition-colors',
                  format === f ? 'border-violet-400/60 bg-violet-500/10 text-slate-100' : 'border-white/10 hover:bg-white/[0.03] text-slate-300')}>
                <div className="font-medium">{t}</div><div className="text-xs text-slate-500 mt-0.5">{sub}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Song">
          <button onClick={pick}
            className={cx('w-full rounded-2xl border-2 border-dashed p-5 text-left transition-colors flex items-center gap-3',
              audio ? 'border-violet-400/60 bg-violet-500/5' : 'border-white/15 hover:bg-white/5')}>
            <div className="w-10 h-10 rounded-xl bg-white/5 grid place-items-center"><Music className="w-5 h-5 text-violet-300" /></div>
            <div className="min-w-0">
              <div className="font-semibold text-slate-100 truncate">{audio ? basename(audio) : 'Choose a song…'}</div>
              <div className="text-xs text-slate-400">{audio ? 'Click to change' : 'mp3 · m4a · wav · flac'}</div>
            </div>
          </button>
        </Field>
        <Field label="Title"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={format === 'ad' ? 'My spot' : 'My music video'} /></Field>
        <Segmented label="Look" value={mode} onChange={setMode} options={[
          { value: 'realistic', title: 'Realistic', desc: 'photoreal, cinematic' },
          { value: 'toon', title: 'Animated', desc: '3D cartoon style' },
        ]} />
        <Segmented label="Scope" value={scope} onChange={setScope} options={[
          { value: 'preview', title: 'Preview', desc: 'first ~25% — quick & cheap' },
          { value: 'full', title: 'Full song', desc: 'every scene' },
        ]} />
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button variant="primary" size="lg" className="w-full" icon={Sparkles} loading={busy} disabled={!audio} onClick={go}>
          Generate video
        </Button>
      </Card>

      <Card className="p-5">
        <Field label="Cast" hint="optional — your characters star in it">
          {ready.length === 0
            ? <EmptyState icon={UserRound} title="No characters yet">Create some in the Cast tab to feature real faces.</EmptyState>
            : (
              <div className="space-y-2">
                {ready.map((c) => {
                  const i = cast.indexOf(c.id);
                  const on = i >= 0;
                  return (
                    <div key={c.id} className={cx('flex items-center gap-3 rounded-2xl border p-2.5 transition-colors',
                      on ? 'border-violet-400/60 bg-violet-500/10' : 'border-white/10 hover:bg-white/5')}>
                      <CharAvatar c={c} className="w-10 h-10 rounded-xl shrink-0" />
                      <button className="min-w-0 flex-1 text-left" onClick={() => toggleCast(c.id)}>
                        <div className="font-semibold text-slate-100 truncate">{c.name}</div>
                        <div className="text-xs text-slate-400">{on ? (i === 0 ? 'Lead' : 'Supporting') : 'Tap to add'}</div>
                      </button>
                      {on && i !== 0 && <Button size="sm" variant="ghost" onClick={() => makeLead(c.id)}>Make lead</Button>}
                      {on && <StatusDot tone="done" />}
                    </div>
                  );
                })}
              </div>
            )}
        </Field>
      </Card>
    </div>
  );
}

function CharAvatar({ c, className }: { c: Character; className?: string }) {
  const url = useMedia(c.thumbKey || c.primaryKey, c.status);
  return <Img src={url} className={cx('object-cover bg-white/5', className)} alt={c.name} />;
}

// ── Videos ──
function Videos() {
  const { runs } = useRender();
  const projects = useQuery({
    queryKey: ['projects'], queryFn: () => vb.listProjects(),
    refetchInterval: (q) => {
      const list = (q.state.data as Project[] | undefined) || [];
      const busy = list.some((p) => IN_PROGRESS.has(p.status)) || Object.values(runs).some((r) => r.active);
      return busy ? 1500 : false;
    },
  });
  const list = projects.data || [];
  if (!list.length) return <EmptyState icon={Film} title="No videos yet">Head to Create and turn a song into one.</EmptyState>;
  return <div className="grid md:grid-cols-2 gap-5 animate-fade-up">{list.map((p) => <VideoCard key={p.id} p={p} />)}</div>;
}

function VideoCard({ p }: { p: Project }) {
  const { runs, startResume, startRequality } = useRender();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const run = runs[p.id];
  const active = run?.active || IN_PROGRESS.has(p.status);
  const bust = `${p.status}-${p.scenesDone}-${p.durationSec}`;
  const video = useMedia(p.status === 'preview' || p.status === 'done' ? p.videoKey || `${p.id}/output/music_video.mp4` : null, bust);
  const poster = useMedia(`${p.id}/output/poster.jpg`, bust);
  const canResume = p.status === 'preview' && (p.previewScenes || 0) < (p.scenesPlanned || 0);

  const del = async () => {
    if (await confirm({ title: `Delete “${p.name}”?`, danger: true, confirmLabel: 'Delete' })) {
      await vb.deleteProject(p.id); qc.invalidateQueries({ queryKey: ['projects'] });
    }
  };

  return (
    <Card className="overflow-hidden flex flex-col">
      <div className="relative aspect-video bg-black/40">
        {video
          ? <video src={`${video}#${bust}`} poster={poster || undefined} controls className="w-full h-full object-contain bg-black" />
          : <div className="absolute inset-0 grid place-items-center text-slate-500">{active ? <Spinner className="w-7 h-7" /> : <Film className="w-8 h-8" />}</div>}
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={p.status === 'failed' ? 'failed' : active ? 'busy' : 'done'} />
          <div className="font-semibold text-slate-100 truncate flex-1">{p.name}</div>
          <span className="text-xs text-slate-400 capitalize">{p.status}</span>
        </div>
        {active && <ProgressBar progress={p.progress || 0.05} message={runMessage(run)} />}
        {p.error && !active && <ErrorNote>{p.error}</ErrorNote>}
        {run?.finished && !active && <div className="text-xs text-slate-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />Finished{p.scenesFailed ? ` · ${p.scenesFailed} scene(s) failed` : ''}</div>}
        {!active && (
          <div className="flex flex-wrap gap-2">
            {canResume && <Button size="sm" variant="primary" icon={Plus} onClick={() => startResume(p.id)}>Finish full song</Button>}
            {(p.status === 'preview' || p.status === 'done') && (p.scenesDone || 0) > 0 &&
              <Button size="sm" variant="soft" icon={Sparkles} onClick={() => startRequality(p.id)} title="Re-render the video at 20 steps, reusing the scenes & keyframes">Re-render · Quality</Button>}
            {(p.status === 'preview' || p.status === 'done') && <Button size="sm" variant="soft" icon={Wand2} onClick={() => setEditing((v) => !v)}>Scenes</Button>}
            {(p.status === 'preview' || p.status === 'done') && video &&
              <Button size="sm" variant="soft" icon={Download} onClick={() => vb.downloadVideo(p.id)}>Download</Button>}
            <Button size="sm" variant="ghost" icon={Trash2} onClick={del}>Delete</Button>
          </div>
        )}
        {editing && !active && <SceneEditor pid={p.id} />}
      </div>
    </Card>
  );
}

function SceneEditor({ pid }: { pid: string }) {
  const { runs, startRegen } = useRender();
  const scenes = useQuery({ queryKey: ['scenes', pid], queryFn: () => vb.listScenes(pid) });
  const busy = runs[pid]?.active;
  const list = scenes.data || [];
  return (
    <div className="mt-1 grid grid-cols-3 sm:grid-cols-4 gap-2">
      {list.map((s) => <SceneThumb key={s.index} pid={pid} s={s} disabled={!!busy} onRegen={() => startRegen(pid, s.index)} />)}
    </div>
  );
}

function SceneThumb({ pid, s, disabled, onRegen }: { pid: string; s: Scene; disabled: boolean; onRegen: () => void }) {
  const url = useMedia(`${pid}/keyframes/scene_${s.index}_thumb.jpg`, s.status);
  return (
    <button onClick={onRegen} disabled={disabled} title={s.lyric || s.title}
      className="group relative aspect-video rounded-lg overflow-hidden border border-white/10 bg-black/40 disabled:opacity-50">
      <Img src={url} className="w-full h-full object-cover" alt={`Scene ${s.index + 1}`} />
      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition grid place-items-center">
        <RotateCcw className="w-4 h-4 text-white" />
      </div>
      {s.status === 'failed' && <div className="absolute top-1 right-1"><AlertTriangle className="w-3.5 h-3.5 text-red-400" /></div>}
      <span className="absolute bottom-0.5 left-1 text-[10px] text-white/70">{s.index + 1}</span>
    </button>
  );
}

// ── Cast ──
function Characters() {
  const qc = useQueryClient();
  const chars = useQuery({
    queryKey: ['chars'], queryFn: () => vb.listCharacters(),
    refetchInterval: (q) => ((q.state.data as Character[] | undefined)?.some((c) => c.status === 'analyzing') ? 2000 : false),
  });
  const list = chars.data || [];
  return (
    <div className="space-y-5 animate-fade-up">
      <NewCharacter onCreated={() => qc.invalidateQueries({ queryKey: ['chars'] })} />
      {list.length === 0
        ? <EmptyState icon={UserRound} title="No characters yet">Add a photo or describe someone — they’ll star in your videos.</EmptyState>
        : <div className="grid sm:grid-cols-2 gap-4">{list.map((c) => <CharCard key={c.id} c={c} />)}</div>}
    </div>
  );
}

function NewCharacter({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) { setErr('Name required.'); return; }
    if (!photo && !prompt.trim()) { setErr('Add a photo or a description.'); return; }
    setBusy(true); setErr(null);
    try {
      const { characterId } = await vb.createCharacter({ name: name.trim() });
      await vb.characterPortrait({ character: characterId, photo: photo || undefined, prompt: prompt || undefined });
      setName(''); setPrompt(''); setPhoto(''); onCreated();
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-5 grid sm:grid-cols-[1fr_1fr] gap-4">
      <div className="space-y-4">
        <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ian" /></Field>
        <Field label="Describe them" hint="optional if you add a photo">
          <textarea className={cx(inputCls, 'h-20 py-2.5 resize-none')} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="A 30-year-old man, short dark beard, denim jacket…" />
        </Field>
      </div>
      <div className="space-y-4">
        <Field label="Reference photo" hint="optional">
          <button onClick={async () => { const p = await vb.pickImage(); if (p) setPhoto(p); }}
            className={cx('w-full rounded-2xl border-2 border-dashed p-5 text-left flex items-center gap-3 transition-colors',
              photo ? 'border-violet-400/60 bg-violet-500/5' : 'border-white/15 hover:bg-white/5')}>
            <div className="w-10 h-10 rounded-xl bg-white/5 grid place-items-center"><ImageIcon className="w-5 h-5 text-violet-300" /></div>
            <div className="min-w-0"><div className="font-semibold text-slate-100 truncate">{photo ? photo.split('/').pop() : 'Choose a photo…'}</div>
              <div className="text-xs text-slate-400">jpg · png · heic</div></div>
          </button>
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button variant="primary" icon={Plus} loading={busy} className="w-full" onClick={create}>Add character</Button>
      </div>
    </Card>
  );
}

function CharCard({ c }: { c: Character }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const url = useMedia(c.primaryKey, c.status);
  const del = async () => {
    if (await confirm({ title: `Delete “${c.name}”?`, danger: true, confirmLabel: 'Delete' })) {
      await vb.deleteCharacter(c.id); qc.invalidateQueries({ queryKey: ['chars'] });
    }
  };
  return (
    <Card className="overflow-hidden flex">
      <div className="w-28 shrink-0 bg-black/40"><Img src={url} className="w-full h-full object-cover aspect-[3/4]" alt={c.name} /></div>
      <div className="p-4 flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-2">
          <StatusDot tone={c.status === 'ready' ? 'done' : c.status === 'analyzing' ? 'busy' : c.status === 'rejected' || c.status === 'failed' ? 'failed' : 'idle'} />
          <div className="font-semibold text-slate-100 truncate flex-1">{c.name}</div>
        </div>
        <div className="text-xs text-slate-400 mt-1 line-clamp-3 flex-1">{c.error || c.description || (c.status === 'analyzing' ? 'Creating portrait…' : '')}</div>
        <div className="flex justify-end mt-2"><IconButton icon={Trash2} label="Delete" size="sm" onClick={del} /></div>
      </div>
    </Card>
  );
}

// ── Settings ──
// Every generation stage runs on-device. The card lists each stage's model with its size and a Download
// button when the weights aren't on disk yet; video has a Fast/Quality choice (the model + speed).
const DL_STAGES: { stage: string; label: string; model: string; size: string }[] = [
  { stage: 'VIDEO', label: 'Video (image→video)', model: 'Wan 2.2 · mlx-video', size: '~54 GB' },
  { stage: 'KEYFRAME', label: 'Keyframe images', model: 'FLUX · mflux', size: '~15 GB' },
  { stage: 'LLM', label: 'Story & shot-list', model: 'Qwen3 · mlx-lm', size: '~19 GB' },
  { stage: 'VLM', label: 'Face caption + safety', model: 'gemma-3 · mlx-vlm', size: '~8 GB' },
  { stage: 'STT', label: 'Lyric timing', model: 'whisper · mlx', size: '~1.6 GB' },
];

// One stage: "Installed" when the weights are on disk, else a Download button with live % progress.
function StageDownloadRow({ st }: { st: (typeof DL_STAGES)[number] }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['modelStatus'], queryFn: () => vb.modelsStatus() });
  const [dl, setDl] = useState<{ pct: number } | null>(null);
  const [err, setErr] = useState('');
  const ready = status.data?.[st.stage] === 'ready';

  const startDownload = () => {
    setErr('');
    setDl({ pct: 0 });
    const off = vb.onDownload(st.stage, (e) => {
      if (e.event === 'progress') setDl({ pct: e.pct ?? 0 });
      else if (e.event === 'error') { setErr(e.error || 'download failed'); setDl(null); off(); }
      else if (e.event === 'done' || e.event === 'closed') { setDl(null); off(); qc.invalidateQueries({ queryKey: ['modelStatus'] }); }
    });
    vb.downloadModel(st.stage).catch((e) => { setErr(String(e?.message || e)); setDl(null); off(); });
  };

  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-200 truncate">{st.label}</div>
        <div className="text-xs text-slate-500">{st.model} · {st.size}</div>
      </div>
      {ready ? (
        <span className="text-xs text-emerald-400 inline-flex items-center gap-1 shrink-0"><CheckCircle2 className="w-3.5 h-3.5" />Installed</span>
      ) : dl ? (
        <div className="flex items-center gap-2 w-44 shrink-0">
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-violet-400 transition-all" style={{ width: `${dl.pct}%` }} /></div>
          <span className="text-xs text-slate-400 tabular-nums w-8 text-right">{dl.pct.toFixed(0)}%</span>
          <button onClick={() => vb.cancelDownload(st.stage)} className="text-xs text-slate-500 hover:text-slate-300">cancel</button>
        </div>
      ) : (
        <button onClick={startDownload} className="text-xs inline-flex items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-500/10 px-2.5 py-1 text-violet-200 hover:bg-violet-500/20 shrink-0">
          <Download className="w-3.5 h-3.5" /> Download
        </button>
      )}
      {err && <div className="text-xs text-red-300 shrink-0">{err}</div>}
    </div>
  );
}

// Fast/Quality IS the model choice: Fast = FastWan-5B (DMD 3-step draft), Quality = Wan 14B (bf16-relay).
// Both finish at 1080p (the shot renders at 480p on-device, then interpolates + upscales).
const VIDEO_MODES: { key: '5b' | '14b'; title: string; sub: string }[] = [
  { key: '5b', title: 'Fast', sub: 'FastWan-5B · 3-step draft · ~4–5 min/clip' },
  { key: '14b', title: 'Quality', sub: 'Wan 14B · best detail · slower' },
];

function SettingsScreen() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => vb.getSettings() });
  const caps = useQuery({ queryKey: ['localCaps'], queryFn: () => vb.localCapabilities() });
  const [dataDir, setDataDir] = useState('');
  useEffect(() => { vb.dataDir().then(setDataDir); }, []);

  const mode: '5b' | '14b' = settings.data?.localVideoModel === '5b' ? '5b' : '14b';
  const setMode = (m: '5b' | '14b') => vb.setSettings({ localVideoModel: m }).then(() => qc.invalidateQueries({ queryKey: ['settings'] }));

  return (
    <div className="space-y-5 animate-fade-up max-w-2xl">
      {settings.data && caps.data && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Film className="w-5 h-5 text-violet-300" /><h2 className="font-semibold text-slate-100">On-device models</h2>
            <span className="text-xs text-slate-500 ml-auto">{caps.data.ramGB}GB unified memory</span>
          </div>

          {!caps.data.supported ? (
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-sm text-amber-200/90">
              Videoboom runs entirely on-device and needs an <b>Apple Silicon Mac</b> with <b>{caps.data.minRamGB}GB+</b> unified memory ({caps.data.recommendedRamGB}GB recommended). {caps.data.reason}
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-400 -mt-1">Everything runs on this Mac (MLX) — no key, no cloud, fully offline. Each model downloads once. Video needs ~24GB free at peak; {caps.data.recommendedRamGB}GB memory recommended.</p>
              {!caps.data.depsInstalled && (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-200/90">
                  Local engine not installed yet — run <code className="text-amber-100">bash local/setup.sh</code> once (installs mlx + downloads the models).
                </div>
              )}
              <Field label="Video quality">
                <div className="grid grid-cols-2 gap-2">
                  {VIDEO_MODES.map((v) => (
                    <button key={v.key} onClick={() => setMode(v.key)}
                      className={cx('rounded-lg border px-3 py-2 text-left transition-colors',
                        mode === v.key ? 'border-violet-400/60 bg-violet-500/10 text-slate-100' : 'border-white/10 hover:bg-white/[0.03] text-slate-300')}>
                      <div className="text-sm font-medium">{v.title}</div><div className="text-xs text-slate-500">{v.sub}</div>
                    </button>
                  ))}
                </div>
              </Field>
              <p className="text-xs text-slate-400 -mt-2">Both modes finish at 1080p — the shot renders at 480p on-device, then the finish pass interpolates + upscales.</p>
              <div className="border-t border-white/5 pt-3 space-y-0.5">
                <div className="text-xs font-medium text-slate-400 mb-1">Models on disk</div>
                {DL_STAGES.map((st) => <StageDownloadRow key={st.stage} st={st} />)}
              </div>
              <Field label="Lyrics language" hint="blank = auto-detect">
                <input className={inputCls} defaultValue={settings.data.sttLang} placeholder="it, en, es…"
                  onBlur={(e) => vb.setSettings({ sttLang: e.target.value.trim() }).then(() => qc.invalidateQueries({ queryKey: ['settings'] }))} />
              </Field>
            </>
          )}
        </Card>
      )}

      <Card className="p-4 text-xs text-slate-500">Projects are stored in <span className="text-slate-300 break-all">{dataDir}</span></Card>
    </div>
  );
}

// ── misc ──
function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2 rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-200"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span className="min-w-0">{children}</span></div>;
}
