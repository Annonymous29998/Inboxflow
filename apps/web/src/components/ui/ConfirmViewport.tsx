import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Info, Loader2, X } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui';
import { useConfirmStore, type ConfirmTone } from '@/stores/confirm';

const toneIcon = {
  default: Info,
  danger: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
} as Record<string, any>;

const toneColor = {
  default: 'text-muted-foreground',
  danger: 'text-destructive',
  warning: 'text-amber-400',
  info: 'text-sky-400',
  success: 'text-emerald-400',
} as Record<string, string>;

const toneRing = {
  default: 'border-border',
  danger: 'border-destructive/40',
  warning: 'border-amber-500/40',
  info: 'border-sky-500/40',
  success: 'border-emerald-500/40',
} as Record<string, string>;

export function ConfirmViewport() {
  const activeConfirm = useConfirmStore((s) => s.activeConfirm);
  const activePrompt = useConfirmStore((s) => s.activePrompt);
  const closeConfirm = useConfirmStore((s) => s.closeConfirm);
  const closePrompt = useConfirmStore((s) => s.closePrompt);

  return (
    <>
      {activeConfirm && <ConfirmDialog onClose={closeConfirm} />}
      {activePrompt && <PromptDialog onClose={closePrompt} />}
    </>
  );
}

function ConfirmDialog({ onClose }: { onClose: (ok: boolean) => void }) {
  const cfg = useConfirmStore.getState().activeConfirm!;
  const destructive = !!cfg.destructive || cfg.tone === 'danger';
  const tone: ConfirmTone = cfg.tone ?? (destructive ? 'danger' : 'default');
  const Icon = toneIcon[tone] ?? Info;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(false);
      }
      if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('textarea,input,[contenteditable],button[aria-haspopup]')) {
        e.preventDefault();
        handleConfirm();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleConfirm() {
    if (busy) return;
    setBusy(true);
    onClose(true);
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 px-4 font-mono backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={() => onClose(false)} aria-label="Close" />

      <div className={`relative z-10 w-full max-w-md overflow-hidden border ${toneRing[tone]} bg-card text-foreground shadow-2xl`}>
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="flex gap-4">
            <Icon className={`h-5 w-5 flex-none mt-0.5 ${toneColor[tone]}`} />
            <div className="min-w-0">
              <h2 className={`text-base font-semibold uppercase tracking-wide ${destructive ? 'text-destructive' : 'text-accent'}`}>{cfg.title}</h2>
              {cfg.description ? (
                <p className="mt-2 text-sm text-muted-foreground whitespace-pre-line">{cfg.description}</p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onClose(false)}
            className="border border-border p-2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
            disabled={busy}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-border px-6 py-5 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onClose(false)} disabled={busy}>
            {cfg.cancelText ?? 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {cfg.confirmText ?? (destructive ? 'Delete' : 'Confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog({ onClose }: { onClose: (value: string | null) => void }) {
  const cfg = useConfirmStore.getState().activePrompt!;
  const [value, setValue] = useState(cfg.defaultValue ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = value;
    if (cfg.validate) {
      const err = cfg.validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    setBusy(true);
    onClose(trimmed);
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 px-4 font-mono backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={() => onClose(null)} aria-label="Close" />

      <div className="relative z-10 w-full max-w-md overflow-hidden border border-border bg-card text-foreground shadow-2xl">
        <form onSubmit={handleSubmit}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <h2 className="text-base font-semibold uppercase tracking-wide text-accent">{cfg.title}</h2>
              {cfg.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{cfg.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onClose(null)}
              className="border border-border p-2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 px-6 py-5">
            <div>
              {cfg.title.includes('name') || cfg.title.includes('list') || cfg.title.toLowerCase().includes('list') ? null : (
                <Label>{cfg.title}</Label>
              )}
              <Input
                ref={inputRef}
                value={value}
                placeholder={cfg.placeholder}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError('');
                }}
                disabled={busy}
                autoFocus
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <div className="flex flex-col-reverse gap-3 border-t border-border px-6 py-5 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => onClose(null)} disabled={busy}>
              {cfg.cancelText ?? 'Cancel'}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {cfg.confirmText ?? 'Confirm'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
