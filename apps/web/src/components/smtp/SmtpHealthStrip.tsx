import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { SmtpProfile } from '@/services/smtp.service';

type Props = {
  providers: Array<
    Pick<
      SmtpProfile,
      | 'id'
      | 'name'
      | 'isActive'
      | 'lastTestStatus'
      | 'successRate'
      | 'successCount'
      | 'failCount'
      | 'sentToday'
      | 'dailyLimit'
      | 'fromEmail'
    >
  >;
  /** Compact single-line strip (queue console). */
  compact?: boolean;
  className?: string;
  title?: string;
  manageTo?: string;
  emptyHint?: string;
};

function healthTone(p: Props['providers'][number]) {
  if (!p.isActive) return 'neutral' as const;
  if (p.lastTestStatus === 'Failed') return 'danger' as const;
  const rate = Number(p.successRate ?? 100);
  const fails = Number(p.failCount ?? 0);
  const ok = Number(p.successCount ?? 0);
  if (fails > ok && fails > 0) return 'danger' as const;
  if (rate < 70 && ok + fails >= 5) return 'warning' as const;
  if (p.lastTestStatus === 'Connected' || rate >= 85) return 'success' as const;
  if (p.lastTestStatus === 'Pending') return 'warning' as const;
  return 'neutral' as const;
}

function rateLabel(p: Props['providers'][number]) {
  const ok = Number(p.successCount ?? 0);
  const fail = Number(p.failCount ?? 0);
  const total = ok + fail;
  if (total <= 0) {
    return p.lastTestStatus === 'Connected' ? 'ready' : p.lastTestStatus || 'idle';
  }
  const rate = Math.round(Number(p.successRate ?? (ok / total) * 100));
  return `${rate}% · ${ok}ok/${fail}fail`;
}

/** Live SMTP health strip — read-only; does not change rotation or send path. */
export function SmtpHealthStrip({
  providers,
  compact,
  className,
  title = 'SMTP health',
  manageTo = '/app/smtp',
  emptyHint,
}: Props) {
  const active = providers.filter((p) => p.isActive);
  if (!active.length) {
    return (
      <div className={cn('border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground', className)}>
        {emptyHint || 'No active SMTPs — '}
        {!emptyHint ? (
          <Link to={manageTo} className="text-primary hover:underline">
            open SMTP Manager
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn('border border-border bg-muted/20', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-accent">
          {title} {compact ? '' : '· right now'}
        </span>
        <Link to={manageTo} className="text-[10px] text-primary hover:underline">
          Manage →
        </Link>
      </div>
      <div
        className={cn(
          'flex gap-2 px-2 py-2',
          compact ? 'flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-visible' : 'flex-wrap',
        )}
      >
        {active.map((p) => {
          const tone = healthTone(p);
          return (
            <div
              key={p.id}
              className="min-w-[9.5rem] flex-1 border border-border bg-background px-2.5 py-1.5 sm:flex-none"
              title={p.fromEmail || p.name}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-medium text-foreground">
                  {p.fromEmail || p.name}
                </span>
                <Badge tone={tone} className="shrink-0 text-[9px]">
                  {tone === 'success' ? 'ok' : tone === 'danger' ? 'bad' : tone === 'warning' ? 'warn' : '—'}
                </Badge>
              </div>
              <div className="mt-0.5 truncate text-[10px] tabular-nums text-muted-foreground">
                {rateLabel(p)}
                {` · ${p.successCount ?? p.sentToday ?? 0} total`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function formatSmtpPickLabel(p: {
  name: string;
  isDefault?: boolean;
  type?: string;
  lastTestStatus?: string | null;
  successRate?: number;
  successCount?: number;
  failCount?: number;
}) {
  const ok = Number(p.successCount ?? 0);
  const fail = Number(p.failCount ?? 0);
  const total = ok + fail;
  const rate =
    total > 0 ? Math.round(Number(p.successRate ?? (ok / total) * 100)) : null;
  const bits = [
    p.name,
    p.isDefault ? 'default' : null,
    p.type || null,
    p.lastTestStatus || null,
    rate != null ? `${rate}% ok` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}
