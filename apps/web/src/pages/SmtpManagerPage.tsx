import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Eye, EyeOff, Loader2, Plus, Trash2, X, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { parseFromIdentities, smtpService, type SmtpProfile } from '@/services/smtp.service';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/toast';
import { confirmDialog } from '@/stores/confirm';
import { useDraft, useDraftStore } from '@/stores/draft';
import { useAuthStore } from '@/stores/auth';
import { uiCacheGet, uiCacheSet } from '@/lib/ui-cache';
import { WorkspaceOnDeviceNotice } from '@/components/campaigns/WorkspaceOnDeviceNotice';
import { isWorkspaceOnDeviceError, reportWorkspaceOnDevice } from '@/lib/workspace-on-device';

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
  senders: Array<{ email: string; name: string }>;
  replyTo: string;
  dailyLimit: string;
  hourlyLimit: string;
  minuteLimit: string;
  priority: string;
  notes: string;
  isDefault: boolean;
  /** Skip TLS cert hostname verification (self-signed / mismatched certs). */
  ignoreTLS: boolean;
  /** Where this process opens the SMTP socket: this NIC, or SOCKS5. */
  outboundPath: 'direct' | 'bind' | 'socks';
  bindIp: string;
  socksHost: string;
  socksPort: string;
  socksUser: string;
  socksPass: string;
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
  {
    id: 'brevo',
    label: 'Brevo',
    patch: { host: 'smtp-relay.brevo.com', port: '587', encryption: 'STARTTLS' },
  },
  {
    id: 'bulko',
    label: 'Bulko',
    patch: { host: 'smtp.bulko.io', port: '2525', encryption: 'STARTTLS', ignoreTLS: true },
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
  senders: [{ email: '', name: '' }],
  replyTo: '',
  dailyLimit: '',
  hourlyLimit: '',
  minuteLimit: '',
  priority: '10',
  notes: '',
  isDefault: false,
  ignoreTLS: false,
  outboundPath: 'direct',
  bindIp: '',
  socksHost: '',
  socksPort: '',
  socksUser: '',
  socksPass: '',
};

function senderEmails(form: FormState) {
  return form.senders.map((s) => s.email.trim()).filter(Boolean);
}

function autoSmtpName(form: FormState) {
  const custom = (form.name || form.label || '').trim();
  if (custom) return custom;
  const emails = senderEmails(form);
  return (emails.join(', ') || form.fromEmail || form.user || form.host || 'SMTP').trim();
}

function profileDisplayName(p: SmtpProfile) {
  const emails = parseFromIdentities(p.fromIdentities).map((s) => s.email);
  const joined = emails.join(', ');
  const custom = (p.label || p.name || '').trim();
  if (custom && custom !== p.fromEmail && custom !== p.user) return custom;
  return joined || custom || p.fromEmail || p.user || p.name || 'SMTP';
}

function statusTone(status?: string | null) {
  if (status === 'Connected') return 'success' as const;
  if (status === 'Failed') return 'danger' as const;
  return 'warning' as const;
}

function formHasInput(f: FormState) {
  return (
    Boolean(f.host?.trim()) ||
    Boolean(f.user?.trim()) ||
    Boolean(f.pass?.trim()) ||
    Boolean(f.fromEmail?.trim()) ||
    f.senders.some((s) => s.email.trim() || s.name.trim()) ||
    Boolean(f.name?.trim()) ||
    Boolean(f.label?.trim()) ||
    Boolean(f.fromName?.trim()) ||
    Boolean(f.replyTo?.trim()) ||
    Boolean(f.notes?.trim())
  );
}

