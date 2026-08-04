import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Film, UserRound, Settings as SettingsIcon, Music, Plus, RotateCcw, Trash2,
  Image as ImageIcon, Wand2, AlertTriangle, CheckCircle2, Download,
  Lock, Shield, Cloud, Cpu, KeyRound, ExternalLink, type LucideIcon,
} from 'lucide-react';
import {
  Button, IconButton, Card, Field, Segmented, ProgressBar, Spinner, StatusDot, EmptyState,
  Img, inputCls, cx, useConfirm,
} from './components/ui';
import type {
  Project, Character, Scene, Settings, SidecarEvent, LocalCapabilities,
  Stage, Backend, StageSelection, CloudModels, ResolvedStage,
} from './vb';
import logo from './logo.png';
import { Onboarding } from './Onboarding';

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
// `warning` is for non-fatal degradations the run recovered from but the user must still know about —
// a failed 1080p upscale silently hands back the 480p render at the end of an hour-long job.
interface RunState { active: boolean; label: string; stage?: string; total?: number; done: number; finished?: boolean; cost?: number; error?: string; warning?: string }
const RenderCtx = createContext<{
  runs: Record<string, RunState>;
  startRender: (pid: string, preview: boolean) => void;
  startResume: (pid: string) => void;
  startRequality: (pid: string) => void;
  startRegen: (pid: string, index: number) => void;
  startStoryboard: (pid: string, regenStory?: boolean) => void;
  startRenderSelected: (pid: string, scenes: number[]) => void;
  startRegenKeyframe: (pid: string, index: number) => void;
}>({ runs: {}, startRender: () => {}, startResume: () => {}, startRequality: () => {}, startRegen: () => {}, startStoryboard: () => {}, startRenderSelected: () => {}, startRegenKeyframe: () => {} });
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
        if (e.event === 'stage') { next.stage = e.stage; if (e.total != null) next.total = e.total; if (e.stage === 'clips' || e.stage === 'keyframes') next.done = 0; }
        else if (e.event === 'scene' || e.event === 'keyframe') next.done = (cur.done || 0) + 1;
        else if (e.event === 'done') { next.finished = true; if (e.costCents != null) next.cost = e.costCents; }
        else if (e.event === 'error') next.error = e.message;
        else if (e.event === 'warn') next.warning = e.message;
        return { ...r, [pid]: next };
      });
      if (e.event === 'scene' || e.event === 'keyframe' || e.event === 'done') { qc.invalidateQueries({ queryKey: ['scenes', pid] }); qc.invalidateQueries({ queryKey: ['projects'] }); }
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
    startStoryboard: (pid: string, regenStory?: boolean) => launch(pid, 'Storyboard', `render:${pid}`, () => vb.buildStoryboard(pid, regenStory)),
    startRenderSelected: (pid: string, scenes: number[]) => launch(pid, `Render ${scenes.length} scene${scenes.length === 1 ? '' : 's'}`, `render:${pid}`, () => vb.renderSelected(pid, scenes)),
    startRegenKeyframe: (pid: string, index: number) => launch(pid, `Keyframe ${index + 1}`, `render:${pid}`, () => vb.regenerateKeyframe(pid, index)),
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

