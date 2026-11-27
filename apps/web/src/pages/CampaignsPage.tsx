import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { recipientLogDetail } from '@/lib/smtp-log-label';
import { campaignSendService, type SendActivity, type SendStatus } from '@/services/campaign-send.service';
import { isGeneratedSenderName, parseFromIdentities, senderListLabel, smtpService } from '@/services/smtp.service';
import { templateHtmlToBlocks, templateService, type EmailTemplateSummary } from '@/services/template.service';
import {
  useCampaignDeliverability,
} from '@/components/campaigns/CampaignDeliverabilityPanel';
import { scrubCampaignEditorContent } from '@/lib/spam-content-filter';
import { uiCacheGet, uiCacheInvalidateCampaigns, uiCacheSet } from '@/lib/ui-cache';
import { Button, Card, Input, Label, PageLoading, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { SendFlowPhase } from '@/components/campaigns/SendProgressModal';
import { CampaignAudiencePane } from '@/components/campaigns/CampaignAudiencePane';
import { CampaignResultsPane } from '@/components/campaigns/CampaignResultsPane';
import { AttachmentsPane } from '@/components/campaigns/AttachmentsPane';
import { SendConsole } from '@/components/campaigns/SendConsole';
import { LetterPane } from '@/components/campaigns/LetterPane';
import { PlaceholderPane } from '@/components/campaigns/LetterMergePanel';
import { MailerFold, MailerWorkspace, type MailerTab } from '@/components/campaigns/MailerWorkspace';
import { MailerWelcome } from '@/components/campaigns/MailerWelcome';
import {
  isWorkspaceOnDeviceError,
  reportWorkspaceOnDevice,
  WORKSPACE_ON_DEVICE_COPY,
} from '@/lib/workspace-on-device';
import { CampaignAddSmtpModal } from '@/components/campaigns/CampaignAddSmtpModal';
import { CampaignImportRecipientsModal } from '@/components/campaigns/CampaignImportRecipientsModal';
import { CampaignLetterImportModal } from '@/components/campaigns/CampaignLetterImportModal';
import { isMailerTenant } from '@/lib/roles';
import { isUnauthorizedError } from '@/lib/startup-auth';
import { activeAttachments, type CampaignAttachment, type PreviewContact } from '@/lib/letter-placeholders';
import { useAuthStore } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { confirmDialog, promptDialog } from '@/stores/confirm';
import { useDraft, useDraftStore } from '@/stores/draft';
import { formatQueueHeartbeat } from '@/lib/queue-heartbeat';
import {
  EMAIL_SEND_BATCH_PAUSE_MS,
  EMAIL_SEND_BATCH_SIZE,
  EMAIL_SEND_BATCH_SIZE_MAX,
  EMAIL_SEND_BATCH_SIZE_MIN,
  EMAIL_SEND_BETWEEN_MS,
  EMAIL_SEND_MAX_PER_HOUR,
  EMAIL_SEND_MAX_PER_MINUTE,
  normalizeBatchSize,
  recommendedQueuePacing,
} from '@/lib/sequential-send';

function isApiSendProvider(p?: { type?: string; viaApiKey?: boolean }) {
  if (!p) return false;
  if (p.viaApiKey) return true;
  return Boolean(p.type && p.type !== 'SMTP');
}

function flash(message: string, tone: 'success' | 'error' | 'warning' | 'info' = 'success') {
  if (!message) return;
  if (tone === 'error') toast.error(message);
  else if (tone === 'warning') toast.warning(message);
  else if (tone === 'info') toast.info(message);
  else toast.success(message);
}

/** Scrub spam phrases from imported / pasted campaign HTML and show a toast if anything changed. */
function scrubImportedHtml(html: string, plainText?: string | null) {
  const scrubbed = scrubCampaignEditorContent({
    subject: '',
    previewText: '',
    htmlContent: html,
    plainTextContent: plainText || undefined,
  });
  if (scrubbed.changed && scrubbed.removed.length) {
    flash(
      `Spam phrases removed on import: ${scrubbed.removed.slice(0, 5).join(', ')}${scrubbed.removed.length > 5 ? '…' : ''}`,
      'info',
    );
  }
  return scrubbed;
}

type ProviderOption = {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  isActive: boolean;
  fromEmail?: string;
  fromName?: string;
  fromIdentities?: Array<{ email: string; name?: string }>;
  label?: string | null;
  user?: string;
  viaApiKey?: boolean;
  lastTestStatus?: string | null;
  issues?: string[];
  successCount?: number;
  failCount?: number;
  successRate?: number;
  sentToday?: number;
  dailyLimit?: number | null;
  host?: string;
  port?: string;
  outboundPath?: string;
  bindIp?: string;
  socksHost?: string;
  socksPort?: string;
  socksUser?: string;
  sshHost?: string;
  sshPort?: string;
  sshUser?: string;
  remoteIp?: string;
};

function smtpIdentities(p?: ProviderOption | null) {
  const listed = parseFromIdentities(p?.fromIdentities)
    .map((s) => ({ email: s.email, name: s.name || '' }))
    .filter((s) => s.email.includes('@'));
  if (listed.length) return listed;
  if (p?.fromEmail) return [{ email: p.fromEmail, name: p.fromName || '' }];
  return [];
}

function smtpProfileTitle(p: ProviderOption) {
  const emails = smtpIdentities(p).map((s) => s.email);
  const label = String(p.label || '').trim();
  if (label && !isGeneratedSenderName(label)) return label;
  if (isGeneratedSenderName(p.name) || isGeneratedSenderName(label)) return senderListLabel(emails) || p.name;
  return p.name || 'SMTP';
}

type Campaign = {
  id: string;
  name: string;
  status: string;
  type: string;
  subject?: string | null;
  previewText?: string | null;
  senderName?: string | null;
  senderEmail?: string | null;
  domainId?: string | null;
  replyTo?: string | null;
  htmlContent?: string | null;
  plainTextContent?: string | null;
  listId?: string | null;
  templateId?: string | null;
  templatePool?: string[] | null;
  providerId?: string | null;
  queueSettings?: {
    batchSize?: number;
    batchPauseMs?: number;
    betweenEmailMs?: number;
    maxPerMinute?: number;
    maxPerHour?: number;
    sendChannel?: 'smtp' | 'api';
    maxFailPercent?: number;
    providerIds?: string[];
  } | null;
  subjectPool?: string[] | null;
  fromNamePool?: string[] | null;
  deliverabilityScore?: number | null;
  inboxReadinessScore?: number | null;
  analysisReport?: DeliverabilityReport | null;
  trackOpens?: boolean;
  trackClicks?: boolean;
  editorJson?: {
    blocks?: EditorBlock[];
    placeholderMap?: Record<string, string>;
    spinPools?: Record<string, string[]>;
    attachments?: CampaignAttachment[];
  } | null;
  sentCount?: number;
  openedCount?: number;
  clickedCount?: number;
  deliveredCount?: number;
  failedCount?: number;
  totalRecipients?: number;
  sentAt?: string | null;
  utmCampaign?: string | null;
};

type DeliverabilityReport = {
  score: number;
  rating: string;
  issues: Array<{
    id: string;
    category: string;
    severity: string;
    title: string;
    explanation: string;
    suggestedFix: string;
  }>;
  inboxReadiness: {
    overall: number;
    breakdown: Record<string, number>;
    recommendations: string[];
  };
  subjectAnalysis?: { score: number; alternatives: string[] };
};

type EditorBlock = {
  id: string;
  type: string;
  content: string;
  props?: Record<string, string>;
};

/** Imported templates are often complete HTML documents — send them as-is, not wrapped again. */
function isFullHtmlDocument(html: string): boolean {
  const trimmed = html.trim();
  return /<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
}

function letterTextMass(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .replace(/unsubscribe/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function letterLooksEmpty(html: string): boolean {
  return letterTextMass(html).length < 8;
}

function blocksToHtml(blocks: EditorBlock[], dark = false): string {
  if (blocks.length === 1 && blocks[0].type === 'html' && isFullHtmlDocument(blocks[0].content)) {
    return blocks[0].content;
  }

  const bg = dark ? '#0f172a' : '#ffffff';
  const fg = dark ? '#e2e8f0' : '#1a1a1a';
  const muted = dark ? '#94a3b8' : '#666666';
  const inner = blocks
    .map((b) => {
      switch (b.type) {
        case 'text':
          return `<p style="margin:0 0 16px;color:${fg};font-size:16px;line-height:1.6">${b.content}</p>`;
        case 'image':
          return `<img src="${b.props?.src || 'https://placehold.co/560x280'}" alt="${b.props?.alt || ''}" style="max-width:100%;height:auto;display:block;margin:0 0 16px" />`;
        case 'button':
          return `<p style="text-align:center;margin:24px 0"><a href="${b.props?.href || '#'}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:600">${b.content || 'Click here'}</a></p>`;
        case 'divider':
          return `<hr style="border:none;border-top:1px solid ${dark ? '#334155' : '#e5e7eb'};margin:24px 0" />`;
        case 'spacer':
          return `<div style="height:${b.props?.height || '24'}px"></div>`;
        case 'social':
          return `<p style="text-align:center;color:${muted};font-size:13px">Follow us · Twitter · LinkedIn · Instagram</p>`;
        case 'columns':
          return `<table width="100%" style="margin:16px 0"><tr><td width="50%" style="padding:8px;vertical-align:top;color:${fg}">${b.content || 'Column 1'}</td><td width="50%" style="padding:8px;vertical-align:top;color:${fg}">${b.props?.col2 || 'Column 2'}</td></tr></table>`;
        case 'video':
          return `<a href="${b.props?.href || '#'}"><img src="${b.props?.src || 'https://placehold.co/560x315/0f766e/fff?text=Watch+Video'}" alt="Video thumbnail" style="max-width:100%;border-radius:8px" /></a>`;
        case 'countdown':
          return `<p style="text-align:center;font-size:28px;font-weight:700;color:${fg};letter-spacing:2px">${b.content || '02 : 14 : 36'}</p>`;
        case 'products':
          return `<table width="100%"><tr><td style="padding:8px;border:1px solid ${dark ? '#334155' : '#e5e7eb'};border-radius:8px;color:${fg}"><strong>${b.content || 'Product name'}</strong><br/><span style="color:${muted}">${b.props?.price || '$49'}</span></td></tr></table>`;
        case 'html':
          return b.content;
        default:
          return '';
      }
    })
    .join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media(max-width:600px){ .email-wrap{ width:100% !important; } }</style></head><body style="margin:0;background:${dark ? '#020617' : '#f4faf8'};padding:24px;font-family:Georgia,serif">
  <div class="email-wrap" style="max-width:600px;margin:0 auto;background:${bg};padding:40px;border-radius:12px">
  ${inner}
  <p style="margin-top:40px;font-size:12px;color:${muted};text-align:center">{{physical_address}}<br/><a href="{{unsubscribe_url}}" style="color:${muted}">Unsubscribe</a></p>
  </div></body></html>`;
}

const CAMPAIGN_PAGE_SIZE = 20;

const RESEND_NAME_SUFFIX = /\s·\sresend(?:\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2})?$/i;

function campaignListTitle(c: { name?: string | null; utmCampaign?: string | null }) {
  const tagged =
    RESEND_NAME_SUFFIX.test(c.name || '') || String(c.utmCampaign || '').startsWith('resend');
  const name = (c.name || '').trim() || 'Name this campaign';
  return { name, tagged };
}

function campaignAlreadySent(status?: string | null) {
  return ['SENT', 'FAILED', 'CANCELLED'].includes(String(status || ''));
}

function campaignSendLive(status?: string | null, sendPhase?: string) {
  if (sendPhase === 'success') return false;
  return status === 'SENDING' || status === 'PAUSED';
}

function campaignListCounts(c: {
  sentCount?: number | null;
  failedCount?: number | null;
  openedCount?: number | null;
  totalRecipients?: number | null;
}) {
  const failed = Math.max(0, Number(c.failedCount) || 0);
  const total = Math.max(0, Number(c.totalRecipients) || 0);
  let sent = Math.max(0, Number(c.sentCount) || 0);
  if (failed > 0 && total > 0 && sent >= total) sent = Math.max(0, total - failed);
  return { sent, failed, opened: Math.max(0, Number(c.openedCount) || 0) };
}

export function CampaignsPage() {
  const cached = uiCacheGet<{ campaigns: Campaign[]; total: number }>('campaigns:1');
  const [campaigns, setCampaigns] = useState<Campaign[]>(() => cached?.campaigns ?? []);
  const [loading, setLoading] = useState(() => !(cached?.campaigns?.length));
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyCreate, setBusyCreate] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(() => cached?.total ?? 0);
  const [workspaceOnDevice, setWorkspaceOnDevice] = useState(false);
  const navigate = useNavigate();
  const pages = Math.max(1, Math.ceil(total / CAMPAIGN_PAGE_SIZE));
  const role = useAuthStore((s) => s.user?.role);
  const showWelcome = isMailerTenant(role) && !loading && total === 0 && campaigns.length === 0;

  async function load(isPoll = false) {
    const attempts = isPoll ? 1 : 3;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const d = await api.get<{ campaigns: Campaign[]; total: number; page: number; limit: number }>(
            `/api/campaigns?page=${page}&limit=${CAMPAIGN_PAGE_SIZE}`,
          );
          setWorkspaceOnDevice(false);
          setCampaigns(d.campaigns);
          setTotal(d.total);
          uiCacheSet(`campaigns:${page}`, { campaigns: d.campaigns, total: d.total });
          const lastPage = Math.max(1, Math.ceil(d.total / (d.limit || CAMPAIGN_PAGE_SIZE)));
          if (page > lastPage) setPage(lastPage);
          return;
        } catch (err) {
          if (isWorkspaceOnDeviceError(err)) {
            setWorkspaceOnDevice(true);
            if (!isPoll) reportWorkspaceOnDevice(err);
            return;
          }
          // Opening the app can refuse the saved login once. The next try succeeds.
          // Do not flash "Unauthorized" while the user stays on Campaigns.
          if (isUnauthorizedError(err)) {
            if (attempt < attempts - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }
            return;
          }
          if (!isPoll) flash(err instanceof Error ? err.message : 'Could not load campaigns', 'error');
          return;
        }
      }
    } finally {
      setLoading(false);
    }
  }

  const listLive = campaigns.some((c) => c.status === 'SENDING' || c.status === 'PAUSED');
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(true), listLive ? 3_000 : 10_000);
    return () => window.clearInterval(id);
  }, [page, listLive]);

  async function createNewDraftCampaign() {
    if (busyCreate) return;
    setBusyCreate(true);
    try {
      const created = await api.post<{ campaign: Campaign }>('/api/campaigns', {
        name: '',
        type: 'REGULAR',
        status: 'DRAFT',
      });
      uiCacheInvalidateCampaigns();
      await load();
      navigate(`/app/campaigns/${created.campaign.id}?tab=setup`);
    } catch (err) {
      if (isWorkspaceOnDeviceError(err)) {
        setWorkspaceOnDevice(true);
        reportWorkspaceOnDevice(err);
        return;
      }
      flash(err instanceof Error ? err.message : 'Failed to create draft campaign', 'error');
    } finally {
      setBusyCreate(false);
    }
  }

  async function deleteCampaign(c: Campaign, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (c.status === 'SENDING') {
      flash('Cancel the send first, then delete this campaign.', 'warning');
      return;
    }
    if (!(await confirmDialog({
      title: `Delete campaign`,
      description: `Permanently delete campaign “${c.name}”?\n\nThis removes every send log, statistic row, and link tied to this campaign and cannot be undone.`,
      tone: 'danger',
      destructive: true,
      confirmText: 'Delete campaign',
    }))) return;
    setDeletingId(c.id);
    try {
      await api.delete(`/api/campaigns/${c.id}`);
      flash(`Deleted “${c.name}”`);
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not delete campaign', 'error');
    } finally {
      setDeletingId(null);
    }
  }

  if (showWelcome) {
    return (
      <MailerWelcome
        busy={busyCreate}
        error={workspaceOnDevice ? WORKSPACE_ON_DEVICE_COPY : null}
        onStart={() => void createNewDraftCampaign()}
      />
    );
  }

  return (
    <div className="h-full min-h-0 space-y-6 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">Open a campaign for Setup · SMTP/Proxy · Recipients · Letter · Logs · Results</p>
        </div>
        <Button className="w-full sm:w-auto" disabled={busyCreate} onClick={() => void createNewDraftCampaign()}>
          <Plus className="h-4 w-4" /> New campaign
        </Button>
      </div>

      <div className="grid gap-3">
        {loading ? (
          <PageLoading label="Loading campaigns…" />
        ) : (
          <>
        {campaigns.map((c) => {
          const title = campaignListTitle(c);
          const counts = campaignListCounts(c);
          return (
          <div key={c.id} className="camp-row">
            <Link to={`/app/campaigns/${c.id}?tab=setup`} className="camp-row-main">
              <strong>
                {title.name}
                {title.tagged ? <span className="camp-tag">resend</span> : null}
              </strong>
              <div className="meta">
                {c.subject || 'No subject'}
                {['SENT', 'SENDING', 'PAUSED'].includes(c.status)
                  ? ` · ${counts.sent} sent · ${counts.failed} failed · ${counts.opened} opened`
                  : ''}
                {` · ${c.status}`}
              </div>
            </Link>
            <div className="camp-row-actions">
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={deletingId === c.id || c.status === 'SENDING'}
                title={c.status === 'SENDING' ? 'Cancel send before deleting' : 'Delete campaign'}
                onClick={(e) => void deleteCampaign(c, e)}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </div>
          </div>
          );
        })}
        {!campaigns.length && (
          <Card className="space-y-3 py-10 text-center">
            <p className="text-ink-muted">{total > 0 ? 'No campaigns on this page.' : 'No campaigns yet.'}</p>
            {total === 0 ? (
            <Button disabled={busyCreate} onClick={() => void createNewDraftCampaign()}>
              <Plus className="h-4 w-4" /> Create your first campaign
            </Button>
            ) : null}
          </Card>
        )}
        {total > 0 ? (
          <Card className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-ink-muted">
              Showing <span className="font-medium text-foreground">{campaigns.length}</span> of{' '}
              <span className="font-medium text-foreground">{total.toLocaleString()}</span> campaign
              {total === 1 ? '' : 's'} · Page{' '}
              <span className="font-medium text-foreground">{Math.min(page, pages)}</span> of{' '}
              <span className="font-medium text-foreground">{pages}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={page <= 1}>
                « First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ‹ Prev
              </Button>
              <div className="hidden items-center gap-1 md:flex">
                {((): number[] => {
                  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
                  const start = page <= 4 ? 1 : page >= pages - 3 ? pages - 6 : page - 3;
                  const out: number[] = [];
                  for (let i = 0; i < 7; i++) {
                    const t = start + i;
                    if (t >= 1 && t <= pages) out.push(t);
                  }
                  return out;
                })().map((target) => (
                  <Button
                    key={target}
                    size="sm"
                    variant={target === page ? 'primary' : 'outline'}
                    onClick={() => setPage(target)}
                  >
                    {target}
                  </Button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
              >
                Next ›
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage(pages)} disabled={page >= pages}>
                Last »
              </Button>
            </div>
          </Card>
        ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function CampaignEditorPage() {
  const { id } = useParams();
  const smtpAllowDirect = useAuthStore((s) => s.user?.smtpAllowDirect !== false);
  const boundPcIp = useAuthStore((s) => String(s.user?.boundIp || '').trim());
  const physicalAddress = useAuthStore((s) => s.user?.organization?.physicalAddress || '');
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const draftKey = `campaign:${id || 'new'}`;
  const defaultCampaign: Partial<Campaign> = {
    name: '',
    type: 'REGULAR',
    subject: '',
    previewText: '',
    senderName: '',
    senderEmail: '',
    providerId: null,
    trackOpens: true,
    trackClicks: true,
  };
  const [campaign, setCampaign] = useDraft<Partial<Campaign>>(`${draftKey}:campaign`, defaultCampaign);
  const [lists, setLists] = useState<Array<{ id: string; name: string; _count?: { members: number } }>>([]);
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [blocks, setBlocks] = useDraft<EditorBlock[]>(`${draftKey}:blocks`, []);
  const [report, setReport] = useState<DeliverabilityReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [sendPhase, setSendPhase] = useState<SendFlowPhase>('confirm');
  const [sendAsResend, setSendAsResend] = useState(false);
  const [busyCreate, setBusyCreate] = useState(false);
  const [fabChoice, setFabChoice] = useState<'send' | 'resend' | 'stop' | null>(null);
  const [resendListId, setResendListId] = useState('');
  const [sendCount, setSendCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [openedCount, setOpenedCount] = useState(0);
  const [clickedCount, setClickedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [recentFailures, setRecentFailures] = useState<Array<{ email: string; error: string }>>([]);
  const [recentSent, setRecentSent] = useState<Array<{ email: string; at?: string | null }>>([]);
  const [sendActivity, setSendActivity] = useState<SendActivity[]>([]);
  const [engagementList, setEngagementList] = useState<NonNullable<SendStatus['engagementList']>>([]);
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [sendCancelled, setSendCancelled] = useState(false);
  const [sendPaused, setSendPaused] = useState(false);
  const [sendError, setSendError] = useState('');
  const defaultQueueSettings = {
    batchSize: EMAIL_SEND_BATCH_SIZE,
    batchPauseMs: EMAIL_SEND_BATCH_PAUSE_MS,
    betweenEmailMs: EMAIL_SEND_BETWEEN_MS,
    maxPerMinute: EMAIL_SEND_MAX_PER_MINUTE,
    maxPerHour: EMAIL_SEND_MAX_PER_HOUR,
    sendChannel: 'smtp' as 'smtp' | 'api',
    providerIds: undefined as string[] | undefined,
    maxFailPercent: 15,
  };
  const [placeholderMap, setPlaceholderMap] = useState<Record<string, string>>({});
  const [spinPools, setSpinPools] = useState<Record<string, string[]>>({});
  const [attachments, setAttachments] = useState<CampaignAttachment[]>([]);
  const [previewContacts, setPreviewContacts] = useState<PreviewContact[]>([]);
  const previewSaveTimer = useRef<number | null>(null);
  const [listCheck, setListCheck] = useState<{
    total: number;
    sendable: number;
    skipped: number;
    samples?: Array<{ email: string; reason: string }>;
  } | null>(null);
  const [checkingList, setCheckingList] = useState(false);
  const [queueStage, setQueueStage] = useState<string>('sending');
  const [pauseUntil, setPauseUntil] = useState<string | null>(null);
  const [batchNumber, setBatchNumber] = useState<number | null>(null);
  const [liveBatchSize, setLiveBatchSize] = useState<number>(EMAIL_SEND_BATCH_SIZE);
  const [queueSettings, setQueueSettings] = useDraft(`${draftKey}:queueSettings`, defaultQueueSettings);
  const [paceNow, setPaceNow] = useState(() => Date.now());

  useEffect(() => {
    setQueueSettings((q) =>
      recommendedQueuePacing({
        ...q,
        sendChannel: q.sendChannel === 'api' ? 'api' : 'smtp',
      }),
    );
  }, [id, isNew, draftKey]);
  useEffect(() => {
    if (campaign.status !== 'SENDING' && campaign.status !== 'PAUSED') return;
    const timer = window.setInterval(() => setPaceNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [campaign.status]);
  const paceLine = useMemo(
    () =>
      formatQueueHeartbeat({
        status: campaign.status || 'DRAFT',
        lastEmail,
        finished: sentCount + failedCount,
        queueStage,
        pauseUntil,
        betweenEmailMs: queueSettings.betweenEmailMs,
        batchNumber,
        queueBatchSize: liveBatchSize,
        now: paceNow,
      }),
    [
      campaign.status,
      lastEmail,
      sentCount,
      failedCount,
      queueStage,
      pauseUntil,
      queueSettings.betweenEmailMs,
      batchNumber,
      liveBatchSize,
      paceNow,
    ],
  );
  const [subjectPoolText, setSubjectPoolText] = useDraft<string>(`${draftKey}:subjectPoolText`, '');
  const [fromNamePoolText, setFromNamePoolText] = useDraft<string>(`${draftKey}:fromNamePoolText`, '');
  const [testMatrixTo, setTestMatrixTo] = useDraft<string>(`${draftKey}:testMatrixTo`, '');
  const [logFilter, setLogFilter] = useState('');
  const [logOldestFirst, setLogOldestFirst] = useState(true);
  const [logClearedAt, setLogClearedAt] = useState('');
  const [smtpOpenId, setSmtpOpenId] = useState<string>('');
  const [smtpModalOpen, setSmtpModalOpen] = useState(false);
  const [recipientsModalOpen, setRecipientsModalOpen] = useState(false);
  const [letterModalOpen, setLetterModalOpen] = useState(false);
  const [testingSmtpId, setTestingSmtpId] = useState<string | null>(null);
  const rawTab = searchParams.get('tab');
  const mailerTab: MailerTab =
    rawTab === 'smtp' ||
    rawTab === 'recipients' ||
    rawTab === 'placeholder' ||
    rawTab === 'letter' ||
    rawTab === 'attachments' ||
    rawTab === 'logs' ||
    rawTab === 'results'
      ? rawTab
      : 'setup';
  function setMailerTab(next: MailerTab) {
    const live = campaignSendLive(campaign.status, sendPhase);
    const tab = live && next !== 'logs' ? 'logs' : next;
    const p = new URLSearchParams(searchParams);
    p.set('tab', tab);
    setSearchParams(p, { replace: true });
  }
  useEffect(() => {
    if (!campaignSendLive(campaign.status, sendPhase)) return;
    if (mailerTab === 'logs') return;
    setMailerTab('logs');
  }, [campaign.status, sendPhase, mailerTab]);
  const [busyPlacementTest, setBusyPlacementTest] = useState(false);
  const [busyTestMatrix, setBusyTestMatrix] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [letterImporting, setLetterImporting] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [hydrated, setHydrated] = useState(isNew);
  const skipAutoSaveRef = useRef(true);
  const templateMenuRef = useRef<HTMLDivElement>(null);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [previewTemplateIndex, setPreviewTemplateIndex] = useState(0);
  const previewTemplateIndexRef = useRef(0);
  const templateStepLockRef = useRef(false);
  const loadedTemplateIdRef = useRef<string | null>(null);
  const letterPreviewSeqRef = useRef(0);
  const [viewingLetterId, setViewingLetterId] = useState<string | null>(null);
  const templateBodiesRef = useRef<
    Record<string, { html: string; plain: string; placeholderMap?: Record<string, string> }>
  >({});
  const [previewFrameKey, setPreviewFrameKey] = useState(0);
  const autoSaveTimerRef = useRef<number | null>(null);
  const sendStreamCancelRef = useRef<{ cancel: () => void } | null>(null);
  const resendStartedRef = useRef(false);
  /** Ignore the previous SENT snapshot until this send/resend is actually queued. */
  const sendProgressArmedRef = useRef(false);
  const fromDraftRef = useRef(new Map<string, Array<{ email: string; name: string }>>());
  const fromSaveTimerRef = useRef(new Map<string, number>());
  const [verifiedDomains, setVerifiedDomains] = useState<Array<{ id: string; domain: string }>>([]);

  function stopSendStream() {
    try { sendStreamCancelRef.current?.cancel(); } catch {}
    sendStreamCancelRef.current = null;
  }

  function parsePool(text: string): string[] {
    return text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function selectedTemplateIds(c: Partial<Campaign> | Campaign): string[] {
    const pool = Array.isArray(c.templatePool) ? c.templatePool.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (pool.length) return [...new Set(pool)];
    return c.templateId ? [c.templateId] : [];
  }

  function campaignLocked(status?: string | null) {
    return status === 'SENDING' || status === 'PAUSED';
  }

  const templatePoolIds = selectedTemplateIds(campaign);
  const activePoolIndex = templatePoolIds.length
    ? Math.min(Math.max(0, previewTemplateIndex), templatePoolIds.length - 1)
    : 0;
  const activeTemplateId = templatePoolIds[activePoolIndex] || campaign.templateId || null;

  const html = useMemo(() => {
    if (!blocks.length) return campaign.htmlContent || '';
    if (blocks.length === 1 && blocks[0].type === 'html') {
      const raw = blocks[0].content;
      if (!letterLooksEmpty(raw) || !campaign.htmlContent || letterLooksEmpty(campaign.htmlContent)) return raw;
    }
    const out = blocksToHtml(blocks, false);
    if (letterLooksEmpty(out) && campaign.htmlContent && !letterLooksEmpty(campaign.htmlContent)) {
      return campaign.htmlContent;
    }
    return out;
  }, [blocks, campaign.htmlContent]);

  function packEditorJson(nextBlocks = blocks) {
    return {
      blocks: nextBlocks,
      placeholderMap,
      spinPools,
      attachments,
    };
  }

  useEffect(() => {
    if (!campaign.listId) {
      setPreviewContacts([]);
      return;
    }
    api
      .get<{ contacts: PreviewContact[] }>(
        `/api/contacts?listId=${encodeURIComponent(campaign.listId)}&limit=80`,
      )
      .then((d) => setPreviewContacts(Array.isArray(d.contacts) ? d.contacts : []))
      .catch(() => setPreviewContacts([]));
  }, [campaign.listId]);

  function updatePreviewContact(next: PreviewContact) {
    setPreviewContacts((list) =>
      list.map((row) => ((row.id && row.id === next.id) || row.email === next.email ? { ...row, ...next } : row)),
    );
    if (!next.id) return;
    if (previewSaveTimer.current) window.clearTimeout(previewSaveTimer.current);
    previewSaveTimer.current = window.setTimeout(() => {
      void api
        .patch(`/api/contacts/${next.id}`, {
          firstName: next.firstName || '',
          lastName: next.lastName || '',
          customData: next.customData || {},
        })
        .catch((err) => {
          flash(err instanceof Error ? err.message : 'Could not save this person', 'error');
        });
    }, 450);
  }

  async function sendMailboxProof(input: { to: string; html: string }) {
    const to = input.to.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      flash('Enter the inbox that should receive this copy', 'warning');
      return;
    }
    const subjectLine = campaign.subject?.trim() || parsePool(subjectPoolText)[0] || '';
    if (!subjectLine) {
      flash('Add a subject on Setup before sending this copy', 'warning');
      setMailerTab('setup');
      return;
    }
    if (!input.html.trim()) {
      flash('The letter is empty', 'warning');
      return;
    }
    try {
      let campaignId = id && !isNew ? id : null;
      if (!campaignSendLive(campaign.status, sendPhase)) {
        const saved = await save(false, { silent: true });
        if (saved) campaignId = saved;
      }
      if (!campaignId) {
        flash('Save the campaign first', 'warning');
        return;
      }
      const result = await campaignSendService.proof(campaignId, {
        to,
        subject: subjectLine,
        html: input.html,
        providerId: pickedSmtpIds[0] || campaign.providerId || undefined,
        attachments: activeAttachments(attachments).map((file) => ({
          filename: file.filename,
          contentType: file.contentType,
          contentBase64: file.contentBase64,
        })),
      });
      setTestMatrixTo(to);
      toast.success('Test copy sent', `Check ${result.fromEmail ? `${result.fromEmail} → ` : ''}${to}`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Test copy failed', 'error');
    }
  }

  const listMemberCount = useMemo(
    () => lists.find((l) => l.id === campaign.listId)?._count?.members ?? 0,
    [lists, campaign.listId],
  );

  const [sendChannel, setSendChannel] = useState<'smtp' | 'api'>('smtp');

  const smtpProviders = useMemo(
    () => providers.filter((p) => p.isActive && !isApiSendProvider(p)),
    [providers],
  );
  const apiProviders = useMemo(
    () => providers.filter((p) => p.isActive && isApiSendProvider(p)),
    [providers],
  );
  const channelProviders = sendChannel === 'api' ? apiProviders : smtpProviders;

  const hasActiveSmtp = useMemo(
    () =>
      sendChannel === 'api'
        ? apiProviders.length > 0
        : smtpProviders.some((p) => p.lastTestStatus === 'Connected') || smtpProviders.length > 0,
    [sendChannel, apiProviders.length, smtpProviders],
  );

  const selectedProvider = useMemo(
    () =>
      campaign.providerId
        ? providers.find((p) => p.id === campaign.providerId)
        : undefined,
    [providers, campaign.providerId],
  );

  useEffect(() => {
    if (campaign.providerId) {
      const pinned = providers.find((p) => p.id === campaign.providerId);
      if (pinned) {
        setSendChannel(isApiSendProvider(pinned) ? 'api' : 'smtp');
        return;
      }
    }
    if (queueSettings.sendChannel === 'api' || queueSettings.sendChannel === 'smtp') {
      setSendChannel(queueSettings.sendChannel);
    }
  }, [campaign.providerId, providers, queueSettings.sendChannel]);

  const smtpFroms = campaign.providerId
    ? smtpIdentities(selectedProvider)
    : channelProviders.flatMap((p) => smtpIdentities(p)).filter((s, i, arr) => {
        const key = s.email.toLowerCase();
        return arr.findIndex((x) => x.email.toLowerCase() === key) === i;
      });
  const pinnedFrom = String(campaign.senderEmail || '').trim();
  const rotateFroms = !pinnedFrom || pinnedFrom === '__rotate__' || pinnedFrom.toLowerCase() === 'rotate';
  const fromName =
    campaign.senderName ||
    smtpFroms.find((s) => s.email.toLowerCase() === pinnedFrom.toLowerCase())?.name ||
    selectedProvider?.fromName ||
    '';
  const apiFromEmails = apiProviders.map((p) => p.fromEmail).filter(Boolean) as string[];
  const fromEmail =
    sendChannel === 'api'
      ? selectedProvider?.fromEmail ||
        (apiFromEmails.length === 1 ? apiFromEmails[0] : '') ||
        campaign.senderEmail ||
        ''
      : campaign.providerId
        ? rotateFroms
          ? smtpFroms[0]?.email || selectedProvider?.fromEmail || ''
          : pinnedFrom || selectedProvider?.fromEmail || ''
        : '';
  const fromLabel =
    sendChannel === 'api'
      ? selectedProvider?.fromEmail
        ? fromName
          ? `${fromName} <${selectedProvider.fromEmail}>`
          : selectedProvider.fromEmail
        : apiFromEmails.length
          ? `Each key’s From · ${apiFromEmails.join(' ↔ ')}`
          : 'Add a sender email when you save the API key in Settings'
      : !campaign.providerId
        ? `Auto-rotate SMTP · ${channelProviders
            .flatMap((p) => {
              const ids = smtpIdentities(p);
              return ids.length ? ids.map((s) => s.email) : [p.fromEmail || smtpProfileTitle(p)];
            })
            .filter(Boolean)
            .join(' ↔ ') || 'all active SMTPs'}`
        : rotateFroms && smtpFroms.length > 1
          ? `Rotate From · ${smtpFroms.map((s) => s.email).join(' ↔ ')}`
          : fromEmail
            ? fromName
              ? `${fromName} <${fromEmail}>`
              : fromEmail
            : fromName || 'Set sender email';

  const deliverability = useCampaignDeliverability(
    campaign.subject || '',
    campaign.previewText || undefined,
    html,
    listMemberCount,
    hasActiveSmtp,
    fromEmail || undefined,
  );

  useEffect(() => {
    api.get<{ lists: Array<{ id: string; name: string; _count?: { members: number } }> }>('/api/lists').then((d) =>
      setLists(d.lists),
    );
    templateService.list().then(setTemplates).catch(console.error);
    smtpService.list().then(setProviders).catch(console.error);
    api
      .get<{ domains: Array<{ id: string; domain: string; status: string }> }>('/api/domains')
      .then((d) => setVerifiedDomains(d.domains.filter((x) => x.status === 'VERIFIED')))
      .catch(console.error);
    if (!isNew && id) {
      setHydrated(false);
      skipAutoSaveRef.current = true;
      api
        .get<{ campaign: Campaign & { queueSettings?: typeof queueSettings } }>(`/api/campaigns/${id}`)
        .then((d) => {
          const tPool = Array.isArray(d.campaign.templatePool)
            ? d.campaign.templatePool.map((x) => String(x || '').trim()).filter(Boolean)
            : [];
          const pool = tPool.length ? tPool : d.campaign.templateId ? [d.campaign.templateId] : [];
          const tid = d.campaign.templateId || pool[0] || null;
          const poolIdx = tid ? pool.indexOf(tid) : 0;
          const idx = poolIdx >= 0 ? poolIdx : 0;
          previewTemplateIndexRef.current = idx;
          setPreviewTemplateIndex(idx);
          setCampaign({
            ...d.campaign,
            templatePool: pool,
            templateId: tid,
          });
          loadedTemplateIdRef.current = tid;
          setViewingLetterId(tid);
          if (tid && d.campaign.htmlContent?.trim()) {
            rememberTemplateBody(tid, d.campaign.htmlContent, d.campaign.plainTextContent || '', false);
          }
          const savedBlocks = d.campaign.editorJson?.blocks;
          setPlaceholderMap(d.campaign.editorJson?.placeholderMap || {});
          setSpinPools(d.campaign.editorJson?.spinPools || {});
          setAttachments(Array.isArray(d.campaign.editorJson?.attachments) ? d.campaign.editorJson.attachments : []);
          if (savedBlocks?.length) {
            setBlocks(savedBlocks);
          } else if (d.campaign.htmlContent?.trim()) {
            setBlocks(templateHtmlToBlocks(d.campaign.htmlContent));
          } else {
            setBlocks([]);
          }
          setPreviewFrameKey((k) => k + 1);
          void Promise.all(
            pool.map((pid) => fetchTemplateBody(pid, false).catch(() => null)),
          );
          if (d.campaign.analysisReport) setReport(d.campaign.analysisReport as DeliverabilityReport);
          setQueueSettings((q) =>
            recommendedQueuePacing({
              ...q,
              ...(d.campaign.queueSettings || {}),
              sendChannel:
                d.campaign.queueSettings?.sendChannel === 'api' ||
                d.campaign.queueSettings?.sendChannel === 'smtp'
                  ? d.campaign.queueSettings.sendChannel
                  : q.sendChannel,
            }),
          );
          const subjects = Array.isArray(d.campaign.subjectPool) ? d.campaign.subjectPool : [];
          const names = Array.isArray(d.campaign.fromNamePool) ? d.campaign.fromNamePool : [];
          setSubjectPoolText(subjects.join('\n'));
          setFromNamePoolText(names.join('\n'));
          setOpenedCount(d.campaign.openedCount ?? 0);
          setClickedCount(d.campaign.clickedCount ?? 0);
          if (d.campaign.status === 'SENDING' || d.campaign.status === 'PAUSED') {
            setMailerTab('logs');
            setSendPaused(d.campaign.status === 'PAUSED');
            setSendPhase('background');
          }
          void campaignSendService
            .getSendStatus(id)
            .then((status) => {
              const n = campaignListCounts(status);
              setSentCount(n.sent);
              setFailedCount(n.failed);
              setPendingCount(status.pendingCount);
              if (status.openedCount != null) setOpenedCount(status.openedCount);
              if (status.clickedCount != null) setClickedCount(status.clickedCount);
              if (status.engagementList) setEngagementList(status.engagementList);
              if (status.totalRecipients > 0) setSendCount(status.totalRecipients);
              if (status.lastEmail) setLastEmail(status.lastEmail);
              if (status.activity?.length) {
                setSendActivity(
                  [...status.activity].sort((a, b) => String(a.at).localeCompare(String(b.at))),
                );
              }
              if (status.status === 'PAUSED') setSendPaused(true);
            })
            .catch(() => undefined);
          setHydrated(true);
          setAutoSaveState('idle');
          window.setTimeout(() => {
            skipAutoSaveRef.current = false;
          }, 400);
        })
        .catch((err) => {
          console.error(err);
          setHydrated(true);
          skipAutoSaveRef.current = false;
        });
    } else {
      setHydrated(true);
      skipAutoSaveRef.current = false;
    }
    resendStartedRef.current = false;
  }, [id, isNew]);

  useEffect(() => {
    if (!hydrated || isNew || !id) return;
    if (searchParams.get('send') !== '1') return;
    const next = new URLSearchParams(searchParams);
    next.delete('send');
    setSearchParams(next, { replace: true });
    void openSendFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, id, isNew]);

  useEffect(() => {
    if (!hydrated || isNew || !id) return;
    if (searchParams.get('resend') !== '1') return;
    if (resendStartedRef.current) return;
    resendStartedRef.current = true;
    setSearchParams({}, { replace: true });
    setSendAsResend(true);
    setResendListId(campaign.listId || '');
    setSendCount(lists.find((l) => l.id === campaign.listId)?._count?.members ?? campaign.totalRecipients ?? 0);
    setSentCount(0);
    setFailedCount(0);
    setRecentFailures([]);
    setRecentSent([]);
    setSendActivity([]);
    setMailerTab('logs');
    if (campaign.status === 'SENDING') {
      sendProgressArmedRef.current = true;
      setSendPhase('background');
      return;
    }
    void confirmBackgroundResend();
  }, [hydrated, id, isNew, searchParams, campaign.status, campaign.totalRecipients, campaign.listId]);

  useEffect(() => {
    if (!hydrated || isNew || !id) return;
    let watch = false;
    try {
      watch =
        sessionStorage.getItem('inboxflow:watchingCampaignId') === id ||
        Boolean((location.state as { watchSend?: boolean } | null)?.watchSend);
    } catch {
      watch = Boolean((location.state as { watchSend?: boolean } | null)?.watchSend);
    }
    if (!watch) return;
    if (campaign.status !== 'SENDING' && campaign.status !== 'PAUSED') return;
    sendProgressArmedRef.current = true;
    setSendAsResend(false);
    setSendPhase('background');
    setMailerTab('logs');
    setSendCount(campaign.totalRecipients ?? 0);
    try {
      sessionStorage.removeItem('inboxflow:watchingCampaignId');
    } catch {
      /* ignore */
    }
    if ((location.state as { watchSend?: boolean } | null)?.watchSend) {
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [hydrated, id, isNew, campaign.status, campaign.totalRecipients, location.state, location.pathname, navigate]);

  useEffect(() => {
    if (!sendAsResend) return;
    const n = lists.find((l) => l.id === resendListId)?._count?.members;
    if (n != null) setSendCount(n);
  }, [sendAsResend, resendListId, lists]);

  function rememberTemplateBody(
    templateId: string,
    html: string,
    plain = '',
    overwrite = true,
    placeholderMapFromTemplate?: Record<string, string>,
    allowEmpty = false,
  ) {
    const tid = String(templateId || '').trim();
    const body = String(html || '').trim();
    if (!tid || (!body && !allowEmpty)) return;
    const prev = templateBodiesRef.current[tid];
    if (!overwrite && prev?.html) return;
    if (!allowEmpty && letterLooksEmpty(body) && prev?.html && !letterLooksEmpty(prev.html)) return;
    templateBodiesRef.current[tid] = {
      html: body,
      plain: String(plain || ''),
      placeholderMap: placeholderMapFromTemplate || prev?.placeholderMap,
    };
  }

  async function fetchTemplateBody(templateId: string, force = false) {
    const tid = String(templateId || '').trim();
    if (!tid) return null;
    if (!force && templateBodiesRef.current[tid]) return templateBodiesRef.current[tid];
    const template = await templateService.get(tid);
    const raw = template.htmlContent?.trim() || '';
    if (!raw) return templateBodiesRef.current[tid] || null;
    const scrubbed = scrubImportedHtml(raw, template.plainText);
    rememberTemplateBody(
      tid,
      scrubbed.htmlContent,
      scrubbed.plainTextContent || template.plainText || '',
      force || !templateBodiesRef.current[tid]?.html,
      template.editorJson?.placeholderMap,
    );
    return templateBodiesRef.current[tid] || null;
  }

  async function persistActiveTemplateEdits(templateId: string | null | undefined, nextBlocks = blocks) {
    const tid = String(templateId || '').trim();
    if (!tid) return;
    if (loadedTemplateIdRef.current && loadedTemplateIdRef.current !== tid) return;
    const listed = templates.find((t) => t.id === tid);
    if (listed?.isPublic) return;
    const htmlForSave = blocksToHtml(nextBlocks, false);
    if (!htmlForSave.trim() || letterLooksEmpty(htmlForSave)) return;
    const plainFromBlocks = nextBlocks
      .filter((b) => b.type === 'text' || b.type === 'button')
      .map((b) => b.content)
      .join('\n\n');
    rememberTemplateBody(tid, htmlForSave, plainFromBlocks);
    try {
      await templateService.update(tid, {
        htmlContent: htmlForSave,
        plainText: plainFromBlocks.trim() ? plainFromBlocks : null,
        editorJson: packEditorJson(nextBlocks),
      });
    } catch {
      /* public / missing templates must not fail campaign save */
    }
  }

  async function loadTemplateIntoEditor(
    templateId: string,
    opts?: { patchCampaign?: boolean; templatePool?: string[]; forceFetch?: boolean },
  ) {
    const body = await fetchTemplateBody(templateId, Boolean(opts?.forceFetch));
    if (!body) {
      flash('That template has no HTML content', 'error');
      return false;
    }
    const rawHtml = body.html || '';

    const nextHtml = rawHtml;
    const plain = body?.plain || '';
    const nextBlocks = templateHtmlToBlocks(nextHtml);
    const pool = [...new Set((opts?.templatePool?.length ? opts.templatePool : selectedTemplateIds({ ...campaign, templateId })).filter(Boolean))];

    loadedTemplateIdRef.current = templateId;
    setViewingLetterId(templateId);
    setBlocks(nextBlocks);
    if (body?.placeholderMap && Object.keys(body.placeholderMap).length) {
      setPlaceholderMap(body.placeholderMap);
    }
    setPreviewFrameKey((k) => k + 1);
    setCampaign((c) => ({
      ...c,
      templateId,
      templatePool: pool,
      htmlContent: nextHtml,
      plainTextContent: plain || c.plainTextContent,
    }));

    if (opts?.patchCampaign && id && !campaignLocked(campaign.status)) {
      await api.patch(`/api/campaigns/${id}`, {
        templateId,
        htmlContent: nextHtml,
        plainTextContent: plain,
        editorJson: packEditorJson(nextBlocks),
        templatePool: pool,
      });
    }

    return true;
  }

  async function stepPoolTemplate(delta: number) {
    const ids = selectedTemplateIds(campaign);
    if (ids.length < 2 || templateLoading || templateStepLockRef.current) return;
    const fromIdx = Math.min(Math.max(0, previewTemplateIndexRef.current), ids.length - 1);
    const toIdx = (fromIdx + delta + ids.length) % ids.length;
    if (toIdx === fromIdx) return;
    const fromId = ids[fromIdx]!;
    const toId = ids[toIdx]!;
    templateStepLockRef.current = true;
    skipAutoSaveRef.current = true;
    previewTemplateIndexRef.current = toIdx;
    setPreviewTemplateIndex(toIdx);
    setTemplateLoading(true);
    try {
      const currentHtml = blocksToHtml(blocks, false);
      if (currentHtml.trim() && loadedTemplateIdRef.current === fromId) {
        rememberTemplateBody(fromId, currentHtml, campaign.plainTextContent || '');
        await persistActiveTemplateEdits(fromId, blocks);
      }
      const cached = templateBodiesRef.current[toId];
      if (cached?.html) {
        loadedTemplateIdRef.current = toId;
        setViewingLetterId(toId);
        const nextBlocks = templateHtmlToBlocks(cached.html);
        setBlocks(nextBlocks);
        setPreviewFrameKey((k) => k + 1);
        setCampaign((c) => ({
          ...c,
          templateId: toId,
          templatePool: ids,
          htmlContent: cached.html,
          plainTextContent: cached.plain || c.plainTextContent,
        }));
        if (id && !campaignLocked(campaign.status)) {
          await api.patch(`/api/campaigns/${id}`, {
            templateId: toId,
            htmlContent: cached.html,
            plainTextContent: cached.plain,
            editorJson: packEditorJson(nextBlocks),
            templatePool: ids,
          });
        }
      } else {
        const ok = await loadTemplateIntoEditor(toId, { patchCampaign: Boolean(id), templatePool: ids, forceFetch: true });
        if (!ok) {
          previewTemplateIndexRef.current = fromIdx;
          setPreviewTemplateIndex(fromIdx);
        }
      }
      const fromHtml = templateBodiesRef.current[fromId]?.html || '';
      const toHtml = templateBodiesRef.current[toId]?.html || '';
      if (fromHtml && toHtml && fromHtml === toHtml) {
        flash('These two templates currently have the same HTML. Uncheck and re-tick them to reload the originals.', 'warning');
      }
    } catch (err) {
      previewTemplateIndexRef.current = fromIdx;
      setPreviewTemplateIndex(fromIdx);
      flash(err instanceof Error ? err.message : 'Could not switch template', 'error');
    } finally {
      templateStepLockRef.current = false;
      setTemplateLoading(false);
      window.setTimeout(() => {
        skipAutoSaveRef.current = false;
      }, 700);
    }
  }

  async function applyTemplate(templateId: string) {
    if (!templateId) {
      setCampaign((c) => ({ ...c, templateId: null }));
      setBlocks([]);
      flash('Template cleared — select one from the list', 'info');
      return;
    }

    setTemplateLoading(true);
    try {
      // New campaign from Templates → Use in campaign: create draft by templateId only.
      // Server loads HTML from DB (avoids 500 when large HTML + editorJson exceeds body limit).
      if (isNew) {
        const created = await api.post<{ campaign: Campaign }>('/api/campaigns', {
          name: String(campaign.name || '').trim(),
          type: campaign.type || 'REGULAR',
          templateId,
          trackOpens: campaign.trackOpens ?? true,
          trackClicks: campaign.trackClicks ?? true,
          status: 'DRAFT',
        });
        const clearDraft = useDraftStore.getState().clearDraft;
        clearDraft(`campaign:new:campaign`);
        clearDraft(`campaign:new:blocks`);
        flash(`Template applied & saved as new draft: ${created.campaign.name}`);
        navigate(`/app/campaigns/${created.campaign.id}`, { replace: true });
        return;
      }

      const pool = [...new Set([...selectedTemplateIds(campaign), templateId])];
      const ok = await loadTemplateIntoEditor(templateId, {
        patchCampaign: true,
        templatePool: pool,
        forceFetch: true,
      });
      if (ok) {
        const idx = pool.indexOf(templateId);
        previewTemplateIndexRef.current = idx >= 0 ? idx : 0;
        setPreviewTemplateIndex(idx >= 0 ? idx : 0);
        const name = templates.find((t) => t.id === templateId)?.name;
        flash(`Loaded template: ${name || 'template'}`);
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not load template', 'error');
    } finally {
      setTemplateLoading(false);
    }
  }

  async function toggleTemplateInPool(templateId: string) {
    const current = selectedTemplateIds(campaign);
    const exists = current.includes(templateId);
    const next = exists ? current.filter((id) => id !== templateId) : [...current, templateId];
    const fromId = current[activePoolIndex] || campaign.templateId || null;

    if (!next.length) {
      setCampaign((c) => ({ ...c, templatePool: [], templateId: null }));
      previewTemplateIndexRef.current = 0;
      setPreviewTemplateIndex(0);
      setBlocks([]);
      if (id && !campaignLocked(campaign.status)) {
        void api.patch(`/api/campaigns/${id}`, { templateId: null, templatePool: [] }).catch(() => {});
      }
      return;
    }

    setCampaign((c) => ({
      ...c,
      templatePool: next,
      templateId: exists ? (next.includes(fromId || '') ? fromId : next[0]) : templateId,
    }));

    if (!exists) {
      if (isNew && next.length === 1) {
        previewTemplateIndexRef.current = 0;
        setPreviewTemplateIndex(0);
        await applyTemplate(templateId);
        return;
      }
      setTemplateLoading(true);
      try {
        if (fromId && fromId !== templateId) await persistActiveTemplateEdits(fromId, blocks);
        const ok = await loadTemplateIntoEditor(templateId, {
          patchCampaign: Boolean(id),
          templatePool: next,
          forceFetch: true,
        });
        if (ok) {
          const idx = Math.max(0, next.indexOf(templateId));
          previewTemplateIndexRef.current = idx;
          setPreviewTemplateIndex(idx);
        }
      } catch (err) {
        flash(err instanceof Error ? err.message : 'Could not load template', 'error');
      } finally {
        setTemplateLoading(false);
      }
      return;
    }

    const nextIdx = Math.min(activePoolIndex, next.length - 1);
    previewTemplateIndexRef.current = Math.max(0, nextIdx);
    setPreviewTemplateIndex(Math.max(0, nextIdx));
    if (fromId === templateId && next[nextIdx]) {
      setTemplateLoading(true);
      try {
        await loadTemplateIntoEditor(next[nextIdx]!, { patchCampaign: Boolean(id), templatePool: next });
      } catch (err) {
        flash(err instanceof Error ? err.message : 'Could not load template', 'error');
      } finally {
        setTemplateLoading(false);
      }
    } else if (id && !campaignLocked(campaign.status)) {
      void api.patch(`/api/campaigns/${id}`, { templatePool: next, templateId: fromId || next[0] || null }).catch(() => {});
    }
  }

  async function selectLetter(templateId: string) {
    if (!templateId) return;
    const current = selectedTemplateIds(campaign);
    if (!current.includes(templateId)) {
      await toggleTemplateInPool(templateId);
      return;
    }
    await previewLetter(templateId, { persist: true, forceFetch: !templateBodiesRef.current[templateId]?.html });
  }

  async function previewLetter(
    templateId: string,
    opts?: { persist?: boolean; forceFetch?: boolean },
  ) {
    if (!templateId) return;
    const seq = ++letterPreviewSeqRef.current;
    const persist = Boolean(opts?.persist);
    const pool = selectedTemplateIds(campaign);
    const fromId = loadedTemplateIdRef.current || campaign.templateId || pool[activePoolIndex] || null;
    const cached = templateBodiesRef.current[templateId];
    const needFetch = Boolean(opts?.forceFetch) || !cached?.html;

    if (fromId === templateId && !needFetch) {
      setViewingLetterId(templateId);
      if (persist && id && !campaignLocked(campaign.status)) {
        await api.patch(`/api/campaigns/${id}`, { templateId, templatePool: pool }).catch(() => {});
      }
      return;
    }

    try {
      if (fromId && fromId !== templateId) {
        const currentHtml = blocksToHtml(blocks, false);
        if (currentHtml.trim()) {
          rememberTemplateBody(fromId, currentHtml, campaign.plainTextContent || '', true, placeholderMap);
        }
        if (persist) await persistActiveTemplateEdits(fromId, blocks);
      }
      if (seq !== letterPreviewSeqRef.current) return;
      const inPool = pool.indexOf(templateId);
      if (inPool >= 0) {
        previewTemplateIndexRef.current = inPool;
        setPreviewTemplateIndex(inPool);
      }
      if (!needFetch && cached?.html) {
        loadedTemplateIdRef.current = templateId;
        setViewingLetterId(templateId);
        const nextBlocks = templateHtmlToBlocks(cached.html);
        setBlocks(nextBlocks);
        if (cached.placeholderMap && Object.keys(cached.placeholderMap).length) {
          setPlaceholderMap(cached.placeholderMap);
        }
        setPreviewFrameKey((k) => k + 1);
        setCampaign((c) => ({
          ...c,
          templateId,
          templatePool: pool,
          htmlContent: cached.html,
          plainTextContent: cached.plain || c.plainTextContent,
        }));
        if (persist && id && !campaignLocked(campaign.status)) {
          await api.patch(`/api/campaigns/${id}`, {
            templateId,
            htmlContent: cached.html,
            plainTextContent: cached.plain,
            editorJson: packEditorJson(nextBlocks),
            templatePool: pool,
          });
        }
        return;
      }
      if (needFetch) setTemplateLoading(true);
      await loadTemplateIntoEditor(templateId, {
        patchCampaign: persist && Boolean(id),
        templatePool: pool,
        forceFetch: needFetch,
      });
    } catch (err) {
      if (seq === letterPreviewSeqRef.current) {
        flash(err instanceof Error ? err.message : 'Could not open letter', 'error');
      }
    } finally {
      if (seq === letterPreviewSeqRef.current) setTemplateLoading(false);
    }
  }

  useEffect(() => {
    if (!templateMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!templateMenuRef.current?.contains(e.target as Node)) setTemplateMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [templateMenuOpen]);

  useEffect(() => {
    const templateId = searchParams.get('template');
    if (!templateId || !isNew) return;
    void applyTemplate(templateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when opening /new?template=
  }, [searchParams, isNew]);

  useEffect(() => () => stopSendStream(), []);

  function addBlock(type: string) {
    setBlocks((b) => [
      ...b,
      {
        id: crypto.randomUUID(),
        type,
        content:
          type === 'text'
            ? 'New text block'
            : type === 'button'
              ? 'Call to action'
              : type === 'html'
                ? '<p>Custom HTML</p>'
                : type === 'products'
                  ? 'Featured product'
                  : '',
        props: type === 'image' ? { src: 'https://placehold.co/560x280/ccfbf1/0f766e', alt: 'Image' } : {},
      },
    ]);
  }

  async function save(andAnalyze = false, opts?: { silent?: boolean; thenSend?: boolean }): Promise<string | null> {
    const silent = opts?.silent === true;
    if (!silent) setSaving(true);
    else setAutoSaveState('saving');
    try {
      const htmlForSave =
        letterLooksEmpty(blocksToHtml(blocks, false)) && campaign.htmlContent?.trim()
          ? campaign.htmlContent
          : blocksToHtml(blocks, false);
      const plainFromBlocks = blocks
        .filter((b) => b.type === 'text' || b.type === 'button')
        .map((b) => b.content)
        .join('\n\n');

      const plainTextContent = plainFromBlocks.trim()
        ? `${plainFromBlocks}\n\nUnsubscribe: {{unsubscribe_url}}`
        : campaign.plainTextContent || undefined;

      const payload = {
        name: campaign.name,
        type: campaign.type,
        subject: campaign.subject,
        previewText: campaign.previewText,
        senderName: campaign.senderName,
        senderEmail: campaign.senderEmail,
        replyTo: campaign.replyTo,
        htmlContent: htmlForSave,
        plainTextContent,
        editorJson: packEditorJson(),
        queueSettings: {
          ...queueSettings,
          batchSize: normalizeBatchSize(queueSettings.batchSize),
          sendChannel,
        },
        providerId: campaign.providerId ?? null,
        listId: campaign.listId || null,
        trackOpens: campaign.trackOpens,
        trackClicks: campaign.trackClicks,
        templateId:
          selectedTemplateIds(campaign)[
            Math.min(Math.max(0, previewTemplateIndexRef.current), Math.max(0, selectedTemplateIds(campaign).length - 1))
          ] ||
          activeTemplateId ||
          selectedTemplateIds(campaign)[0] ||
          null,
        templatePool: selectedTemplateIds(campaign),
        subjectPool: parsePool(subjectPoolText),
        fromNamePool: parsePool(fromNamePoolText),
      };

      let campaignId = id;
      if (isNew) {
        const created = await api.post<{ campaign: Campaign }>('/api/campaigns', {
          name: campaign.name,
          type: campaign.type,
          subject: campaign.subject,
          previewText: campaign.previewText,
          senderName: campaign.senderName,
          senderEmail: campaign.senderEmail,
          listId: campaign.listId,
          providerId: campaign.providerId ?? null,
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
        });
        campaignId = created.campaign.id;
        await api.patch(`/api/campaigns/${campaignId}`, payload);
        navigate(
          opts?.thenSend ? `/app/campaigns/${campaignId}?send=1` : `/app/campaigns/${campaignId}`,
          { replace: true },
        );
      } else {
        if (campaignLocked(campaign.status)) {
          throw new Error('Cannot edit a campaign while it is sending');
        }
        await api.patch(`/api/campaigns/${id}`, payload);
      }

      const poolIds = selectedTemplateIds(campaign);
      const viewedIdx = Math.min(Math.max(0, previewTemplateIndexRef.current), Math.max(0, poolIds.length - 1));
      const saveTemplateId = loadedTemplateIdRef.current || poolIds[viewedIdx] || campaign.templateId || null;
      if (saveTemplateId) {
        await persistActiveTemplateEdits(saveTemplateId, blocks);
      }

      if (andAnalyze && campaignId) {
        const result = await api.post<{ report: DeliverabilityReport }>(`/api/campaigns/${campaignId}/analyze`);
        setReport(result.report);
        if (!silent) {
          flash('Saved');
        }
      } else if (!silent) {
        flash('Saved');
      }

      uiCacheInvalidateCampaigns();

      if (!silent) {
        const savedDraftKey = `campaign:${campaignId || 'new'}`;
        const store = useDraftStore.getState();
        store.setDraft(`${savedDraftKey}:campaign`, {
          ...campaign,
          htmlContent: htmlForSave,
          plainTextContent,
          listId: campaign.listId || null,
          templateId: activeTemplateId || campaign.templateId || null,
          templatePool: selectedTemplateIds(campaign),
          editorJson: packEditorJson(),
          queueSettings,
          subjectPool: parsePool(subjectPoolText),
          fromNamePool: parsePool(fromNamePoolText),
        });
        store.setDraft(`${savedDraftKey}:blocks`, blocks);
        store.setDraft(`${savedDraftKey}:queueSettings`, queueSettings);
        store.setDraft(`${savedDraftKey}:subjectPoolText`, subjectPoolText);
        store.setDraft(`${savedDraftKey}:fromNamePoolText`, fromNamePoolText);
      }

      setAutoSaveState('saved');
      // Prevent the post-save state write from immediately queuing another autosave
      skipAutoSaveRef.current = true;
      window.setTimeout(() => {
        skipAutoSaveRef.current = false;
      }, 600);
      return campaignId || id || null;
    } catch (err) {
      setAutoSaveState('error');
      if (!silent) {
        flash(err instanceof Error ? err.message : 'Save failed', 'error');
      }
      return null;
    } finally {
      if (!silent) setSaving(false);
    }
  }

  // Auto-save list, subject, template, SMTP, HTML, queue — so leave/return restores everything
  useEffect(() => {
    if (!hydrated || isNew || !id) return;
    if (skipAutoSaveRef.current || templateStepLockRef.current) return;
    if (campaignLocked(campaign.status)) {
      setAutoSaveState('dirty');
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = window.setTimeout(() => {
        setAutoSaveState('saving');
        void api
          .patch(`/api/campaigns/${id}`, {
            queueSettings: {
              ...queueSettings,
              batchSize: normalizeBatchSize(queueSettings.batchSize),
            },
          })
          .then(() => setAutoSaveState('saved'))
          .catch(() => setAutoSaveState('error'));
      }, 400);
      return () => {
        if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
      };
    }

    setAutoSaveState('dirty');
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void save(false, { silent: true });
    }, 900);

    return () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hydrated,
    isNew,
    id,
    campaign.name,
    campaign.type,
    campaign.subject,
    campaign.previewText,
    campaign.senderName,
    campaign.senderEmail,
    campaign.listId,
    campaign.templateId,
    campaign.templatePool,
    campaign.providerId,
    campaign.trackOpens,
    campaign.trackClicks,
    blocks,
    queueSettings,
    subjectPoolText,
    fromNamePoolText,
    placeholderMap,
    spinPools,
    attachments,
    campaign.status,
  ]);

  function applyLetterHtml(nextHtml: string, opts?: { allowEmpty?: boolean }) {
    const clean = nextHtml;
    const allowEmpty = Boolean(opts?.allowEmpty);
    if (!allowEmpty && letterLooksEmpty(clean) && !letterLooksEmpty(html)) return;
    const htmlBlock = blocks.find((b) => b.type === 'html');
    if (htmlBlock && (blocks.length === 1 || isFullHtmlDocument(htmlBlock.content))) {
      setBlocks((bs) => bs.map((b) => (b.id === htmlBlock.id ? { ...b, content: clean } : b)));
    } else {
      setBlocks(templateHtmlToBlocks(clean));
    }
    setCampaign((c) => ({ ...c, htmlContent: clean }));
    const tid = loadedTemplateIdRef.current || viewingLetterId;
    if (tid) rememberTemplateBody(tid, clean, campaign.plainTextContent || '', true, placeholderMap, allowEmpty);
  }

  async function importLetterFile(file: File, letterName?: string) {
    const content = await file.text();
    const format = file.name.endsWith('.mjml') ? 'mjml' : 'html';
    const templateName =
      letterName?.trim() || file.name.replace(/\.(html|htm|mjml|txt)$/i, '').trim() || 'Imported letter';
    setLetterImporting(true);
    setImportStatus('Importing…');
    try {
      const result = await templateService.importHtml({
        filename: file.name,
        content,
        format,
        campaignId: isNew ? undefined : id,
        name: campaign.name,
        templateName,
        saveAsTemplate: true,
      });
      const scrubbed = scrubImportedHtml(result.html, result.plainText);
      applyLetterHtml(scrubbed.htmlContent);
      const tid = result.template?.id;
      setCampaign((c) => {
        const pool = tid ? [...new Set([...selectedTemplateIds(c), tid])] : selectedTemplateIds(c);
        return {
          ...c,
          htmlContent: scrubbed.htmlContent,
          plainTextContent: scrubbed.plainTextContent || result.plainText,
          ...(tid ? { templateId: tid, templatePool: pool } : {}),
        };
      });
      if (tid) loadedTemplateIdRef.current = tid;
      try {
        const listed = await templateService.list();
        setTemplates(listed);
      } catch {
        if (result.template) {
          setTemplates((prev) =>
            prev.some((x) => x.id === result.template!.id) ? prev : [result.template!, ...prev],
          );
        }
      }
      setImportStatus('');
      const cleaned = result.removed?.length
        ? ` · cleaned: ${result.removed.slice(0, 5).join(', ')}${result.removed.length > 5 ? '…' : ''}`
        : scrubbed.removed.length
          ? ` · cleaned: ${scrubbed.removed.slice(0, 5).join(', ')}`
          : '';
      flash(`Imported “${templateName}” — saved to Templates${cleaned}`, 'success');
    } catch (err) {
      setImportStatus('');
      flash(err instanceof Error ? err.message : 'Import failed', 'error');
      throw err;
    } finally {
      setLetterImporting(false);
    }
  }

  async function scrubSpam() {
    const scrubbed = scrubCampaignEditorContent({
      subject: campaign.subject || '',
      previewText: campaign.previewText || '',
      htmlContent: html,
      plainTextContent: campaign.plainTextContent || undefined,
    });

    setCampaign((c) => ({
      ...c,
      subject: scrubbed.subject,
      previewText: scrubbed.previewText,
      plainTextContent: scrubbed.plainTextContent,
    }));

    if (scrubbed.htmlContent !== html) {
      setBlocks([{ id: crypto.randomUUID(), type: 'html', content: scrubbed.htmlContent }]);
    }

    flash(
      scrubbed.changed
        ? `Scrubbed spam phrases: ${scrubbed.removed.join(', ') || 'content cleaned'}`
        : 'No spam trigger phrases found',
      'info',
    );

    if (!isNew && id) {
      await api.patch(`/api/campaigns/${id}`, {
        subject: scrubbed.subject,
        previewText: scrubbed.previewText,
        htmlContent: scrubbed.htmlContent,
        plainTextContent: scrubbed.plainTextContent,
      });
    }
  }

  async function applyInboxFriendlyContent() {
    const scrubbed = scrubCampaignEditorContent({
      subject: deliverability.sanitizedSubject,
      previewText: campaign.previewText || '',
      htmlContent: deliverability.sanitizedHtml,
      plainTextContent: campaign.plainTextContent || undefined,
    });

    setCampaign((c) => ({
      ...c,
      subject: scrubbed.subject,
      previewText: scrubbed.previewText,
      plainTextContent: scrubbed.plainTextContent,
    }));

    if (scrubbed.htmlContent !== html) {
      setBlocks([{ id: crypto.randomUUID(), type: 'html', content: scrubbed.htmlContent }]);
    }

    if (!isNew && id) {
      await api.patch(`/api/campaigns/${id}`, {
        subject: scrubbed.subject,
        previewText: scrubbed.previewText,
        htmlContent: scrubbed.htmlContent,
        plainTextContent: scrubbed.plainTextContent,
      });
    }

    return scrubbed;
  }

  async function openSendFlow() {
    const smtpIds = Array.isArray(queueSettings.providerIds)
      ? queueSettings.providerIds
      : campaign.providerId
        ? [campaign.providerId]
        : providers.filter((p) => !isApiSendProvider(p) && p.isActive).map((p) => p.id);
    if (!smtpIds.length) {
      flash('Pick at least one SMTP', 'warning');
      setMailerTab('smtp');
      return;
    }
    const list = lists.find((l) => l.id === campaign.listId);
    const recipients = list?._count?.members ?? 0;
    if (!campaign.listId || recipients < 1) {
      flash('Pick recipients', 'warning');
      setMailerTab('recipients');
      return;
    }
    const subject = campaign.subject?.trim() || parsePool(subjectPoolText)[0] || '';
    if (!subject) {
      flash('Add a subject on Setup', 'warning');
      setMailerTab('setup');
      return;
    }
    const hasHtml =
      Boolean(campaign.htmlContent?.trim()) ||
      Boolean(html?.trim()) ||
      blocks.some((b) => b.type === 'html' || b.type === 'text');
    if (!hasHtml) {
      flash('Add a letter first', 'warning');
      setMailerTab('letter');
      return;
    }
    if (!id || isNew) {
      const saved = await save(false, { silent: true, thenSend: true });
      if (!saved) flash('Save the campaign first', 'warning');
      return;
    }
    try {
      await applyInboxFriendlyContent();
      await save(false, { silent: true });
      setSendCount(recipients);
      setSendAsResend(false);
      setSendPhase('confirm');
      setSentCount(0);
      setFailedCount(0);
      setRecentFailures([]);
      setSendCancelled(false);
      setSendPaused(false);
      setSendError('');
      setMailerTab('logs');
      await confirmBackgroundSend(false);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not prepare send', 'error');
    }
  }

  async function confirmBackgroundSend(force = false) {
    if (!id || isNew) return;

    if (!force) {
      const failures = deliverability.failures;
      const warnings = deliverability.warnings;
      const smtpWarnings = selectedProvider?.issues?.length
        ? selectedProvider.issues
        : [];
      if (failures.length) {
        toast.error(
          'Campaign send blocked — fix deliverability failures first',
          failures.map((f) => `• ${f.title}: ${f.detail}`).join('\n'),
        );
        setSendPhase('confirm');
        return;
      }
      const combinedWarns = Array.from(
        new Set([
          ...warnings.map((w: (typeof warnings)[number]) => `[content] ${w.title}: ${w.detail}`),
          ...smtpWarnings.map((w) => `[smtp] ${w}`),
          ...(selectedProvider?.fromEmail &&
          selectedProvider?.user &&
          (() => {
            const atFrom = selectedProvider.fromEmail.lastIndexOf('@');
            const atUser = selectedProvider.user.lastIndexOf('@');
            if (atFrom < 0 || atUser < 0) return [] as string[];
            const fDom = selectedProvider.fromEmail.slice(atFrom + 1).toLowerCase();
            const uDom = selectedProvider.user.slice(atUser + 1).toLowerCase();
            if (fDom === uDom || fDom.endsWith(`.${uDom}`) || uDom.endsWith(`.${fDom}`)) return [] as string[];
            return [`[smtp] From domain (${fDom}) ≠ SMTP login domain (${uDom}) — this often lands in Spam (fix SPF/DKIM includes or align to the same domain).`];
          })() || []),
        ]),
      );
      if (combinedWarns.length) {
        toast.warning(
          'WARNING — these may send to Spam',
          combinedWarns.slice(0, 12).join('\n') +
            (combinedWarns.length > 12 ? `\n… +${combinedWarns.length - 12} more — use Deliverability panel in editor to inspect.` : ''),
        );
      }
    }

    sendProgressArmedRef.current = false;
    setSendPhase('background');
    setSendCancelled(false);
    setSendPaused(false);
    setSendError('');
    setSentCount(0);
    setFailedCount(0);
    setRecentFailures([]);
    setRecentSent([]);
    setSendActivity([]);
    stopSendStream();
    try {
      sessionStorage.setItem('inboxflow:watchingCampaignId', id);
    } catch {
      /* ignore */
    }

    try {
      const result = await campaignSendService.startBackgroundSend(id, {
        providerId: campaign.providerId,
        // Deliverability issues stay as warnings — do not hard-block the queue.
        force: true,
        queueSettings: {
          ...queueSettings,
          batchSize: normalizeBatchSize(queueSettings.batchSize),
          sendChannel,
        },
      });
      setSendCount(result.totalRecipients || sendCount);
      setLastEmail(null);
      setQueueStage('sending');
      setPauseUntil(null);
      setBatchNumber(null);
      setCampaign((c) => ({ ...c, status: 'SENDING' }));
      sendProgressArmedRef.current = true;
      setMailerTab('logs');
      flash(
        `Campaign queued · ${result.totalRecipients || sendCount} recipients · this campaign only`,
        'info',
      );

      if (result.jobId) {
        sendStreamCancelRef.current = campaignSendService.streamProgress(result.jobId, {
          onUpdate: (u) => {
            const meta = (u.meta as Record<string, unknown>) ?? {};
            const sent = Number(meta.sent ?? u.processed ?? 0);
            const failed = Number(meta.failed ?? 0);
            setSentCount((prev) => Math.max(prev, sent));
            setFailedCount((prev) => Math.max(prev, failed));
            if (typeof meta.lastEmail === 'string' && meta.lastEmail) {
              setLastEmail(meta.lastEmail);
              setRecentSent((prev) => {
                const next = [{ email: meta.lastEmail as string }, ...prev.filter((x) => x.email !== meta.lastEmail)];
                return next.slice(0, 12);
              });
            }
            if (typeof meta.stage === 'string') setQueueStage(meta.stage);
            if (typeof meta.pauseUntil === 'string') setPauseUntil(meta.pauseUntil);
            else if (meta.stage === 'sending' || meta.pauseUntil === null) setPauseUntil(null);
            if (typeof meta.batchNumber === 'number') setBatchNumber(meta.batchNumber);
            if (typeof meta.batchSize === 'number') setLiveBatchSize(normalizeBatchSize(meta.batchSize));
            if (u.total && Number(u.total) > 0) {
              setSendCount((prev) => Math.max(prev, Number(u.total)));
            }
            if (u.status === 'COMPLETED' || u.status === 'CANCELLED' || u.status === 'FAILED') {
              stopSendStream();
              if (u.status === 'FAILED') {
                setSendError(String(u.error || 'Send failed'));
                setSendPhase('error');
                setCampaign((c) => ({ ...c, status: 'FAILED' }));
              } else {
                setSendCancelled(u.status === 'CANCELLED');
                setSendPhase('success');
                setCampaign((c) => ({
                  ...c,
                  status: u.status === 'CANCELLED' ? 'CANCELLED' : 'SENT',
                }));
              }
            }
          },
          onError: () => {
            stopSendStream();
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      setSendError(msg);
      setSendPhase('error');
      flash(msg, 'error');
    }
  }

  async function confirmBackgroundResend() {
    if (!id || isNew) return;
    sendProgressArmedRef.current = false;
    setSendPhase('background');
    setSendCancelled(false);
    setSendPaused(false);
    setSendError('');
    setSentCount(0);
    setFailedCount(0);
    setRecentFailures([]);
    setRecentSent([]);
    setSendActivity([]);
    setLastEmail(null);
    setQueueStage('sending');
    stopSendStream();
    try {
      sessionStorage.setItem('inboxflow:watchingCampaignId', id);
    } catch {
      /* ignore */
    }
    try {
      await save(false);
      if (!resendListId) {
        setSendError('Select an audience list');
        setSendPhase('error');
        flash('Select an audience list', 'warning');
        return;
      }
      const result = await campaignSendService.resend(id, {
        providerId: campaign.providerId,
        force: true,
        listId: resendListId,
        queueSettings: {
          ...queueSettings,
          batchSize: normalizeBatchSize(queueSettings.batchSize),
          sendChannel,
        },
      });
      setSendCount(result.totalRecipients || sendCount);
      setPauseUntil(null);
      setBatchNumber(null);
      const nextId = result.campaignId;
      if (result.merged || !nextId || nextId === id) {
        setCampaign((c) => ({ ...c, status: 'SENDING' }));
        sendProgressArmedRef.current = true;
        setSendPhase('background');
        setMailerTab('logs');
        return;
      }
      try {
        sessionStorage.setItem('inboxflow:watchingCampaignId', nextId);
      } catch {
        /* ignore */
      }
      navigate(`/app/campaigns/${nextId}`, { state: { watchSend: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resend failed';
      setSendError(msg);
      setSendPhase('error');
      flash(msg, 'error');
    }
  }

  async function cloneAsResendDraft() {
    if (!id || isNew) {
      flash('Save this campaign first', 'warning');
      return;
    }
    if (busyCreate) return;
    setBusyCreate(true);
    try {
      const base = (campaign.name || 'Campaign').replace(RESEND_NAME_SUFFIX, '').trim() || 'Campaign';
      let nextId: string | undefined;
      let nextName = `${base} · resend`;
      try {
        const created = await api.post<{ campaign: { id: string; name?: string } }>(
          `/api/campaigns/${id}/duplicate`,
          { asResendDraft: true },
        );
        nextId = created.campaign?.id;
        if (created.campaign?.name) nextName = created.campaign.name;
      } catch (err) {
        const status =
          err && typeof err === 'object' && 'status' in err ? Number((err as { status?: number }).status) : 0;
        if (status && ![404, 405, 501].includes(status)) throw err;
        const htmlForSave =
          letterLooksEmpty(blocksToHtml(blocks, false)) && campaign.htmlContent?.trim()
            ? campaign.htmlContent
            : blocksToHtml(blocks, false);
        const created = await api.post<{ campaign: { id: string; name?: string } }>('/api/campaigns', {
          name: nextName,
          type: campaign.type || 'REGULAR',
          subject: campaign.subject,
          previewText: campaign.previewText,
          senderName: campaign.senderName,
          senderEmail: campaign.senderEmail,
          listId: campaign.listId,
          providerId: campaign.providerId ?? null,
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
          htmlContent: htmlForSave,
          status: 'DRAFT',
        });
        nextId = created.campaign?.id;
        if (nextId) {
          await api.patch(`/api/campaigns/${nextId}`, {
            name: nextName,
            subject: campaign.subject,
            previewText: campaign.previewText,
            senderName: campaign.senderName,
            senderEmail: campaign.senderEmail,
            htmlContent: htmlForSave,
            listId: campaign.listId || null,
            providerId: campaign.providerId ?? null,
            templateId: campaign.templateId || null,
            templatePool: selectedTemplateIds(campaign),
            subjectPool: parsePool(subjectPoolText),
            fromNamePool: parsePool(fromNamePoolText),
            queueSettings,
            editorJson: packEditorJson(),
          });
        }
      }
      if (!nextId) throw new Error('Could not create resend draft');
      uiCacheInvalidateCampaigns();
      setFabChoice(null);
      flash(`${nextName} opened as a new draft`);
      navigate(`/app/campaigns/${nextId}?tab=setup`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not create resend draft', 'error');
    } finally {
      setBusyCreate(false);
    }
  }

  function openResendFlow() {
    if (!id || isNew) return;
    setSendCount(lists.find((l) => l.id === campaign.listId)?._count?.members ?? campaign.totalRecipients ?? 0);
    setResendListId(campaign.listId || '');
    setSendAsResend(true);
    setSendPhase('background');
    setMailerTab('logs');
    setSentCount(0);
    setFailedCount(0);
    setRecentFailures([]);
    setSendCancelled(false);
    setSendPaused(false);
    setSendError('');
    void confirmBackgroundResend();
  }

  function cancelBackgroundSend() {
    void (async () => {
      stopSendStream();
      setSendCancelled(true);
      setSendPaused(false);
      setSendPhase('success');
      if (id && !isNew) {
        try {
          await campaignSendService.cancel(id);
          setCampaign((c) => ({ ...c, status: 'CANCELLED' }));
          setMailerTab('results');
          flash('Sending cancelled', 'warning');
        } catch (err) {
          flash(err instanceof Error ? err.message : 'Cancel failed', 'error');
        }
      }
    })();
  }

  async function pauseBackgroundSend() {
    if (!id || isNew) return;
    try {
      await campaignSendService.pause(id);
      setSendPaused(true);
      setCampaign((c) => ({ ...c, status: 'PAUSED' }));
      flash('Campaign paused', 'warning');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Pause failed', 'error');
      // Unstick modal if campaign already failed/stopped on the server
      try {
        const status = await campaignSendService.getSendStatus(id);
        const n = campaignListCounts(status);
        setSentCount(n.sent);
        setFailedCount(n.failed);
        if (status.openedCount != null) setOpenedCount(status.openedCount);
        if (status.clickedCount != null) setClickedCount(status.clickedCount);
        if (status.engagementList) setEngagementList(status.engagementList);
        if (['FAILED', 'CANCELLED', 'SENT'].includes(status.status)) {
          setSendCancelled(status.status === 'CANCELLED');
          if (status.status === 'FAILED') {
            setSendError('Send stopped on server');
            setSendPhase('error');
          } else {
            setSendPhase('success');
          }
          setCampaign((c) => ({ ...c, status: status.status }));
        }
      } catch {
        /* ignore */
      }
    }
  }

  async function resumeBackgroundSend() {
    if (!id || isNew) return;
    try {
      await campaignSendService.resume(id);
      setSendPaused(false);
      setSendCancelled(false);
      setSendPhase('background');
      setCampaign((c) => ({ ...c, status: 'SENDING' }));
      flash('Campaign resumed', 'success');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Resume failed', 'error');
    }
  }

  async function retryFailedSend() {
    if (!id || isNew) return;
    try {
      const result = await campaignSendService.retryFailed(id);
      setSendPaused(false);
      setSendPhase('background');
      setFailedCount(0);
      setRecentFailures([]);
      setCampaign((c) => ({ ...c, status: 'SENDING' }));
      flash(`Re-queued ${result.retried} failed recipient(s)`, 'success');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Retry failed', 'error');
    }
  }

  async function runPlacementTest() {
    const ticked = allSmtps.filter((p) => pickedSmtpIds.includes(p.id));
    const parts = ticked.map((p) => {
      const n = smtpIdentities(p).length || 1;
      return `${smtpProfileTitle(p)} × ${n} From${n === 1 ? '' : 's'}`;
    });
    const totalTests = ticked.reduce((sum, p) => sum + (smtpIdentities(p).length || 1), 0);
    const asked = await promptDialog('Send placement test?', {
      description:
        `Not a campaign. One message per From on each ticked SMTP, all to one inbox. Live send is still one email per recipient.\n\n${totalTests || 0} test email${totalTests === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
      placeholder: 'you@gmail.com',
      defaultValue: testMatrixTo || 'you@gmail.com',
      confirmText: 'Send placement test',
      validate: (value) => {
        const email = value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid inbox email';
        return null;
      },
    });
    if (!asked) return;
    const to = asked.trim();
    setTestMatrixTo(to);

    const subject =
      campaign.subject?.trim() ||
      parsePool(subjectPoolText)[0] ||
      '';
    if (!subject) {
      flash('Add a campaign subject on Setup before sending a placement test', 'warning');
      setMailerTab('setup');
      return;
    }
    const hasHtml = Boolean(campaign.htmlContent?.trim()) || blocks.some((b) => b.type === 'html' || b.type === 'text');
    if (!hasHtml && !html?.trim()) {
      flash('Import or add an HTML letter first', 'warning');
      setMailerTab('letter');
      return;
    }
    if (!pickedSmtpIds.length && !campaign.providerId) {
      flash('Select at least one SMTP on SMTP/Proxy', 'warning');
      setMailerTab('smtp');
      return;
    }
    try {
      setBusyPlacementTest(true);
      let campaignId = id && !isNew ? id : null;
      if (!campaignSendLive(campaign.status, sendPhase)) {
        const saved = await save(false, { silent: true });
        if (saved) campaignId = saved;
      }
      if (!campaignId) {
        flash('Save the campaign first', 'warning');
        return;
      }
      const fromNames = parsePool(fromNamePoolText);
      if (campaign.senderName?.trim()) fromNames.unshift(campaign.senderName.trim());
      const uniqueFrom = [...new Set(fromNames.map((n) => n.trim()).filter(Boolean))];
      const poolIds = selectedTemplateIds(campaign);
      const viewedIdx = Math.min(Math.max(0, previewTemplateIndexRef.current), Math.max(0, poolIds.length - 1));
      const viewedId = poolIds[viewedIdx];
      const sendHtml = blocksToHtml(blocks, false);
      const htmlByTemplateId =
        viewedId && sendHtml.trim() ? { [viewedId]: sendHtml } : undefined;
      const result = await campaignSendService.testMatrix(campaignId, {
        to,
        subjects: [subject],
        fromNames: uniqueFrom.length ? [uniqueFrom[0]] : undefined,
        noSubjectPrefix: true,
        templateIds: viewedId ? [viewedId] : poolIds.length ? [poolIds[0]!] : undefined,
        htmlByTemplateId,
        allFromIdentities: true,
        providerIds: pickedSmtpIds,
      });
      const now = new Date().toISOString();
      const logRows: SendActivity[] = (result.results || []).map((r) => ({
        email: to,
        status: r.success ? 'SENT' : 'FAILED',
        error: r.success
          ? `placement · ${r.fromEmail || result.fromEmail || 'from'} · ${r.providerHost || r.providerName || result.providerHost || result.providerName || 'SMTP'}`
          : r.error || 'Placement test failed',
        at: now,
      }));
      if (logRows.length) {
        setSendActivity((prev) => [...logRows, ...prev]);
      }
      setMailerTab('logs');
      if (result.sent > 0) {
        const ok = result.results.filter((r) => r.success);
        const names = [...new Set(ok.map((r) => r.templateName).filter(Boolean))];
        const froms = [...new Set(ok.map((r) => r.fromEmail).filter(Boolean))];
        toast.success(
          `Placement: ${result.sent}/${result.total} via ${result.providerHost || result.providerName || 'SMTP'}`,
          `From ${froms.join(', ') || result.fromEmail || 'unknown'} → ${to}${names.length ? ` · ${names.join(', ')}` : ''}. Check Inbox, Promotions, and Spam.`,
        );
        const failed = result.results.filter((r) => !r.success);
        if (failed.length) {
          flash(
            `${failed.length} From(s) not accepted: ${failed.map((f) => f.error || f.templateName || 'send failed').join(' · ')}`,
            'warning',
          );
        }
      } else {
        const err = result.results?.[0]?.error || 'Send failed — SMTP did not accept the message';
        flash(
          `${err}${result.providerHost ? ` (via ${result.providerHost})` : ''}`,
          'error',
        );
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Placement test failed', 'error');
    } finally {
      setBusyPlacementTest(false);
    }
  }

  async function runTestMatrix() {
    if (!id || isNew) return;
    const to = testMatrixTo.trim();
    if (!to) {
      flash('Enter a test recipient email', 'warning');
      return;
    }
    const subjects = parsePool(subjectPoolText);
    if (campaign.subject?.trim()) subjects.unshift(campaign.subject.trim());
    const uniqueSubjects = [...new Set(subjects)].slice(0, 8);
    if (!uniqueSubjects.length) {
      flash('Add at least one subject', 'warning');
      return;
    }
    const fromNames = parsePool(fromNamePoolText);
    if (campaign.senderName?.trim()) fromNames.unshift(campaign.senderName.trim());
    try {
      setBusyTestMatrix(true);
      await save(false);
      const result = await campaignSendService.testMatrix(id, {
        to,
        subjects: uniqueSubjects,
        fromNames: fromNames.length ? [...new Set(fromNames)].slice(0, 8) : undefined,
      });
      flash(
        `Test matrix: ${result.sent}/${result.total} sent`,
        result.success ? 'success' : 'warning',
      );
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Test matrix failed', 'error');
    } finally {
      setBusyTestMatrix(false);
    }
  }

  async function exportCampaignConfig() {
    if (!id || isNew) return;
    try {
      const data = await campaignSendService.exportConfig(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `campaign-${id}-config.json`;
      a.click();
      URL.revokeObjectURL(url);
      flash('Campaign config exported');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Export failed', 'error');
    }
  }

  useEffect(() => {
    if (!id || isNew) return;
    const live = campaign.status === 'SENDING' || campaign.status === 'PAUSED';
    if (!live && mailerTab !== 'logs' && mailerTab !== 'results') {
      return;
    }

    const sub = campaignSendService.streamSendStatus(id, {
      onUpdate: (status) => {
        const n = campaignListCounts(status);
        setSentCount(n.sent);
        setFailedCount(n.failed);
        setPendingCount(status.pendingCount);
        if (status.openedCount != null) setOpenedCount(status.openedCount);
        if (status.clickedCount != null) setClickedCount(status.clickedCount);
        if (status.engagementList) setEngagementList(status.engagementList);
        if (status.recentFailures) setRecentFailures(status.recentFailures);
        if (status.recentSent) setRecentSent(status.recentSent);
        const activity = status.activity;
        if (activity?.length) {
          setSendActivity((prev) => {
            const incoming = [...activity].sort((a, b) => String(a.at).localeCompare(String(b.at)));
            if (!prev.length || incoming.length >= prev.length) return incoming;
            const key = (a: SendActivity) => `${a.email}|${a.at}|${a.status}`;
            const map = new Map(prev.map((a) => [key(a), a]));
            for (const a of incoming) map.set(key(a), a);
            return [...map.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
          });
        }
        if (status.lastEmail) setLastEmail(status.lastEmail);
        setQueueStage(status.queueStage || 'sending');
        setPauseUntil(status.pauseUntil ?? null);
        if (status.batchNumber != null) setBatchNumber(status.batchNumber);
        if (status.queueBatchSize != null) setLiveBatchSize(normalizeBatchSize(status.queueBatchSize));
        if (status.totalRecipients > 0) setSendCount(status.totalRecipients);

        if (status.status === 'SENDING' || status.status === 'PAUSED') {
          sendProgressArmedRef.current = true;
        }

        if (status.status === 'PAUSED') {
          setSendPaused(true);
          setCampaign((c) => ({ ...c, status: 'PAUSED' }));
          return;
        }
        setSendPaused(false);

        if (status.status === 'FAILED') {
          setSendError('Send failed on server — open Queue Console or check SMTP / content errors');
          setSendPhase('error');
          setCampaign((c) => ({ ...c, status: 'FAILED' }));
          setMailerTab('results');
          return;
        }

        // Old SENT snapshots (resend) must not close the modal at 0/N before SMTP starts.
        const processed = status.sentCount + status.failedCount;
        const finished =
          sendProgressArmedRef.current &&
          status.pendingCount === 0 &&
          processed > 0 &&
          (['SENT', 'CANCELLED'].includes(String(status.status)) ||
            (status.status === 'SENDING' &&
              status.totalRecipients > 0 &&
              processed >= status.totalRecipients));

        if (finished) {
          setSendCancelled(status.status === 'CANCELLED');
          setSendPhase('success');
          setCampaign((c) => ({
            ...c,
            status: status.status === 'CANCELLED' ? 'CANCELLED' : 'SENT',
          }));
          flash(
            status.status === 'CANCELLED'
              ? `Send cancelled — ${status.sentCount} sent, ${status.failedCount} failed`
              : status.failedCount > 0
                ? `Send complete — ${status.sentCount} sent, ${status.failedCount} failed (see list)`
                : `Send complete — ${status.sentCount} sent`,
            status.failedCount > 0 || status.status === 'CANCELLED' ? 'warning' : 'success',
          );
          setMailerTab('results');
        }
      },
    });

    return () => sub.cancel();
  }, [id, isNew, mailerTab, campaign.status]);

  async function generateSubjects() {
    setAiLoading(true);
    try {
      const data = await api.post<{ results: string[] }>('/api/ai/generate', {
        type: 'subject_lines',
        tone: 'professional',
        prompt: campaign.previewText || campaign.name || 'newsletter update',
        count: 5,
      });
      if (data.results[0]) setCampaign((c) => ({ ...c, subject: data.results[0] }));
      flash(`AI suggestions: ${data.results.join(' · ')}`, 'info');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'AI failed', 'error');
    } finally {
      setAiLoading(false);
    }
  }

  async function deleteCurrentCampaign() {
    if (!id || isNew) return;
    if (campaign.status === 'SENDING') {
      flash('Cancel the send first, then delete this campaign.', 'warning');
      return;
    }
    if (!(await confirmDialog({
      title: `Delete campaign`,
      description: `Permanently delete campaign “${campaign.name || 'this campaign'}”?\n\nAll send data, open/click stats and queue rows for this campaign are removed — this cannot be undone.`,
      tone: 'danger',
      destructive: true,
      confirmText: 'Delete campaign',
    }))) return;
    try {
      await api.delete(`/api/campaigns/${id}`);
      navigate('/app/campaigns');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not delete campaign', 'error');
    }
  }

  const allSmtps = providers.filter((p) => !isApiSendProvider(p));
  const pickedSmtpIds = Array.isArray(queueSettings.providerIds)
    ? queueSettings.providerIds
    : campaign.providerId
      ? [campaign.providerId]
      : allSmtps.filter((p) => p.isActive).map((p) => p.id);
  function toggleSmtpPick(pid: string, on: boolean) {
    const next = on ? [...new Set([...pickedSmtpIds, pid])] : pickedSmtpIds.filter((x) => x !== pid);
    setQueueSettings({ ...queueSettings, providerIds: next });
    setCampaign({
      ...campaign,
      providerId: next.length === 1 ? next[0] : null,
    });
  }
  function smtpPathLine(p: ProviderOption) {
    if (!smtpAllowDirect) {
      const host = String(p.socksHost || '').trim();
      if (host) return `SOCKS5 ${host}${p.socksPort ? `:${p.socksPort}` : ''}`;
      return boundPcIp ? `Bind PC ${boundPcIp}` : 'Bind PC';
    }
    if (p.outboundPath === 'socks') {
      return p.socksHost
        ? `SOCKS5 ${p.socksHost}${p.socksPort ? `:${p.socksPort}` : ''}`
        : 'SOCKS5 · set host';
    }
    if (p.outboundPath === 'bind') return p.bindIp ? `Bind IP ${p.bindIp}` : 'Bind IP · set IP';
    return 'Lightsail';
  }
  function smtpPathValue(p: ProviderOption) {
    if (!smtpAllowDirect) return String(p.socksHost || '').trim() ? 'socks' : 'bind';
    const raw = String(p.outboundPath || 'direct');
    if (raw === 'socks') return 'socks';
    if (raw === 'bind' || raw === 'remote' || raw === 'ssh') return 'bind';
    return 'direct';
  }
  async function saveSmtpPath(
    p: ProviderOption,
    patch: Partial<
      Pick<
        ProviderOption,
        | 'outboundPath'
        | 'bindIp'
        | 'socksHost'
        | 'socksPort'
        | 'socksUser'
        | 'sshHost'
        | 'sshPort'
        | 'sshUser'
        | 'remoteIp'
        | 'host'
        | 'port'
        | 'user'
        | 'fromEmail'
        | 'fromName'
        | 'fromIdentities'
      >
    >,
  ) {
    let outboundPath = patch.outboundPath ?? smtpPathValue(p);
    if (!smtpAllowDirect) {
        const socksHost = String(patch.socksHost ?? p.socksHost ?? '').trim();
      outboundPath = socksHost ? 'socks' : 'bind';
    }
    const next = {
      ...p,
      ...patch,
      outboundPath,
      bindIp: smtpAllowDirect ? patch.bindIp ?? p.bindIp : boundPcIp,
    };
    const identities = smtpIdentities(next);
    const joined = senderListLabel(identities.map((s) => s.email));
    const renameName = patch.fromIdentities != null && isGeneratedSenderName(p.name);
    const renameLabel = patch.fromIdentities != null && isGeneratedSenderName(p.label);
    const nextName = renameName ? joined || p.name : p.name;
    const nextLabel = renameLabel ? joined || null : p.label;
    setProviders((list) =>
      list.map((row) =>
        row.id === p.id ? { ...row, ...next, name: nextName, label: nextLabel } : row,
      ),
    );
    try {
      await smtpService.update(p.id, {
        ...(renameName ? { name: nextName } : {}),
        ...(renameLabel ? { label: nextLabel ?? null } : {}),
        config: {
          outboundPath,
          host: next.host || '',
          port: next.port || '',
          user: next.user || '',
          fromEmail: identities[0]?.email || next.fromEmail || '',
          fromName: identities[0]?.name || next.fromName || '',
          fromIdentities: JSON.stringify(identities),
          bindIp: smtpAllowDirect ? next.bindIp || '' : boundPcIp,
          socksHost: next.socksHost || '',
          socksPort: next.socksPort || '',
          socksUser: next.socksUser || '',
          sshHost: next.sshHost || '',
          sshPort: next.sshPort || '22',
          sshUser: next.sshUser || '',
          remoteIp: next.remoteIp || '',
        },
      });
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not save SMTP path', 'error');
    }
  }
  const consoleSubject = campaign.subject?.trim() || parsePool(subjectPoolText)[0] || '';
  const filteredLogs = (() => {
    const q = logFilter.trim().toLowerCase();
    const rows = sendActivity
      .filter((row) => {
        if (row.status === 'OPENED' || row.status === 'CLICKED') return false;
        if (logClearedAt && row.at <= logClearedAt) return false;
        if (!q) return true;
        const detail = recipientLogDetail(row.status, row.error);
        return `${row.email} ${row.status} ${detail || ''} ${campaign.senderEmail} ${consoleSubject}`
          .toLowerCase()
          .includes(q);
      })
      .slice()
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return logOldestFirst ? rows : [...rows].reverse();
  })();
  const consoleRows = filteredLogs.map((row, index) => ({
    n: logOldestFirst ? index + 1 : filteredLogs.length - index,
    from: campaign.senderEmail || '',
    to: row.email,
    subject: consoleSubject,
    status: row.status,
    detail: recipientLogDetail(row.status, row.error) || '',
  }));
  const filteredEngagement = (() => {
    const q = logFilter.trim().toLowerCase();
    if (!q) return engagementList;
    return engagementList.filter((row) => `${row.email} ${row.status}`.toLowerCase().includes(q));
  })();
  const pad = 'mailer-pad space-y-3';

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {fabChoice
        ? createPortal(
            <div className="mailer-root fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 font-mono">
              <button type="button" className="absolute inset-0 z-0" onClick={() => setFabChoice(null)} aria-label="Close" />
              <div
                className="relative z-10 w-full max-w-md border border-[var(--mailer-stroke)] bg-[var(--mailer-panel)] text-foreground shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="border-b border-[var(--mailer-stroke)] px-6 py-5">
                  <h2 className="text-lg font-semibold uppercase tracking-wide text-accent">
                    {fabChoice === 'stop'
                      ? 'Stop sending?'
                      : fabChoice === 'resend'
                        ? 'Resend campaign?'
                        : 'Send campaign?'}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {fabChoice === 'stop'
                      ? 'Addresses already accepted stay sent. The rest of the queue will not go out.'
                      : fabChoice === 'resend'
                        ? 'Resend sends this campaign again now. Edit copies it to a new draft named “original · resend” — it shows in the list immediately, even before you change anything.'
                        : `This starts sending to ${
                            listMemberCount === 1
                              ? '1 contact'
                              : `${listMemberCount.toLocaleString()} contacts`
                          }. Logs open now; Results open when the queue finishes.`}
                  </p>
                </div>
                <div className="flex flex-col-reverse gap-3 px-6 py-5 sm:flex-row sm:justify-end">
                  <Button type="button" variant="outline" onClick={() => setFabChoice(null)}>
                    {fabChoice === 'stop' ? 'Keep sending' : 'Cancel'}
                  </Button>
                  {fabChoice !== 'stop' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busyCreate}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (fabChoice !== 'resend') {
                          setFabChoice(null);
                          setMailerTab('setup');
                          return;
                        }
                        void cloneAsResendDraft();
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      {busyCreate ? 'Copying…' : 'Edit'}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant={fabChoice === 'stop' ? 'danger' : 'primary'}
                    onClick={() => {
                      const kind = fabChoice;
                      setFabChoice(null);
                      if (kind === 'stop') cancelBackgroundSend();
                      else if (kind === 'resend') openResendFlow();
                      else void openSendFlow();
                    }}
                  >
                    {fabChoice === 'stop' ? (
                      'Stop'
                    ) : (
                      <>
                        <RotateCw className="h-4 w-4" />
                        {fabChoice === 'resend' ? 'Resend' : 'Send'}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      <MailerWorkspace
        tab={mailerTab}
        onTab={setMailerTab}
        name={campaign.name || ''}
        onName={(name) => setCampaign({ ...campaign, name })}
        onSave={() => void save(false)}
        saving={saving}
        sending={campaignSendLive(campaign.status, sendPhase)}
        liveProgress={
          campaignSendLive(campaign.status, sendPhase)
            ? {
                sent: sentCount,
                failed: failedCount,
                pending: pendingCount,
                total: sendCount || campaign.totalRecipients || 0,
                lastEmail,
                stage: queueStage,
                detail: paceLine,
                paused: campaign.status === 'PAUSED' || sendPaused,
              }
            : null
        }
        onOpenLive={() => {
          setSendPhase('background');
          setMailerTab('logs');
        }}
        onPauseSend={() => void pauseBackgroundSend()}
        onResumeSend={() => void resumeBackgroundSend()}
        alreadySent={campaignAlreadySent(campaign.status) || Boolean(campaign.sentAt)}
        placementBusy={busyPlacementTest}
        onPlacementTest={() => void runPlacementTest()}
        onSendOrStop={() => {
          if (campaignSendLive(campaign.status, sendPhase)) setFabChoice('stop');
          else setFabChoice(campaignAlreadySent(campaign.status) || campaign.sentAt ? 'resend' : 'send');
        }}
        panels={{
          setup: (
            <div className={pad} style={{ paddingTop: 10 }}>
              <MailerFold title="Subject" meta="one per line">
                <Label>Subject (one per line)</Label>
                <Textarea
                  value={subjectPoolText || campaign.subject || ''}
                  onChange={(e) => {
                    setSubjectPoolText(e.target.value);
                    const first = e.target.value.split('\n').map((s) => s.trim()).find(Boolean) || '';
                    setCampaign({ ...campaign, subject: first });
                  }}
                  className="min-h-24 font-mono text-xs"
                />
                <p className="mailer-hint">Spin: {'{Hi|Hello|Hey} your catalog'} — one variant per recipient.</p>
              </MailerFold>
              <MailerFold title="Sender" meta="display name">
                <Label>Sender name (one per line)</Label>
                <Textarea
                  value={fromNamePoolText || campaign.senderName || ''}
                  onChange={(e) => {
                    setFromNamePoolText(e.target.value);
                    const first = e.target.value.split('\n').map((s) => s.trim()).find(Boolean) || '';
                    setCampaign({ ...campaign, senderName: first });
                  }}
                  className="min-h-20 font-mono text-xs"
                />
                <p className="mailer-hint">From address comes from the SMTP you pick. This is the display name only.</p>
              </MailerFold>
              <MailerFold title="Audience" meta="list">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Label>Audience list</Label>
                  <Button type="button" size="sm" variant="outline" onClick={() => setRecipientsModalOpen(true)}>
                    Import
                  </Button>
                </div>
                <Select
                  value={campaign.listId || ''}
                  onChange={(e) => setCampaign({ ...campaign, listId: e.target.value })}
                >
                  <option value="">Select list</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l._count?.members != null ? ` (${l._count.members})` : ''}
                    </option>
                  ))}
                </Select>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!id || isNew || checkingList}
                    onClick={async () => {
                      if (!id || isNew) return;
                      setCheckingList(true);
                      try {
                        const d = await api.post<{
                          total: number;
                          sendable: number;
                          skipped: number;
                          samples?: Array<{ email: string; reason: string }>;
                        }>(`/api/campaigns/${id}/check-audience`);
                        setListCheck(d);
                        flash(
                          d.skipped
                            ? `List check: ${d.sendable} sendable · ${d.skipped} skipped (syntax / MX / role)`
                            : `List check: ${d.sendable} sendable`,
                          d.skipped ? 'warning' : 'success',
                        );
                      } catch (err) {
                        flash(err instanceof Error ? err.message : 'Check failed', 'error');
                      } finally {
                        setCheckingList(false);
                      }
                    }}
                  >
                    {checkingList ? 'Checking…' : 'Check list'}
                  </Button>
                  {listCheck ? (
                    <span className="mailer-hint" style={{ margin: 0 }}>
                      {listCheck.sendable}/{listCheck.total} sendable
                      {listCheck.skipped ? ` · ${listCheck.skipped} skipped` : ''}
                    </span>
                  ) : null}
                </div>
              </MailerFold>
              <MailerFold title="Pacing" meta="batch · gap · cap">
                <div className="grid2">
                  <div>
                    <Label>Emails per batch</Label>
                    <Input
                      type="number"
                      value={queueSettings.batchSize}
                      onChange={(e) =>
                        setQueueSettings({ ...queueSettings, batchSize: Number(e.target.value) || queueSettings.batchSize })
                      }
                    />
                  </div>
                  <div>
                    <Label>Pause between batches (s)</Label>
                    <Input
                      type="number"
                      value={Math.round((queueSettings.batchPauseMs ?? 0) / 1000)}
                      onChange={(e) =>
                        setQueueSettings({ ...queueSettings, batchPauseMs: Number(e.target.value) * 1000 })
                      }
                    />
                  </div>
                  <div>
                    <Label>Gap between emails (ms)</Label>
                    <Input
                      type="number"
                      value={queueSettings.betweenEmailMs}
                      onChange={(e) =>
                        setQueueSettings({ ...queueSettings, betweenEmailMs: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div>
                    <Label>Max emails / minute</Label>
                    <Input
                      type="number"
                      value={queueSettings.maxPerMinute}
                      onChange={(e) =>
                        setQueueSettings({ ...queueSettings, maxPerMinute: Number(e.target.value) || queueSettings.maxPerMinute })
                      }
                    />
                  </div>
                </div>
                <p className="mailer-hint">
                  0 seconds means no wait. The next email uses these numbers, including while a send is already running.
                  A rejected address is marked failed and the list keeps sending. Only the Pause button stops it.
                </p>
              </MailerFold>
            </div>
          ),
          smtp: (
            <div className="flex h-full min-h-0 flex-col">
              <div className="mailer-toolbar">
                <Button type="button" size="sm" onClick={() => setSmtpModalOpen(true)}>
                  Add SMTP
                </Button>
                <span className="count">
                  {pickedSmtpIds.length} of {allSmtps.length} selected
                </span>
              </div>
              <div className="mailer-pad">
                <p className="mailer-hint" style={{ marginTop: 0 }}>
                  {smtpAllowDirect
                    ? 'Sends from Lightsail by default. Use the list for Bind IP or SOCKS5.'
                    : 'Sends from this Bind PC. Optional SOCKS5 — fill host/port on the row if you want a proxy.'}
                </p>
                {allSmtps.map((p, index) => {
                  const on = pickedSmtpIds.includes(p.id);
                  const path = smtpPathValue(p);
                  const fromCount = smtpIdentities(p).length || 1;
                  const open = smtpOpenId === p.id;
                  const toggleOpen = () => setSmtpOpenId(open ? '' : p.id);
                  return (
                    <div key={p.id} className={cn('smtp-card', on && 'on', open && 'open', !smtpAllowDirect && 'bound')}>
                      <div className="head">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => toggleSmtpPick(p.id, e.target.checked)}
                        />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={toggleOpen}>
                          <strong>{smtpProfileTitle(p) || `SMTP ${index + 1}`}</strong>
                          {p.host ? ` · ${p.host}${p.port ? `:${p.port}` : ''}` : ''}
                          <div className="meta text-[11px] text-muted-foreground">
                            {fromCount} From{fromCount === 1 ? '' : 's'} · {p.lastTestStatus || 'Pending'}
                          </div>
                          <div className="path-tag">{smtpPathLine({ ...p, outboundPath: path })}</div>
                        </button>
                        {smtpAllowDirect ? (
                          <Select
                            className="path-select field"
                            value={path}
                            onChange={(e) => {
                              void saveSmtpPath(p, { outboundPath: e.target.value });
                            }}
                          >
                            <option value="direct">Default</option>
                            <option value="bind">Bind IP</option>
                            <option value="socks">SOCKS5</option>
                          </Select>
                        ) : null}
                        <button type="button" className="meta px-1" onClick={toggleOpen} aria-label={open ? 'Collapse' : 'Expand'}>
                          {open ? '▾' : '▸'}
                        </button>
                      </div>
                      <div className="fields">
                        <div className="grid2">
                          <div>
                            <Label>Host</Label>
                            <Input
                              value={p.host || ''}
                              onChange={(e) =>
                                setProviders((list) =>
                                  list.map((row) => (row.id === p.id ? { ...row, host: e.target.value } : row)),
                                )
                              }
                              onBlur={(e) => void saveSmtpPath(p, { host: e.target.value })}
                            />
                          </div>
                          <div>
                            <Label>Port</Label>
                            <Input
                              value={p.port || ''}
                              onChange={(e) =>
                                setProviders((list) =>
                                  list.map((row) => (row.id === p.id ? { ...row, port: e.target.value } : row)),
                                )
                              }
                              onBlur={(e) => void saveSmtpPath(p, { port: e.target.value })}
                            />
                          </div>
                          <div>
                            <Label>Username</Label>
                            <Input
                              value={p.user || ''}
                              onChange={(e) =>
                                setProviders((list) =>
                                  list.map((row) => (row.id === p.id ? { ...row, user: e.target.value } : row)),
                                )
                              }
                              onBlur={(e) => void saveSmtpPath(p, { user: e.target.value })}
                            />
                          </div>
                          <div>
                            <Label>Password</Label>
                            <Input type="password" value="••••••••" readOnly />
                          </div>
                        </div>
                        {(() => {
                          const listed = parseFromIdentities(p.fromIdentities).map((s) => ({
                            email: s.email,
                            name: s.name || '',
                          }));
                          const editRows = listed.length
                            ? listed
                            : [{ email: p.fromEmail || '', name: p.fromName || '' }];
                          function queueFromSave(next: Array<{ email: string; name: string }>) {
                            fromDraftRef.current.set(p.id, next);
                            const pending = fromSaveTimerRef.current.get(p.id);
                            if (pending) window.clearTimeout(pending);
                            fromSaveTimerRef.current.set(
                              p.id,
                              window.setTimeout(() => {
                                const rows = fromDraftRef.current.get(p.id) || next;
                                void saveSmtpPath(
                                  { ...p, fromIdentities: rows },
                                  {
                                    fromIdentities: rows,
                                    fromEmail: rows.find((s) => s.email.includes('@'))?.email || rows[0]?.email,
                                    fromName: rows.find((s) => s.email.includes('@'))?.name || rows[0]?.name,
                                  },
                                );
                              }, 80),
                            );
                          }
                          function stageFrom(next: Array<{ email: string; name: string }>) {
                            fromDraftRef.current.set(p.id, next);
                            const emails = next.map((s) => s.email.trim()).filter((email) => email.includes('@'));
                            const joined = senderListLabel(emails);
                            setProviders((list) =>
                              list.map((item) =>
                                item.id === p.id
                                  ? {
                                      ...item,
                                      fromIdentities: next,
                                      fromEmail: emails[0] || next[0]?.email || '',
                                      fromName: next.find((s) => s.email.includes('@'))?.name || next[0]?.name || '',
                                      ...(isGeneratedSenderName(item.name) ? { name: joined || item.name } : {}),
                                      ...(isGeneratedSenderName(item.label) ? { label: joined || null } : {}),
                                    }
                                  : item,
                              ),
                            );
                          }
                          return (
                            <div className="mt-2">
                              <Label>From addresses</Label>
                              <div className="mt-1 space-y-2">
                                {editRows.map((row, i) => (
                                  <div key={`${p.id}-from-${i}`} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2">
                                    <Input
                                      value={row.name}
                                      placeholder="From name (optional)"
                                      onChange={(e) => {
                                        const base = fromDraftRef.current.get(p.id) || editRows;
                                        stageFrom(base.map((s, idx) => (idx === i ? { ...s, name: e.target.value } : s)));
                                      }}
                                      onBlur={() => queueFromSave(fromDraftRef.current.get(p.id) || editRows)}
                                    />
                                    <Input
                                      type="email"
                                      value={row.email}
                                      placeholder="hello@yourdomain.com"
                                      onChange={(e) => {
                                        const base = fromDraftRef.current.get(p.id) || editRows;
                                        stageFrom(base.map((s, idx) => (idx === i ? { ...s, email: e.target.value } : s)));
                                      }}
                                      onBlur={() => queueFromSave(fromDraftRef.current.get(p.id) || editRows)}
                                    />
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      aria-label="Add sender"
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => {
                                        const base = fromDraftRef.current.get(p.id) || editRows;
                                        const next = [
                                          ...base.slice(0, i + 1),
                                          { email: '', name: '' },
                                          ...base.slice(i + 1),
                                        ];
                                        stageFrom(next);
                                      }}
                                    >
                                      +
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={editRows.length <= 1}
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => {
                                        const base = fromDraftRef.current.get(p.id) || editRows;
                                        const next = base.filter((_, idx) => idx !== i);
                                        const identities = next.length ? next : [{ email: '', name: '' }];
                                        stageFrom(identities);
                                        queueFromSave(identities);
                                      }}
                                    >
                                      −
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                        {path === 'bind' && smtpAllowDirect ? (
                          <div className="mt-2">
                            <Label>Bind IP</Label>
                            <Input
                              value={p.bindIp || ''}
                              placeholder="203.0.113.10"
                              onChange={(e) =>
                                setProviders((list) =>
                                  list.map((row) => (row.id === p.id ? { ...row, bindIp: e.target.value } : row)),
                                )
                              }
                              onBlur={(e) => void saveSmtpPath(p, { outboundPath: 'bind', bindIp: e.target.value })}
                            />
                            <p className="mailer-hint">SMTP leaves from this local/dedicated IP on the send box.</p>
                          </div>
                        ) : null}
                        {path === 'socks' || !smtpAllowDirect ? (
                          <div className="grid2 mt-2">
                            <div>
                              <Label>SOCKS host</Label>
                              <Input
                                value={p.socksHost || ''}
                                placeholder="10.0.0.8"
                                onChange={(e) =>
                                  setProviders((list) =>
                                    list.map((row) => (row.id === p.id ? { ...row, socksHost: e.target.value } : row)),
                                  )
                                }
                                onBlur={(e) => void saveSmtpPath(p, { outboundPath: 'socks', socksHost: e.target.value })}
                              />
                            </div>
                            <div>
                              <Label>SOCKS port</Label>
                              <Input
                                value={p.socksPort || ''}
                                placeholder="Port"
                                onChange={(e) =>
                                  setProviders((list) =>
                                    list.map((row) => (row.id === p.id ? { ...row, socksPort: e.target.value } : row)),
                                  )
                                }
                                onBlur={(e) => void saveSmtpPath(p, { outboundPath: 'socks', socksPort: e.target.value })}
                              />
                            </div>
                            <div>
                              <Label>SOCKS user</Label>
                              <Input
                                value={p.socksUser || ''}
                                onChange={(e) =>
                                  setProviders((list) =>
                                    list.map((row) => (row.id === p.id ? { ...row, socksUser: e.target.value } : row)),
                                  )
                                }
                                onBlur={(e) => void saveSmtpPath(p, { outboundPath: 'socks', socksUser: e.target.value })}
                              />
                            </div>
                            <div>
                              <Label>SOCKS password</Label>
                              <Input type="password" placeholder="optional" />
                            </div>
                            <p className="mailer-hint" style={{ gridColumn: '1 / -1' }}>
                              {smtpAllowDirect
                                ? 'Tunnel SMTP through your SOCKS5 proxy.'
                                : 'Optional. Leave blank to send from this bound PC.'}
                            </p>
                          </div>
                        ) : null}
                        <div className="mt-3 flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={testingSmtpId === p.id}
                            onClick={async () => {
                              setTestingSmtpId(p.id);
                              try {
                                const r = await smtpService.testConnection({ providerId: p.id });
                                flash(r.success ? r.message || 'Path connected' : r.error || r.message, r.success ? 'success' : 'error');
                              } catch (err) {
                                flash(err instanceof Error ? err.message : 'Test failed', 'error');
                              } finally {
                                setTestingSmtpId(null);
                              }
                            }}
                          >
                            {testingSmtpId === p.id ? 'Testing…' : 'Test path'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!allSmtps.length ? (
                  <p className="mailer-hint">
                    No SMTP profiles.{' '}
                    <Link to="/app/smtp" className="text-primary underline">
                      Open SMTP Manager
                    </Link>
                  </p>
                ) : null}
              </div>
            </div>
          ),
          recipients: (
            <CampaignAudiencePane campaignId={isNew ? undefined : id} listId={campaign.listId} />
          ),
          placeholder: (
            <PlaceholderPane
              html={html}
              onHtmlChange={applyLetterHtml}
              placeholderMap={placeholderMap}
              onPlaceholderMap={setPlaceholderMap}
              spinPools={spinPools}
              onSpinPools={setSpinPools}
              attachments={attachments}
              onAttachments={setAttachments}
            />
          ),
          attachments: <AttachmentsPane attachments={attachments} onAttachments={setAttachments} />,
          letter: (
            <div className="letter-wrap">
              <aside className="pick-list">
                <button
                  type="button"
                  className={cn('pick', 'import', letterImporting && 'pointer-events-none opacity-50')}
                  onClick={() => setLetterModalOpen(true)}
                >
                  <div>
                    <strong>{letterImporting ? 'Importing…' : 'Import HTML'}</strong>
                    <div className="meta">Name the letter, then import</div>
                  </div>
                </button>
                {templates.map((t) => {
                  const ticked = templatePoolIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={cn('pick', ticked && 'on')}
                      title="Tick to use this letter"
                      onClick={() => {
                        if (ticked) void selectLetter(t.id);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={ticked}
                        onChange={() => void toggleTemplateInPool(t.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div>
                        <strong>{t.name}</strong>
                        <div className="meta">HTML{ticked ? ' · in campaign' : ''}</div>
                      </div>
                    </button>
                  );
                })}
                {!templates.length ? (
                  <p className="mailer-hint px-2 py-4">Import HTML here to add a letter. It is also saved on Templates.</p>
                ) : null}
              </aside>
                <LetterPane
                  html={html}
                  onHtmlChange={applyLetterHtml}
                  importing={letterImporting}
                  onImportClick={() => setLetterModalOpen(true)}
                  placeholderMap={placeholderMap}
                  spinPools={spinPools}
                  attachments={attachments}
                  onAttachments={setAttachments}
                  previewContacts={previewContacts}
                  onPreviewContactChange={updatePreviewContact}
                  senderName={campaign.senderName}
                  senderEmail={campaign.senderEmail}
                  subject={campaign.subject || parsePool(subjectPoolText)[0] || ''}
                  physicalAddress={physicalAddress}
                  proofAddress={testMatrixTo}
                  onProofAddress={setTestMatrixTo}
                  onSendCopy={sendMailboxProof}
                />
            </div>
          ),
          logs: (
            <div className="flex h-full min-h-0 flex-col">
              {sendError ? <p className="mailer-err px-3 py-2">{sendError}</p> : null}
              <div className={cn('complete', (campaign.status === 'SENT' || sendPhase === 'success') && !sendCancelled && 'on')}>
                <b>SEND COMPLETE</b>
                <p className="mailer-hint" style={{ margin: '6px 0 10px' }}>
                  {sentCount} sent · {failedCount} failed · {openedCount} opened · {clickedCount} clicked. Logs stay. Recipients keep status.
                </p>
                <Button type="button" size="sm" onClick={() => setMailerTab('results')}>View opens & clicks</Button>
                <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => setMailerTab('recipients')}>View recipients</Button>
              </div>
              <div className="mailer-toolbar">
                <Input
                  className="max-w-xs"
                  placeholder="Filter this campaign…"
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                />
                <Button type="button" size="sm" variant="outline" onClick={() => {
                  void navigator.clipboard.writeText(filteredLogs.map((r) => `${r.at} ${r.status} ${r.email} ${recipientLogDetail(r.status, r.error) || ''}`).join('\n'));
                }}>Copy</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => {
                  const blob = new Blob([filteredLogs.map((r) => `${r.at} ${r.status} ${r.email} ${recipientLogDetail(r.status, r.error) || ''}`).join('\n')], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `campaign-${id || 'log'}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}>Download</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setLogOldestFirst((v) => !v)}>
                  {logOldestFirst ? 'Newest' : 'Oldest'}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setLogClearedAt(new Date().toISOString())}>
                  Clear
                </Button>
                <span className="count">
                  {filteredLogs.length} lines
                  {pendingCount ? ` · ${pendingCount} still queued` : ''}
                  {' · this campaign · keep all'}
                </span>
                {campaign.status === 'SENDING' ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => void pauseBackgroundSend()}>
                    Pause
                  </Button>
                ) : null}
                {campaign.status === 'PAUSED' ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => void resumeBackgroundSend()}>
                    Resume
                  </Button>
                ) : null}
              </div>
              {campaign.status === 'SENDING' || campaign.status === 'PAUSED' ? (
                <div className="mailer-toolbar">
                  <span className="mailer-pace-line">{paceLine}</span>
                </div>
              ) : null}
              <div className="mailer-toolbar">
                <label className="mailer-pace">
                  Pause between batches (s)
                  <Input
                    type="number"
                    min={0}
                    value={Math.round((queueSettings.batchPauseMs ?? 0) / 1000)}
                    onChange={(e) =>
                      setQueueSettings({ ...queueSettings, batchPauseMs: Math.max(0, Number(e.target.value) || 0) * 1000 })
                    }
                  />
                </label>
                <label className="mailer-pace">
                  Gap (ms)
                  <Input
                    type="number"
                    min={0}
                    value={queueSettings.betweenEmailMs}
                    onChange={(e) =>
                      setQueueSettings({ ...queueSettings, betweenEmailMs: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <label className="mailer-pace">
                  Max / minute
                  <Input
                    type="number"
                    min={1}
                    value={queueSettings.maxPerMinute}
                    onChange={(e) =>
                      setQueueSettings({
                        ...queueSettings,
                        maxPerMinute: Math.max(1, Number(e.target.value) || queueSettings.maxPerMinute),
                      })
                    }
                  />
                </label>
                <span className="count">0 = no wait · next email picks this up</span>
              </div>
              <SendConsole rows={consoleRows} stickToEnd={logOldestFirst} />
              <div className="mailer-toolbar">
                <span className="count" style={{ marginLeft: 0 }}>
                  {sentCount} sent · {openedCount} opened · {clickedCount} clicked · {failedCount} failed
                </span>
              </div>
              <div className="mailer-engage">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Status</th>
                      <th>Opened</th>
                      <th>Clicked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEngagement.length ? (
                      filteredEngagement.map((row) => (
                        <tr key={row.email}>
                          <td>{row.email}</td>
                          <td>{row.status}</td>
                          <td>{row.opened ? '1×' : '—'}</td>
                          <td>{row.clicked ? '1×' : '—'}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4}>No opens or clicks yet. They show here while the send is still going.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ),
          results: (
            <CampaignResultsPane
              campaignId={isNew ? undefined : id}
              listId={campaign.listId}
              campaignStatus={campaign.status}
              sentCount={sentCount}
              openedCount={openedCount}
              clickedCount={clickedCount}
              failedCount={failedCount}
            />
          ),
        }}
      />
      <CampaignAddSmtpModal
        open={smtpModalOpen}
        onClose={() => setSmtpModalOpen(false)}
        onCreated={(p) => {
          setProviders((list) => [p, ...list.filter((row) => row.id !== p.id)]);
          setQueueSettings((q) => ({
            ...q,
            providerIds: [...new Set([...(q.providerIds || []), p.id])],
          }));
          setCampaign((c) => ({
            ...c,
            providerId: p.id,
            senderEmail: p.fromEmail || c.senderEmail,
            senderName: p.fromName || c.senderName,
          }));
          flash('SMTP added to this campaign');
        }}
      />
      <CampaignImportRecipientsModal
        open={recipientsModalOpen}
        onClose={() => setRecipientsModalOpen(false)}
        onImported={(list) => {
          setLists((rows) => [
            { id: list.id, name: list.name, _count: { members: list.count } },
            ...rows.filter((row) => row.id !== list.id),
          ]);
          setCampaign((c) => ({ ...c, listId: list.id }));
          flash(`Imported ${list.count} recipient${list.count === 1 ? '' : 's'}`);
        }}
      />
      <CampaignLetterImportModal
        open={letterModalOpen}
        importing={letterImporting}
        onClose={() => setLetterModalOpen(false)}
        onImportFile={importLetterFile}
      />
    </div>
  );
}