export function SmtpManagerPage() {
  const smtpAllowDirect = useAuthStore((s) => s.user?.smtpAllowDirect !== false);
  const boundPcIp = useAuthStore((s) => String(s.user?.boundIp || '').trim());
  const [providers, setProviders] = useState<SmtpProfile[]>(() => {
    const cached = uiCacheGet<SmtpProfile[]>('smtp') ?? [];
    return cached.map((p) => ({ ...p, fromIdentities: parseFromIdentities(p.fromIdentities) }));
  });
  const [editingId, setEditingId] = useDraft<string | null>('smtp:editingId', null);
  const [form, setForm] = useDraft<FormState>('smtp:form', emptyForm);
  const [testTo, setTestTo] = useDraft<string>('smtp:testTo', '');
  const [issues, setIssues] = useDraft<string[]>('smtp:issues', []);
  const [busyTestVerify, setBusyTestVerify] = useState(false);
  const [busyTestSend, setBusyTestSend] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [busyToggle, setBusyToggle] = useState(false);
  const [busyDelete, setBusyDelete] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [busyDetect, setBusyDetect] = useState(false);
  const [busyRotate, setBusyRotate] = useState(false);
  const [showPass, setShowPass] = useDraft<boolean>('smtp:showPass', false);
  const [lastTestOk, setLastTestOk] = useDraft<boolean>('smtp:lastTestOk', false);
  const [formOpen, setFormOpen] = useState(false);
  const [rotationEnabled, setRotationEnabled] = useState(true);
  const [rotationMode, setRotationMode] = useState<
    'failover' | 'round_robin' | 'weighted' | 'performance'
  >('round_robin');
  const [workspaceOnDevice, setWorkspaceOnDevice] = useState(false);

  const selected = useMemo(
    () => providers.find((p) => p.id === editingId) || null,
    [providers, editingId],
  );

  async function load() {
    try {
      const data = await smtpService.listSmtp();
      setWorkspaceOnDevice(false);
      setProviders(data);
      uiCacheSet('smtp', data);
    } catch (err) {
      if (isWorkspaceOnDeviceError(err)) {
        setWorkspaceOnDevice(true);
        setProviders([]);
        reportWorkspaceOnDevice(err);
        return;
      }
      toast.error('Could not load SMTP profiles', err instanceof Error ? err.message : undefined);
    }
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
      if (
        rot?.mode === 'failover' ||
        rot?.mode === 'round_robin' ||
        rot?.mode === 'weighted' ||
        rot?.mode === 'performance'
      ) {
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
      if (d.user.email && !testTo) setTestTo(d.user.email);
    });
  }, []);

  async function saveRotation() {
    setBusyRotate(true);
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
    } finally {
      setBusyRotate(false);
    }
  }

  function applyQuickFill(id: string) {
    const fill = QUICK_FILLS.find((q) => q.id === id);
    if (!fill) return;
    setForm((f) => ({ ...f, ...fill.patch }));
    setLastTestOk(false);
  }

  async function closeForm() {
    if (formOpen && formHasInput(form)) {
      const ok = await confirmDialog({
        title: 'Close SMTP editor?',
        description: 'Unsaved changes on this profile will be discarded.',
        tone: 'warning',
        confirmText: 'Close',
        cancelText: 'Keep editing',
      });
      if (!ok) return;
    }
    setFormOpen(false);
  }

  async function startCreate() {
    if (workspaceOnDevice) {
      reportWorkspaceOnDevice();
      return;
    }
    setEditingId(null);
    setForm(emptyForm);
    setShowPass(false);
    setLastTestOk(false);
    setIssues([]);
    setFormOpen(true);
  }

  async function startEdit(p: SmtpProfile) {
    setFormOpen(true);
    setEditingId(p.id);
    setShowPass(false);
    setLastTestOk(p.lastTestStatus === 'Connected');
    const detail = await smtpService.get(p.id);
    const cfg = detail.config || {};
    const listed = parseFromIdentities(detail.fromIdentities);
    const senderRows = listed
      .map((s) => ({ email: String(s.email || '').trim(), name: String(s.name || '').trim() }))
      .filter((s) => s.email);
    const firstEmail = senderRows[0]?.email || detail.fromEmail || '';
    const storedName = (detail.label || detail.name || '').trim();
    const customName =
      storedName && storedName !== firstEmail && storedName !== detail.fromEmail && storedName !== detail.user
        ? storedName
        : '';
    setForm({
      name: customName,
      label: customName,
      host: cfg.host || detail.host || '',
      port: String(cfg.port || detail.port || '587'),
      encryption: cfg.encryption || detail.encryption || 'STARTTLS',
      user: cfg.user || detail.user || '',
      pass: cfg.pass && cfg.pass !== '••••••••' ? cfg.pass : '',
      fromName: cfg.fromName || detail.fromName || '',
      fromEmail: cfg.fromEmail || detail.fromEmail || '',
      senders: senderRows.length ? senderRows : [{ email: '', name: '' }],
      replyTo: cfg.replyTo || detail.replyTo || '',
      dailyLimit: detail.dailyLimit != null ? String(detail.dailyLimit) : '',
      hourlyLimit: detail.hourlyLimit != null ? String(detail.hourlyLimit) : '',
      minuteLimit: detail.minuteLimit != null ? String(detail.minuteLimit) : '',
      priority: String(detail.priority ?? 0),
      notes: detail.notes || '',
      isDefault: detail.isDefault,
      ignoreTLS: String(cfg.ignoreTLS || '').toLowerCase() === 'true',
      outboundPath:
        cfg.outboundPath === 'bind' || cfg.outboundPath === 'socks' ? cfg.outboundPath : 'direct',
      bindIp: cfg.bindIp || '',
      socksHost: cfg.socksHost || '',
      socksPort: String(cfg.socksPort || ''),
      socksUser: cfg.socksUser || '',
      socksPass: cfg.socksPass && cfg.socksPass !== '••••••••' ? cfg.socksPass : '',
    });
    setIssues(detail.issues || []);
  }

  function buildConfig() {
    const portNum = Number(form.port);
    const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? String(Math.trunc(portNum)) : form.port.trim();
    const encryption = form.encryption || 'STARTTLS';
    return {
      host: form.host.trim(),
      port,
      encryption,
      secure: encryption === 'SSL' || encryption === 'TLS' ? 'true' : 'false',
      requireTLS: encryption === 'STARTTLS' ? 'true' : 'false',
      ignoreTLS: form.ignoreTLS ? 'true' : 'false',
      user: form.user,
      // Mask / empty keeps existing password on the server when editing
      pass: form.pass && form.pass !== '••••••••' ? form.pass : editingId ? '••••••••' : '',
      fromEmail: (form.senders.find((s) => s.email.trim())?.email || form.fromEmail).trim(),
      fromName: (form.senders.find((s) => s.email.trim())?.name || form.fromName).trim(),
      fromIdentities: JSON.stringify(
        form.senders
          .map((s) => ({ email: s.email.trim(), name: s.name.trim() }))
          .filter((s) => s.email.includes('@')),
      ),
      replyTo: form.replyTo,
      outboundPath: smtpAllowDirect
        ? form.outboundPath || 'direct'
        : (form.socksHost || '').trim()
          ? 'socks'
          : 'bind',
      bindIp: smtpAllowDirect ? (form.bindIp || '').trim() : boundPcIp,
      socksHost: (form.socksHost || '').trim(),
      socksPort: (form.socksPort || '').trim(),
      socksUser: (form.socksUser || '').trim(),
      socksPass: form.socksPass && form.socksPass !== '••••••••' ? form.socksPass : editingId ? '••••••••' : '',
    };
  }

  async function testConnection(sendEmail = false, opts?: { silent?: boolean }) {
    if (!opts?.silent) {
      if (sendEmail) setBusyTestSend(true);
      else setBusyTestVerify(true);
    }
    type TestResult = {
      success: boolean;
      message: string;
      error?: string;
      messageId?: string;
      sentCount?: number;
      fromEmails?: string[];
      issues?: string[];
    };
    let result: TestResult = { success: false, message: 'Not run' };
    try {
      if (sendEmail && !testTo.trim()) {
        setLastTestOk(false);
        if (!opts?.silent) toast.error('Enter a recipient email');
        return { success: false, message: 'Recipient email required', error: 'Enter a recipient email' } as TestResult;
      }

      const r = await smtpService.testConnection({
        providerId: editingId || undefined,
        config: buildConfig(),
        sendTestEmail: sendEmail,
        testEmailTo: sendEmail ? testTo.trim() : undefined,
        notes: form.notes.trim() || null,
      });
      result = r;

      setLastTestOk(result.success);
      if (result.success) {
        if (!opts?.silent) {
          toast.success(sendEmail ? 'Sent' : 'Connected');
        }
      } else if (!opts?.silent) {
        toast.error(result.error || result.message || 'SMTP test failed');
      }
      if (editingId) await load();
      return result;
    } catch (err) {
      setLastTestOk(false);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (!opts?.silent) toast.error(msg);
      return { success: false, message: msg, error: msg } as TestResult;
    } finally {
      if (!opts?.silent) {
        if (sendEmail) setBusyTestSend(false);
        else setBusyTestVerify(false);
      }
    }
  }

  async function save(activate: boolean) {
    setBusySave(true);
    try {
      const missing: string[] = [];
      if (!form.host.trim()) missing.push('SMTP host (e.g. smtp.yourdomain.com)');
      if (!form.user.trim()) missing.push('SMTP username (usually your login email)');
      if (!editingId && !form.pass.trim()) missing.push('SMTP password or app password');
      if (!form.senders.some((s) => s.email.trim().includes('@'))) {
        missing.push('At least one sender / From email');
      }
      if (missing.length) {
        toast.warning(
          'Required fields missing',
          missing.length === 1 ? missing[0] : `Please add:\n• ${missing.join('\n• ')}`,
        );
        return;
      }

      const changedCredentials =
        !editingId ||
        (form.pass && form.pass !== '••••••••') ||
        selected?.host !== form.host.trim() ||
        selected?.user !== form.user.trim() ||
        String(selected?.port ?? '') !== String(form.port ?? '') ||
        selected?.fromEmail !== form.fromEmail.trim();

      if (activate) {
        if (!lastTestOk || changedCredentials) {
          toast.info('Verifying connection before activation…');
          const test = await testConnection(false, { silent: true });
          if (!test.success) {
            setLastTestOk(false);
            toast.error(
              'SMTP was NOT saved — connection test failed',
              `Dead SMTP credentials refused. Fix them first.\n\n${test.error || test.message}`,
            );
            return;
          }
          setLastTestOk(true);
        }
      }

      const payload = {
        name: autoSmtpName(form),
        label: form.name.trim() || form.label.trim() || null,
        type: 'SMTP' as const,
        config: buildConfig(),
        isDefault: form.isDefault,
        isActive: false,
        dailyLimit: form.dailyLimit ? Number(form.dailyLimit) : null,
        hourlyLimit: form.hourlyLimit ? Number(form.hourlyLimit) : null,
        minuteLimit: form.minuteLimit ? Number(form.minuteLimit) : null,
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

      // Always refresh the sidebar so a newly saved profile is visible even if
      // Activate fails (status stays Off / Pending).
      await load();

      if (activate && profileId) {
        // Persist Connected on the saved row, then activate. Anonymous tests
        // before create never update lastTestStatus.
        const persisted = await smtpService.testConnection({
          providerId: profileId,
          config: buildConfig(),
        });
        if (!persisted.success) {
          setLastTestOk(false);
          toast.error(
            'SMTP saved as draft — activation failed',
            persisted.error || persisted.message || 'Test Connection must succeed before activating',
          );
          return;
        }
        setLastTestOk(true);
        await smtpService.update(profileId, { isActive: true, isDefault: form.isDefault });
        toast.success('SMTP saved and activated');
      } else {
        toast.success(
          activate ? 'SMTP saved (live connection confirmed)' : (editingId ? 'Changes saved' : 'SMTP draft saved'),
        );
      }
      setLastTestOk(activate ? true : lastTestOk);
      await load();
      setFormOpen(false);
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusySave(false);
    }
  }

  async function toggleActive(p: SmtpProfile) {
    setBusyToggle(true);
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
    } finally {
      setBusyToggle(false);
    }
  }

  async function remove(id: string) {
    if (!(await confirmDialog({
      title: `Delete SMTP profile`,
      description: `Permanently remove this SMTP provider?\n\nAny campaign queued using this profile will fall back to the default provider; if no other provider exists, sends will be paused until one is configured.\n\nThis cannot be undone.`,
      tone: 'danger',
      destructive: true,
      confirmText: 'Delete provider',
    }))) return;
    setBusyDelete(true);
    try {
      await smtpService.remove(id);
      if (editingId === id) {
        setFormOpen(false);
        setEditingId(null);
        setForm(emptyForm);
        const clearDraft = useDraftStore.getState().clearDraft;
        clearDraft('smtp:editingId');
        clearDraft('smtp:form');
        clearDraft('smtp:issues');
        clearDraft('smtp:showPass');
        clearDraft('smtp:lastTestOk');
      }
      await load();
      toast.success('SMTP profile deleted');
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyDelete(false);
    }
  }

  async function autoDetectTls() {
    setBusyDetect(true);
    try {
      const detected = await smtpService.detectTls(form.port || 587);
      setForm((f) => ({
        ...f,
        port: String(detected.port),
        encryption: detected.encryption,
      }));
      setLastTestOk(false);
      toast.success('TLS auto-detected', detected.hint);
    } catch (err) {
      toast.error('Detect failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyDetect(false);
    }
  }

  async function exportSmtp() {
    setBusyExport(true);
    try {
      const data = await smtpService.exportProfiles();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inboxflow-smtp-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('SMTP exported', 'Passwords omitted — re-enter after import');
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyExport(false);
    }
  }

  async function importSmtp(file: File) {
    setBusyImport(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { profiles?: unknown[] };
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : Array.isArray(parsed) ? parsed : [];
      const result = await smtpService.importProfiles(profiles);
      toast.success(`Imported ${result.imported} profile(s)`, result.note);
      await load();
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyImport(false);
    }
  }

  return (
    <div className="mailer-root page-root space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mailer-hint" style={{ marginTop: 0 }}>
            system · smtp
          </p>
          <h1 className="page-title text-primary">SMTP Manager</h1>
          <p className="page-sub">
            {workspaceOnDevice
              ? 'SMTP profiles live on this PC'
              : `${providers.length} profile${providers.length === 1 ? '' : 's'} · add or edit opens a form`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void exportSmtp()} disabled={busyExport}>
          {busyExport ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Export
        </Button>
        <label className={cn('inline-flex h-8 cursor-pointer items-center justify-center border border-border px-3 text-sm', busyImport && 'pointer-events-none opacity-50')}>
          {busyImport ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Import
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            disabled={busyImport}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importSmtp(f);
              e.target.value = '';
            }}
          />
        </label>
        <Button size="sm" onClick={() => void startCreate()} disabled={workspaceOnDevice}>
          <Plus className="h-4 w-4" /> New SMTP
        </Button>
        </div>
      </div>

      <div className="mailer-panel">
        <div className="mailer-pad flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span className="text-[10px] uppercase tracking-wide text-accent">Rotation</span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={rotationEnabled}
            onChange={(e) => setRotationEnabled(e.target.checked)}
          />
          On
        </label>
        <Select
          className="w-auto min-w-[12rem] max-w-xs"
          value={rotationMode}
          onChange={(e) =>
            setRotationMode(
              e.target.value as 'failover' | 'round_robin' | 'weighted' | 'performance',
            )
          }
          disabled={!rotationEnabled}
        >
          <option value="round_robin">Round-robin</option>
          <option value="weighted">Weighted</option>
          <option value="failover">Failover</option>
          <option value="performance">Performance</option>
        </Select>
        <Button size="sm" onClick={() => void saveRotation()} disabled={busyRotate}>
          {busyRotate ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
        </Button>
        <span className="hidden text-[11px] text-muted-foreground xl:inline">
          Spreads load across active SMTPs. Limits still apply.
        </span>
        </div>
      </div>

      <div className="space-y-2">
            {providers.map((p) => (
              <div key={p.id} className="camp-row">
                <button type="button" className="camp-row-main text-left" onClick={() => void startEdit(p)}>
                  <strong>{profileDisplayName(p)}</strong>
                  <div className="meta">
                    {p.host}
                    {p.port ? `:${p.port}` : ''}
                    {p.outboundPath === 'bind' && p.bindIp ? ` · bind ${p.bindIp}` : ''}
                    {p.outboundPath === 'socks' && p.socksHost
                      ? ` · socks ${p.socksHost}${p.socksPort ? `:${p.socksPort}` : ''}`
                      : ''}
                    {` · ${p.lastTestStatus || 'Pending'}`}
                    {p.isActive ? ' · Active' : ' · Off'}
                    {p.isDefault ? ' · Default' : ''}
                    {` · Total ${p.successCount ?? p.sentToday ?? 0}`}
                  </div>
                </button>
                <div className="camp-row-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void startEdit(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyToggle}
                    onClick={() => void toggleActive(p)}
                  >
                    {p.isActive ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busyDelete}
                    onClick={() => void remove(p.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </div>
            ))}
            {!providers.length ? (
              workspaceOnDevice ? (
                <WorkspaceOnDeviceNotice />
              ) : (
              <div className="mailer-panel">
                <div className="mailer-pad">
                  <p className="mailer-hint" style={{ marginTop: 0 }}>
                    No SMTP profiles yet. Click New SMTP to add host, port, username, and password.
                  </p>
                </div>
              </div>
              )
            ) : null}
      </div>

      {formOpen
        ? createPortal(
        <div className="mailer-root fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-3">
          <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => void closeForm()} />
          <div className="mailer-panel relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--mailer-stroke)] px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="mailer-hint" style={{ marginTop: 0 }}>
                {editingId ? 'edit profile' : 'new profile'}
              </p>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value, label: e.target.value })}
                placeholder={senderEmails(form).join(', ') || 'SMTP name'}
                aria-label="SMTP name"
                className="mt-0.5 w-full border-transparent bg-transparent px-0 py-0.5 text-lg font-semibold text-primary placeholder:text-primary/50 focus:border-primary focus:bg-background focus:px-2"
              />
            </div>
            <button
              type="button"
              onClick={() => void closeForm()}
              className="border border-[var(--mailer-stroke)] p-2 text-[var(--mailer-dim)] hover:text-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {selected ? (
              <div className="grid grid-cols-1 gap-1.5 border border-border bg-muted/40 p-3 text-[11px] sm:grid-cols-3">
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Badge tone={statusTone(selected.lastTestStatus)}>
                      {selected.lastTestStatus || 'Pending test'}
                    </Badge>
                    {selected.isActive ? (
                      <Badge tone="success">Active for sends</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    )}
                    {selected.isDefault ? <Badge tone="info">Default</Badge> : null}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Sender</span>
                  <div className="mt-0.5 truncate font-medium text-foreground">
                    {(parseFromIdentities(selected.fromIdentities).length
                      ? parseFromIdentities(selected.fromIdentities).map((s) => s.email).join(', ')
                      : selected.fromName
                        ? `${selected.fromName} <${selected.fromEmail || selected.user || '—'}>`
                        : selected.fromEmail || selected.user || '—') || '—'}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Host</span>
                  <div className="mt-0.5 truncate font-medium text-foreground">
                    {selected.host || '—'}
                    {selected.port ? `:${selected.port}` : ''}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Add any SMTP server — enter your host, port, username, and password. Works with Hostinger,
                cPanel, Google Workspace, Microsoft 365, or any provider that gives you SMTP credentials.
              </p>
            )}

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
                <div className="flex gap-2">
                  <Input
                    value={form.port}
                    onChange={(e) => {
                      setForm({ ...form, port: e.target.value });
                      setLastTestOk(false);
                    }}
                    placeholder="Any port — 587, 465, 2525…"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => void autoDetectTls()} disabled={busyDetect}>
                    {busyDetect ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Auto TLS
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">Use the port your provider gives you (not limited to 587/465).</p>
              </div>
              <div>
                <Label>Encryption</Label>
                <Select
                  value={form.encryption}
                  onChange={(e) => setForm({ ...form, encryption: e.target.value })}
                >
                  <option value="STARTTLS">STARTTLS (common on 587 / 2525)</option>
                  <option value="SSL">SSL/TLS on connect (common on 465)</option>
                  <option value="TLS">TLS</option>
                  <option value="NONE">None (plain — when provider says Tls/Ssl = no)</option>
                </Select>
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
              <div className="md:col-span-2 border border-border bg-muted/20 p-3">
                {smtpAllowDirect ? (
                  <>
                    <Label>Outbound path</Label>
                    <p className="mt-0.5 mb-2 text-[11px] text-muted-foreground">
                      Default is Lightsail. Bind IP or SOCKS5 only if you need them.
                    </p>
                    <Select
                      value={form.outboundPath || 'direct'}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          outboundPath: e.target.value as FormState['outboundPath'],
                        })
                      }
                    >
                      <option value="direct">Default</option>
                      <option value="bind">Bind IP — localAddress on this machine</option>
                      <option value="socks">SOCKS5 — proxy host / port / user</option>
                    </Select>
                    {(form.outboundPath || 'direct') === 'bind' ? (
                      <div className="mt-3">
                        <Label>Bind IP</Label>
                        <Input
                          value={form.bindIp || ''}
                          onChange={(e) => setForm({ ...form, bindIp: e.target.value })}
                          placeholder="203.0.113.10"
                        />
                      </div>
                    ) : null}
                    {(form.outboundPath || 'direct') === 'socks' ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <Label>SOCKS host</Label>
                          <Input
                            value={form.socksHost || ''}
                            onChange={(e) => setForm({ ...form, socksHost: e.target.value })}
                            placeholder="127.0.0.1"
                          />
                        </div>
                        <div>
                          <Label>SOCKS port</Label>
                          <Input
                            value={form.socksPort || ''}
                            onChange={(e) => setForm({ ...form, socksPort: e.target.value })}
                            placeholder="Port"
                          />
                        </div>
                        <div>
                          <Label>SOCKS user (optional)</Label>
                          <Input
                            value={form.socksUser || ''}
                            onChange={(e) => setForm({ ...form, socksUser: e.target.value })}
                            placeholder="proxy user"
                          />
                        </div>
                        <div>
                          <Label>SOCKS password</Label>
                          <Input
                            type={showPass ? 'text' : 'password'}
                            value={form.socksPass || ''}
                            onChange={(e) => setForm({ ...form, socksPass: e.target.value })}
                            placeholder={editingId ? '••••••••' : ''}
                          />
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Label>SOCKS5</Label>
                    <p className="mt-0.5 mb-2 text-[11px] text-muted-foreground">
                      Optional. Leave blank to send from this bound PC.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label>SOCKS host</Label>
                        <Input
                          value={form.socksHost || ''}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              socksHost: e.target.value,
                              outboundPath: e.target.value.trim() ? 'socks' : 'bind',
                            })
                          }
                          placeholder="127.0.0.1"
                        />
                      </div>
                      <div>
                        <Label>SOCKS port</Label>
                        <Input
                          value={form.socksPort || ''}
                          onChange={(e) => setForm({ ...form, socksPort: e.target.value })}
                          placeholder="Port"
                        />
                      </div>
                      <div>
                        <Label>SOCKS user (optional)</Label>
                        <Input
                          value={form.socksUser || ''}
                          onChange={(e) => setForm({ ...form, socksUser: e.target.value })}
                          placeholder="proxy user"
                        />
                      </div>
                      <div>
                        <Label>SOCKS password</Label>
                        <Input
                          type={showPass ? 'text' : 'password'}
                          value={form.socksPass || ''}
                          onChange={(e) => setForm({ ...form, socksPass: e.target.value })}
                          placeholder={editingId ? '••••••••' : ''}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="md:col-span-2 border border-border bg-muted/20 p-3">
                <Label>Sender / From emails</Label>
                <p className="mb-2 mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  One SMTP login can send as several From addresses if the SMTP provider allows it.
                  Campaigns can pin one or rotate these.
                </p>
                <div className="space-y-2">
                  {form.senders.map((row, i) => (
                    <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                      <Input
                        value={row.name}
                        onChange={(e) => {
                          const senders = form.senders.map((s, idx) =>
                            idx === i ? { ...s, name: e.target.value } : s,
                          );
                          setForm({ ...form, senders, fromName: senders[0]?.name || '' });
                        }}
                        placeholder="From name (optional)"
                      />
                      <Input
                        type="email"
                        value={row.email}
                        onChange={(e) => {
                          const senders = form.senders.map((s, idx) =>
                            idx === i ? { ...s, email: e.target.value } : s,
                          );
                          setForm({ ...form, senders, fromEmail: senders[0]?.email || '' });
                          setLastTestOk(false);
                        }}
                        placeholder="hello@yourdomain.com"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label="Add sender"
                        onClick={() => {
                          const senders = [
                            ...form.senders.slice(0, i + 1),
                            { email: '', name: '' },
                            ...form.senders.slice(i + 1),
                          ];
                          setForm({ ...form, senders });
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={form.senders.length <= 1}
                        onClick={() => {
                          const senders = form.senders.filter((_, idx) => idx !== i);
                          setForm({
                            ...form,
                            senders: senders.length ? senders : [{ email: '', name: '' }],
                            fromEmail: senders[0]?.email || '',
                            fromName: senders[0]?.name || '',
                          });
                        }}
                        aria-label="Remove sender"
                      >
                        −
                      </Button>
                    </div>
                  ))}
                </div>
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
              <div>
                <Label>Per-minute limit (optional)</Label>
                <Input
                  value={form.minuteLimit}
                  onChange={(e) => setForm({ ...form, minuteLimit: e.target.value })}
                  placeholder="e.g. 20"
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
              <Label>Notes (used as Test & send email body)</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="min-h-18"
                placeholder="Optional — if empty, test email says: Your SMTP connection is working."
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

            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.ignoreTLS}
                onChange={(e) => {
                  setForm({ ...form, ignoreTLS: e.target.checked });
                  setLastTestOk(false);
                }}
              />
              <span>
                Allow insecure TLS (skip certificate hostname checks only — STARTTLS still runs).
                Needed when the cert doesn’t match the SMTP hostname (e.g. Bulko / slipjar.app). Prefer
                leaving this off for trusted providers.
              </span>
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
                <Label>Test email to (required for Test & send only)</Label>
                <Input
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@gmail.com"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Test Connection never sends mail. Test & send requires this address.
                </p>
              </div>
            </div>

          </div>
          <div className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--mailer-stroke)] px-4 py-2">
            {!editingId ? (
              <Button className="flex-1 sm:flex-none" variant="primary" disabled={busySave} onClick={() => void save(true)}>
                {busySave ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Add & Activate SMTP
              </Button>
            ) : (
              <Button className="flex-1 sm:flex-none" variant="primary" disabled={busySave || (!lastTestOk && selected?.lastTestStatus !== 'Connected')} onClick={() => void save(true)}>
                {busySave ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Activate
              </Button>
            )}
            <Button className="flex-1 sm:flex-none" disabled={busyTestVerify} onClick={() => void testConnection(false)}>
              {busyTestVerify ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              Test Connection
            </Button>
            <Button className="flex-1 sm:flex-none" variant="outline" disabled={busyTestSend || !testTo} onClick={() => void testConnection(true)}>
              {busyTestSend ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Test & send
            </Button>
            <Button className="flex-1 sm:flex-none" variant="secondary" disabled={busySave} onClick={() => void save(false)}>
              {busySave ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editingId ? 'Save changes' : 'Save draft'}
            </Button>
            {editingId ? (
              <>
                <Button variant="outline" onClick={() => void toggleActive(selected!)} disabled={busyToggle}>
                  {busyToggle ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {selected?.isActive ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="danger" onClick={() => void remove(editingId)} disabled={busyDelete}>
                  {busyDelete ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
                </Button>
              </>
            ) : null}
          </div>
          </div>
        </div>,
        document.body,
      )
        : null}
    </div>
  );
}
