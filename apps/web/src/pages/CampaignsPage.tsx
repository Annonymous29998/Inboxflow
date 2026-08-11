import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlignLeft,
  Columns2,
  Clock,
  Code,
  Copy,
  Eraser,
  Minus,
  Image as ImageIcon,
  MousePointer,
  Plus,
  Send,
  Share2,
  Sparkles,
  Square,
  Trash2,
  Type,
  Video,
  Eye,
  Loader2,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { campaignSendService } from '@/services/campaign-send.service';
import { smtpService } from '@/services/smtp.service';
import { templateHtmlToBlocks, templateService, type EmailTemplateSummary } from '@/services/template.service';
import {
  CampaignDeliverabilityPanel,
  useCampaignDeliverability,
} from '@/components/campaigns/CampaignDeliverabilityPanel';
import { scrubCampaignEditorContent, scrubSpamFromHtml, scrubSpamFromText } from '@/lib/spam-content-filter';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { cn, scoreColor, scoreLabel } from '@/lib/utils';
import { SendProgressModal, type SendFlowPhase } from '@/components/campaigns/SendProgressModal';
import { CampaignRecipientsPanel } from '@/components/campaigns/CampaignRecipientsPanel';
import { toast } from '@/stores/toast';
import { confirmDialog, promptDialog } from '@/stores/confirm';
import { useDraft, useDraftStore } from '@/stores/draft';

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
  user?: string;
  lastTestStatus?: string | null;
  issues?: string[];
};

