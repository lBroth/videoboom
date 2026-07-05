// First-run wizard. Deliberately minimal — only the steps that work today: detect hardware → verdict →
// optional keys → done. The plan's storage / runtime-install / calibrate steps depend on LOCAL_PLAN M3/M5
// infra that isn't built yet, so they're omitted rather than faked. Keyless is the primary path: "Skip —
// stay local" finishes the wizard with every stage on-device. Gated by settings.onboarded.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Cloud, KeyRound, Sparkles, Check, ExternalLink } from 'lucide-react';
import { Button, Card, inputCls, cx } from './components/ui';
import logo from './logo.png';

const vb = window.vb;

const KEY_FIELDS: { name: string; label: string; hint: string; url: string }[] = [
  { name: 'openrouter', label: 'OpenRouter', hint: 'unlocks cloud LLM, images & video', url: 'https://openrouter.ai/keys' },
  { name: 'replicate', label: 'Replicate', hint: 'unlocks cloud lyric timing (WhisperX)', url: 'https://replicate.com/account/api-tokens' },
];

function KeyInput({ field, saved, onSaved }: { field: (typeof KEY_FIELDS)[number]; saved: boolean; onSaved: () => void }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!val.trim()) return;
    setBusy(true);
    try { await vb.setKey(field.name, val.trim()); setVal(''); onSaved(); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-white/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-100">{field.label}</span>
        {saved && <span className="text-xs text-emerald-400 inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" />saved</span>}
        <button onClick={() => vb.openExternal(field.url)} className="ml-auto text-xs text-violet-300 hover:text-violet-200 inline-flex items-center gap-1">
          Get a key <ExternalLink className="w-3 h-3" />
        </button>
      </div>
      <div className="text-xs text-slate-500 -mt-1">{field.hint}</div>
      <div className="flex gap-2">
        <input type="password" className={inputCls} placeholder={saved ? '•••••••• (replace)' : `Paste your ${field.label} key`}
          value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <Button onClick={save} disabled={!val.trim() || busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}

const STAGE_LABELS: [string, string][] = [
  ['STT', 'Lyric timing'], ['LLM', 'Story & shots'], ['KEYFRAME', 'Keyframes'], ['VIDEO', 'Video'], ['VLM', 'Face caption'],
];

export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ['localCaps'], queryFn: () => vb.localCapabilities() });
  const keys = useQuery({ queryKey: ['keysStatus'], queryFn: () => vb.keysStatus() });
  const resolved = useQuery({ queryKey: ['resolved'], queryFn: () => vb.resolvedBackends(), enabled: false });
  const [step, setStep] = useState<'welcome' | 'keys' | 'done'>('welcome');
  const [busy, setBusy] = useState(false);

  const supported = caps.data?.supported;
  const refreshKeys = () => { qc.invalidateQueries({ queryKey: ['keysStatus'] }); qc.invalidateQueries({ queryKey: ['resolved'] }); };
  const finish = async () => {
    setBusy(true);
    try { await vb.setSettings({ onboarded: true }); onFinish(); } finally { setBusy(false); }
  };
  const goDone = () => { qc.invalidateQueries({ queryKey: ['resolved'] }); resolved.refetch(); setStep('done'); };

  return (
    <div className="min-h-full flex items-center justify-center p-6 animate-fade-up">
      <Card className="w-full max-w-lg p-6 space-y-5">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="w-10 h-10 rounded-xl shadow-glow" />
          <div>
            <div className="font-extrabold tracking-tight text-lg brand-text">Videoboom</div>
            <div className="text-xs text-slate-500">Turn a song into a music video</div>
          </div>
        </div>

        {step === 'welcome' && (
          <>
            <p className="text-sm text-slate-300">
              Videoboom runs on your Mac by default — <b className="text-slate-100">private, no key, no cost</b>. Add a key
              only to unlock cloud where you want it.
            </p>
            {caps.data && (
              supported ? (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-2.5 text-sm text-emerald-200/90 flex items-start gap-2">
                  <Shield className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>This Mac ({caps.data.ramGB}GB) can run every stage on-device. Models download once, then generation is fully offline.</span>
                </div>
              ) : (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-sm text-amber-200/90 flex items-start gap-2">
                  <Cloud className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>On-device video needs an Apple-Silicon Mac with {caps.data.minRamGB}GB+. This machine can still make videos via <b>Cloud</b> — add an OpenRouter key (and a Replicate key for lyric timing) next.</span>
                </div>
              )
            )}
            <div className="flex flex-col gap-2 pt-1">
              <Button onClick={finish} disabled={busy} className="w-full justify-center">
                <Sparkles className="w-4 h-4" /> Skip — stay local
              </Button>
              <button onClick={() => setStep('keys')} className="text-sm text-slate-400 hover:text-slate-200 inline-flex items-center justify-center gap-1.5 py-1">
                <KeyRound className="w-3.5 h-3.5" /> Add a key (optional)
              </button>
            </div>
          </>
        )}

        {step === 'keys' && (
          <>
            <p className="text-sm text-slate-400">
              Keys are optional and Videoboom works fully without them. They are encrypted with your OS keychain and
              never leave this machine. Saving a key only <i>unlocks</i> cloud — it never switches a stage; you choose
              per stage in Settings.
            </p>
            <div className="space-y-2">
              {KEY_FIELDS.map((f) => (
                <KeyInput key={f.name} field={f} saved={Boolean(keys.data?.[f.name])} onSaved={refreshKeys} />
              ))}
            </div>
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => setStep('welcome')} className="text-sm text-slate-500 hover:text-slate-300">← Back</button>
              <Button onClick={goDone}>Continue</Button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <p className="text-sm text-slate-300">You're set. Here's how each stage will run right now — change any of it any time in Settings.</p>
            <div className="rounded-xl border border-white/10 divide-y divide-white/5">
              {STAGE_LABELS.map(([id, label]) => {
                const rs = resolved.data?.[id as keyof typeof resolved.data];
                const cloud = rs?.backend === 'cloud';
                return (
                  <div key={id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="text-slate-300 flex-1">{label}</span>
                    <span className={cx('inline-flex items-center gap-1 text-xs', cloud ? 'text-sky-300' : 'text-emerald-300')}>
                      {cloud ? <Cloud className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
                      {cloud ? 'Cloud' : 'Local · private'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => setStep('keys')} className="text-sm text-slate-500 hover:text-slate-300">← Back</button>
              <Button onClick={finish} disabled={busy} className="justify-center"><Sparkles className="w-4 h-4" /> Start</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