// 'storyboard' is a READY-to-curate state (keyframes done, awaiting the user's scene picks), NOT busy.
const IN_PROGRESS = new Set(['queued', 'storyboarding', 'rendering', 'refresh']);

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
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => vb.getSettings() });
  const qc = useQueryClient();

  // First run (or a migrated blob that never onboarded): show the wizard until it's completed/skipped.
  if (settings.data && !settings.data.onboarded) {
    return <Onboarding onFinish={() => qc.invalidateQueries({ queryKey: ['settings'] })} />;
  }

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
  const { startStoryboard } = useRender();
  const [audio, setAudio] = useState<string>('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'music-video' | 'ad'>('music-video');
  const [style, setStyle] = useState('cinematic photorealistic music video, dramatic lighting, film grade, shallow depth of field');
  const [mode, setMode] = useState<'realistic' | 'toon'>('realistic');
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
      // Fase A: build the storyboard (prompts + a keyframe per scene, no clips) so the user curates it first.
      startStoryboard(projectId);
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
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button variant="primary" size="lg" className="w-full" icon={Sparkles} loading={busy} disabled={!audio} onClick={go}>
          Genera storyboard
        </Button>
        <p className="text-xs text-slate-500 text-center -mt-2">Genera prompt + un'immagine per scena. Poi le modifichi e scegli quali rendere in video.</p>
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
        {run?.warning && !active && (
          <div className="text-xs text-amber-300/90 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{run.warning}</span>
          </div>
        )}
        {run?.finished && !active && (
          <div className="text-xs text-slate-400 flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />Finished{p.scenesFailed ? ` · ${p.scenesFailed} scene(s) failed` : ''}</span>
            {run.cost != null && run.cost > 0 && <CostPill cents={run.cost} />}
          </div>
        )}
        {/* Delete stays outside the `active` gate. A project stuck in an in-progress status used to hide
            every button behind it, including this one, leaving no way to remove it from the app at all. */}
        {active && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={Trash2} onClick={del}>Delete</Button>
          </div>
        )}
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
        {p.status === 'storyboard' && !active &&
          <div className="text-xs text-slate-400">Storyboard pronto — modifica le scene, poi seleziona quali rendere in video.</div>}
        {(editing || p.status === 'storyboard') && !active && <SceneEditor pid={p.id} />}
      </div>
    </Card>
  );
}

// Vertical filmstrip storyboard editor: one row per scene in narrative order. Edit the prompt/motion, re-roll
// the keyframe image, replace it with your own, and check the scenes to render into clips.
function SceneEditor({ pid }: { pid: string }) {
  const { runs, startRenderSelected, startStoryboard } = useRender();
  const scenes = useQuery({ queryKey: ['scenes', pid], queryFn: () => vb.listScenes(pid) });
  const busy = !!runs[pid]?.active;
  const list = scenes.data || [];
  const [sel, setSel] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setSel((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const allOn = list.length > 0 && sel.size === list.length;
  const picks = [...sel].sort((a, b) => a - b);

  if (!list.length) return <div className="text-xs text-slate-500 py-3">Nessuna scena — genera prima lo storyboard.</div>;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <button onClick={() => setSel(allOn ? new Set() : new Set(list.map((s) => s.index)))} className="text-slate-300 hover:text-white hover:underline underline-offset-2">
          {allOn ? 'Deseleziona tutte' : 'Seleziona tutte'}
        </button>
        <span className="text-slate-500">{sel.size}/{list.length} selezionate</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => startStoryboard(pid, true)} title="Rigenera prompt + immagini da capo">Rigenera storyboard</Button>
        <Button size="sm" variant="primary" icon={Film} disabled={busy || !picks.length} onClick={() => startRenderSelected(pid, picks)}>Render selezionate ({picks.length})</Button>
      </div>
      <div className="space-y-2">
        {list.map((s) => <SceneRow key={s.index} pid={pid} s={s} disabled={busy} selected={sel.has(s.index)} onToggle={() => toggle(s.index)} />)}
      </div>
    </div>
  );
}

