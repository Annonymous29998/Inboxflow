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

function tabOpenDuringSend(id: MailerTab) {
  return id === 'logs';
}

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
  onPauseSend,
  onResumeSend,
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
    paused?: boolean;
  } | null;
  onOpenLive?: () => void;
  onPauseSend?: () => void;
  onResumeSend?: () => void;
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
          disabled={sending}
          onChange={(e) => onName(e.target.value)}
        />
        {onPlacementTest ? (
          <Button type="button" variant="outline" size="sm" onClick={onPlacementTest} disabled={placementBusy || sending}>
            {placementBusy ? 'Sending…' : 'Placement test'}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onSave} disabled={saving || sending}>
          Save
        </Button>
      </div>
      <div className="mailer-tabs">
        {MAILER_WIZARD.map((t, i) => {
          const locked = Boolean(sending) && !tabOpenDuringSend(t.id);
          return (
            <button
              key={t.id}
              type="button"
              disabled={locked}
              aria-disabled={locked}
              onClick={() => {
                if (locked) return;
                onTab(t.id);
              }}
              className={cn(tab === t.id && 'on', locked && 'off')}
            >
              {i + 1} {t.label}
            </button>
          );
        })}
        {MAILER_EXTRA.map((t) => {
          const locked = Boolean(sending) && !tabOpenDuringSend(t.id);
          return (
            <button
              key={t.id}
              type="button"
              disabled={locked}
              aria-disabled={locked}
              onClick={() => {
                if (locked) return;
                onTab(t.id);
              }}
              className={cn(tab === t.id && 'on', locked && 'off')}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {sending && liveProgress ? (
        <div className="mailer-live">
          <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpenLive}>
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
              {liveProgress.paused
                ? 'paused'
                : liveProgress.lastEmail || liveProgress.stage || 'sending'}
            </span>
          </button>
          {liveProgress.paused && onResumeSend ? (
            <Button type="button" size="sm" variant="outline" onClick={onResumeSend}>
              Resume
            </Button>
          ) : onPauseSend ? (
            <Button type="button" size="sm" variant="outline" onClick={onPauseSend}>
              Pause
            </Button>
          ) : null}
        </div>
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
        className={cn(
          'mailer-fab',
          sending && 'mailer-fab-stop mailer-fab-pulse',
          sending && liveProgress && 'mailer-fab-live',
        )}
        onClick={onSendOrStop}
        aria-label={
          sending && liveProgress
            ? `Stop sending — ${liveProgress.sent + liveProgress.failed} of ${Math.max(liveProgress.total, liveProgress.sent + liveProgress.failed)}`
            : sending
              ? 'Stop sending'
              : alreadySent
                ? 'Resend campaign'
                : 'Send campaign'
        }
      >
        {sending ? (
          <span className="mailer-fab-stack">
            <span>STOP</span>
            {liveProgress ? (
              <span className="mailer-fab-count">
                {liveProgress.sent + liveProgress.failed}/
                {Math.max(liveProgress.total, liveProgress.sent + liveProgress.failed)}
              </span>
            ) : null}
          </span>
        ) : alreadySent ? (
          'RESEND'
        ) : (
          'SEND'
        )}
      </button>
    </div>
  );
}
