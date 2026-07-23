import { useEffect, useMemo, useState } from 'react';
import { Check, Eye, EyeOff, Loader2, Plus, Server, Trash2, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { smtpService, type SmtpProfile } from '@/services/smtp.service';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/toast';

type FormState = {
  name: string;
  label: string;
  host: string;
  port: string;
  encryption: string;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  dailyLimit: string;
  hourlyLimit: string;
  priority: string;
  notes: string;
  isDefault: boolean;
};

const QUICK_FILLS: { id: string; label: string; patch: Partial<FormState> }[] = [
  {
    id: 'hostinger',
    label: 'Hostinger',
    patch: { host: 'smtp.hostinger.com', port: '465', encryption: 'SSL' },
  },
  {
    id: 'gmail',
    label: 'Gmail',
    patch: { host: 'smtp.gmail.com', port: '587', encryption: 'STARTTLS' },
  },
  {
    id: 'outlook',
    label: 'Outlook',
    patch: { host: 'smtp.office365.com', port: '587', encryption: 'STARTTLS' },
  },
  {
    id: 'ses',
    label: 'SES',
    patch: { host: 'email-smtp.us-east-1.amazonaws.com', port: '587', encryption: 'STARTTLS' },
  },
];

const emptyForm: FormState = {
  name: '',
  label: '',
  host: '',
  port: '587',
  encryption: 'STARTTLS',
  user: '',
  pass: '',
  fromName: '',
  fromEmail: '',
  replyTo: '',
  dailyLimit: '',
  hourlyLimit: '',
  priority: '10',
  notes: '',
  isDefault: false,
};

function autoSmtpName(form: FormState) {
  return (form.fromEmail || form.user || form.host || 'SMTP').trim();
}

function statusTone(status?: string | null) {
  if (status === 'Connected') return 'success' as const;
  if (status === 'Failed') return 'danger' as const;
  return 'warning' as const;
}

export function SmtpManagerPage() {
  const [providers, setProviders] = useState<SmtpProfile[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [testTo, setTestTo] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [lastTestOk, setLastTestOk] = useState(false);
  const [rotationEnabled, setRotationEnabled] = useState(true);
  const [rotationMode, setRotationMode] = useState<'failover' | 'round_robin' | 'weighted'>(
    'round_robin',
  );

  const selected = useMemo(
    () => providers.find((p) => p.id === editingId) || null,
    [providers, editingId],
  );

  async function load() {
    const data = await smtpService.list();
    setProviders(data);
  }

  async function loadRotation() {
    try {
      const data = await api.get<{
        organization: {
          sendSettings?: { smtpRotation?: { enabled?: boolean; mode?: string } };
        };
      }>('/api/admin/organization');
      const rot = data.organization.sendSettings?.smtpRotation;
      if (rot?.enabled != null) setRotationEnabled(!!rot.enabled);
      if (rot?.mode === 'failover' || rot?.mode === 'round_robin' || rot?.mode === 'weighted') {
        setRotationMode(rot.mode);
      }
    } catch {
      /* non-admin may lack access — ignore */
    }
  }

  useEffect(() => {
    load().catch(console.error);
    loadRotation().catch(() => undefined);
    api.get<{ user: { email?: string } }>('/api/auth/me').then((d) => {
      if (d.user.email) setTestTo(d.user.email);
    });
  }, []);

  async function saveRotation() {
    try {
      await api.patch('/api/admin/organization', {
        sendSettings: {
          smtpRotation: { enabled: rotationEnabled, mode: rotationMode },
        },
      });
      toast.success(
        'Rotation settings saved',
        rotationEnabled
          ? `${rotationMode.replace('_', ' ')} across active SMTPs (limits respected)`
          : 'Rotation disabled — campaigns use selected SMTP with priority failover',
      );
    } catch (err) {
      toast.error('Could not save rotation', err instanceof Error ? err.message : undefined);
    }
  }

  function applyQuickFill(id: string) {
    const fill = QUICK_FILLS.find((q) => q.id === id);
    if (!fill) return;
    setForm((f) => ({ ...f, ...fill.patch }));
    setLastTestOk(false);
  }

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowPass(false);
    setLastTestOk(false);
    setIssues([]);
  }

  async function startEdit(p: SmtpProfile) {
    setEditingId(p.id);
    setShowPass(false);
    setLastTestOk(p.lastTestStatus === 'Connected');
    const detail = await smtpService.get(p.id);
    const cfg = detail.config || {};
    setForm({
      name: detail.name,
      label: detail.label || '',
      host: cfg.host || detail.host || '',
      port: String(cfg.port || detail.port || '587'),
      encryption: cfg.encryption || detail.encryption || 'STARTTLS',
      user: cfg.user || detail.user || '',
      pass: cfg.pass && cfg.pass !== '••••••••' ? cfg.pass : '',
      fromName: cfg.fromName || detail.fromName || '',
      fromEmail: cfg.fromEmail || detail.fromEmail || '',
      replyTo: cfg.replyTo || detail.replyTo || '',
      dailyLimit: detail.dailyLimit != null ? String(detail.dailyLimit) : '',
      hourlyLimit: detail.hourlyLimit != null ? String(detail.hourlyLimit) : '',
      priority: String(detail.priority ?? 0),
      notes: detail.notes || '',
      isDefault: detail.isDefault,
    });
    setIssues(detail.issues || []);
  }

  function buildConfig() {
    return {
      host: form.host.trim(),
      port: form.port,
      encryption: form.encryption,
      secure: form.encryption === 'SSL' || form.encryption === 'TLS' ? 'true' : 'false',
      requireTLS: form.encryption === 'STARTTLS' ? 'true' : 'false',
      user: form.user,
      // Mask / empty keeps existing password on the server when editing
      pass: form.pass && form.pass !== '••••••••' ? form.pass : editingId ? '••••••••' : '',
      fromEmail: form.fromEmail,
      fromName: form.fromName,
      replyTo: form.replyTo,
    };
  }

  async function testConnection(sendEmail = false) {
    setBusy(true);
    toast.info(sendEmail ? 'Testing and sending…' : 'Testing connection…');
    try {
      if (sendEmail && !testTo.trim()) {
        setLastTestOk(false);
        toast.warning('Enter a recipient email for Test & send');
        return;
      }

      // Always include current form config so unsaved edits are tested.
      // When editing, also pass providerId so a masked password can reuse the stored secret.
      const result = await smtpService.testConnection({
        providerId: editingId || undefined,
        config: buildConfig(),
        sendTestEmail: sendEmail,
        testEmailTo: sendEmail ? testTo.trim() : undefined,
      });

      setLastTestOk(result.success);
      if (result.success) {
        toast.success(sendEmail ? 'Test email sent' : 'SMTP connected', result.message);
      } else {
        toast.error('SMTP test failed', result.error || result.message);
      }
      if (editingId) await load();
    } catch (err) {
      setLastTestOk(false);
      toast.error('SMTP test failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function save(activate: boolean) {
    setBusy(true);
    try {
      if (activate && !lastTestOk && (!selected || selected.lastTestStatus !== 'Connected')) {
        toast.warning('Run Test Connection successfully before activating');
        return;
      }
      const payload = {
        name: autoSmtpName(form),
        label: form.label.trim() || null,
        type: 'SMTP' as const,
        config: buildConfig(),
        isDefault: form.isDefault,
        isActive: false,
        dailyLimit: form.dailyLimit ? Number(form.dailyLimit) : null,
        hourlyLimit: form.hourlyLimit ? Number(form.hourlyLimit) : null,
        priority: Number(form.priority || 0),
        notes: form.notes || null,
      };

      let profileId = editingId;
      if (editingId) {
        await smtpService.update(editingId, payload);
      } else {
        const created = await smtpService.create(payload);
        profileId = created.id;
        setEditingId(profileId);
      }

      if (activate && profileId) {
        const test = await smtpService.testConnection({ providerId: profileId });
        if (!test.success) {
          toast.error('Saved, but activation blocked', 'Connection test failed');
          await load();
          return;
        }
        await smtpService.update(profileId, { isActive: true, isDefault: form.isDefault });
        toast.success('SMTP saved and activated');
      } else {
        toast.success('SMTP saved', 'Inactive until activated after a successful test');
      }
      setLastTestOk(true);
      await load();
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(p: SmtpProfile) {
    try {
      if (!p.isActive && p.lastTestStatus !== 'Connected') {
        toast.warning('Test connection first before enabling');
        return;
      }
      await smtpService.update(p.id, { isActive: !p.isActive });
      toast.success(p.isActive ? 'SMTP deactivated' : 'SMTP activated');
      await load();
    } catch (err) {
      toast.error('Update failed', err instanceof Error ? err.message : undefined);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this SMTP profile?')) return;
    try {
      await smtpService.remove(id);
      if (editingId === id) startCreate();
      await load();
      toast.success('SMTP profile deleted');
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : undefined);
    }
  }

  return (
    <div className="space-y-4 font-mono">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-accent">system · smtp</p>
          <h1 className="page-title text-primary">SMTP Manager</h1>
          <p className="page-sub max-w-2xl">
            Add your SMTP host, username, and password. Test the connection, then activate to send.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={startCreate}>
          <Plus className="h-4 w-4" /> Add SMTP
        </Button>
      </div>

      <div className="tui-box">
        <div className="tui-box-title">SMTP rotation</div>
        <div className="space-y-3 p-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Spread load across multiple active SMTP accounts. Respects each profile’s daily/hourly
            limits, then fails over if a send fails. This improves reliability — it is not for
            evading provider policies.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={rotationEnabled}
              onChange={(e) => setRotationEnabled(e.target.checked)}
            />
            Enable automatic SMTP rotation
          </label>
          <div className="max-w-md">
            <Label>Rotation mode</Label>
            <Select
              value={rotationMode}
              onChange={(e) =>
                setRotationMode(e.target.value as 'failover' | 'round_robin' | 'weighted')
              }
              disabled={!rotationEnabled}
            >
              <option value="round_robin">Round-robin — even distribution</option>
              <option value="weighted">Weighted — higher priority sends more</option>
              <option value="failover">Failover — prefer highest priority / default</option>
            </Select>
          </div>
          <Button size="sm" onClick={() => void saveRotation()}>
            Save rotation settings
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] xl:grid-cols-[340px_1fr]">
        <div className="tui-box max-h-[40vh] overflow-auto lg:max-h-[70vh]">
          <div className="tui-box-title">Profiles</div>
          <div className="space-y-1 p-2">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void startEdit(p)}
                className={cn(
                  'flex w-full items-start gap-2 border px-2 py-2 text-left text-xs transition-colors',
                  editingId === p.id
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border hover:bg-muted',
                )}
              >
                <Server className="mt-0.5 h-3.5 w-3.5 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.fromEmail || p.user || p.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {p.host}
                    {p.port ? `:${p.port}` : ''}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={statusTone(p.lastTestStatus)}>{p.lastTestStatus || 'Pending'}</Badge>
                    {p.isActive ? <Badge tone="success">Active</Badge> : <Badge>Off</Badge>}
                    {p.isDefault ? <Badge tone="info">Default</Badge> : null}
                  </div>
                </div>
              </button>
            ))}
            {!providers.length ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No SMTP profiles yet.</p>
            ) : null}
          </div>
        </div>

        <div className="tui-box">
          <div className="tui-box-title">{editingId ? 'Edit SMTP' : 'New SMTP'}</div>
          <div className="space-y-3 p-4">
            <p className="text-[11px] text-muted-foreground">
              Add any SMTP server — enter your host, port, username, and password. Works with Hostinger,
              cPanel, Google Workspace, Microsoft 365, or any provider that gives you SMTP credentials.
            </p>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <Label>SMTP host</Label>
                <Input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="smtp.yourprovider.com"
                  required
                />
              </div>
              <div>
                <Label>Port</Label>
                <Input
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="587 or 465"
                />
              </div>
              <div>
                <Label>Encryption</Label>
                <Select
                  value={form.encryption}
                  onChange={(e) => setForm({ ...form, encryption: e.target.value })}
                >
                  <option value="STARTTLS">STARTTLS (port 587)</option>
                  <option value="SSL">SSL (port 465)</option>
                  <option value="TLS">TLS</option>
                </Select>
              </div>
              <div>
                <Label>Label (optional)</Label>
                <Input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. Marketing, Transactional"
                />
              </div>
              <div>
                <Label>Username</Label>
                <Input
                  value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value })}
                  placeholder="you@yourdomain.com"
                />
              </div>
              <div>
                <Label>Password / app password</Label>
                <div className="relative">
                  <Input
                    type={showPass ? 'text' : 'password'}
                    value={form.pass}
                    onChange={(e) => setForm({ ...form, pass: e.target.value })}
                    placeholder={editingId ? '••••••••' : ''}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 border border-border bg-background p-1.5 text-muted-foreground hover:text-primary"
                    aria-label={showPass ? 'Hide password' : 'Show password'}
                    title={showPass ? 'Hide password' : 'Show password'}
                  >
                    {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <Label>Sender name</Label>
                <Input
                  value={form.fromName}
                  onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                  placeholder="Inbox Flow"
                />
              </div>
              <div>
                <Label>Sender email</Label>
                <Input
                  value={form.fromEmail}
                  onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
                  placeholder="hello@yourdomain.com"
                />
              </div>
              <div>
                <Label>Reply-To (optional)</Label>
                <Input
                  value={form.replyTo}
                  onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
                />
              </div>
              <div>
                <Label>Priority (optional)</Label>
                <Input
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                />
              </div>
              <div>
                <Label>Daily limit (optional)</Label>
                <Input
                  value={form.dailyLimit}
                  onChange={(e) => setForm({ ...form, dailyLimit: e.target.value })}
                  placeholder="e.g. 2000"
                />
              </div>
              <div>
                <Label>Hourly limit (optional)</Label>
                <Input
                  value={form.hourlyLimit}
                  onChange={(e) => setForm({ ...form, hourlyLimit: e.target.value })}
                  placeholder="e.g. 200"
                />
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-accent">
                Optional — quick-fill host defaults
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_FILLS.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => applyQuickFill(q.id)}
                    className="border border-border px-2 py-1 text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="min-h-[72px]"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
              />
              Set as default SMTP (gets 465↔587 failover)
            </label>

            {issues.length > 0 ? (
              <Card className="space-y-1 border-warning/40 p-3 text-xs text-warning">
                <div className="font-medium">Detected configuration issues</div>
                {issues.map((issue) => (
                  <div key={issue}>• {issue}</div>
                ))}
              </Card>
            ) : null}

            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <Label>Test email to</Label>
                <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button className="flex-1 sm:flex-none" disabled={busy} onClick={() => void testConnection(false)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Test Connection
              </Button>
              <Button className="flex-1 sm:flex-none" variant="outline" disabled={busy || !testTo} onClick={() => void testConnection(true)}>
                Test & send
              </Button>
              <Button className="flex-1 sm:flex-none" variant="secondary" disabled={busy} onClick={() => void save(false)}>
                Save draft
              </Button>
              <Button className="flex-1 sm:flex-none" disabled={busy || (!lastTestOk && selected?.lastTestStatus !== 'Connected')} onClick={() => void save(true)}>
                <Check className="h-4 w-4" /> Activate
              </Button>
              {editingId ? (
                <>
                  <Button variant="outline" onClick={() => void toggleActive(selected!)}>
                    {selected?.isActive ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="danger" onClick={() => void remove(editingId)}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
