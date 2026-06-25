/* Reusable UI kit — single source of truth for styles. Accessible, responsive, animated. */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Clock, Loader2, type LucideIcon } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

/* ── Img — loads a light thumbnail; falls back to the full image if the thumb is missing (old data) ── */
export function Img({ src, fallback, ...rest }:
  { src?: string | null; fallback?: string | null } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const [failed, setFailed] = useState(false);
  const use = (failed && fallback) ? fallback : (src || fallback || '');
  return <img {...rest} src={use || undefined} loading="lazy" decoding="async"
    onError={() => { if (!failed && fallback && fallback !== src) setFailed(true); }} />;
}

/* ── Spinner ──────────────────────────────────────────────────────────── */
export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 aria-hidden className={cx('animate-spin', className)} />;
}

/* ── Button ───────────────────────────────────────────────────────────── */
type Variant = 'primary' | 'soft' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const BTN_BASE =
  'relative inline-flex items-center justify-center gap-2 font-semibold rounded-2xl select-none ' +
  'transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap';
const BTN_SIZE: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-[15px]',
};
const BTN_VARIANT: Record<Variant, string> = {
  primary: 'text-white brand-gradient shadow-glow hover:brightness-110',
  soft: 'text-slate-100 bg-white/[0.08] hover:bg-white/[0.14] border border-white/10',
  ghost: 'text-slate-300 hover:text-white hover:bg-white/[0.07]',
  danger: 'text-red-200 bg-red-500/15 hover:bg-red-500/25 border border-red-500/25',
};

export function Button({
  variant = 'soft', size = 'md', icon: Icon, loading, children, className, type = 'button', ...rest
}: {
  variant?: Variant; size?: Size; icon?: LucideIcon; loading?: boolean; children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <motion.button
      type={type} whileTap={{ scale: 0.97 }} transition={{ duration: 0.12 }}
      className={cx(BTN_BASE, BTN_SIZE[size], BTN_VARIANT[variant], className)}
      aria-busy={loading || undefined} {...(rest as Record<string, unknown>)}
    >
      {loading ? <Spinner className="w-4 h-4" /> : Icon ? <Icon aria-hidden className="w-[18px] h-[18px]" /> : null}
      {children}
    </motion.button>
  );
}

/* ── IconButton (square, needs a label) ───────────────────────────────── */
export function IconButton({
  icon: Icon, label, variant = 'ghost', size = 'md', className, ...rest
}: {
  icon: LucideIcon; label: string; variant?: Variant; size?: Size;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const box = size === 'sm' ? 'h-9 w-9' : 'h-11 w-11';
  return (
    <motion.button
      type="button" whileTap={{ scale: 0.94 }} aria-label={label} title={label}
      className={cx('inline-grid place-items-center rounded-xl transition-colors disabled:opacity-50', box, BTN_VARIANT[variant], className)}
      {...(rest as Record<string, unknown>)}
    >
      <Icon aria-hidden className="w-[18px] h-[18px]" />
    </motion.button>
  );
}

/* ── Card ─────────────────────────────────────────────────────────────── */
export function Card({ className, children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('rounded-4xl border border-white/10 bg-white/[0.035] shadow-card backdrop-blur-sm', className)} {...rest}>
      {children}
    </div>
  );
}

