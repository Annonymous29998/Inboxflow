import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Input, Label } from '@/components/ui';
import { toast } from '@/stores/toast';
import { useDraft, useDraftStore } from '@/stores/draft';

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
};

export function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domainInput, setDomainInput] = useDraft<string>('domains:domainInput', '');
  const [selected, setSelected] = useDraft<Domain | null>('domains:selected', null);
  const [instructions, setInstructions] = useDraft<{
    title: string;
    tip: string;
    steps: Array<{ step: number; title: string; description: string; record?: { type: string; host: string; value: string; status: string } }>;
  } | null>('domains:instructions', null);

  async function load() {
    const data = await api.get<{ domains: Domain[] }>('/api/domains');
    setDomains(data.domains);
    if (selected) {
      const updated = data.domains.find((d) => d.id === selected.id);
      if (updated) setSelected(updated);
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    try {
      const data = await api.post<{ domain: Domain; instructions: typeof instructions }>('/api/domains', {
        domain: domainInput,
      });
      setDomainInput('');
      setSelected(data.domain);
      setInstructions(data.instructions);
      const clearDraft = useDraftStore.getState().clearDraft;
      clearDraft('domains:domainInput');
      await load();
      toast.success('Domain added', data.domain.domain);
    } catch (err) {
      toast.error('Could not add domain', err instanceof Error ? err.message : undefined);
    }
  }

  async function verify(id: string) {
    toast.info('Verifying DNS…');
    try {
      const data = await api.post<{ domain: Domain; instructions: typeof instructions; results: unknown[] }>(
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
    const data = await api.get<{ instructions: typeof instructions }>(`/api/domains/${domain.id}/instructions`);
    setInstructions(data.instructions);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Domain authentication</h1>
        <p className="text-ink-muted">
          Verify a domain you own, then publish SPF, DKIM, DMARC, tracking, and return-path records.
        </p>
        <div className="mt-3 max-w-3xl border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
          <span className="text-primary">You must verify a domain you control.</span> SPF must list
          the SMTP you actually send with. <strong className="text-foreground">Brevo</strong> needs{' '}
          <code className="text-foreground">include:spf.brevo.com</code> on the From domain (and on{' '}
          <code className="text-foreground">client.yourdomain</code> if you From that host). The
          SMTP Provider IP <code className="text-foreground">136.243.17.45</code> is only for
          akoneseo — do not add it for Brevo. After DNS, wait 10–30 minutes, then Gmail → Show
          original → SPF: PASS.
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <form onSubmit={addDomain} className="flex gap-2">
              <div className="flex-1">
                <Label>Add a domain you own</Label>
                <Input
                  placeholder="yourcompany.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="mt-6">
                Add
              </Button>
            </form>
            <p className="mt-2 text-[11px] text-ink-muted">
              Do not add <code className="text-foreground">bulko.io</code>,{' '}
              <code className="text-foreground">gmail.com</code>, or other providers&apos; domains —
              you cannot publish DNS for those.
            </p>
          </Card>

          {domains.map((d) => (
            <Card key={d.id} className="cursor-pointer hover:border-primary/40" onClick={() => openWizard(d)}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{d.domain}</div>
                  <div className="text-sm text-ink-muted">Reputation {d.reputationScore}/100</div>
                </div>
                <Badge tone={d.status === 'VERIFIED' ? 'success' : 'warning'}>{d.status}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <AuthPill ok={d.spfValid} label="SPF" />
                <AuthPill ok={d.dkimValid} label="DKIM" />
                <AuthPill ok={d.dmarcValid} label="DMARC" />
                <AuthPill ok={d.trackingValid} label="Tracking" />
                <AuthPill ok={d.returnPathValid} label="Return-Path" />
              </div>
            </Card>
          ))}
          {!domains.length ? (
            <p className="px-1 text-sm text-ink-muted">
              Add a domain you own above, then verify SPF / DKIM / DMARC. Your SMTP login (e.g. Bulko)
              alone is not enough for inbox placement.
            </p>
          ) : null}
        </div>

        <Card className="min-h-120">
          {selected && instructions ? (
            <div>
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-display text-2xl">{instructions.title}</h2>
                  <p className="text-sm text-ink-muted mt-1">{instructions.tip}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Button onClick={() => verify(selected.id)}>
                    <RefreshCw className="h-4 w-4" /> Verify DNS
                  </Button>
                  <Button variant="outline" onClick={() => void generateDkim(selected.id)}>
                    {selected.hasDkimPrivateKey ? 'Rotate DKIM' : 'Enable app DKIM'}
                  </Button>
                </div>
              </div>
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
                          <span className="text-ink-muted">Type:</span> TXT / CNAME
                        </div>
                        <div>
                          <span className="text-ink-muted">Host:</span> {step.record.host}
                        </div>
                        <div>
                          <span className="text-ink-muted">Value:</span> {step.record.value}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-ink-muted text-sm px-6 text-center">
              Select or add a domain you own to open the authentication wizard. Provider domains
              (bulko.io, sendgrid.net, gmail.com, etc.) cannot be verified here.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function AuthPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 border border-border bg-muted px-2 py-1 text-xs">
      {ok ? <CheckCircle2 className="h-3 w-3 text-primary" /> : <Circle className="h-3 w-3 text-ink-muted" />}
      {label}
    </span>
  );
}
