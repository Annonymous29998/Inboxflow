import { useState, type ReactNode } from 'react';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Blue Mailer Setup: collapsed rows, open one section at a time. */
export function MailerFold({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('mailer-fold', open && 'open')}>
      <button type="button" className="mailer-fold-sum" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="mailer-fold-title">{title}</span>
        {meta ? <span className="mailer-fold-meta">{meta}</span> : null}
      </button>
      {open ? <div className="mailer-fold-body">{children}</div> : null}
    </div>
  );
}

export const MAILER_WIZARD = [
  { id: 'setup', label: 'Setup' },
  { id: 'smtp', label: 'SMTP/Proxy' },
  { id: 'recipients', label: 'Recipients' },
  { id: 'placeholder', label: 'Placeholder' },
  { id: 'letter', label: 'Letter' },
] as const;

export const MAILER_EXTRA = [
  { id: 'logs', label: 'Logs' },
  { id: 'results', label: 'Results' },
] as const;

export type MailerTab = (typeof MAILER_WIZARD)[number]['id'] | (typeof MAILER_EXTRA)[number]['id'];

export function MailerWorkspace({
  tab,
  onTab,
  name,
  onName,
  onSave,
  saving,
  sending,
  alreadySent,
  liveProgress,
  onOpenLive,
  onSendOrStop,
  onPlacementTest,
  placementBusy,
  panels,
}: {
  tab: MailerTab;
  onTab: (tab: MailerTab) => void;
  name: string;
  onName: (name: string) => void;
  onSave: () => void;
  saving?: boolean;
  sending?: boolean;
  alreadySent?: boolean;
  liveProgress?: {
    sent: number;
    failed: number;
    pending: number;
    total: number;
    lastEmail?: string | null;
    stage?: string;
  } | null;
  onOpenLive?: () => void;
  onSendOrStop: () => void;
  onPlacementTest?: () => void;
  placementBusy?: boolean;
  panels: Record<MailerTab, ReactNode>;
}) {
  return (
    <div className="mailer-root flex h-full min-h-0 flex-1 flex-col" data-mailer="inboxflow">
      <div className="mailer-top">
        <Input
          value={name}
          placeholder="Name this campaign"
          onChange={(e) => onName(e.target.value)}
        />
        {onPlacementTest ? (
          <Button type="button" variant="outline" size="sm" onClick={onPlacementTest} disabled={placementBusy}>
            {placementBusy ? 'Sending…' : 'Placement test'}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onSave} disabled={saving}>
          Save
        </Button>
      </div>
      <div className="mailer-tabs">
        {MAILER_WIZARD.map((t, i) => (
          <button key={t.id} type="button" onClick={() => onTab(t.id)} className={cn(tab === t.id && 'on')}>
            {i + 1} {t.label}
          </button>
        ))}
        {MAILER_EXTRA.map((t) => (
          <button key={t.id} type="button" onClick={() => onTab(t.id)} className={cn(tab === t.id && 'on')}>
            {t.label}
          </button>
        ))}
      </div>
      {sending && liveProgress ? (
        <button type="button" className="mailer-live" onClick={onOpenLive}>
          <span>
            {liveProgress.sent + liveProgress.failed}/{Math.max(liveProgress.total, liveProgress.sent + liveProgress.failed)}
            {' · '}
            {liveProgress.sent} sent
            {' · '}
            {liveProgress.failed} failed
            {' · '}
            {liveProgress.pending} left
          </span>
          <span>
            {liveProgress.lastEmail || liveProgress.stage || 'sending'}
          </span>
        </button>
      ) : null}
      <div className="mailer-stage">
        {(Object.keys(panels) as MailerTab[]).map((id) => {
          const keepAlive =
            id === tab ||
            ((id === 'letter' || id === 'placeholder') && (tab === 'letter' || tab === 'placeholder'));
          if (!keepAlive) return null;
          const on = tab === id;
          return (
            <div
              key={id}
              className={cn(
                'mailer-panel',
                id === 'letter' || id === 'smtp' || id === 'logs' ? 'overflow-hidden' : 'overflow-auto',
              )}
              style={{ display: on ? undefined : 'none' }}
              aria-hidden={!on}
            >
              {panels[id]}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className={cn('mailer-fab', sending && 'mailer-fab-stop mailer-fab-pulse')}
        onClick={onSendOrStop}
      >
        {sending ? 'STOP' : alreadySent ? 'RESEND' : 'SEND'}
      </button>
    </div>
  );
}
