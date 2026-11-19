import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Eye, EyeOff, Loader2, Plus, Zap } from 'lucide-react';
import { Button, Input, Label, Select, Textarea } from '@/components/ui';
import { smtpService, type SmtpProfile } from '@/services/smtp.service';
import { useAuthStore } from '@/stores/auth';

type SenderRow = { email: string; name: string };

const QUICK_FILLS: { id: string; label: string; patch: Partial<{ host: string; port: string; encryption: string; ignoreTLS: boolean }> }[] = [
  { id: 'hostinger', label: 'Hostinger', patch: { host: 'smtp.hostinger.com', port: '465', encryption: 'SSL' } },
  { id: 'gmail', label: 'Gmail', patch: { host: 'smtp.gmail.com', port: '587', encryption: 'STARTTLS' } },
  { id: 'outlook', label: 'Outlook', patch: { host: 'smtp.office365.com', port: '587', encryption: 'STARTTLS' } },
  { id: 'ses', label: 'SES', patch: { host: 'email-smtp.us-east-1.amazonaws.com', port: '587', encryption: 'STARTTLS' } },
  { id: 'brevo', label: 'Brevo', patch: { host: 'smtp-relay.brevo.com', port: '587', encryption: 'STARTTLS' } },
  { id: 'bulko', label: 'Bulko', patch: { host: 'smtp.bulko.io', port: '2525', encryption: 'STARTTLS', ignoreTLS: true } },
];

