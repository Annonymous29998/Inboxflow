import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { api } from '@/lib/api';
import { campaignSendService } from '@/services/campaign-send.service';
import { smtpService } from '@/services/smtp.service';
import { templateHtmlToBlocks, templateService, type EmailTemplateSummary } from '@/services/template.service';
import {
  CampaignDeliverabilityPanel,
  useCampaignDeliverability,
} from '@/components/campaigns/CampaignDeliverabilityPanel';
import { scrubCampaignEditorContent } from '@/lib/spam-content-filter';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { cn, scoreColor, scoreLabel } from '@/lib/utils';
import { SendProgressModal, type SendFlowPhase } from '@/components/campaigns/SendProgressModal';
import { toast } from '@/stores/toast';

function flash(message: string, tone: 'success' | 'error' | 'warning' | 'info' = 'success') {
  if (!message) return;
  if (tone === 'error') toast.error(message);
  else if (tone === 'warning') toast.warning(message);
  else if (tone === 'info') toast.info(message);
  else toast.success(message);
}

type ProviderOption = {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  isActive: boolean;
  fromEmail?: string;
  fromName?: string;
  lastTestStatus?: string | null;
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
  deliverabilityScore?: number | null;
  inboxReadinessScore?: number | null;
  analysisReport?: DeliverabilityReport | null;
  trackOpens?: boolean;
  trackClicks?: boolean;
  editorJson?: { blocks?: EditorBlock[] } | null;
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
  const navigate = useNavigate();

  async function load() {
    const d = await api.get<{ campaigns: Campaign[] }>('/api/campaigns');
    setCampaigns(d.campaigns);
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function deleteCampaign(c: Campaign, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (c.status === 'SENDING') {
      flash('Cancel the send first, then delete this campaign.', 'warning');
      return;
    }
    if (!confirm(`Delete “${c.name}”? This cannot be undone.`)) return;
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
        <Button className="w-full sm:w-auto" onClick={() => navigate('/app/campaigns/new')}>
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
            <Button onClick={() => navigate('/app/campaigns/new')}>
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
  const [campaign, setCampaign] = useState<Partial<Campaign>>({
    name: 'Untitled campaign',
    type: 'REGULAR',
    subject: '',
    previewText: '',
    senderName: '',
    senderEmail: '',
    trackOpens: true,
    trackClicks: true,
  });
  const [lists, setLists] = useState<Array<{ id: string; name: string; _count?: { members: number } }>>([]);
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'tablet' | 'mobile' | 'dark'>('desktop');
  const [report, setReport] = useState<DeliverabilityReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendPhase, setSendPhase] = useState<SendFlowPhase>('confirm');
  const [sendCount, setSendCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [sendCancelled, setSendCancelled] = useState(false);
  const [sendError, setSendError] = useState('');
  const [queueSettings, setQueueSettings] = useState({
    batchSize: 10,
    batchPauseMs: 5000,
    betweenEmailMs: 500,
    maxPerMinute: 60,
    maxPerHour: 2000,
  });
  const [importStatus, setImportStatus] = useState('');

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

  const fromName = campaign.senderName || selectedProvider?.fromName || 'Inbox Flow';
  const fromEmail = campaign.senderEmail || selectedProvider?.fromEmail || selectedProvider?.name || '';
  const fromLabel = fromEmail ? `${fromName} <${fromEmail}>` : fromName;

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
      api.get<{ campaign: Campaign & { queueSettings?: typeof queueSettings } }>(`/api/campaigns/${id}`).then((d) => {
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
      });
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
      const template = await templateService.get(templateId);
      const html = template.htmlContent?.trim() || '';
      if (!html) {
        flash('That template has no HTML content', 'error');
        return;
      }

      const nextBlocks =
        template.editorJson?.blocks?.length && template.editorJson.blocks[0]?.content
          ? template.editorJson.blocks
          : templateHtmlToBlocks(html);

      setBlocks(nextBlocks);
      setCampaign((c) => ({
        ...c,
        templateId,
        htmlContent: html,
        plainTextContent: template.plainText || c.plainTextContent,
        name: c.name && c.name !== 'Untitled campaign' ? c.name : template.name,
      }));
      flash(`Loaded template: ${template.name}`);

      if (!isNew && id) {
        await api.patch(`/api/campaigns/${id}`, {
          templateId,
          htmlContent: html,
          plainTextContent: template.plainText,
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

  async function save(andAnalyze = false) {
    setSaving(true);
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
        flash(`Deliverability score: ${result.report.score}/100 (${scoreLabel(result.report.score)})`);
      } else {
        flash('Saved');
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
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
      setSendCancelled(false);
      setSendError('');
      setSendOpen(true);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not prepare send', 'error');
    }
  }

  async function confirmBackgroundSend(force = false) {
    if (!id || isNew) return;
    setSendPhase('background');
    setSendCancelled(false);
    setSendError('');

    try {
      const result = await campaignSendService.startBackgroundSend(id, {
        providerId: campaign.providerId,
        force,
        queueSettings,
      });
      setSendCount(result.totalRecipients ?? sendCount);
      setSentCount(0);
      setFailedCount(0);
      setCampaign((c) => ({ ...c, status: 'SENDING' }));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed');
      setSendPhase('error');
    }
  }

  function cancelBackgroundSend() {
    if (id && !isNew) {
      void campaignSendService.cancel(id);
      setSendCancelled(true);
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
        if (status.totalRecipients > 0) setSendCount(status.totalRecipients);

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
              : `Send complete — ${status.sentCount} sent, ${status.failedCount} failed`,
            status.status === 'CANCELLED' ? 'warning' : 'success',
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
      flash(`AI suggestions: ${data.results.join(' · ', 'info')}`);
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
    if (!confirm(`Delete “${campaign.name || 'this campaign'}”? This cannot be undone.`)) return;
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
          <Button variant="outline" size="sm" onClick={() => save(false)} disabled={saving}>
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
        errorMessage={sendError}
        fromLabel={fromLabel}
        batchSize={queueSettings.batchSize}
        batchPauseSeconds={Math.max(1, Math.round(queueSettings.batchPauseMs / 1000))}
        cancelled={sendCancelled}
        onConfirmSend={() => void confirmBackgroundSend(false)}
        onForceSend={() => void confirmBackgroundSend(true)}
        onCancelSend={cancelBackgroundSend}
        onClose={() => setSendOpen(false)}
      />

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
                onChange={(e) =>
                  setCampaign({
                    ...campaign,
                    providerId: e.target.value === 'rotate' ? null : e.target.value,
                  })
                }
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
                placeholder={selectedProvider?.fromName || 'Inbox Flow'}
              />
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
                  const name = window.prompt('New list name');
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
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Batch size</Label>
                <Input
                  type="number"
                  value={queueSettings.batchSize}
                  onChange={(e) =>
                    setQueueSettings({ ...queueSettings, batchSize: Number(e.target.value) || 10 })
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
                      batchPauseMs: Number(e.target.value) || 5000,
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
                      betweenEmailMs: Number(e.target.value) || 500,
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
              Sends in batches with a pause between them. Cancel anytime from the send modal.
            </p>
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

                  if (result.template) {
                    setTemplates((prev) => {
                      const exists = prev.some((t) => t.id === result.template!.id);
                      if (exists) return prev;
                      return [result.template!, ...prev];
                    });
                    await applyTemplate(result.template.id);
                  } else {
                    setBlocks(templateHtmlToBlocks(result.html));
                    setCampaign((c) => ({
                      ...c,
                      htmlContent: result.html,
                      plainTextContent: result.plainText,
                    }));
                  }

                  const notes = [
                    ...result.validation.flags.map((f) => `Flag: ${f}`),
                    ...result.validation.warnings.map((w) => `Warn: ${w}`),
                  ];
                  setImportStatus(
                    notes.length
                      ? `Saved to library — ${notes.slice(0, 2).join(' · ')}`
                      : 'Template imported and applied',
                  );
                } catch (err) {
                  setImportStatus(err instanceof Error ? err.message : 'Import failed');
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
        <Card className="min-h-[640px]">
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
                  <div className="flex justify-between text-[10px] uppercase text-ink-muted mb-1">
                    <span>{block.type}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => setBlocks((bs) => bs.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </div>
                  {block.type === 'html' || block.type === 'text' || block.type === 'products' || block.type === 'countdown' ? (
                    <Textarea
                      className="min-h-[60px]"
                      value={block.content}
                      onChange={(e) =>
                        setBlocks((bs) => bs.map((b, i) => (i === idx ? { ...b, content: e.target.value } : b)))
                      }
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
                <iframe title="preview" srcDoc={html} className="h-[420px] w-full bg-[#f8faf8]" />
              ) : (
                <div className="flex h-[420px] flex-col items-center justify-center gap-2 bg-[#f8faf8] p-6 text-center text-sm text-muted-foreground">
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
              <div className="mt-4 space-y-3 max-h-[420px] overflow-auto">
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
