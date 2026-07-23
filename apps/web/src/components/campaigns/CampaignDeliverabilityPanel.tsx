import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { runCampaignDeliverabilityChecks, type DeliverabilityCheck } from '@/lib/campaign-deliverability';
import { cn } from '@/lib/utils';

interface CampaignDeliverabilityPanelProps {
  subject: string;
  previewText?: string;
  htmlBody: string;
  recipientCount: number;
  hasActiveSmtp: boolean;
  fromEmail?: string;
}

function CheckRow({ check }: { check: DeliverabilityCheck }) {
  const Icon = check.level === 'pass' ? CheckCircle2 : AlertTriangle;

  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon
        className={cn(
          'h-4 w-4 mt-0.5 shrink-0',
          check.level === 'pass' && 'text-emerald-500',
          check.level === 'warn' && 'text-amber-500',
          check.level === 'fail' && 'text-red-500',
        )}
      />
      <div>
        <p className="font-medium">{check.title}</p>
        <p className="text-xs text-muted-foreground">{check.detail}</p>
      </div>
    </div>
  );
}

export function CampaignDeliverabilityPanel({
  subject,
  previewText,
  htmlBody,
  recipientCount,
  hasActiveSmtp,
  fromEmail,
}: CampaignDeliverabilityPanelProps) {
  const deliverability = useMemo(
    () =>
      runCampaignDeliverabilityChecks({
        subject,
        previewText,
        htmlBody,
        recipientCount,
        hasActiveSmtp,
        fromEmail,
      }),
    [subject, previewText, htmlBody, recipientCount, hasActiveSmtp, fromEmail],
  );

  if (!htmlBody.trim() && !subject.trim()) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Add subject and HTML content to run inbox placement checks.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-emerald-500" />
        <p className="text-sm font-semibold">Inbox placement checks</p>
      </div>

      <div
        className={cn(
          'rounded-lg border px-4 py-3 text-sm',
          deliverability.canSend
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100'
            : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100',
        )}
      >
        {deliverability.canSend
          ? 'Ready to send. These checks reduce spam risk but cannot guarantee inbox placement.'
          : 'Fix the failed checks below before sending.'}
      </div>

      {deliverability.filteredSpamPhrases.length > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Auto-filter will clean: {deliverability.filteredSpamPhrases.slice(0, 4).join(', ')}
          {deliverability.filteredSpamPhrases.length > 4 ? '…' : ''}
        </p>
      ) : null}

      <div className="max-h-[320px] space-y-3 overflow-y-auto rounded-xl border border-border p-4">
        {deliverability.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </div>
    </div>
  );
}

export function useCampaignDeliverability(
  subject: string,
  previewText: string | undefined,
  htmlBody: string,
  recipientCount: number,
  hasActiveSmtp: boolean,
  fromEmail?: string,
) {
  return useMemo(
    () =>
      runCampaignDeliverabilityChecks({
        subject,
        previewText,
        htmlBody,
        recipientCount,
        hasActiveSmtp,
        fromEmail,
      }),
    [subject, previewText, htmlBody, recipientCount, hasActiveSmtp, fromEmail],
  );
}