function SceneRow({ pid, s, disabled, selected, onToggle }: { pid: string; s: Scene; disabled: boolean; selected: boolean; onToggle: () => void }) {
  const { startRegenKeyframe } = useRender();
  const qc = useQueryClient();
  const url = useMedia(`${pid}/keyframes/scene_${s.index}_thumb.jpg`, s.status);
  const [prompt, setPrompt] = useState(s.prompt || '');
  const [motion, setMotion] = useState(s.motion || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setPrompt(s.prompt || ''); setMotion(s.motion || ''); }, [s.prompt, s.motion]);
  const dirty = prompt !== (s.prompt || '') || motion !== (s.motion || '');

  const save = async () => {
    setSaving(true);
    try { await vb.updateScene(pid, s.index, { prompt, motion }); qc.invalidateQueries({ queryKey: ['scenes', pid] }); }
    finally { setSaving(false); }
  };
  const replace = async () => {
    const img = await vb.pickImage();
    if (!img) return;
    setSaving(true);
    try { await vb.setSceneKeyframe(pid, s.index, img); qc.invalidateQueries({ queryKey: ['scenes', pid] }); }
    finally { setSaving(false); }
  };

  return (
    <div className={cx('flex gap-3 rounded-xl border p-2.5 transition-colors', selected ? 'border-violet-400/60 bg-violet-500/[0.07]' : 'border-white/10')}>
      <label className="flex items-start pt-1"><input type="checkbox" checked={selected} onChange={onToggle} disabled={disabled} className="accent-violet-500 w-4 h-4" /></label>
      <div className="relative w-40 shrink-0 aspect-video rounded-lg overflow-hidden border border-white/10 bg-black/40">
        <Img src={url} className="w-full h-full object-cover" alt={`Scene ${s.index + 1}`} />
        <span className="absolute bottom-0.5 left-1 text-[10px] text-white/70">#{s.index + 1}</span>
        {s.status === 'done' && <span className="absolute top-1 right-1"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /></span>}
        {s.status === 'failed' && <span className="absolute top-1 right-1"><AlertTriangle className="w-3.5 h-3.5 text-red-400" /></span>}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200 truncate">{s.title || `Scena ${s.index + 1}`}</span>
          {s.transition && <span className="text-[10px] uppercase tracking-wide text-slate-500">{s.transition}</span>}
          <span className="text-[10px] text-slate-500 capitalize ml-auto">{s.status || 'pending'}</span>
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={disabled} rows={2}
          className={cx(inputCls, 'text-xs resize-y min-h-[2.5rem]')} placeholder="Prompt della scena" />
        <input value={motion} onChange={(e) => setMotion(e.target.value)} disabled={disabled}
          className={cx(inputCls, 'text-xs')} placeholder="Motion (camera + azione)" />
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="soft" icon={RotateCcw} disabled={disabled} onClick={() => startRegenKeyframe(pid, s.index)} title="Rigenera l'immagine (nuovo seed)">Rigenera img</Button>
          <Button size="sm" variant="ghost" icon={ImageIcon} disabled={disabled || saving} onClick={replace}>Sostituisci img</Button>
          <Button size="sm" variant={dirty ? 'primary' : 'ghost'} icon={CheckCircle2} disabled={disabled || saving || !dirty} onClick={save} loading={saving}>Salva prompt</Button>
        </div>
      </div>
    </div>
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

// ── Settings (hybrid: local-default, opt into cloud per stage) ──
// The renderer NEVER decides a backend — it renders resolvedBackends() (settings:resolved IPC). Everything is
// local until a key is saved AND a stage is opted into cloud. See DUAL_BACKEND_PLAN.md §7.

const PROVIDER_LABEL: Record<'openrouter' | 'replicate', string> = { openrouter: 'OpenRouter', replicate: 'Replicate' };

// The five render stages (order per §7). `provider` is the key that gates Cloud (STT = Replicate; rest =
// OpenRouter). `model`/`size` drive the on-device download affordance shown when a stage resolves local.
const STAGE_ROWS: { id: Stage; label: string; provider: 'openrouter' | 'replicate'; model: string; size: string }[] = [
  { id: 'STT', label: 'Lyric timing', provider: 'replicate', model: 'whisper · mlx', size: '~1.6 GB' },
  { id: 'LLM', label: 'Story & shot-list', provider: 'openrouter', model: 'Qwen3 · mlx-lm', size: '~19 GB' },
  { id: 'VLM', label: 'Face caption + safety', provider: 'openrouter', model: 'gemma-3 · mlx-vlm', size: '~8 GB' },
  { id: 'KEYFRAME', label: 'Keyframe images', provider: 'openrouter', model: 'FLUX · mflux', size: '~9.6 GB' },
  { id: 'VIDEO', label: 'Video (image→video)', provider: 'openrouter', model: 'Wan 2.2 · mlx-video', size: '~54 GB' },
];

const KEY_FIELDS: { name: 'openrouter' | 'replicate'; label: string; hint: string; url: string }[] = [
  { name: 'openrouter', label: 'OpenRouter', hint: 'unlocks cloud LLM, images & video.', url: 'https://openrouter.ai/keys' },
  { name: 'replicate', label: 'Replicate', hint: 'unlocks cloud lyric timing (WhisperX).', url: 'https://replicate.com/account/api-tokens' },
];

const MODEL_FIELDS: { key: keyof CloudModels; label: string }[] = [
  { key: 'storyModel', label: 'Story model' },
  { key: 'llmModel', label: 'Shot-list model' },
  { key: 'keyframeModel', label: 'Keyframe model' },
  { key: 'videoModel', label: 'Video model' },
  { key: 'vlmModel', label: 'Caption (VLM) model' },
  { key: 'moderationModel', label: 'Moderation model' },
];

// Fast/Quality are two SPEEDS of the same Wan 14B (x16 VAE — holds detail + character identity). Both finish
// at 1080p (the shot renders at 480p on-device, then interpolates + upscales). FastWan-5B was retired (its
// x64 VAE deformed people).
const VIDEO_MODES: { key: 'fast' | 'hd'; title: string; sub: string }[] = [
  { key: 'fast', title: 'Fast', sub: 'Wan 14B · Lightning 4-step + tiny-VAE · ~2 min/clip' },
  { key: 'hd', title: 'Quality', sub: 'Wan 14B · 6-step + official VAE · +25% detail · ~1.5x slower' },
];

// Cost estimate pill — cloud-only. An all-local render never emits costCents, so this is simply never shown.
function CostPill({ cents }: { cents: number }) {
  return (
    <span title="Estimate — billed by your providers" className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 border border-sky-400/25 px-2 py-0.5 text-xs text-sky-200">
      {`≈ $${(cents / 100).toFixed(2)} · cloud stages`}
    </span>
  );
}

// Compact tri-state segmented control (Auto · Local · Cloud). A segment can be disabled (Cloud without a key)
// — this is what makes local-default structural: Cloud is literally unclickable until the key step.
function StageSegment({ options, value, onChange }: {
  options: { key: string; label: string; icon?: LucideIcon; disabled?: boolean; title?: string }[];
  value: string; onChange: (k: string) => void;
}) {
  return (
    <div role="radiogroup" className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-0.5 gap-0.5 shrink-0">
      {options.map((o) => {
        const active = value === o.key;
        const Icon = o.icon;
        return (
          <button key={o.key} type="button" role="radio" aria-checked={active} disabled={o.disabled} title={o.title}
            onClick={() => onChange(o.key)}
            className={cx('inline-flex items-center gap-1 h-8 px-3 rounded-lg text-xs font-semibold transition-colors',
              active ? 'bg-violet-500/20 text-violet-100 shadow-inner ring-1 ring-violet-400/50'
                : 'text-slate-400 hover:text-slate-200',
              o.disabled && 'opacity-40 cursor-not-allowed hover:text-slate-400')}>
            {Icon && <Icon className="w-3 h-3" />}{o.label}
          </button>
        );
      })}
    </div>
  );
}

// The resolver's verdict for a stage, rendered verbatim (never recomputed here). `auto` prefixes "Auto →".
function ResolvedBadge({ rs, provLabel, auto }: { rs: ResolvedStage; provLabel: string; auto: boolean }) {
  const local = rs.backend === 'local';
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {auto && <span className="text-slate-500">Auto →</span>}
      <span className={cx('inline-flex items-center gap-1', local ? 'text-emerald-300/90' : 'text-sky-300/90')}>
        {local ? <Shield className="w-3.5 h-3.5" /> : <Cloud className="w-3.5 h-3.5" />}
        {local ? 'Local · private' : `Cloud · ${provLabel} · leaves this Mac`}
      </span>
    </div>
  );
}

