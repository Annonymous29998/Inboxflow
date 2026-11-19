import { useEffect, useState } from 'react';
import { Copy, RefreshCw, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Badge, Button, Card, Input, Label } from '@/components/ui';
import { toast } from '@/stores/toast';
import { confirmDialog } from '@/stores/confirm';
import { useDraft, useDraftStore } from '@/stores/draft';
import { uiCacheGet, uiCacheSet } from '@/lib/ui-cache';

type DnsRow = {
  type: string;
  host: string;
  value: string;
  status: string;
  dnsType?: 'TXT' | 'CNAME';
  fqdn?: string;
};

type SmtpCred = {
  id: string;
  username: string;
  host: string;
  port: number;
  encryption: string;
  dailyLimit: number;
  sentToday?: number;
  isActive: boolean;
  createdAt: string;
};

type Domain = {
  id: string;
  domain: string;
  status: string;
  spfValid: boolean;
  dkimValid: boolean;
  dmarcValid: boolean;
  trackingValid: boolean;
  returnPathValid: boolean;
  reputationScore: number;
  hasDkimPrivateKey?: boolean;
  dkimSelector?: string | null;
  dnsRecords: Array<{ id: string; type: string; host: string; value: string; status: string }>;
  smtpCredentials?: SmtpCred[];
};

type Instructions = {
  title: string;
  tip: string;
  sending?: string;
  smtpHosts?: string[];
  dnsRecords?: Array<DnsRow | undefined>;
  steps: Array<{
    step: number;
    title: string;
    description: string;
    record?: DnsRow;
  }>;
};