export function CampaignAddSmtpModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (profile: SmtpProfile) => void;
}) {
  const smtpAllowDirect = useAuthStore((s) => s.user?.smtpAllowDirect !== false);
  const boundPcIp = useAuthStore((s) => String(s.user?.boundIp || '').trim());
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [encryption, setEncryption] = useState('STARTTLS');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [senders, setSenders] = useState<SenderRow[]>([{ email: '', name: '' }]);
  const [replyTo, setReplyTo] = useState('');
  const [priority, setPriority] = useState('10');
  const [dailyLimit, setDailyLimit] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState('');
  const [minuteLimit, setMinuteLimit] = useState('');
  const [notes, setNotes] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [ignoreTLS, setIgnoreTLS] = useState(false);
  const [outboundPath, setOutboundPath] = useState<'direct' | 'bind' | 'socks'>(
    smtpAllowDirect ? 'direct' : 'socks',
  );
  const [bindIp, setBindIp] = useState('');
  const [socksHost, setSocksHost] = useState('');
  const [socksPort, setSocksPort] = useState('');
  const [socksUser, setSocksUser] = useState('');
  const [socksPass, setSocksPass] = useState('');
  const [testTo, setTestTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyDetect, setBusyDetect] = useState(false);
  const [busyTest, setBusyTest] = useState(false);
  const [busySend, setBusySend] = useState(false);

  if (!open) return null;

  const path = smtpAllowDirect
    ? outboundPath
    : socksHost.trim()
      ? 'socks'
      : 'bind';
  const identities = senders
    .map((s) => ({ email: s.email.trim(), name: s.name.trim() }))
    .filter((s) => s.email.includes('@'));

  function buildConfig() {
    return {
      host: host.trim(),
      port: port.trim() || '587',
      encryption,
      secure: encryption === 'SSL' || encryption === 'TLS' ? 'true' : 'false',
      requireTLS: encryption === 'STARTTLS' ? 'true' : 'false',
      ignoreTLS: ignoreTLS ? 'true' : 'false',
      user: user.trim(),
      pass,
      fromEmail: identities[0]?.email || '',
      fromName: identities[0]?.name || '',
      fromIdentities: JSON.stringify(identities),
      replyTo: replyTo.trim(),
      outboundPath: path,
      bindIp: smtpAllowDirect ? bindIp.trim() : boundPcIp,
      socksHost: socksHost.trim(),
      socksPort: socksPort.trim(),
      socksUser: socksUser.trim(),
      socksPass,
    };
  }

  async function save(activate: boolean) {
    setError('');
    if (!host.trim() || !user.trim() || !pass.trim() || !identities.length) {
      setError('Enter host, username, password, and at least one From email');
      return;
    }
    setBusy(true);
    try {
      if (activate) {
        const test = await smtpService.testConnection({
          config: buildConfig(),
          sendTestEmail: false,
        });
        if (!test.success) {
          setError(test.error || test.message || 'Connection test failed — not saved');
          return;
        }
      }
      const created = await smtpService.create({
        name: name.trim() || identities[0]?.name || identities[0]?.email || host.trim(),
        label: name.trim() || null,
        config: buildConfig(),
        isActive: activate,
        isDefault,
        dailyLimit: dailyLimit ? Number(dailyLimit) : null,
        hourlyLimit: hourlyLimit ? Number(hourlyLimit) : null,
        minuteLimit: minuteLimit ? Number(minuteLimit) : null,
        priority: Number(priority || 0),
        notes: notes.trim() || null,
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save SMTP');
    } finally {
      setBusy(false);
    }
  }

  async function autoDetectTls() {
    setBusyDetect(true);
    setError('');
    try {
      const detected = await smtpService.detectTls(port || 587);
      setPort(String(detected.port));
      setEncryption(detected.encryption);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detect failed');
    } finally {
      setBusyDetect(false);
    }
  }

  async function testConnection(sendEmail: boolean) {
    setError('');
    if (sendEmail && !testTo.trim()) {
      setError('Enter a recipient for Test & send');
      return;
    }
    if (sendEmail) setBusySend(true);
    else setBusyTest(true);
    try {
      const r = await smtpService.testConnection({
        config: buildConfig(),
        sendTestEmail: sendEmail,
        testEmailTo: sendEmail ? testTo.trim() : undefined,
        notes: notes.trim() || null,
      });
      if (!r.success) setError(r.error || r.message || 'SMTP test failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusySend(false);
      setBusyTest(false);
    }
  }

  const socksFields = (
    <>
      <div>
        <Label>SOCKS host</Label>
        <Input value={socksHost} onChange={(e) => setSocksHost(e.target.value)} placeholder="127.0.0.1" />
      </div>
      <div>
        <Label>SOCKS port</Label>
        <Input value={socksPort} onChange={(e) => setSocksPort(e.target.value)} placeholder="Port" />
      </div>
      <div>
        <Label>SOCKS user (optional)</Label>
        <Input value={socksUser} onChange={(e) => setSocksUser(e.target.value)} />
      </div>
      <div>
        <Label>SOCKS password</Label>
        <Input type={showPass ? 'text' : 'password'} value={socksPass} onChange={(e) => setSocksPass(e.target.value)} />
      </div>
    </>
  );

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4">
      <form
        className="tui-box flex max-h-[92vh] w-full max-w-3xl flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <div className="tui-box-title shrink-0">Add SMTP</div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <Label>SMTP name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional label" />
            </div>
            <div className="col-span-2">
              <Label>SMTP host</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourprovider.com" required />
            </div>
            <div>
              <Label>Port</Label>
              <div className="flex gap-2">
                <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="587, 465, 2525…" />
                <Button type="button" variant="outline" size="sm" onClick={() => void autoDetectTls()} disabled={busyDetect}>
                  {busyDetect ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Auto TLS
                </Button>
              </div>
            </div>
            <div>
              <Label>Encryption</Label>
              <Select value={encryption} onChange={(e) => setEncryption(e.target.value)}>
                <option value="STARTTLS">STARTTLS (common on 587 / 2525)</option>
                <option value="SSL">SSL/TLS on connect (common on 465)</option>
                <option value="TLS">TLS</option>
                <option value="NONE">None (plain)</option>
              </Select>
            </div>
            <div>
              <Label>Username</Label>
              <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="you@yourdomain.com" required />
            </div>
            <div>
              <Label>Password / app password</Label>
              <div className="relative">
                <Input
                  type={showPass ? 'text' : 'password'}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  className="pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 border border-border bg-background p-1.5 text-muted-foreground hover:text-primary"
                  aria-label={showPass ? 'Hide password' : 'Show password'}
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="col-span-2 border border-border bg-muted/20 p-3">
              {smtpAllowDirect ? (
                <>
                  <Label>Outbound path</Label>
                  <Select
                    value={path}
                    onChange={(e) => setOutboundPath(e.target.value as 'direct' | 'bind' | 'socks')}
                  >
                    <option value="direct">Direct</option>
                    <option value="bind">Bind IP — localAddress on this machine</option>
                    <option value="socks">SOCKS5 — proxy host / port / user</option>
                  </Select>
                  {path === 'bind' ? (
                    <div className="mt-3">
                      <Label>Bind IP</Label>
                      <Input value={bindIp} onChange={(e) => setBindIp(e.target.value)} placeholder="203.0.113.10" />
                    </div>
                  ) : null}
                  {path === 'socks' ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">{socksFields}</div>
                  ) : null}
                </>
              ) : (
                <>
                  <Label>SOCKS5</Label>
                  <p className="mailer-hint mb-2 mt-0.5 text-[11px]">
                    Optional. Leave blank to send from this bound PC.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">{socksFields}</div>
                </>
              )}
            </div>
            <div className="col-span-2 border border-border bg-muted/20 p-3">
              <Label>Sender / From emails</Label>
              <p className="mailer-hint mb-2 mt-0.5 text-[11px] leading-snug">
                One SMTP login can send as several From addresses if the SMTP provider allows it.
                Campaigns can pin one or rotate these.
              </p>
              <div className="space-y-2">
                {senders.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2">
                    <Input
                      value={row.name}
                      onChange={(e) =>
                        setSenders((rows) => rows.map((s, idx) => (idx === i ? { ...s, name: e.target.value } : s)))
                      }
                      placeholder="From name (optional)"
                    />
                    <Input
                      type="email"
                      value={row.email}
                      onChange={(e) =>
                        setSenders((rows) => rows.map((s, idx) => (idx === i ? { ...s, email: e.target.value } : s)))
                      }
                      placeholder="hello@yourdomain.com"
                      required={i === 0}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="Add sender"
                      onClick={() =>
                        setSenders((rows) => [
                          ...rows.slice(0, i + 1),
                          { email: '', name: '' },
                          ...rows.slice(i + 1),
                        ])
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="Remove sender"
                      disabled={senders.length <= 1}
                      onClick={() =>
                        setSenders((rows) => {
                          const next = rows.filter((_, idx) => idx !== i);
                          return next.length ? next : [{ email: '', name: '' }];
                        })
                      }
                    >
                      −
                    </Button>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <Label>Reply-To (optional)</Label>
              <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
            </div>
            <div>
              <Label>Priority (optional)</Label>
              <Input value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
            <div>
              <Label>Daily limit (optional)</Label>
              <Input value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="e.g. 2000" />
            </div>
            <div>
              <Label>Hourly limit (optional)</Label>
              <Input value={hourlyLimit} onChange={(e) => setHourlyLimit(e.target.value)} placeholder="e.g. 200" />
            </div>
            <div>
              <Label>Per-minute limit (optional)</Label>
              <Input value={minuteLimit} onChange={(e) => setMinuteLimit(e.target.value)} placeholder="e.g. 20" />
            </div>
            <div className="col-span-2">
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-accent">Optional — quick-fill host defaults</p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_FILLS.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => {
                      if (q.patch.host) setHost(q.patch.host);
                      if (q.patch.port) setPort(q.patch.port);
                      if (q.patch.encryption) setEncryption(q.patch.encryption);
                      if (q.patch.ignoreTLS) setIgnoreTLS(true);
                    }}
                    className="border border-border px-2 py-1 text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="col-span-2">
              <Label>Notes (used as Test & send email body)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-18"
                placeholder="Optional — if empty, test email says: Your SMTP connection is working."
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Set as default SMTP (gets 465↔587 failover)
            </label>
            <label className="col-span-2 flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5" checked={ignoreTLS} onChange={(e) => setIgnoreTLS(e.target.checked)} />
              <span>Allow insecure TLS (skip certificate hostname checks only — STARTTLS still runs).</span>
            </label>
            <div className="col-span-2">
              <Label>Test email to (required for Test & send only)</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-[12rem] flex-1"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@gmail.com"
                />
                <Button type="button" variant="outline" className="whitespace-nowrap" disabled={busySend} onClick={() => void testConnection(true)}>
                  {busySend ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  Test & send
                </Button>
              </div>
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-border px-4 py-2">
          <Button type="button" className="whitespace-nowrap" disabled={busyTest} onClick={() => void testConnection(false)}>
            {busyTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Test Connection
          </Button>
          <Button type="button" variant="primary" className="whitespace-nowrap" disabled={busy} onClick={() => void save(true)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Add & Activate SMTP
          </Button>
          <Button type="button" variant="secondary" className="whitespace-nowrap" disabled={busy} onClick={() => void save(false)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save draft
          </Button>
          <Button type="button" variant="outline" className="whitespace-nowrap" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