// On-device download affordance for a stage that resolved local (reuses the model-status query + download
// stream). Renders nothing once the weights are on disk; a cloud-resolved stage never mounts this.
function ModelDownload({ stage, model, size }: { stage: string; model: string; size: string }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['modelStatus'], queryFn: () => vb.modelsStatus() });
  const [dl, setDl] = useState<{ pct: number } | null>(null);
  const [err, setErr] = useState('');
  const ready = status.data?.[stage] === 'ready';

  const startDownload = () => {
    setErr('');
    setDl({ pct: 0 });
    const off = vb.onDownload(stage, (e) => {
      if (e.event === 'progress') setDl({ pct: e.pct ?? 0 });
      else if (e.event === 'error') { setErr(e.error || 'download failed'); setDl(null); off(); }
      else if (e.event === 'done' || e.event === 'closed') { setDl(null); off(); qc.invalidateQueries({ queryKey: ['modelStatus'] }); }
    });
    vb.downloadModel(stage).catch((e) => { setErr(String(e?.message || e)); setDl(null); off(); });
  };

  if (ready) return null;   // installed — the Local badge already tells the story
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500">{model} · {size}</span>
      {dl ? (
        <div className="flex items-center gap-2 w-44">
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-violet-400 transition-all" style={{ width: `${dl.pct}%` }} /></div>
          <span className="text-xs text-slate-400 tabular-nums w-8 text-right">{dl.pct.toFixed(0)}%</span>
          <button onClick={() => vb.cancelDownload(stage)} className="text-xs text-slate-500 hover:text-slate-300">cancel</button>
        </div>
      ) : (
        <button onClick={startDownload} className="text-xs inline-flex items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-500/10 px-2.5 py-1 text-violet-200 hover:bg-violet-500/20">
          <Download className="w-3.5 h-3.5" /> Download
        </button>
      )}
      {err && <span className="text-xs text-red-300">{err}</span>}
    </div>
  );
}