type Campaign = {
  id: string;
  name: string;
  status: string;
  type: string;
  subject?: string | null;
  previewText?: string | null;
  senderName?: string | null;
  senderEmail?: string | null;
  replyTo?: string | null;
  htmlContent?: string | null;
  plainTextContent?: string | null;
  listId?: string | null;
  templateId?: string | null;
  providerId?: string | null;
  queueSettings?: {
    batchSize?: number;
    batchPauseMs?: number;
    betweenEmailMs?: number;
    maxPerMinute?: number;
    maxPerHour?: number;
  } | null;
  subjectPool?: string[] | null;
  fromNamePool?: string[] | null;
  deliverabilityScore?: number | null;
  inboxReadinessScore?: number | null;
  analysisReport?: DeliverabilityReport | null;
  trackOpens?: boolean;
  trackClicks?: boolean;
  editorJson?: { blocks?: EditorBlock[] } | null;
  sentCount?: number;
  openedCount?: number;
  clickedCount?: number;
  deliveredCount?: number;
  sentAt?: string | null;
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

const BLOCK_TYPES = [
  { type: 'text', label: 'Text', icon: Type },
  { type: 'image', label: 'Image', icon: ImageIcon },
  { type: 'button', label: 'Button', icon: MousePointer },
  { type: 'divider', label: 'Divider', icon: Minus },
  { type: 'spacer', label: 'Spacer', icon: Square },
  { type: 'social', label: 'Social', icon: Share2 },
  { type: 'columns', label: 'Columns', icon: Columns2 },
  { type: 'video', label: 'Video', icon: Video },
  { type: 'countdown', label: 'Countdown', icon: Clock },
  { type: 'products', label: 'Products', icon: AlignLeft },
  { type: 'html', label: 'HTML', icon: Code },
];

/** Imported templates are often complete HTML documents — send them as-is, not wrapped again. */
function isFullHtmlDocument(html: string): boolean {
  const trimmed = html.trim();
  return /<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
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

export function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyCreate, setBusyCreate] = useState(false);
  const navigate = useNavigate();

  async function load() {
    const d = await api.get<{ campaigns: Campaign[] }>('/api/campaigns');
    setCampaigns(d.campaigns);
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function createNewDraftCampaign() {
    if (busyCreate) return;
    setBusyCreate(true);
    try {
      const created = await api.post<{ campaign: Campaign }>('/api/campaigns', {
        name: 'Untitled campaign',
        type: 'REGULAR',
        status: 'DRAFT',
      });
      await load();
      navigate(`/app/campaigns/${created.campaign.id}`);
    } catch (err) {
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
      setCampaigns((list) => list.filter((item) => item.id !== c.id));
      flash(`Deleted “${c.name}”`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not delete campaign', 'error');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">Create, analyze, and send with confidence</p>
        </div>
        <Button className="w-full sm:w-auto" disabled={busyCreate} onClick={() => void createNewDraftCampaign()}>
          <Plus className="h-4 w-4" /> New campaign
        </Button>
      </div>

      <div className="grid gap-3">
        {campaigns.map((c) => (
          <Card key={c.id} className="transition-colors hover:border-primary/50">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Link to={`/app/campaigns/${c.id}`} className="min-w-0 flex-1">
                <div className="font-medium hover:text-primary">{c.name}</div>
                <div className="truncate text-sm text-ink-muted">{c.subject || 'No subject'}</div>
                {c.status === 'SENT' && (c.sentCount ?? 0) > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-ink-muted">
                    <span>
                      <span className="font-semibold text-success">{c.deliveredCount || c.sentCount}</span>
                      /{c.sentCount} delivered
                    </span>
                    <span>
                      <span className="font-semibold text-primary">{c.openedCount ?? 0}</span> opened
                      {c.sentCount
                        ? ` (${Math.round(((c.openedCount ?? 0) / c.sentCount) * 100)}%)`
                        : ''}
                    </span>
                    <span>
                      <span className="font-semibold text-primary">{c.clickedCount ?? 0}</span> clicked
                      {c.sentCount
                        ? ` (${Math.round(((c.clickedCount ?? 0) / c.sentCount) * 100)}%)`
                        : ''}
                    </span>
                  </div>
                ) : null}
              </Link>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                {c.deliverabilityScore != null && (
                  <span className="text-sm font-semibold" style={{ color: scoreColor(c.deliverabilityScore) }}>
                    {c.deliverabilityScore}/100
                  </span>
                )}
                <Badge>{c.type}</Badge>
                <Badge tone={c.status === 'SENT' ? 'success' : 'info'}>{c.status}</Badge>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={deletingId === c.id || c.status === 'SENDING'}
                  title={c.status === 'SENDING' ? 'Cancel send before deleting' : 'Delete campaign'}
                  onClick={(e) => void deleteCampaign(c, e)}
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {!campaigns.length && (
          <Card className="space-y-3 py-10 text-center">
            <p className="text-ink-muted">No campaigns yet.</p>
            <Button disabled={busyCreate} onClick={() => void createNewDraftCampaign()}>
              <Plus className="h-4 w-4" /> Create your first campaign
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}

export function CampaignEditorPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const draftKey = `campaign:${id || 'new'}`;
  const defaultCampaign: Partial<Campaign> = {
    name: 'Untitled campaign',
    type: 'REGULAR',
    subject: '',
    previewText: '',
    senderName: '',
    senderEmail: '',
    trackOpens: true,
    trackClicks: true,
  };
  const [campaign, setCampaign] = useDraft<Partial<Campaign>>(`${draftKey}:campaign`, defaultCampaign);
  const [lists, setLists] = useState<Array<{ id: string; name: string; _count?: { members: number } }>>([]);
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [blocks, setBlocks] = useDraft<EditorBlock[]>(`${draftKey}:blocks`, []);
  const [previewMode, setPreviewMode] = useDraft<'desktop' | 'tablet' | 'mobile' | 'dark'>(`${draftKey}:previewMode`, 'desktop');
  const [report, setReport] = useState<DeliverabilityReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendPhase, setSendPhase] = useState<SendFlowPhase>('confirm');
  const [sendCount, setSendCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [recentFailures, setRecentFailures] = useState<Array<{ email: string; error: string }>>([]);
  const [sendCancelled, setSendCancelled] = useState(false);
  const [sendPaused, setSendPaused] = useState(false);
  const [sendError, setSendError] = useState('');
  const defaultQueueSettings = {
    batchSize: 5,
    batchPauseMs: 30_000,
    betweenEmailMs: 4_000,
    maxPerMinute: 12,
    maxPerHour: 400,
  };
  const [queueSettings, setQueueSettings] = useDraft(`${draftKey}:queueSettings`, defaultQueueSettings);
  const [subjectPoolText, setSubjectPoolText] = useDraft<string>(`${draftKey}:subjectPoolText`, '');
  const [fromNamePoolText, setFromNamePoolText] = useDraft<string>(`${draftKey}:fromNamePoolText`, '');
  const [testMatrixTo, setTestMatrixTo] = useDraft<string>(`${draftKey}:testMatrixTo`, '');
  const [busyPlacementTest, setBusyPlacementTest] = useState(false);
  const [busyTestMatrix, setBusyTestMatrix] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [viewHtmlOpen, setViewHtmlOpen] = useState(false);
  const [viewHtmlDraft, setViewHtmlDraft] = useState('');
  const [viewHtmlBlockId, setViewHtmlBlockId] = useState<string | null>(null);
  const [savingHtml, setSavingHtml] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [hydrated, setHydrated] = useState(isNew);
  const skipAutoSaveRef = useRef(true);
  const autoSaveTimerRef = useRef<number | null>(null);
  const sendStreamCancelRef = useRef<{ cancel: () => void } | null>(null);

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

  const html = useMemo(() => blocksToHtml(blocks, previewMode === 'dark'), [blocks, previewMode]);

  const listMemberCount = useMemo(
    () => lists.find((l) => l.id === campaign.listId)?._count?.members ?? 0,
    [lists, campaign.listId],
  );

  const hasActiveSmtp = useMemo(
    () => providers.some((p) => p.isActive && p.lastTestStatus === 'Connected'),
    [providers],
  );

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === campaign.providerId) || providers.find((p) => p.isDefault) || providers[0],
    [providers, campaign.providerId],
  );

  const fromName = campaign.senderName || selectedProvider?.fromName || '';
  const fromEmail = campaign.senderEmail || selectedProvider?.fromEmail || '';
  const fromLabel = fromEmail
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
    smtpService.list().then((active) => {
      setProviders(active.filter((p) => p.isActive));
      setCampaign((c) => {
        if (c.providerId) return c;
        const def = active.find((p) => p.isDefault) || active[0];
        return def ? { ...c, providerId: def.id } : c;
      });
    }).catch(console.error);
    if (!isNew && id) {
      setHydrated(false);
      skipAutoSaveRef.current = true;
      api
        .get<{ campaign: Campaign & { queueSettings?: typeof queueSettings } }>(`/api/campaigns/${id}`)
        .then((d) => {
          setCampaign(d.campaign);
          const savedBlocks = d.campaign.editorJson?.blocks;
          if (savedBlocks?.length) {
            setBlocks(savedBlocks);
          } else if (d.campaign.htmlContent?.trim()) {
            setBlocks(templateHtmlToBlocks(d.campaign.htmlContent));
          } else {
            setBlocks([]);
          }
          if (d.campaign.analysisReport) setReport(d.campaign.analysisReport as DeliverabilityReport);
          if (d.campaign.queueSettings) {
            setQueueSettings((q) => ({ ...q, ...d.campaign.queueSettings }));
          }
          const subjects = Array.isArray(d.campaign.subjectPool) ? d.campaign.subjectPool : [];
          const names = Array.isArray(d.campaign.fromNamePool) ? d.campaign.fromNamePool : [];
          setSubjectPoolText(subjects.join('\n'));
          setFromNamePoolText(names.join('\n'));
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
  }, [id, isNew]);

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
          name: (campaign.name && campaign.name !== 'Untitled campaign') ? campaign.name : 'Untitled campaign',
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

      const template = await templateService.get(templateId);
      const rawHtml = template.htmlContent?.trim() || '';
      if (!rawHtml) {
        flash('That template has no HTML content', 'error');
        return;
      }

      const scrubbed = scrubImportedHtml(rawHtml, template.plainText);
      const html = scrubbed.htmlContent;
      const plain = scrubbed.plainTextContent || template.plainText || '';

      const nextBlocks =
        template.editorJson?.blocks?.length && template.editorJson.blocks[0]?.content && !scrubbed.changed
          ? template.editorJson.blocks
          : templateHtmlToBlocks(html);

      setBlocks(nextBlocks);
      setCampaign((c) => ({
        ...c,
        templateId,
        htmlContent: html,
        plainTextContent: plain || c.plainTextContent,
        name: c.name && c.name !== 'Untitled campaign' ? c.name : template.name,
      }));
      flash(`Loaded template: ${template.name}`);

      if (id) {
        await api.patch(`/api/campaigns/${id}`, {
          templateId,
          htmlContent: html,
          plainTextContent: plain,
          editorJson: { blocks: nextBlocks },
        });
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not load template', 'error');
    } finally {
      setTemplateLoading(false);
    }
  }

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

  async function save(andAnalyze = false, opts?: { silent?: boolean }) {
    const silent = opts?.silent === true;
    if (!silent) setSaving(true);
    else setAutoSaveState('saving');
    try {
      const htmlForSave = blocksToHtml(blocks, false);
      const plainFromBlocks = blocks
        .filter((b) => b.type === 'text' || b.type === 'button')
        .map((b) => b.content)
        .join('\n\n');

      const plainTextContent = plainFromBlocks.trim()
        ? `${plainFromBlocks}\n\nUnsubscribe: {{unsubscribe_url}}`
        : campaign.plainTextContent || undefined;

      const payload = {
        ...campaign,
        htmlContent: htmlForSave,
        plainTextContent,
        editorJson: { blocks },
        queueSettings,
        providerId: campaign.providerId,
        listId: campaign.listId || null,
        templateId: campaign.templateId || null,
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
          providerId: campaign.providerId,
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
        });
        campaignId = created.campaign.id;
        await api.patch(`/api/campaigns/${campaignId}`, payload);
        navigate(`/app/campaigns/${campaignId}`, { replace: true });
      } else {
        await api.patch(`/api/campaigns/${id}`, payload);
      }

      if (andAnalyze && campaignId) {
        const result = await api.post<{ report: DeliverabilityReport }>(`/api/campaigns/${campaignId}/analyze`);
        setReport(result.report);
        if (!silent) {
          flash(`Deliverability score: ${result.report.score}/100 (${scoreLabel(result.report.score)})`);
        }
      } else if (!silent) {
        flash('Saved');
      }

      if (!silent) {
        const savedDraftKey = `campaign:${campaignId || 'new'}`;
        const store = useDraftStore.getState();
        store.setDraft(`${savedDraftKey}:campaign`, {
          ...campaign,
          htmlContent: htmlForSave,
          plainTextContent,
          listId: campaign.listId || null,
          templateId: campaign.templateId || null,
          editorJson: { blocks },
          queueSettings,
          subjectPool: parsePool(subjectPoolText),
          fromNamePool: parsePool(fromNamePoolText),
        });
        store.setDraft(`${savedDraftKey}:blocks`, blocks);
        store.setDraft(`${savedDraftKey}:queueSettings`, queueSettings);
        store.setDraft(`${savedDraftKey}:subjectPoolText`, subjectPoolText);
        store.setDraft(`${savedDraftKey}:fromNamePoolText`, fromNamePoolText);
        store.setDraft(`${savedDraftKey}:previewMode`, previewMode);
      }

      setAutoSaveState('saved');
      // Prevent the post-save state write from immediately queuing another autosave
      skipAutoSaveRef.current = true;
      window.setTimeout(() => {
        skipAutoSaveRef.current = false;
      }, 600);
    } catch (err) {
      setAutoSaveState('error');
      if (!silent) {
        flash(err instanceof Error ? err.message : 'Save failed', 'error');
      }
    } finally {
      if (!silent) setSaving(false);
    }
  }

  // Auto-save list, subject, template, SMTP, HTML, queue — so leave/return restores everything
  useEffect(() => {
    if (!hydrated || isNew || !id) return;
    if (skipAutoSaveRef.current) return;
    if (campaign.status === 'SENDING') return;

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
    campaign.providerId,
    campaign.trackOpens,
    campaign.trackClicks,
    blocks,
    queueSettings,
    subjectPoolText,
    fromNamePoolText,
  ]);

  function openHtmlViewer(blockId: string, content: string) {
    setViewHtmlBlockId(blockId);
    setViewHtmlDraft(content || html);
    setViewHtmlOpen(true);
  }

  async function saveHtmlFromModal() {
    if (!viewHtmlOpen) return;
    setSavingHtml(true);
    try {
      const scrubbed = scrubImportedHtml(viewHtmlDraft);
      const nextHtml = scrubbed.htmlContent;
      const nextPlain = scrubbed.plainTextContent || '';
      const nextBlocks = viewHtmlBlockId
        ? blocks.map((b) => (b.id === viewHtmlBlockId ? { ...b, content: nextHtml } : b))
        : templateHtmlToBlocks(nextHtml);

      setBlocks(nextBlocks);
      setCampaign((c) => ({
        ...c,
        htmlContent: nextHtml,
        plainTextContent: nextPlain || c.plainTextContent,
      }));
      setViewHtmlDraft(nextHtml);

      const editorJson = { blocks: nextBlocks };

      if (!isNew && id) {
        await api.patch(`/api/campaigns/${id}`, {
          htmlContent: nextHtml,
          plainTextContent: nextPlain || undefined,
          editorJson,
        });
      }

      if (campaign.templateId) {
        await templateService.update(campaign.templateId, {
          htmlContent: nextHtml,
          plainText: nextPlain || null,
          editorJson,
        });
      }

      flash(
        campaign.templateId
          ? 'HTML saved to this campaign and the linked template'
          : 'HTML saved to this campaign (no linked template)',
      );
      setViewHtmlOpen(false);
      setViewHtmlBlockId(null);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not save HTML', 'error');
    } finally {
      setSavingHtml(false);
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
    if (!id || isNew) {
      await save();
      return;
    }
    if (!deliverability.canSend) {
      flash(
        deliverability.failures[0]?.detail || 'Fix inbox placement checks before sending.',
        'warning',
      );
      return;
    }
    try {
      await applyInboxFriendlyContent();
      await save(false);
      const list = lists.find((l) => l.id === campaign.listId);
      setSendCount(list?._count?.members ?? 0);
      setSendPhase('confirm');
      setSentCount(0);
      setFailedCount(0);
      setRecentFailures([]);
      setSendCancelled(false);
      setSendPaused(false);
      setSendError('');
      setSendOpen(true);
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

    setSendPhase('background');
    setSendCancelled(false);
    setSendPaused(false);
    setSendError('');
    stopSendStream();

    try {
      const result = await campaignSendService.startBackgroundSend(id, {
        providerId: campaign.providerId,
        force,
        queueSettings,
      });
      setSendCount(result.totalRecipients ?? sendCount);
      setSentCount(0);
      setFailedCount(0);
      setRecentFailures([]);
      setCampaign((c) => ({ ...c, status: 'SENDING' }));

      if (result.jobId) {
        sendStreamCancelRef.current = campaignSendService.streamProgress(result.jobId, {
          onUpdate: (u) => {
            const meta = (u.meta as any) ?? {};
            const sent = Number(meta.sent ?? u.processed ?? 0);
            const failed = Number(meta.failed ?? 0);
            setSentCount((prev) => Math.max(prev, sent));
            setFailedCount((prev) => Math.max(prev, failed));
            if (u.total && Number(u.total) > 0) {
              setSendCount((prev) => Math.max(prev, Number(u.total)));
            }
            if (u.status === 'COMPLETED' || u.status === 'CANCELLED' || u.status === 'FAILED') {
              stopSendStream();
              if (u.status === 'FAILED') {
                setSendError(String(u.error || 'Send failed'));
                setSendPhase('error');
              } else {
                setSendCancelled(u.status === 'CANCELLED');
                setSendPhase('success');
              }
            }
          },
          onError: (err) => {
            stopSendStream();
          },
        });
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed');
      setSendPhase('error');
    }
  }

  function cancelBackgroundSend() {
    if (id && !isNew) {
      void campaignSendService.cancel(id);
      setSendCancelled(true);
      setSendPaused(false);
    }
    stopSendStream();
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
    }
    stopSendStream();
  }

  async function resumeBackgroundSend() {
    if (!id || isNew) return;
    try {
      await campaignSendService.resume(id);
      setSendPaused(false);
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
    if (!id || isNew) return;
    const to = testMatrixTo.trim();
    if (!to) {
      flash('Enter a test recipient email (Gmail/Outlook you can open)', 'warning');
      return;
    }
    const subject = campaign.subject?.trim();
    if (!subject) {
      flash('Add a campaign subject before sending a placement test', 'warning');
      return;
    }
    const hasHtml = Boolean(campaign.htmlContent?.trim()) || blocks.some((b) => b.type === 'html' || b.type === 'text');
    if (!hasHtml && !html?.trim()) {
      flash('Import or add an HTML template first', 'warning');
      return;
    }
    try {
      setBusyPlacementTest(true);
      await save(false);
      const fromNames = parsePool(fromNamePoolText);
      if (campaign.senderName?.trim()) fromNames.unshift(campaign.senderName.trim());
      const uniqueFrom = [...new Set(fromNames.map((n) => n.trim()).filter(Boolean))];
      const result = await campaignSendService.testMatrix(id, {
        to,
        subjects: [subject],
        fromNames: uniqueFrom.length ? [uniqueFrom[0]] : undefined,
      });
      if (result.sent > 0) {
        toast.success(
          `Placement test sent to ${to}`,
          'Open that mailbox and check Primary/Inbox AND Spam/Promotions. Inbox Flow cannot see which folder it landed in.',
        );
      } else {
        flash(`Placement test failed: ${result.results?.[0]?.error || 'Send failed'}`, 'error');
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
    if (!sendOpen || sendPhase !== 'background' || !id || isNew) return;

    let stopped = false;

    async function poll() {
      try {
        const status = await campaignSendService.getSendStatus(id!);
        if (stopped) return;
        setSentCount(status.sentCount);
        setFailedCount(status.failedCount);
        if (status.recentFailures) setRecentFailures(status.recentFailures);
        if (status.totalRecipients > 0) setSendCount(status.totalRecipients);

        if (status.status === 'PAUSED') {
          setSendPaused(true);
          setCampaign((c) => ({ ...c, status: 'PAUSED' }));
          return;
        }
        setSendPaused(false);

        const finished =
          status.pendingCount === 0 &&
          ['SENT', 'FAILED', 'CANCELLED'].includes(String(status.status));

        if (finished) {
          setSendCancelled(status.status === 'CANCELLED');
          setSendPhase('success');
          setCampaign((c) => ({ ...c, status: status.status as Campaign['status'] }));
          flash(
            status.status === 'CANCELLED'
              ? `Send cancelled — ${status.sentCount} sent, ${status.failedCount} failed`
              : status.failedCount > 0
                ? `Send complete — ${status.sentCount} sent, ${status.failedCount} failed (see list)`
                : `Send complete — ${status.sentCount} sent`,
            status.failedCount > 0 || status.status === 'CANCELLED' ? 'warning' : 'success',
          );
        }
      } catch {
        /* ignore transient poll errors */
      }
    }

    void poll();
    const interval = window.setInterval(poll, 2500);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [sendOpen, sendPhase, id, isNew]);

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

  const previewWidth =
    previewMode === 'mobile' ? 375 : previewMode === 'tablet' ? 768 : previewMode === 'dark' ? 600 : '100%';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Input
            className="w-full border-0 bg-transparent px-0 font-display text-xl shadow-none focus:ring-0 sm:text-2xl"
            value={campaign.name || ''}
            onChange={(e) => setCampaign({ ...campaign, name: e.target.value })}
          />
          <p className="text-sm text-ink-muted">Select a template · set subject & list · send</p>
        </div>
        <div className="page-toolbar">
          <span className="mr-1 hidden text-[10px] uppercase tracking-wide text-ink-muted sm:inline">
            {autoSaveState === 'saving'
              ? 'Saving…'
              : autoSaveState === 'saved'
                ? 'Saved'
                : autoSaveState === 'dirty'
                  ? 'Unsaved…'
                  : autoSaveState === 'error'
                    ? 'Save failed'
                    : ''}
          </span>
          <Button variant="outline" size="sm" onClick={() => void save(false)} disabled={saving}>
            Save
          </Button>
          <Button variant="outline" size="sm" onClick={scrubSpam} disabled={saving || isNew}>
            <Eraser className="h-4 w-4" /> <span className="hidden sm:inline">Clean spam words</span><span className="sm:hidden">Scrub</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => save(true)} disabled={saving}>
            <span className="hidden sm:inline">Analyze deliverability</span><span className="sm:hidden">Analyze</span>
          </Button>
          <Button size="sm" onClick={openSendFlow} disabled={saving || isNew || !deliverability.canSend}>
            <Send className="h-4 w-4" /> Send
          </Button>
          {!isNew ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={saving || campaign.status === 'SENDING'}
              title={campaign.status === 'SENDING' ? 'Cancel send before deleting' : 'Delete campaign'}
              onClick={() => void deleteCurrentCampaign()}
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          ) : null}
        </div>
      </div>


      <SendProgressModal
        open={sendOpen}
        phase={sendPhase}
        sendCount={sendCount}
        sentCount={sentCount}
        failedCount={failedCount}
        recentFailures={recentFailures}
        errorMessage={sendError}
        fromLabel={fromLabel}
        batchSize={queueSettings.batchSize}
        batchPauseSeconds={Math.max(1, Math.round(queueSettings.batchPauseMs / 1000))}
        cancelled={sendCancelled}
        paused={sendPaused}
        onConfirmSend={() => void confirmBackgroundSend(false)}
        onForceSend={() => void confirmBackgroundSend(true)}
        onCancelSend={cancelBackgroundSend}
        onPauseSend={() => void pauseBackgroundSend()}
        onResumeSend={() => void resumeBackgroundSend()}
        onRetryFailed={() => void retryFailedSend()}
        onClose={() => setSendOpen(false)}
      />

      {viewHtmlOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 px-4 font-mono">
          <button
            type="button"
            className="absolute inset-0"
            onClick={() => {
              if (savingHtml) return;
              setViewHtmlOpen(false);
              setViewHtmlBlockId(null);
            }}
            aria-label="Close"
          />
          <div className="relative z-10 flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden border border-border bg-card text-foreground shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-accent">Edit HTML</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {campaign.templateId
                    ? 'Changes save to this campaign and the linked template'
                    : 'Changes save to this campaign. Link a template to update Templates too.'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={savingHtml}
                  onClick={() => {
                    void navigator.clipboard.writeText(viewHtmlDraft);
                    flash('HTML copied to clipboard', 'info');
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingHtml || !viewHtmlDraft.trim()}
                  onClick={() => void saveHtmlFromModal()}
                >
                  {savingHtml ? 'Saving…' : 'Save'}
                </Button>
                <button
                  type="button"
                  disabled={savingHtml}
                  onClick={() => {
                    setViewHtmlOpen(false);
                    setViewHtmlBlockId(null);
                  }}
                  className="border border-border p-2 text-muted-foreground hover:text-primary disabled:opacity-50"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <Textarea
              value={viewHtmlDraft}
              onChange={(e) => setViewHtmlDraft(e.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded-none border-0 bg-background px-5 py-4 font-mono text-[11px] leading-relaxed focus-visible:ring-0"
              style={{ minHeight: '55vh' }}
            />
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,320px)]">
        {/* Settings + blocks */}
        <div className="space-y-4">
          <Card className="space-y-3">
            <h3 className="font-medium">Campaign settings</h3>
            <div>
              <Label>HTML template</Label>
              <Select
                value={campaign.templateId || ''}
                disabled={templateLoading}
                onChange={(e) => void applyTemplate(e.target.value)}
              >
                <option value="">Select imported template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Import templates on the{' '}
                <Link to="/app/templates" className="text-primary underline">
                  Templates
                </Link>{' '}
                page, then pick one here to send.
              </p>
            </div>
            <div>
              <Label>Type</Label>
              <Select
                value={campaign.type}
                onChange={(e) => setCampaign({ ...campaign, type: e.target.value })}
              >
                <option value="REGULAR">Regular Email</option>
                <option value="SCHEDULED">Scheduled Email</option>
                <option value="AUTOMATED">Automated Email</option>
                <option value="DRIP">Drip Campaign</option>
              </Select>
            </div>
            <div>
              <Label>Subject</Label>
              <div className="flex gap-2">
                <Input
                  value={campaign.subject || ''}
                  onChange={(e) => setCampaign({ ...campaign, subject: e.target.value })}
                />
                <Button variant="ghost" size="sm" onClick={generateSubjects} disabled={aiLoading} title="AI subjects">
                  <Sparkles className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div>
              <Label>Subject pool (one per line)</Label>
              <Textarea
                value={subjectPoolText}
                onChange={(e) => setSubjectPoolText(e.target.value)}
                className="min-h-18 text-xs"
                placeholder="Optional variants — rotated randomly per recipient"
              />
            </div>
            <div>
              <Label>From-name pool (one per line)</Label>
              <Textarea
                value={fromNamePoolText}
                onChange={(e) => setFromNamePoolText(e.target.value)}
                className="min-h-14 text-xs"
                placeholder="Optional names tied to verified SMTP From"
              />
            </div>
            <div>
              <Label>Preview text</Label>
              <Input
                value={campaign.previewText || ''}
                onChange={(e) => setCampaign({ ...campaign, previewText: e.target.value })}
              />
            </div>
            <div>
              <Label>SMTP / provider</Label>
              <Select
                value={campaign.providerId || 'rotate'}
                onChange={(e) => {
                  const nextId = e.target.value === 'rotate' ? null : e.target.value;
                  const p = providers.find((x) => x.id === nextId);
                  setCampaign({
                    ...campaign,
                    providerId: nextId,
                    senderName: campaign.senderName || p?.fromName || '',
                    senderEmail: campaign.senderEmail || p?.fromEmail || '',
                  });
                }}
              >
                <option value="rotate">Auto-rotate (all active SMTPs)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isDefault ? ' (default)' : ''} · {p.type}
                  </option>
                ))}
              </Select>
            </div>
            <div className="border border-border bg-background px-3 py-2 text-xs">
              <div className="uppercase tracking-wider text-accent">From preview</div>
              <div className="mt-1 truncate text-sm text-primary">{fromLabel}</div>
            </div>
            <div>
              <Label>Sender name</Label>
              <Input
                value={campaign.senderName || ''}
                onChange={(e) => setCampaign({ ...campaign, senderName: e.target.value })}
                placeholder={selectedProvider?.fromName || 'Shows in inbox — e.g. Acme Store'}
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                This is what recipients see. Fill it here (or on the SMTP profile), then Save before sending.
              </p>
            </div>
            <div>
              <Label>Sender email</Label>
              <Input
                value={campaign.senderEmail || ''}
                onChange={(e) => setCampaign({ ...campaign, senderEmail: e.target.value })}
                placeholder={selectedProvider?.fromEmail || ''}
              />
            </div>
            <div>
              <Label>Audience list</Label>
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                onClick={async () => {
                  const name = await promptDialog('New list name', {
                    description: 'Create a new contact list to organize your audience.',
                    placeholder: 'e.g. Q4 launch prospects',
                    validate: (v) => (!v.trim() ? 'Enter a list name' : null),
                    confirmText: 'Create list',
                  });
                  if (!name?.trim()) return;
                  try {
                    const data = await api.post<{ list: { id: string; name: string } }>('/api/lists', {
                      name: name.trim(),
                    });
                    const refreshed = await api.get<{
                      lists: Array<{ id: string; name: string; _count?: { members: number } }>;
                    }>('/api/lists');
                    setLists(refreshed.lists);
                    setCampaign({ ...campaign, listId: data.list.id });
                    flash(
                      `List “${data.list.name}” created. Add contacts to it from Contacts, then send.`,
                      'info',
                    );
                  } catch (err) {
                    flash(err instanceof Error ? err.message : 'Could not create list', 'error');
                  }
                }}
              >
                + Create list
              </Button>
              {!lists.length ? (
                <p className="mt-1 text-[11px] text-warning">
                  No lists yet — create one, then add contacts before sending.
                </p>
              ) : null}
            </div>
          </Card>

          <Card className="space-y-3">
            <h3 className="font-medium text-xs uppercase tracking-wider text-accent">Intelligent queue</h3>
            <p className="text-[11px] text-muted-foreground">
              Human-like pacing: ~4s between emails (±jitter), small batches, longer pauses. Faster bursts look automated and hurt inbox placement.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Batch size</Label>
                <Input
                  type="number"
                  value={queueSettings.batchSize}
                  onChange={(e) =>
                    setQueueSettings({ ...queueSettings, batchSize: Number(e.target.value) || 5 })
                  }
                />
              </div>
              <div>
                <Label>Batch pause (ms)</Label>
                <Input
                  type="number"
                  value={queueSettings.batchPauseMs}
                  onChange={(e) =>
                    setQueueSettings({
                      ...queueSettings,
                      batchPauseMs: Number(e.target.value) || 30_000,
                    })
                  }
                />
              </div>
              <div>
                <Label>Between emails (ms)</Label>
                <Input
                  type="number"
                  value={queueSettings.betweenEmailMs}
                  onChange={(e) =>
                    setQueueSettings({
                      ...queueSettings,
                      betweenEmailMs: Number(e.target.value) || 4_000,
                    })
                  }
                />
              </div>
              <div>
                <Label>Max / minute</Label>
                <Input
                  type="number"
                  value={queueSettings.maxPerMinute}
                  onChange={(e) =>
                    setQueueSettings({
                      ...queueSettings,
                      maxPerMinute: Number(e.target.value) || 60,
                    })
                  }
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Sends in batches with a pause between them. Pause / resume / retry from the send modal
              or the{' '}
              <Link to="/app/queue" className="text-primary underline">
                Queue Console
              </Link>
              .
            </p>
          </Card>

          <Card className="space-y-3">
            <h3 className="font-medium text-xs uppercase tracking-wider text-accent">
              Subject / sender test matrix
            </h3>
            <p className="text-[11px] text-muted-foreground">
              QA before a big send — emails each subject × from-name combo with a [TEST] prefix.
              Use <span className="text-foreground">Send placement test</span> for one copy of your
              current template, then check Primary/Inbox and Spam/Promotions yourself.
            </p>
            <div>
              <Label>Send tests to</Label>
              <Input
                value={testMatrixTo}
                onChange={(e) => setTestMatrixTo(e.target.value)}
                placeholder="you@gmail.com"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={isNew || saving || busyPlacementTest}
                onClick={() => void runPlacementTest()}
              >
                {busyPlacementTest ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Send placement test
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={isNew || saving || busyTestMatrix}
                onClick={() => void runTestMatrix()}
              >
                {busyTestMatrix ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Run test matrix
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isNew}
                onClick={() => void exportCampaignConfig()}
              >
                Export config
              </Button>
            </div>
          </Card>

          <Card className="space-y-3">
            <h3 className="font-medium text-xs uppercase tracking-wider text-accent">Import to library</h3>
            <p className="text-[11px] text-muted-foreground">
              Uploads are saved to your template library and can be selected above.
            </p>
            <input
              type="file"
              accept=".html,.htm,.mjml,.txt"
              className="block w-full text-xs text-muted-foreground file:mr-3 file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-xs"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const content = await file.text();
                const format = file.name.endsWith('.mjml') ? 'mjml' : 'html';
                try {
                  setImportStatus('Importing…');
                  const result = await templateService.importHtml({
                    filename: file.name,
                    content,
                    format,
                    campaignId: isNew ? undefined : id,
                    name: campaign.name,
                    templateName: file.name.replace(/\.(html|htm|mjml|txt)$/i, ''),
                    saveAsTemplate: true,
                  });

                  const scrubbed = scrubImportedHtml(result.html, result.plainText);
                  const cleanHtml = scrubbed.htmlContent;
                  const cleanPlain = scrubbed.plainTextContent || result.plainText;

                  if (result.template) {
                    setTemplates((prev) => {
                      const exists = prev.some((t) => t.id === result.template!.id);
                      if (exists) return prev;
                      return [result.template!, ...prev];
                    });
                    setBlocks(templateHtmlToBlocks(cleanHtml));
                    setCampaign((c) => ({
                      ...c,
                      templateId: result.template!.id,
                      htmlContent: cleanHtml,
                      plainTextContent: cleanPlain,
                      name: c.name && c.name !== 'Untitled campaign' ? c.name : result.template!.name,
                    }));
                    if (!isNew && id) {
                      await api.patch(`/api/campaigns/${id}`, {
                        templateId: result.template.id,
                        htmlContent: cleanHtml,
                        plainTextContent: cleanPlain,
                        editorJson: { blocks: templateHtmlToBlocks(cleanHtml) },
                      });
                    }
                  } else {
                    setBlocks(templateHtmlToBlocks(cleanHtml));
                    setCampaign((c) => ({
                      ...c,
                      htmlContent: cleanHtml,
                      plainTextContent: cleanPlain,
                    }));
                  }

                  const notes = [
                    ...result.validation.flags.map((f) => `Flag: ${f}`),
                    ...result.validation.warnings.map((w) => `Warn: ${w}`),
                  ];
                  flash(
                    notes.length
                      ? `Imported — ${notes.slice(0, 2).join(' · ')}`
                      : 'Template imported and spam-filtered',
                    'success',
                  );
                  setImportStatus('');
                } catch (err) {
                  flash(err instanceof Error ? err.message : 'Import failed', 'error');
                  setImportStatus('');
                } finally {
                  e.target.value = '';
                }
              }}
            />
            {importStatus ? <p className="text-xs text-primary">{importStatus}</p> : null}
          </Card>

          <Card>
            <h3 className="font-medium mb-3">Blocks (optional)</h3>
            <div className="grid grid-cols-2 gap-2">
              {BLOCK_TYPES.map((b) => (
                <button
                  key={b.type}
                  onClick={() => addBlock(b.type)}
                  className="flex items-center gap-2 border border-border px-2 py-2 text-xs hover:border-primary hover:bg-primary/10"
                >
                  <b.icon className="h-3.5 w-3.5 text-primary" />
                  {b.label}
                </button>
              ))}
            </div>
          </Card>
        </div>

        {/* Canvas */}
        <Card className="min-h-160">
          <div className="flex flex-wrap items-center gap-2 mb-4 border-b border-border pb-3">
            {(['desktop', 'tablet', 'mobile', 'dark'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setPreviewMode(m)}
                className={cn(
                  'border px-3 py-1 text-xs capitalize',
                  previewMode === m
                    ? 'border-primary/40 bg-primary text-primary-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:text-primary',
                )}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="text-xs text-ink-muted mb-2 capitalize">Preview · {previewMode}</div>

          <div className="mx-auto transition-all" style={{ width: previewWidth, maxWidth: '100%' }}>
            <div className="space-y-2 mb-4">
              {blocks.map((block, idx) => (
                <motion.div
                  key={block.id}
                  layout
                  className="group border border-dashed border-border p-3 hover:border-primary"
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase text-ink-muted">
                    <span>{block.type}</span>
                    <div className="flex items-center gap-2">
                      {block.type === 'html' ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-primary opacity-100 hover:underline"
                          onClick={() => openHtmlViewer(block.id, block.content || html)}
                          title="View / edit full HTML"
                        >
                          <Eye className="h-3 w-3" />
                          View
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 hover:text-destructive"
                        onClick={() => setBlocks((bs) => bs.filter((_, i) => i !== idx))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {block.type === 'html' || block.type === 'text' || block.type === 'products' || block.type === 'countdown' ? (
                    <Textarea
                      className="min-h-15"
                      value={block.content}
                      onChange={(e) =>
                        setBlocks((bs) => bs.map((b, i) => (i === idx ? { ...b, content: e.target.value } : b)))
                      }
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData('text');
                        if (!pasted.trim()) return;
                        e.preventDefault();
                        const scrubbed =
                          block.type === 'html'
                            ? scrubSpamFromHtml(pasted)
                            : scrubSpamFromText(pasted, { trim: false });
                        const next = scrubbed.text;
                        const el = e.currentTarget;
                        const start = el.selectionStart ?? block.content.length;
                        const end = el.selectionEnd ?? start;
                        const merged = block.content.slice(0, start) + next + block.content.slice(end);
                        setBlocks((bs) => bs.map((b, i) => (i === idx ? { ...b, content: merged } : b)));
                        if (scrubbed.changed && scrubbed.removed.length) {
                          flash(
                            `Spam phrases removed from paste: ${scrubbed.removed.slice(0, 5).join(', ')}`,
                            'info',
                          );
                        }
                      }}
                    />
                  ) : block.type === 'button' ? (
                    <div className="space-y-2">
                      <Input
                        placeholder="Button label"
                        value={block.content}
                        onChange={(e) =>
                          setBlocks((bs) => bs.map((b, i) => (i === idx ? { ...b, content: e.target.value } : b)))
                        }
                      />
                      <Input
                        placeholder="https://example.com"
                        value={block.props?.href || ''}
                        onChange={(e) =>
                          setBlocks((bs) =>
                            bs.map((b, i) =>
                              i === idx ? { ...b, props: { ...b.props, href: e.target.value } } : b,
                            ),
                          )
                        }
                      />
                    </div>
                  ) : block.type === 'image' || block.type === 'video' ? (
                    <div className="space-y-2">
                      <Input
                        placeholder={block.type === 'video' ? 'Thumbnail image URL' : 'Image URL'}
                        value={block.props?.src || ''}
                        onChange={(e) =>
                          setBlocks((bs) =>
                            bs.map((b, i) =>
                              i === idx ? { ...b, props: { ...b.props, src: e.target.value } } : b,
                            ),
                          )
                        }
                      />
                      {block.type === 'video' ? (
                        <Input
                          placeholder="Video link URL"
                          value={block.props?.href || ''}
                          onChange={(e) =>
                            setBlocks((bs) =>
                              bs.map((b, i) =>
                                i === idx ? { ...b, props: { ...b.props, href: e.target.value } } : b,
                              ),
                            )
                          }
                        />
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-xs text-ink-muted py-2">Configured automatically for preview</div>
                  )}
                </motion.div>
              ))}
            </div>

            <div className="overflow-hidden border border-border">
              {html.trim() ? (
                <iframe title="preview" srcDoc={html} className="h-105 w-full bg-[#f8faf8]" />
              ) : (
                <div className="flex h-105 flex-col items-center justify-center gap-2 bg-[#f8faf8] p-6 text-center text-sm text-muted-foreground">
                  <p>Select an HTML template from the dropdown to preview your email.</p>
                  <Link to="/app/templates" className="text-primary underline">
                    Or import templates
                  </Link>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Deliverability panel */}
        <div className="space-y-4">
          <Card>
            <CampaignDeliverabilityPanel
              subject={campaign.subject || ''}
              previewText={campaign.previewText || undefined}
              htmlBody={html}
              recipientCount={listMemberCount}
              hasActiveSmtp={hasActiveSmtp}
              fromEmail={fromEmail || undefined}
            />
          </Card>

          <Card>
            <h3 className="font-medium mb-3">Inbox readiness</h3>
            {report ? (
              <>
                <ScoreGauge score={report.inboxReadiness.overall} />
                <div className="mt-4 space-y-2">
                  {Object.entries(report.inboxReadiness.breakdown).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="text-ink-muted">{k}</span>
                      <span className="font-medium" style={{ color: scoreColor(v) }}>
                        {Math.round(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-muted">Save & analyze to see your score.</p>
            )}
          </Card>

          {report && (
            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium">Deliverability</h3>
                <span className="text-lg font-semibold" style={{ color: scoreColor(report.score) }}>
                  {report.score}/100
                </span>
              </div>
              <Badge
                tone={
                  report.rating === 'excellent' || report.rating === 'good'
                    ? 'success'
                    : report.rating === 'needs_improvement'
                      ? 'warning'
                      : 'danger'
                }
              >
                {report.rating.replace('_', ' ')}
              </Badge>
              <div className="mt-4 space-y-3 max-h-105 overflow-auto">
                {report.issues.map((issue) => (
                  <div key={issue.id} className="border border-border p-3 text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge
                        tone={
                          issue.severity === 'critical' || issue.severity === 'high'
                            ? 'danger'
                            : issue.severity === 'medium'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {issue.severity}
                      </Badge>
                      <span className="font-medium">{issue.title}</span>
                    </div>
                    <p className="text-ink-muted text-xs mb-2">{issue.explanation}</p>
                    <p className="text-xs text-primary">
                      <strong>Fix:</strong> {issue.suggestedFix}
                    </p>
                  </div>
                ))}
              </div>
              {report.subjectAnalysis?.alternatives?.length ? (
                <div className="mt-4">
                  <div className="text-xs font-medium text-ink-muted mb-2">Subject alternatives</div>
                  {report.subjectAnalysis.alternatives.map((alt) => (
                    <button
                      key={alt}
                      className="mb-1 block w-full px-2 py-1.5 text-left text-sm hover:bg-primary/10"
                      onClick={() => setCampaign({ ...campaign, subject: alt })}
                    >
                      {alt}
                    </button>
                  ))}
                </div>
              ) : null}
            </Card>
          )}

          <Card className="space-y-2">
            <h3 className="font-medium">Export</h3>
            <p className="text-xs text-muted-foreground">
              Campaigns send as HTML email. Download the compiled HTML for backup or use in another tool.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                const blob = new Blob([html], { type: 'text/html' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${(campaign.name || 'email').replace(/\s+/g, '-').toLowerCase()}.html`;
                a.click();
              }}
            >
              <Copy className="h-4 w-4" /> Export HTML
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                void navigator.clipboard.writeText(html);
                flash('HTML copied to clipboard', 'info');
              }}
            >
              Copy HTML
            </Button>
          </Card>
        </div>
      </div>

      {!isNew && id && campaign.status && ['SENT', 'SENDING', 'PAUSED', 'CANCELLED', 'FAILED'].includes(campaign.status) ? (
        <CampaignRecipientsPanel
          campaignId={id}
          campaignName={campaign.subject || campaign.name}
          sentAt={campaign.sentAt}
        />
      ) : null}
    </div>
  );
}

function ScoreGauge({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-4">
      <div
        className="score-ring h-20 w-20 rounded-full p-1.5"
        style={{ ['--score' as string]: score, ['--score-color' as string]: scoreColor(score) }}
      >
        <div className="flex h-full w-full items-center justify-center rounded-full bg-card">
          <span className="text-xl font-semibold" style={{ color: scoreColor(score) }}>
            {score}
          </span>
        </div>
      </div>
      <div>
        <div className="font-medium">{scoreLabel(score)}</div>
        <div className="text-sm text-ink-muted">Inbox readiness score</div>
      </div>
    </div>
  );
}
