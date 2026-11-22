import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { isStaffRole } from '@/lib/roles';
import { api } from '@/lib/api';
import { smtpService } from '@/services/smtp.service';
import { templateService } from '@/services/template.service';
import { NewTemplateModal } from '@/components/templates/NewTemplateModal';
import { LetterPane } from '@/components/campaigns/LetterPane';
import type { CampaignAttachment } from '@/lib/letter-placeholders';
import { Button, Card, Input, Label, PageLoading, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ChevronDown, Copy, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from '@/stores/toast';
import { confirmDialog, promptDialog } from '@/stores/confirm';
import { uiCacheGet, uiCacheSet } from '@/lib/ui-cache';
import { WorkspaceOnDeviceNotice } from '@/components/campaigns/WorkspaceOnDeviceNotice';
import { isWorkspaceOnDeviceError, reportWorkspaceOnDevice } from '@/lib/workspace-on-device';

const TYPES = [
  'subject_lines',
  'headlines',
  'product_descriptions',
  'ctas',
  'email_body',
  'follow_ups',
  'welcome_emails',
  'promotional_emails',
  'newsletters',
] as const;

const TONES = ['professional', 'friendly', 'luxury', 'sales', 'educational'] as const;

export function AiPage() {
  const [type, setType] = useState<(typeof TYPES)[number]>('subject_lines');
  const [tone, setTone] = useState<(typeof TONES)[number]>('professional');
  const [prompt, setPrompt] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await api.post<{ results: string[]; source: string; notice?: string }>('/api/ai/generate', {
        type,
        tone,
        prompt,
        count: 5,
      });
      setResults(data.results);
      setSource(data.source + (data.notice ? ` — ${data.notice}` : ''));
      toast.success('AI suggestions ready', data.source);
    } catch (err) {
      setResults([err instanceof Error ? err.message : 'Failed']);
      toast.error('AI generate failed', err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="page-title">AI Email Assistant</h1>
        <p className="text-ink-muted">
          Generate deliverability-safe copy. Suggestions avoid common spam trigger phrases.
        </p>
      </div>

      <Card>
        <form onSubmit={generate} className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label>Content type</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Tone</Label>
              <Select value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label>Brief</Label>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          </div>
          <Button type="submit" disabled={loading}>
            <Sparkles className="h-4 w-4" />
            {loading ? 'Generating…' : 'Generate'}
          </Button>
        </form>
      </Card>

      {source && <p className="text-xs text-ink-muted">Source: {source}</p>}

      <div className="space-y-3">
        {results.map((r, i) => (
          <Card key={i}>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{r}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => navigator.clipboard.writeText(r)}
            >
              Copy
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function TemplatesPage() {
  const user = useAuthStore((s) => s.user);
  const [templates, setTemplates] = useState<
    Array<{ id: string; name: string; description?: string | null; isPublic: boolean; organizationId?: string | null }>
  >(() => uiCacheGet('templates') ?? []);
  const [loading, setLoading] = useState(() => !(uiCacheGet('templates') as unknown[] | null)?.length);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHtml, setEditHtml] = useState('');
  const [editName, setEditName] = useState('');
  const [placeholderMap, setPlaceholderMap] = useState<Record<string, string>>({});
  const [editAttachments, setEditAttachments] = useState<CampaignAttachment[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewContacts, setPreviewContacts] = useState<
    Array<{ email: string; firstName?: string | null; lastName?: string | null }>
  >([]);
  const [workspaceOnDevice, setWorkspaceOnDevice] = useState(false);

  async function load() {
    try {
      const d = await api.get<{ templates: typeof templates }>('/api/templates');
      setWorkspaceOnDevice(false);
      setTemplates(Array.isArray(d.templates) ? d.templates : []);
      uiCacheSet('templates', d.templates);
    } catch (err) {
      if (isWorkspaceOnDeviceError(err)) {
        setWorkspaceOnDevice(true);
        setTemplates([]);
        reportWorkspaceOnDevice(err);
        return;
      }
      toast.error('Could not load templates', err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
    api
      .get<{ contacts: Array<{ email: string; firstName?: string | null; lastName?: string | null }> }>(
        '/api/contacts?limit=40',
      )
      .then((d) => setPreviewContacts(Array.isArray(d.contacts) ? d.contacts.filter((c) => c.email) : []))
      .catch(() => setPreviewContacts([]));
  }, []);

  useEffect(() => {
    if (!editingId) return;
    let cancelled = false;
    setEditLoading(true);
    templateService
      .get(editingId)
      .then((t) => {
        if (cancelled) return;
        setEditName(t.name || '');
        setEditHtml(t.htmlContent || '');
        setPlaceholderMap(t.editorJson?.placeholderMap || {});
        setEditAttachments([]);
      })
      .catch((err) => {
        toast.error('Could not open template', err instanceof Error ? err.message : undefined);
        setEditingId(null);
      })
      .finally(() => {
        if (!cancelled) setEditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId]);

  async function createTemplate(input: { name: string; file: File | null }) {
    try {
      let nextId: string | undefined;
      if (input.file) {
        const content = await input.file.text();
        const format = input.file.name.endsWith('.mjml') ? 'mjml' : 'html';
        const result = await templateService.importHtml({
          filename: input.file.name,
          content,
          format,
          templateName: input.name,
          saveAsTemplate: true,
        });
        toast.success('Template imported', input.name);
        nextId = result.template?.id;
        if (result.removed?.length) {
          toast.info(
            'Spam phrases cleaned for inbox placement',
            result.removed.slice(0, 6).join(', ') + (result.removed.length > 6 ? '…' : ''),
          );
        }
      } else {
        const created = await api.post<{ template: { id: string } }>('/api/templates', {
          name: input.name,
          htmlContent: '<p>{Hi|Hello} {{firstName}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
        });
        toast.success('Template created', input.name);
        nextId = created.template?.id;
      }
      await load();
      if (nextId) setEditingId(nextId);
    } catch (err) {
      toast.error('Could not create template', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }

  async function saveEditor() {
    if (!editingId) return;
    setSaving(true);
    try {
      await templateService.update(editingId, {
        name: editName.trim() || undefined,
        htmlContent: editHtml,
        editorJson: { placeholderMap },
      });
      toast.success('Template saved', editName.trim() || 'Letter');
      await load();
    } catch (err) {
      toast.error('Could not save template', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  async function remove(t: (typeof templates)[number]) {
    if (!(await confirmDialog({
      title: `Delete template`,
      description: `Permanently delete template “${t.name}”?\n\nCampaigns already using this template keep their saved body copy, but the reusable source template is gone and cannot be recovered.`,
      tone: 'danger',
      destructive: true,
      confirmText: 'Delete template',
    }))) return;
    setDeletingId(t.id);
    try {
      await api.delete(`/api/templates/${t.id}`);
      setTemplates((list) => list.filter((item) => item.id !== t.id));
      toast.success('Template deleted', t.name);
    } catch (err) {
      toast.error('Could not delete template', err instanceof Error ? err.message : undefined);
    } finally {
      setDeletingId(null);
    }
  }

  const q = filter.trim().toLowerCase();
  const visible = q
    ? templates.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q) ||
          (t.isPublic ? 'public' : 'private').includes(q),
      )
    : templates;

  return (
    <div className="mailer-root page-root space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mailer-hint" style={{ marginTop: 0 }}>
            library · templates
          </p>
          <h1 className="page-title text-primary">Templates</h1>
          <p className="page-sub">
            {templates.length} letter{templates.length === 1 ? '' : 's'} · import HTML or start blank · merge tags, spin, preview as a contact — same tools as the campaign Letter tab
          </p>
        </div>
        <Button
          className="w-full sm:w-auto"
          disabled={workspaceOnDevice}
          onClick={() => {
            if (workspaceOnDevice) {
              reportWorkspaceOnDevice();
              return;
            }
            setNewTemplateOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> New template
        </Button>
      </div>

      <NewTemplateModal
        open={newTemplateOpen}
        onClose={() => setNewTemplateOpen(false)}
        onCreate={createTemplate}
      />

      {templates.length > 4 ? (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter templates…"
          className="max-w-md"
        />
      ) : null}

      {loading ? (
        <PageLoading label="Loading templates…" />
      ) : visible.length ? (
        <div className="space-y-2">
          {visible.map((t) => (
            <div key={t.id} className="camp-row">
              <div className="camp-row-main">
                <strong>{t.name}</strong>
                <div className="meta">
                  {t.description || (t.isPublic ? 'Public template' : 'Private letter')}
                </div>
              </div>
              <div className="camp-row-actions">
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(t.id)}>
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={deletingId === t.id}
                  onClick={() => void remove(t)}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : workspaceOnDevice ? (
        <WorkspaceOnDeviceNotice />
      ) : !templates.length ? (
        <div className="mailer-panel">
          <div className="mailer-pad space-y-3">
            <p className="mailer-hint" style={{ marginTop: 0 }}>
              No templates yet. Import an HTML or MJML letter, or start blank. Imported letters from the campaign Letter tab also land here.
            </p>
            <Button onClick={() => setNewTemplateOpen(true)}>
              <Plus className="h-4 w-4" /> New template
            </Button>
          </div>
        </div>
      ) : (
        <div className="mailer-panel">
          <div className="mailer-pad">
            <p className="mailer-hint" style={{ marginTop: 0 }}>
              No templates match “{filter.trim()}”.
            </p>
          </div>
        </div>
      )}

      {editingId ? (
        <div className="mailer-root fixed inset-0 z-[80] flex flex-col bg-[var(--mailer-bg,#0b0d10)]">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--mailer-stroke)] px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="mailer-hint" style={{ marginTop: 0 }}>
                library · edit letter
              </p>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="max-w-md"
                aria-label="Template name"
              />
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                Close
              </Button>
              <Button type="button" disabled={saving || editLoading} onClick={() => void saveEditor()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {editLoading ? (
              <PageLoading label="Loading letter…" />
            ) : (
              <LetterPane
                html={editHtml}
                onHtmlChange={setEditHtml}
                placeholderMap={placeholderMap}
                onPlaceholderMap={setPlaceholderMap}
                attachments={editAttachments}
                onAttachments={setEditAttachments}
                previewContacts={previewContacts}
                senderName={user?.firstName}
                physicalAddress={user?.organization?.physicalAddress}
                showPlaceholderTab
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isSendingApiKey(p: { type: string; viaApiKey?: boolean }) {
  return p.viaApiKey || p.type !== 'SMTP';
}

function SettingsFold({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mailer-panel">
      <div className="mailer-pad">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mb-1 flex w-full items-center justify-between gap-3 text-left"
        >
          <h2 className="text-sm uppercase tracking-wide text-[var(--mailer-dim)]">{title}</h2>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-[var(--mailer-dim)] transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
        {open ? <div className="mt-3">{children}</div> : null}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const acceptSession = useAuthStore((s) => s.acceptSession);
  const staff = isStaffRole(user?.role);
  const bindOn = staff && Boolean(user?.boundIp) && user?.smtpAllowDirect === false;
  const [bindBusy, setBindBusy] = useState(false);
  const [keys, setKeys] = useState<Array<{ id: string; name: string; keyPrefix: string; createdAt: string }>>([]);
  const [providers, setProviders] = useState<
    Array<{
      id: string;
      name: string;
      type: string;
      isDefault: boolean;
      isActive: boolean;
      fromEmail?: string;
      host?: string;
      viaApiKey?: boolean;
    }>
  >([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [address, setAddress] = useState('');
  const [sessions, setSessions] = useState<Array<{ id: string; userAgent?: string; ipAddress?: string; createdAt: string }>>([]);
  const [apiName, setApiName] = useState('');
  const [apiHost, setApiHost] = useState('');
  const [apiPort, setApiPort] = useState('587');
  const [apiUser, setApiUser] = useState('apikey');
  const [apiKey, setApiKey] = useState('');
  const [apiFromEmail, setApiFromEmail] = useState('');
  const [apiFromName, setApiFromName] = useState('');
  const [savingSendKey, setSavingSendKey] = useState(false);
  const [workspaceOnDevice, setWorkspaceOnDevice] = useState(false);

  async function load() {
    try {
      const [k, s, me] = await Promise.all([
        api.get<{ keys: typeof keys }>('/api/api-keys'),
        api.get<{ sessions: typeof sessions }>('/api/auth/sessions'),
        api.get<{ user: { organization?: { physicalAddress?: string } } }>('/api/auth/me'),
      ]);
      setKeys(Array.isArray(k.keys) ? k.keys : []);
      setSessions(Array.isArray(s.sessions) ? s.sessions : []);
      setAddress(me.user?.organization?.physicalAddress || '');
    } catch (err) {
      toast.error('Could not load settings', err instanceof Error ? err.message : undefined);
    }
    try {
      const pvd = await api.get<{ providers: typeof providers }>('/api/providers');
      setWorkspaceOnDevice(false);
      setProviders(Array.isArray(pvd.providers) ? pvd.providers : []);
    } catch (err) {
      if (isWorkspaceOnDeviceError(err)) {
        setWorkspaceOnDevice(true);
        setProviders([]);
        return;
      }
      toast.error('Could not load SMTP profiles', err instanceof Error ? err.message : undefined);
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    try {
      const data = await api.post<{ key: { secret: string } }>('/api/api-keys', { name: newKeyName });
      setCreatedSecret(data.key.secret);
      setNewKeyName('');
      await load();
      toast.success('API key created', 'Copy the secret now — it won’t be shown again');
    } catch (err) {
      toast.error('Could not create API key', err instanceof Error ? err.message : undefined);
    }
  }

  async function createSendingApiKey(e: React.FormEvent) {
    e.preventDefault();
    if (!apiHost.trim()) {
      toast.error('Host is required');
      return;
    }
    if (!apiKey.trim()) {
      toast.error('API key is required');
      return;
    }
    if (!apiFromEmail.trim()) {
      toast.error('Sender email is required');
      return;
    }
    const port = apiPort.trim() || '587';
    const encryption = port === '465' ? 'SSL' : 'STARTTLS';
    const config: Record<string, string> = {
      host: apiHost.trim(),
      port,
      encryption,
      user: apiUser.trim() || 'apikey',
      pass: apiKey.trim(),
      apiKey: apiKey.trim(),
      viaApiKey: 'true',
      fromEmail: apiFromEmail.trim(),
      fromName: apiFromName.trim(),
    };
    setSavingSendKey(true);
    try {
      const data = await api.post<{ provider: { id: string } }>('/api/providers', {
        name: apiName.trim() || `${apiHost.trim()} ${apiFromEmail.trim()}`,
        type: 'SMTP',
        isActive: false,
        config,
      });
      const test = await smtpService.testConnection({ providerId: data.provider.id });
      if (test.success) {
        await smtpService.update(data.provider.id, { isActive: true });
        toast.success('Sending API key saved', 'Connection OK — it is in campaign SMTP / provider → API key');
      } else {
        toast.warning(
          'Key saved but connection failed',
          test.error || test.message || 'Fix host / API key, then test in SMTP Manager if needed',
        );
      }
      setApiName('');
      setApiHost('');
      setApiPort('587');
      setApiUser('apikey');
      setApiKey('');
      setApiFromEmail('');
      setApiFromName('');
      await load();
    } catch (err) {
      toast.error('Could not save sending API key', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingSendKey(false);
    }
  }

  async function toggleOperatorBind() {
    if (!staff || bindBusy) return;
    setBindBusy(true);
    try {
      if (bindOn) {
        const ok = await confirmDialog({
          title: 'Use Lightsail again?',
          description: 'SMTP will leave from Lightsail, not this RDP/VPS.',
          confirmText: 'Use Lightsail',
        });
        if (!ok) return;
        const off = await api.post<{ accessToken?: string }>('/api/workspace/operator-bind', { enabled: false });
        if (off.accessToken && user) {
          acceptSession({ user: { ...user, boundIp: null, smtpAllowDirect: true, workspaceLocal: false }, accessToken: off.accessToken });
        }
        await fetchMe(true);
        toast.success('Bind PC off', 'Send path is Lightsail default again');
        return;
      }
      let hint = '';
      try {
        const seen = await api.get<{ ip?: string }>('/api/auth/bind-ip');
        hint = String(seen.ip || '').trim();
      } catch {
        hint = '';
      }
      const typed = await promptDialog('Bind this RDP / VPS', {
        description: 'SMTP will leave from this PC instead of Lightsail. Enter this machine’s public IP.',
        placeholder: '203.0.113.10',
        defaultValue: hint,
        confirmText: 'Bind PC',
        validate: (v) => (v.trim() ? null : 'Enter the public IP'),
      });
      if (!typed?.trim()) return;
      const data = await api.post<{ boundIp?: string; accessToken?: string }>('/api/workspace/operator-bind', {
        enabled: true,
        boundIp: typed.trim(),
      });
      window.inboxflowDesktop?.saveBoundIp?.(data.boundIp || typed.trim());
      if (data.accessToken && user) {
        acceptSession({
          user: {
            ...user,
            boundIp: data.boundIp || typed.trim(),
            smtpAllowDirect: false,
            workspaceLocal: true,
          },
          accessToken: data.accessToken,
        });
      }
      await fetchMe(true);
      toast.success('PC bound', `Send uses ${data.boundIp || typed.trim()}`);
    } catch (err) {
      toast.error('Bind PC failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBindBusy(false);
    }
  }

  async function saveOrg(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.patch('/api/admin/organization', { physicalAddress: address });
      toast.success('Address saved');
    } catch (err) {
      toast.error('Could not save address', err instanceof Error ? err.message : undefined);
    }
  }

  return (
    <div className="mailer-root page-root max-w-4xl space-y-4">
      <div>
        <p className="mailer-hint" style={{ marginTop: 0 }}>
          system · settings
        </p>
        <h1 className="page-title text-primary">Settings</h1>
        <p className="page-sub">Organization, API keys, and sessions</p>
      </div>

      {staff ? (
        <div className="mailer-panel">
          <div className="mailer-pad flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Bind PC</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {bindOn
                  ? `On · SMTP leaves from ${user?.boundIp}`
                  : 'Off · SMTP leaves from Lightsail'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={bindOn}
              disabled={bindBusy}
              title="Bind PC"
              onClick={() => void toggleOperatorBind()}
              className={cn('mailer-switch', bindOn && 'on')}
            >
              <span className="mailer-switch-knob" />
              <span className="sr-only">Bind PC</span>
            </button>
          </div>
        </div>
      ) : null}

      <div className="mailer-panel">
        <div className="mailer-pad">
        <h2 className="mb-3 text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Physical mailing address (CAN-SPAM)</h2>
        <form onSubmit={saveOrg} className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, ST 00000"
          />
          <Button type="submit" className="shrink-0">
            Save
          </Button>
        </form>
        </div>
      </div>

      <SettingsFold title="Email providers">
        <p className="mb-4 text-sm text-ink-muted">
          SMTP profiles, testing, and rotation live in SMTP Manager.
        </p>
        <div className="mb-4 space-y-2">
          {providers.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 border border-border px-3 py-2 text-sm"
            >
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="text-ink-muted"> · {p.type}</span>
                {p.isDefault ? <span className="ml-2 text-xs font-medium text-primary">Default</span> : null}
                {!p.isActive ? <span className="ml-2 text-xs text-warning">Inactive</span> : null}
              </div>
            </div>
          ))}
          {!providers.length ? (
            workspaceOnDevice ? (
              <WorkspaceOnDeviceNotice />
            ) : (
              <p className="text-sm text-muted-foreground">No providers configured yet.</p>
            )
          ) : null}
        </div>
        <Link to="/app/smtp" className="inline-flex text-primary underline">
          Open SMTP Manager
        </Link>
      </SettingsFold>

      <SettingsFold title="Sending API keys">
        <p className="mb-4 text-sm text-ink-muted">
          Any provider that gives an SMTP host + API key (SendGrid, Mailgun, SMTP2GO, SES, Postmark, Brevo, …).
          Saved keys appear under campaign <span className="text-foreground">SMTP / provider → API key</span>.
          The sender email you enter here is the From used on send.
        </p>
        <form onSubmit={(e) => void createSendingApiKey(e)} className="mb-4 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label>Host</Label>
              <Input
                value={apiHost}
                onChange={(e) => setApiHost(e.target.value)}
                required
                placeholder="smtp.sendgrid.net"
                autoComplete="off"
              />
            </div>
            <div>
              <Label>Display name</Label>
              <Input
                value={apiName}
                onChange={(e) => setApiName(e.target.value)}
                placeholder="e.g. SMTP2GO production"
              />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label>Port</Label>
              <Input
                value={apiPort}
                onChange={(e) => setApiPort(e.target.value)}
                placeholder="587"
              />
            </div>
            <div>
              <Label>Username</Label>
              <Input
                value={apiUser}
                onChange={(e) => setApiUser(e.target.value)}
                placeholder="apikey"
              />
            </div>
          </div>
          <div>
            <Label>API key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              placeholder="Paste API key / SMTP password"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label>Sender email</Label>
              <Input
                type="email"
                value={apiFromEmail}
                onChange={(e) => setApiFromEmail(e.target.value)}
                required
                placeholder="donotreply@yourdomain.com"
              />
            </div>
            <div>
              <Label>Sender name (optional)</Label>
              <Input
                value={apiFromName}
                onChange={(e) => setApiFromName(e.target.value)}
                placeholder="Leave blank — campaign sender name is used"
              />
            </div>
          </div>
          <Button type="submit" disabled={savingSendKey}>
            {savingSendKey ? 'Saving…' : 'Save sending key'}
          </Button>
        </form>
        {providers
          .filter(isSendingApiKey)
          .map((p) => (
            <div key={p.id} className="flex justify-between gap-2 border-b border-border py-2 text-sm">
              <span>
                {p.name}
                {p.host ? ` · ${p.host}` : p.type !== 'SMTP' ? ` · ${p.type}` : ''}
                {p.fromEmail ? ` · ${p.fromEmail}` : ''}
                {p.isActive ? '' : ' · inactive'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: 'Remove sending key',
                      description: `Remove “${p.name}”? Campaigns will stop using it.`,
                      tone: 'danger',
                      destructive: true,
                      confirmText: 'Remove',
                    }))
                  )
                    return;
                  try {
                    await api.delete(`/api/providers/${p.id}`);
                    await load();
                    toast.success('Sending key removed');
                  } catch (err) {
                    toast.error('Could not remove key', err instanceof Error ? err.message : undefined);
                  }
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        {!providers.some(isSendingApiKey) ? (
          <p className="text-sm text-muted-foreground">No sending API keys yet.</p>
        ) : null}
      </SettingsFold>

      <div className="mailer-panel">
        <div className="mailer-pad">
        <h2 className="mb-1 text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Inbox Flow access keys</h2>
        <p className="mb-3 text-sm text-ink-muted">For scripts that call this app’s API — not for sending mail.</p>
        {createdSecret ? (
          <div className="mb-3 break-all border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            Copy now — shown once: <code>{createdSecret}</code>
          </div>
        ) : null}
        <form onSubmit={createKey} className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name"
            required
          />
          <Button type="submit" className="shrink-0">
            Create
          </Button>
        </form>
        {keys.map((k) => (
          <div key={k.id} className="flex justify-between border-b border-border py-2 text-sm">
            <span>
              {k.name} · {k.keyPrefix}…
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await api.delete(`/api/api-keys/${k.id}`);
                  await load();
                  toast.success('API key revoked');
                } catch (err) {
                  toast.error('Could not revoke key', err instanceof Error ? err.message : undefined);
                }
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
        {!keys.length ? <p className="text-sm text-muted-foreground">No Inbox Flow access keys yet.</p> : null}
        </div>
      </div>

      <SettingsFold title="Active sessions">
        {sessions.map((s) => (
          <div key={s.id} className="flex justify-between gap-4 border-b border-border py-2 text-sm">
            <div className="min-w-0 truncate">
              <div>{s.userAgent || 'Unknown device'}</div>
              <div className="text-xs text-ink-muted">
                {s.ipAddress} · {new Date(s.createdAt).toLocaleString()}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await api.delete(`/api/auth/sessions/${s.id}`);
                  await load();
                  toast.success('Session revoked');
                } catch (err) {
                  toast.error('Could not revoke session', err instanceof Error ? err.message : undefined);
                }
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
        {!sessions.length ? <p className="text-sm text-muted-foreground">No active sessions.</p> : null}
      </SettingsFold>
    </div>
  );
}

export function AdminPage() {
  return <Navigate to="/admin" replace />;
}