// Fast/Quality selector — shown inline on the VIDEO row only when it resolves local.
function VideoQuality({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  const mode: 'fast' | 'hd' = settings.localQuality === 'hd' ? 'hd' : 'fast';
  return (
    <div className="grid grid-cols-2 gap-2 pt-1">
      {VIDEO_MODES.map((v) => (
        <button key={v.key} onClick={() => patch({ localQuality: v.key })}
          className={cx('rounded-lg border px-3 py-2 text-left transition-colors',
            mode === v.key ? 'border-violet-400/60 bg-violet-500/10 text-slate-100' : 'border-white/10 hover:bg-white/[0.03] text-slate-300')}>
          <div className="text-sm font-medium">{v.title}</div><div className="text-xs text-slate-500">{v.sub}</div>
        </button>
      ))}
    </div>
  );
}

// One stage row: tri-state Auto·Local·Cloud (Cloud key-gated) + the resolver's resolved badge + a download
// affordance / video-quality / cloud-video note, gated on how the stage actually resolved.
function StageBackendRow({ row, settings, keys, resolved, engineState, patch }: {
  row: (typeof STAGE_ROWS)[number];
  settings: Settings; keys: Record<string, boolean>;
  resolved?: Record<Stage, ResolvedStage>; engineState?: EngineStateValue; patch: (p: Partial<Settings>) => void;
}) {
  const { id, label, provider, model, size } = row;
  const sel = settings.stages[id];
  const triValue = sel.mode === 'auto' ? 'auto' : (sel.backend === 'cloud' ? 'cloud' : 'local');
  const rs = resolved?.[id];
  const keyed = !!keys[provider];
  const provLabel = PROVIDER_LABEL[provider];

  const setStage = (v: string) => {
    const next: StageSelection = v === 'auto' ? { mode: 'auto' } : { mode: 'manual', backend: v as Backend };
    patch({ stages: { ...settings.stages, [id]: next } });
  };

  const options = [
    { key: 'auto', label: 'Auto' },
    { key: 'local', label: 'Local' },
    { key: 'cloud', label: 'Cloud', icon: keyed ? undefined : Lock, disabled: !keyed, title: keyed ? undefined : `Add your ${provLabel} key below` },
  ];

  const localResolved = rs?.backend === 'local';
  return (
    <div className="py-3 border-t border-white/5 first:border-t-0 space-y-2">
      <div className="flex items-center gap-3">
        <div className="text-sm text-slate-200 flex-1 min-w-0">{label}</div>
        <StageSegment options={options} value={triValue} onChange={setStage} />
      </div>
      {rs && <ResolvedBadge rs={rs} provLabel={provLabel} auto={sel.mode === 'auto'} />}
      {/* on-device video needs an Apple-Silicon Mac; a local-resolved-but-unrunnable stage says so (never silent cloud) */}
      {localResolved && !rs?.localAvailable && (
        <div className="text-xs text-amber-200/80">Not runnable on this Mac — add your {provLabel} key below, then pick Cloud.</div>
      )}
      {/* You can't download a model before the engine exists — gate the per-stage Download behind Install (§7). */}
      {localResolved && rs?.localAvailable && (engineState === 'not-bootstrapped'
        ? <div className="text-xs text-slate-400">Set up the on-device engine (below) to download this model.</div>
        : <ModelDownload stage={id} model={model} size={size} />)}
      {id === 'VIDEO' && localResolved && <VideoQuality settings={settings} patch={patch} />}
      {id === 'VIDEO' && rs?.backend === 'cloud' && (
        <div className="text-xs text-slate-500">Cloud video: Kling · 1280×720</div>
      )}
    </div>
  );
}

// Master control: Auto · Prefer local · Prefer cloud. Prefer-cloud with no key still runs everything local.
function BackendModeControl({ value, anyKey, onChange }: {
  value: Settings['backendPreference']; anyKey: boolean; onChange: (v: Settings['backendPreference']) => void;
}) {
  return (
    <div>
      <Segmented label="Backend mode" value={value} onChange={onChange} columns={3} options={[
        { value: 'auto', title: 'Auto', desc: 'local by default' },
        { value: 'prefer-local', title: 'Prefer local', desc: 'always on-device' },
        { value: 'prefer-cloud', title: 'Prefer cloud', desc: 'cloud where keyed' },
      ]} />
      {value === 'prefer-cloud' && !anyKey && (
        <div className="mt-2 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-200/90">
          No keys yet — everything still runs locally.
        </div>
      )}
    </div>
  );
}

// The tri-state the resolver/guard expose (vb.engineState()); the renderer only reads it, never computes it.
type EngineStateValue = 'unsupported' | 'not-bootstrapped' | 'partial' | 'ready';

// ── On-device engine bootstrap (drives the M3g backend) ───────────────────────────────────────────────
// Friendly labels for the bootstrap phase stream (python→venv→deps→harden→verify).
const ENGINE_PHASE_LABEL: Record<string, string> = {
  python: 'Installing Python…',
  venv: 'Creating environment…',
  deps: 'Installing model runtime…',
  harden: 'Signing for macOS…',
  verify: 'Verifying…',
};
// Each phase's [start%, span%] slice of one smooth overall bar (deps dominates; the only phase with sub-pct).
const ENGINE_PHASE_WEIGHT: Record<string, [number, number]> = {
  python: [0, 8], venv: [8, 4], deps: [12, 68], harden: [80, 12], verify: [92, 8],
};

// The one-time "install the on-device engine" affordance: uv-managed CPython + the MLX runtime, all under
// userData. Drives vb.startBootstrap()/onBootstrap; on {done} it invalidates engineState/modelStatus/
// bootstrapStatus so the surrounding UI advances Install → Download → Render. The caller gates it on
// engineState==='not-bootstrapped'; `compact` trims chrome for the onboarding step.
export function EngineSetup({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [run, setRun] = useState<{ phase: string; pct?: number } | null>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { offRef.current?.(); }, []);   // drop the stream listener on unmount

  const install = () => {
    setErr(''); setDone(false); setRun({ phase: 'python' });
    let settled = false;
    const off = vb.onBootstrap((e) => {
      if (settled) return;
      if (e.event === 'phase' && e.phase) setRun({ phase: e.phase, pct: e.phase === 'deps' ? 0 : undefined });
      else if (e.event === 'progress') setRun((r) => ({ phase: e.phase || r?.phase || 'deps', pct: e.pct }));
      else if (e.event === 'error') {
        settled = true; off();
        const where = e.phase && ENGINE_PHASE_LABEL[e.phase] ? ENGINE_PHASE_LABEL[e.phase].replace('…', '') : '';
        setErr(where ? `${where} failed — ${e.error || 'unknown error'}` : (e.error || 'Install failed.'));
        setRun(null);
      } else if (e.event === 'done') {
        settled = true; off(); setRun(null); setDone(true);
        ['engineState', 'modelStatus', 'bootstrapStatus', 'localCaps', 'resolved'].forEach((q) => qc.invalidateQueries({ queryKey: [q] }));
      }
    });
    offRef.current = off;
    vb.startBootstrap().catch((e2) => {
      if (settled) return;
      settled = true; off(); setErr(String(e2?.message || e2)); setRun(null);
    });
  };

  const cancel = () => { vb.cancelBootstrap(); offRef.current?.(); setRun(null); };

  const [start, span] = run ? (ENGINE_PHASE_WEIGHT[run.phase] || [0, 0]) : [0, 0];
  const overall = run ? (start + span * (run.phase === 'deps' ? (run.pct ?? 0) / 100 : 0)) / 100 : 0;

  return (
    <div className={cx('rounded-xl border border-violet-400/30 bg-violet-500/[0.07] space-y-3', compact ? 'p-3' : 'p-4')}>
      {!compact && (
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-violet-300" />
          <span className="text-sm font-semibold text-slate-100">Install the on-device engine</span>
        </div>
      )}
      <p className="text-xs text-slate-400">
        Sets up the local AI runtime so everything renders on this Mac — no key, no cloud.{' '}
        <span className="text-slate-300">~500 MB · a few minutes, one time.</span>
      </p>
      {done ? (
        <div className="flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="w-4 h-4" /> On-device engine ready.</div>
      ) : run ? (
        <div className="space-y-2">
          <ProgressBar progress={overall} message={ENGINE_PHASE_LABEL[run.phase] || 'Setting up…'} />
          <button onClick={cancel} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
        </div>
      ) : (
        <Button variant="primary" size="sm" icon={Download} onClick={install}>Install</Button>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
    </div>
  );
}

// On-device (Hardware) — never gated on a key. sttLang / workers / localWanDir are on-device knobs a keyless
// user must reach; an unsupported verdict nudges toward Cloud but disables nothing.
function HardwareCard({ settings, caps, engineState, patch }: {
  settings: Settings; caps: LocalCapabilities; engineState?: EngineStateValue; patch: (p: Partial<Settings>) => void;
}) {
  // 'not-bootstrapped' is exactly "supported but no venv" — track the live query so the card advances on {done}
  // (caps.depsInstalled is the fallback while engineState is still loading).
  const notBootstrapped = engineState ? engineState === 'not-bootstrapped' : (caps.supported && !caps.depsInstalled);
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Cpu className="w-5 h-5 text-violet-300" /><h2 className="font-semibold text-slate-100">On-device</h2>
        <span className="text-xs text-slate-500 ml-auto">{caps.ramGB}GB unified memory</span>
      </div>
      {!caps.supported ? (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-sm text-amber-200/90">
          On-device video needs an <b>Apple-Silicon Mac with {caps.minRamGB} GB+</b>. This machine can make videos via Cloud — add an OpenRouter key below (and a Replicate key for lyric timing).
        </div>
      ) : notBootstrapped ? (
        <EngineSetup />
      ) : (
        <p className="text-sm text-slate-400 -mt-1">Local stages run on this Mac (MLX) — no key, no cloud, fully offline. Video needs ~24GB free at peak; {caps.recommendedRamGB}GB memory recommended.</p>
      )}
      <Field label="Lyrics language" hint="blank = auto-detect">
        <input className={inputCls} defaultValue={settings.sttLang} placeholder="it, en, es…"
          onBlur={(e) => patch({ sttLang: e.target.value.trim() })} />
      </Field>
      <Field label="Render workers" hint="parallel scenes (local video is GPU-serialized to 1)">
        <input type="number" min={1} max={16} className={cx(inputCls, 'max-w-28')} defaultValue={settings.workers}
          onBlur={(e) => { const n = parseInt(e.target.value, 10); patch({ workers: Number.isFinite(n) && n > 0 ? n : settings.workers }); }} />
      </Field>
      <Field label="Local Wan folder" hint="blank = default (local/.model-path)">
        <input className={inputCls} defaultValue={settings.localWanDir} placeholder="/path/to/wan/weights"
          onBlur={(e) => patch({ localWanDir: e.target.value.trim() })} />
      </Field>
    </Card>
  );
}

// One key row: password input + Save. Saving only un-greys the Cloud segments — it never flips a stage (I2).
function KeyRow({ field, saved, onSaved }: {
  field: (typeof KEY_FIELDS)[number]; saved: boolean; onSaved: () => void;
}) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!val.trim()) return;
    setBusy(true); setErr('');
    try { await vb.setKey(field.name, val.trim()); setVal(''); onSaved(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-200">{field.label}</span>
        {saved && <span className="text-xs text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />Saved</span>}
        <button onClick={() => vb.openExternal(field.url)} className="ml-auto text-xs text-violet-300 hover:text-violet-200 inline-flex items-center gap-1">
          Get a key <ExternalLink className="w-3 h-3" />
        </button>
      </div>
      <div className="flex gap-2">
        <input type="password" className={inputCls} value={val} onChange={(e) => setVal(e.target.value)}
          placeholder={saved ? 'Saved — enter a new key to replace' : `Paste your ${field.label} key`} />
        <Button variant="soft" loading={busy} disabled={!val.trim()} onClick={save}>Save</Button>
      </div>
      <div className="text-xs text-slate-500">{field.hint}</div>
      {err && <div className="text-xs text-red-300">{err}</div>}
    </div>
  );
}

// Advanced — cloud model slugs. Cloud-only, so it only renders when ≥1 key is present (nothing to configure otherwise).
function AdvancedCard({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }) {
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <SettingsIcon className="w-5 h-5 text-violet-300" /><h2 className="font-semibold text-slate-100">Advanced · cloud models</h2>
      </div>
      <p className="text-sm text-slate-400 -mt-2">Provider slugs for the cloud stages. Leave as-is unless you know a better model.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        {MODEL_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <input className={inputCls} defaultValue={settings.cloud[f.key]}
              onBlur={(e) => patch({ cloud: { ...settings.cloud, [f.key]: e.target.value.trim() || settings.cloud[f.key] } })} />
          </Field>
        ))}
      </div>
    </Card>
  );
}

