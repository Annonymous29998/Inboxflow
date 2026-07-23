import { X } from 'lucide-react';
import { useToastStore, type ToastTone } from '@/stores/toast';
import { cn } from '@/lib/utils';

function toneClass(tone: ToastTone) {
  switch (tone) {
    case 'success':
      return 'border-primary/50 text-primary';
    case 'error':
      return 'border-destructive/50 text-destructive';
    case 'warning':
      return 'border-warning/50 text-warning';
    default:
      return 'border-accent/50 text-accent';
  }
}

function toneLabel(tone: ToastTone) {
  switch (tone) {
    case 'success':
      return 'SUCCESS';
    case 'error':
      return 'ERROR';
    case 'warning':
      return 'WARNING';
    default:
      return 'INFO';
  }
}

export function Toaster() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (!items.length) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-14 right-3 z-[80] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 sm:right-5"
      aria-live="polite"
      aria-relevant="additions"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto animate-fade-in border bg-card px-3 py-2.5 font-mono shadow-xl',
            toneClass(t.tone),
          )}
          role="status"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider opacity-80">[{toneLabel(t.tone)}]</div>
              <div className="mt-0.5 text-sm text-foreground">{t.title}</div>
              {t.description ? (
                <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{t.description}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
