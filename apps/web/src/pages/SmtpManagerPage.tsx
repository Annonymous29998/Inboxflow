import { useEffect, useMemo, useState } from 'react';
import { Check, Eye, EyeOff, Loader2, Plus, Server, Trash2, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { smtpService, type SmtpProfile } from '@/services/smtp.service';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/toast';
import { confirmDialog } from '@/stores/confirm';
import { useDraft, useDraftStore } from '@/stores/draft';

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
  minuteLimit: string;
  priority: string;
  notes: string;
  isDefault: boolean;
  /** Skip TLS cert hostname verification (self-signed / mismatched certs). */
  ignoreTLS: boolean;
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
  replyTo: '',
  dailyLimit: '',
  hourlyLimit: '',
  minuteLimit: '',
  priority: '10',
  notes: '',
  isDefault: false,
  ignoreTLS: false,
};

function autoSmtpName(form: FormState) {
  return (form.fromEmail || form.user || form.host || 'SMTP').trim();
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
    Boolean(f.label?.trim()) ||
    Boolean(f.fromName?.trim()) ||
    Boolean(f.replyTo?.trim()) ||
    Boolean(f.notes?.trim())
  );
}

export function SmtpManagerPage() {
  const [providers, setProviders] = useState<SmtpProfile[]>([]);
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
  const [rotationEnabled, setRotationEnabled] = useState(true);
  const [rotationMode, setRotationMode] = useState<
    'failover' | 'round_robin' | 'weighted' | 'performance'
  >('round_robin');

  const selected = useMemo(
    () => providers.find((p) => p.id === editingId) || null,
    [providers, editingId],
  );

  async function load() {
    try {
      const data = await smtpService.list();
      setProviders(data);
    } catch (err) {
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

  async function startCreate() {
    if (!editingId && formHasInput(form)) {
      const ok = await confirmDialog({
        title: 'Discard draft?',
        description: 'You have unsaved entries in this SMTP form. Starting a new profile will clear your changes.',
        tone: 'warning',
        confirmText: 'Discard & start new',
        cancelText: 'Keep editing',
      });
      if (!ok) return;
    }
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
      minuteLimit: detail.minuteLimit != null ? String(detail.minuteLimit) : '',
      priority: String(detail.priority ?? 0),
      notes: detail.notes || '',
      isDefault: detail.isDefault,
      ignoreTLS: cfg.ignoreTLS === 'true' || cfg.ignoreTLS === true,
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
      fromEmail: form.fromEmail,
      fromName: form.fromName,
      replyTo: form.replyTo,
    };
  }

  async function testConnection(sendEmail = false, opts?: { silent?: boolean }) {
    if (!opts?.silent) {
      if (sendEmail) setBusyTestSend(true);
      else setBusyTestVerify(true);
    }
    if (!opts?.silent) toast.info(sendEmail ? 'Testing and sending…' : 'Testing connection…');
    type TestResult = {
      success: boolean;
      message: string;
      error?: string;
      messageId?: string;
      issues?: string[];
      deliverabilityWarnings?: string[];
    };
    let result: TestResult = { success: false, message: 'Not run' };
    try {
      if (sendEmail && !testTo.trim()) {
        setLastTestOk(false);
        if (!opts?.silent) toast.warning('Enter a recipient email for Test & send');
        return { success: false, message: 'Recipient email required', error: 'Enter a recipient email for Test & send' } as TestResult;
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
          toast.success(
            sendEmail ? 'Test email handed to SMTP' : 'SMTP login OK — no email was sent',
            sendEmail
              ? `${result.message}. Check Inbox, Promotions, AND Spam for “SMTP connection test”. A login OK does not mean Gmail will show the message.`
              : 'This only proves username/password/host work. Click Test & send and fill “Test email to” if you want a message in your inbox.',
          );
        }
        if (result.deliverabilityWarnings?.length && !opts?.silent) {
          toast.warning(
            'Inbox placement warnings',
            `Deliverability warnings:\n• ${result.deliverabilityWarnings.join('\n• ')}`,
          );
        }
      } else if (!opts?.silent) {
        const err = result.error || result.message || '';
        toast.error('SMTP test failed', err);
        if (/altnames|certificate|self[- ]signed|unable to verify/i.test(err) && !form.ignoreTLS) {
          toast.warning(
            'Certificate mismatch',
            'Enable “Allow insecure TLS” on this profile if your provider uses a mismatched or self-signed certificate, then test again.',
          );
        }
      }
      if (editingId) await load();
      return result;
    } catch (err) {
      setLastTestOk(false);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (!opts?.silent) toast.error('SMTP test failed', msg);
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
      if (!form.fromEmail.trim()) missing.push('Sender email address');
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

      let warnings: string[] = [];

      if (activate) {
        if (!lastTestOk || changedCredentials) {
          toast.info('Verifying connection before activation…');
          const test = await testConnection(false, { silent: true });
          warnings = Array.from(new Set([...(warnings || []), ...(test.deliverabilityWarnings || [])]));
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
      } else {
        // Draft / Save changes — only compute static deliverability warnings, do NOT force a live SMTP handshake
        // (Nexlogs parity: save always succeeds, test is optional via explicit Test button)
        try {
          const probe = await smtpService.testConnection({
            providerId: editingId || undefined,
            config: buildConfig(),
            skipLiveVerify: true,
          });
          warnings = probe.deliverabilityWarnings ?? [];
        } catch {
          warnings = [];
        }
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
        if (warnings.length) {
          toast.warning(
            'Saved & Activated — but inbox placement has warnings',
            `Deliverability warnings:\n• ${warnings.join('\n• ')}`,
          );
        } else {
          toast.success('SMTP saved and activated');
        }
      } else {
        if (warnings.length) {
          toast.warning(
            activate ? 'SMTP saved — watch inbox placement' : 'SMTP saved as draft',
            `Deliverability warnings:\n• ${warnings.join('\n• ')}`,
          );
        } else {
          toast.success(
            activate ? 'SMTP saved (live connection confirmed)' : (editingId ? 'Changes saved' : 'SMTP draft saved'),
            activate ? 'Inactive until activated after a successful test' : 'Click Activate or Test Connection when ready.',
          );
        }
      }
      setLastTestOk(activate ? true : lastTestOk);
      await load();
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
        startCreate();
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

  function meterLabel(used: number, limit?: number | null) {
    if (limit == null) return `${used}`;
    return `${used} / ${limit}`;
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
          <div className="mt-3 max-w-2xl border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <span className="text-accent">Sending:</span> Once an SMTP profile is saved and active,
            Inbox Flow will send using that profile with whatever{' '}
            <strong className="text-foreground">Sender Email</strong> you set (including Gmail) for
            Test Connection, Test &amp; send, and campaigns. Your provider may still reject some
            From addresses — that is their policy, not an Inbox Flow block.
          </div>
        </div>
        <Button className="w-full sm:w-auto" variant="outline" onClick={() => void exportSmtp()} disabled={busyExport}>
          {busyExport ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Export
        </Button>
        <label className={cn('inline-flex w-full cursor-pointer items-center justify-center border border-border px-3 py-2 text-sm sm:w-auto', busyImport && 'pointer-events-none opacity-50')}>
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
        <Button className="w-full sm:w-auto" variant="outline" onClick={() => void startCreate()}>
          <Plus className="h-4 w-4" /> New profile
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
                setRotationMode(
                  e.target.value as 'failover' | 'round_robin' | 'weighted' | 'performance',
                )
              }
              disabled={!rotationEnabled}
            >
              <option value="round_robin">Round-robin — even distribution</option>
              <option value="weighted">Weighted — higher priority sends more</option>
              <option value="failover">Failover — prefer highest priority / default</option>
              <option value="performance">Performance — prefer higher success rate</option>
            </Select>
          </div>
          <Button size="sm" onClick={() => void saveRotation()} disabled={busyRotate}>
            {busyRotate ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save rotation settings
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
                  <div className="mt-1.5 space-y-0.5 text-[10px] text-muted-foreground">
                    <div>
                      Today {meterLabel(p.sentToday ?? 0, p.dailyLimit)} · Hour{' '}
                      {meterLabel(p.sentHour ?? 0, p.hourlyLimit)}
                      {p.minuteLimit != null
                        ? ` · Min ${meterLabel(p.sentMinute ?? 0, p.minuteLimit)}`
                        : ''}
                    </div>
                    <div>
                      Success {(p.successRate ?? 50).toFixed(1)}% (
                      {p.successCount ?? 0}ok / {p.failCount ?? 0}fail)
                    </div>
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
          <div className="tui-box-title">
            {editingId && selected
              ? `Editing profile · ${selected.name || selected.fromEmail || selected.user || 'SMTP'}`
              : 'New SMTP profile'}
          </div>
          <div className="space-y-3 p-4">
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
                    {selected.fromName
                      ? `${selected.fromName} <${selected.fromEmail || selected.user || '—'}>`
                      : selected.fromEmail || selected.user || '—'}
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
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Campaigns use this exact encryption, host, port, and From — same as Test &amp; send.
                </p>
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
                <Label>Sender name (optional)</Label>
                <Input
                  value={form.fromName}
                  onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                  placeholder="Leave blank to show only the sender email"
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
                  Test Connection never sends mail. Test & send uses this address. Sender Email must
                  be a From your SMTP provider allows (not @gmail.com unless you are using Gmail SMTP).
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
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
        </div>
      </div>
    </div>
  );
}