function SettingsScreen() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => vb.getSettings() });
  const caps = useQuery({ queryKey: ['localCaps'], queryFn: () => vb.localCapabilities() });
  const keys = useQuery({ queryKey: ['keysStatus'], queryFn: () => vb.keysStatus() });
  const resolved = useQuery({ queryKey: ['resolved'], queryFn: () => vb.resolvedBackends() });
  const engine = useQuery({ queryKey: ['engineState'], queryFn: () => vb.engineState() });
  const [dataDir, setDataDir] = useState('');
  useEffect(() => { vb.dataDir().then(setDataDir); }, []);

  // Every settings write can change what the resolver returns → invalidate both queries.
  const patch = useCallback((p: Partial<Settings>) => {
    vb.setSettings(p).then(() => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['resolved'] });
    });
  }, [qc]);
  // Saving/removing a key re-greys/un-greys Cloud segments and can change resolution.
  const onKeyChanged = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['keysStatus'] });
    qc.invalidateQueries({ queryKey: ['resolved'] });
  }, [qc]);

  const s = settings.data;
  const caps_ = caps.data;
  if (!s || !caps_) return <div className="max-w-2xl animate-fade-up"><Card className="p-8 grid place-items-center"><Spinner className="w-6 h-6" /></Card></div>;

  const k = keys.data || {};
  const anyKey = Object.values(k).some(Boolean);

  return (
    <div className="space-y-5 animate-fade-up max-w-2xl">
      <p className="text-sm text-slate-400">
        Videoboom runs on your Mac by default — private, no key, no cost. Add a key only to unlock cloud where you want it.
      </p>

      <Card className="p-5">
        <BackendModeControl value={s.backendPreference} anyKey={anyKey} onChange={(v) => patch({ backendPreference: v })} />
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <Film className="w-5 h-5 text-violet-300" /><h2 className="font-semibold text-slate-100">Stages</h2>
          <span className="text-xs text-slate-500 ml-auto">where each step runs</span>
        </div>
        {STAGE_ROWS.map((row) => (
          <StageBackendRow key={row.id} row={row} settings={s} keys={k} resolved={resolved.data} engineState={engine.data} patch={patch} />
        ))}
      </Card>

      <HardwareCard settings={s} caps={caps_} engineState={engine.data} patch={patch} />

      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-violet-300" /><h2 className="font-semibold text-slate-100">API keys</h2>
          <span className="text-xs text-slate-500 ml-auto">optional</span>
        </div>
        <p className="text-sm text-slate-400 -mt-2">
          Add a key to unlock cloud for any stage. Videoboom works fully without keys. Keys are encrypted with your OS keychain and never leave this machine.
        </p>
        {KEY_FIELDS.map((f) => <KeyRow key={f.name} field={f} saved={!!k[f.name]} onSaved={onKeyChanged} />)}
      </Card>

      {anyKey && <AdvancedCard settings={s} patch={patch} />}

      <Card className="p-4 text-xs text-slate-500">Projects are stored in <span className="text-slate-300 break-all">{dataDir}</span></Card>
    </div>
  );
}

// ── misc ──
function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2 rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-200"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span className="min-w-0">{children}</span></div>;
}