export function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>(() => uiCacheGet<Domain[]>('domains') ?? []);
  const [smtpHosts, setSmtpHosts] = useState<string[]>(() => uiCacheGet<string[]>('smtpHosts') ?? []);
  const [domainInput, setDomainInput] = useDraft<string>('domains:domainInput', '');
  const [selected, setSelected] = useDraft<Domain | null>('domains:selected', null);
  const [instructions, setInstructions] = useDraft<Instructions | null>('domains:instructions', null);
  const [issued, setIssued] = useState<{
    host: string;
    port: number;
    encryption: string;
    username: string;
    password: string;
    fromExample: string;
    dailyLimit: number;
  } | null>(null);

  async function load() {
    const data = await api.get<{ domains: Domain[]; smtpHosts?: string[] }>('/api/domains');
    setDomains(data.domains);
    setSmtpHosts(data.smtpHosts || []);
    uiCacheSet('domains', data.domains);
    uiCacheSet('smtpHosts', data.smtpHosts || []);
    if (selected) {
      const updated = data.domains.find((d) => d.id === selected.id);
      if (updated) setSelected(updated);
      else {
        setSelected(null);
        setInstructions(null);
      }
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    try {
      const data = await api.post<{ domain: Domain; instructions: Instructions }>('/api/domains', {
        domain: domainInput,
      });
      setDomainInput('');
      setSelected(data.domain);
      setInstructions(data.instructions);
      const clearDraft = useDraftStore.getState().clearDraft;
      clearDraft('domains:domainInput');
      await load();
      toast.success('Domain added — publish these DNS records', data.domain.domain);
    } catch (err) {
      toast.error('Could not add domain', err instanceof Error ? err.message : undefined);
    }
  }

  async function verify(id: string) {
    toast.info('Verifying DNS…');
    try {
      const data = await api.post<{ domain: Domain; instructions: Instructions }>(
        `/api/domains/${id}/verify`,
      );
      setSelected(data.domain);
      setInstructions(data.instructions);
      toast.success('Verification complete', `Status: ${data.domain.status}`);
      await load();
    } catch (err) {
      toast.error('Verification failed', err instanceof Error ? err.message : undefined);
    }
  }

  async function openWizard(domain: Domain) {
    setSelected(domain);
    const data = await api.get<{ instructions: Instructions }>(`/api/domains/${domain.id}/instructions`);
    setInstructions(data.instructions);
  }

  async function generateSmtp(id: string) {
    const ok = await confirmDialog({
      title: 'Generate Inbox Flow SMTP credentials?',
      description:
        'This does not change running campaigns. You paste the host/user/password into SMTP Manager on a new profile, then pin only the campaigns you want onto it.',
      confirmText: 'Generate',
    });
    if (!ok) return;
    try {
      const data = await api.post<{
        passwordOnce: string;
        credential: {
          host: string;
          port: number;
          encryption: string;
          username: string;
          fromExample: string;
          dailyLimit: number;
        };
      }>(`/api/domains/${id}/smtp-credentials`);
      setIssued({
        ...data.credential,
        password: data.passwordOnce,
      });
      toast.success('SMTP credentials ready', 'Copy the password now — it is shown once.');
      await load();
    } catch (err) {
      toast.error('Could not generate SMTP', err instanceof Error ? err.message : undefined);
    }
  }

  async function revokeSmtp(domainId: string, credId: string) {
    const ok = await confirmDialog({
      title: 'Revoke these SMTP credentials?',
      description: 'Profiles in SMTP Manager that still use this login will fail. Other SMTPs and campaigns are not changed.',
      confirmText: 'Revoke',
      destructive: true,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/domains/${domainId}/smtp-credentials/${credId}`);
      if (issued) setIssued(null);
      toast.success('Credentials revoked');
      await load();
    } catch (err) {
      toast.error('Could not revoke', err instanceof Error ? err.message : undefined);
    }
  }

  async function generateDkim(id: string) {
    toast.info('Generating DKIM key…');
    try {
      const data = await api.post<{
        domain: Domain;
        dnsRecord: { host: string; value: string };
        note?: string;
      }>(`/api/domains/${id}/dkim`, { generate: true, selector: 'inboxflow' });
      setSelected(data.domain);
      toast.success('DKIM key stored', data.note || 'Publish the TXT record, then Verify');
      await openWizard(data.domain);
      await load();
    } catch (err) {
      toast.error('DKIM setup failed', err instanceof Error ? err.message : undefined);
    }
  }

  async function removeDomain(e: React.MouseEvent, d: Domain) {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: `Remove ${d.domain}?`,
      description:
        'This only removes it from Inbox Flow. Delete the DNS rows at your registrar yourself if you no longer need them.',
      confirmText: 'Remove',
      destructive: true,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/domains/${d.id}`);
      if (selected?.id === d.id) {
        setSelected(null);
        setInstructions(null);
      }
      toast.success('Domain removed', d.domain);
      await load();
    } catch (err) {
      toast.error('Could not remove domain', err instanceof Error ? err.message : undefined);
    }
  }

  function copyValue(label: string, value: string) {
    void navigator.clipboard.writeText(value).then(
      () => toast.success('Copied', label),
      () => toast.error('Copy failed'),
    );
  }

  const dnsRows = (instructions?.dnsRecords || []).filter(Boolean) as DnsRow[];

  return (
    <div className="mailer-root page-root space-y-4">
      <div>
        <p className="mailer-hint" style={{ marginTop: 0 }}>
          deliverability · domains
        </p>
        <h1 className="page-title text-primary">Domains</h1>
        <p className="page-sub">
          Add a domain you own, copy the 3 DNS records, Verify, then Generate SMTP. Host is{' '}
          <code className="text-foreground">smtp.inboxflow.io</code>.
        </p>
        <p className="mailer-hint max-w-3xl">
          Three TXT records only: SPF, DKIM, DMARC. Then Verify DNS → Generate SMTP → paste into{' '}
          <Link to="/app/smtp" className="text-primary underline">
            SMTP Manager
          </Link>
          . Running campaigns stay on their current SMTP.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="mailer-panel">
            <div className="mailer-pad">
            <form onSubmit={addDomain} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Label>Add a domain you own</Label>
                <Input
                  placeholder="yourcompany.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  required
                />
              </div>
              <Button type="submit">Add</Button>
            </form>
            <p className="mailer-hint">
              Do not add <code className="text-foreground">gmail.com</code> or a provider&apos;s
              domain — you must be able to edit DNS.
            </p>
            </div>
          </div>

          {domains.map((d) => (
            <div key={d.id} className="camp-row cursor-pointer" onClick={() => openWizard(d)}>
              <div className="camp-row-main">
                <strong>{d.domain}</strong>
                <div className="meta">
                  {d.status} · Reputation {d.reputationScore}/100 · SPF {d.spfValid ? 'ok' : '—'} · DKIM{' '}
                  {d.dkimValid ? 'ok' : '—'} · DMARC {d.dmarcValid ? 'ok' : '—'}
                </div>
              </div>
              <div className="camp-row-actions">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    aria-label={`Remove ${d.domain}`}
                    onClick={(e) => void removeDomain(e, d)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
              </div>
            </div>
          ))}
          {!domains.length ? (
            <p className="px-1 text-sm text-ink-muted">
              Add a domain you own above. After DNS verifies, Campaigns can use any sender on that
              domain through your existing SMTP.
            </p>
          ) : null}
        </div>

        <div className="mailer-panel min-h-120">
          <div className="mailer-pad">
          {selected && instructions ? (
            <div>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-2xl">{instructions.title}</h2>
                  <p className="mt-1 text-sm text-ink-muted">{instructions.tip}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Button onClick={() => verify(selected.id)}>
                    <RefreshCw className="h-4 w-4" /> Verify DNS
                  </Button>
                  <Button variant="outline" onClick={() => void generateDkim(selected.id)}>
                    {selected.hasDkimPrivateKey ? 'Rotate DKIM' : 'Enable app DKIM'}
                  </Button>
                  {selected.status === 'VERIFIED' ? (
                    <Button variant="outline" onClick={() => void generateSmtp(selected.id)}>
                      Generate SMTP
                    </Button>
                  ) : null}
                </div>
              </div>

              {selected.status === 'VERIFIED' ? (
                <div className="mb-4 border border-primary/30 bg-primary/5 px-3 py-3 text-[12px]">
                  <div className="font-medium text-primary">Inbox Flow SMTP</div>
                  <p className="mt-1 text-ink-muted">
                    After Verify, generate credentials and paste them into{' '}
                    <Link to="/app/smtp" className="text-primary underline">
                      SMTP Manager
                    </Link>
                    . Host is <code className="text-foreground">smtp.inboxflow.io</code>. Do not
                    switch a campaign that is already sending.
                  </p>
                  {issued ? (
                    <div className="mt-3 space-y-1 border border-border bg-background p-3 font-mono text-[11px]">
                      <CopyRow label="Host" value={issued.host} onCopy={copyValue} />
                      <CopyRow label="Port" value={String(issued.port)} onCopy={copyValue} />
                      <CopyRow label="Encryption" value="STARTTLS (or NONE if test fails)" onCopy={copyValue} />
                      <CopyRow label="Username" value={issued.username} onCopy={copyValue} />
                      <CopyRow label="Password" value={issued.password} onCopy={copyValue} />
                      <CopyRow label="From example" value={issued.fromExample} onCopy={copyValue} />
                      <p className="pt-1 font-sans text-warning">Password is shown once. Copy it now.</p>
                    </div>
                  ) : null}
                  {(selected.smtpCredentials || []).filter((c) => c.isActive).length ? (
                    <ul className="mt-3 space-y-1 text-[11px] text-ink-muted">
                      {selected.smtpCredentials!
                        .filter((c) => c.isActive)
                        .map((c) => (
                          <li key={c.id} className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono">{c.username}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => void revokeSmtp(selected.id, c.id)}
                            >
                              Revoke
                            </Button>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {instructions.sending ? (
                <div className="mb-4 border border-border bg-muted px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
                  {instructions.sending}
                </div>
              ) : null}

              {dnsRows.length ? (
                <div className="mb-4 overflow-x-auto border border-border">
                  <div className="flex items-center justify-between border-b border-border bg-muted px-3 py-2">
                    <span className="text-[11px] uppercase tracking-wider text-accent">
                      Add these at your DNS provider
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const required = dnsRows.filter((r) =>
                          ['SPF', 'DKIM', 'DMARC'].includes(r.type),
                        );
                        const text = required
                          .map(
                            (r) =>
                              `${r.dnsType || 'TXT'}\t${r.host}\t${r.value}`,
                          )
                          .join('\n');
                        copyValue('DNS records', text);
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy SPF + DKIM + DMARC
                    </Button>
                  </div>
                  <table className="w-full text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-border text-ink-muted">
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Host / name</th>
                        <th className="px-3 py-2 font-medium">Value</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dnsRows.map((row) => (
                        <tr key={`${row.type}-${row.host}`} className="border-b border-border align-top last:border-0">
                          <td className="px-3 py-2 font-mono">{row.dnsType || 'TXT'}</td>
                          <td className="px-3 py-2">
                            <CopyCell
                              label="Host"
                              value={row.host}
                              hint={row.fqdn}
                              onCopy={copyValue}
                            />
                          </td>
                          <td className="max-w-56 px-3 py-2">
                            <CopyCell label="Value" value={row.value} onCopy={copyValue} />
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={row.status === 'VALID' ? 'success' : 'neutral'}>{row.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="space-y-4">
                {instructions.steps.map((step) => (
                  <div key={step.step} className="border border-border p-4">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center bg-primary text-xs text-primary-foreground">
                        {step.step}
                      </span>
                      <h3 className="font-medium">{step.title}</h3>
                      {step.record && (
                        <Badge tone={step.record.status === 'VALID' ? 'success' : 'neutral'}>
                          {step.record.status}
                        </Badge>
                      )}
                    </div>
                    <p className="mb-3 text-sm text-ink-muted">{step.description}</p>
                    {step.record && (
                      <div className="space-y-1 overflow-x-auto border border-border bg-muted p-3 font-mono text-xs">
                        <div>
                          <span className="text-ink-muted">Type:</span> {step.record.dnsType || 'TXT'}
                        </div>
                        <div>
                          <span className="text-ink-muted">Host:</span> {step.record.host}
                        </div>
                        <div className="break-all">
                          <span className="text-ink-muted">Value:</span> {step.record.value}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-muted">
              Add a domain you own, verify DNS, then Generate SMTP. Inbox Flow issues
              smtp.inboxflow.io credentials to paste into SMTP Manager.
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyCell({
  label,
  value,
  hint,
  onCopy,
}: {
  label: string;
  value: string;
  hint?: string;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0">
        <div className="break-all font-mono text-foreground">{value}</div>
        {hint && hint !== value ? <div className="break-all text-ink-muted">{hint}</div> : null}
      </div>
      <button
        type="button"
        className="shrink-0 p-1 text-ink-muted hover:text-primary"
        aria-label={`Copy ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onCopy(label, value);
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CopyRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 break-all">
        <span className="text-ink-muted">{label}:</span> {value}
      </div>
      <button
        type="button"
        className="shrink-0 p-1 text-ink-muted hover:text-primary"
        onClick={() => onCopy(label, value)}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