/* ── Field (label + control) ──────────────────────────────────────────── */
export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wider text-slate-400 mb-2">
        {label}{hint && <span className="font-normal normal-case tracking-normal text-slate-500">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export const inputCls =
  'w-full h-11 bg-white/5 border border-white/10 rounded-2xl px-3.5 text-[15px] text-slate-100 ' +
  'placeholder:text-slate-500 outline-none transition focus:border-violet-400/70 focus:bg-white/[0.07]';

/* ── Segmented control (accessible radiogroup of option cards) ─────────── */
export function Segmented<T extends string>({
  label, value, onChange, options, columns = 2,
}: {
  label: string; value: T; onChange: (v: T) => void;
  options: { value: T; title: string; desc?: string; icon?: LucideIcon }[]; columns?: 2 | 3;
}) {
  return (
    <Field label={label}>
      <div role="radiogroup" aria-label={label} className={cx('grid gap-2.5', columns === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
        {options.map((o) => {
          const active = value === o.value;
          const Icon = o.icon;
          return (
            <motion.button
              key={o.value} type="button" role="radio" aria-checked={active} whileTap={{ scale: 0.98 }}
              onClick={() => onChange(o.value)}
              className={cx(
                'rounded-2xl border-2 p-3 text-left transition-colors min-h-[3.5rem]',
                active ? 'border-violet-400/80 bg-violet-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]',
              )}
            >
              <div className="flex items-center gap-2">
                {Icon && <Icon aria-hidden className={cx('w-[18px] h-[18px]', active ? 'text-violet-300' : 'text-slate-400')} />}
                <span className="text-sm font-semibold text-slate-100">{o.title}</span>
              </div>
              {o.desc && <div className="text-[12px] leading-snug text-slate-400 mt-1">{o.desc}</div>}
            </motion.button>
          );
        })}
      </div>
    </Field>
  );
}

/* ── ProgressBar ──────────────────────────────────────────────────────── */
export function ProgressBar({ progress, message, className = '' }: { progress: number; message?: ReactNode; className?: string }) {
  const pct = Math.max(0, Math.min(100, progress * 100));
  return (
    <div className={className}>
      <div className="flex justify-between items-center gap-2 text-[13px] text-slate-300 mb-1.5">
        <span className="truncate flex items-center gap-2 min-w-0"><Spinner className="w-3.5 h-3.5 shrink-0" />{message || 'Working…'}</span>
        <span className="tabular-nums text-slate-400 shrink-0">{Math.round(pct)}%</span>
      </div>
      <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
        <motion.div
          className="h-full rounded-full brand-gradient bg-[length:200%_100%] animate-shimmer"
          initial={false} animate={{ width: `${Math.max(4, pct)}%` }} transition={{ ease: 'easeOut', duration: 0.5 }}
        />
      </div>
    </div>
  );
}

/* ── Badges ───────────────────────────────────────────────────────────── */
// the wallet is denominated in SECONDS of video; format as "m:ss" everywhere (the clock pill below).
export function fmtClock(sec?: number) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// crisp clock glyph (matches the icon weight of the kit). Re-exported as ClockIcon for bare-icon uses.
export function ClockIcon({ className }: { className?: string }) {
  return <Clock aria-hidden className={cx('block shrink-0 text-amber-300/85', className)} />;
}

// video-time pill (wallet seconds as "m:ss"). `approx` prefixes a "~": preview/resume/refresh estimates
// are trued up to the EXACT rendered time and the surplus refunded; full-song prices are exact (no "~").
// `leading-none` + items-center keeps the ~, icon and number on one optical line.
export function TimePill({ n, approx = false }: { n: number; approx?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-[13px] leading-none text-amber-300/90 tabular-nums shrink-0"
      title={approx ? "Estimate — you're charged the exact time rendered; the rest is refunded" : 'Video time'}>
      {approx && <span aria-hidden className="-mr-0.5 text-amber-300/80">~</span>}
      <ClockIcon className="w-[15px] h-[15px]" />
      <span>{fmtClock(n)}</span>
    </span>
  );
}

export function StatusDot({ tone }: { tone: 'done' | 'busy' | 'failed' | 'idle' }) {
  const c = tone === 'done' ? 'bg-emerald-400' : tone === 'busy' ? 'bg-amber-400 animate-pulse' : tone === 'failed' ? 'bg-red-400' : 'bg-slate-500';
  return <span aria-hidden className={cx('inline-block w-2 h-2 rounded-full', c)} />;
}

/* ── EmptyState ───────────────────────────────────────────────────────── */
export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="rounded-4xl border border-dashed border-white/12 px-6 py-12 text-center">
      <div className="mx-auto mb-3 grid place-items-center w-12 h-12 rounded-2xl bg-white/5 text-slate-400">
        <Icon aria-hidden className="w-6 h-6" />
      </div>
      <div className="font-semibold text-slate-200">{title}</div>
      {children && <div className="text-sm text-slate-400 mt-1">{children}</div>}
    </div>
  );
}

/* ── ConfirmDialog (imperative, replaces window.confirm) ──────────────── */
type ConfirmOpts = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {state && (
          <motion.div
            className="fixed inset-0 z-50 grid place-items-end sm:place-items-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => close(false)} role="dialog" aria-modal="true" aria-label={state.title}
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ y: 24, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 24, opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className="w-full sm:max-w-sm rounded-4xl border border-white/12 bg-[#0d111c] p-5 shadow-glow-lg"
            >
              <div className="text-base font-semibold text-slate-100">{state.title}</div>
              {state.body && <div className="text-sm text-slate-400 mt-1.5">{state.body}</div>}
              <div className="flex gap-2.5 mt-5">
                <Button variant="ghost" className="flex-1" onClick={() => close(false)} autoFocus>Cancel</Button>
                <Button variant={state.danger ? 'danger' : 'primary'} className="flex-1" onClick={() => close(true)}>
                  {state.confirmLabel || 'Confirm'}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmCtx.Provider>
  );
}
