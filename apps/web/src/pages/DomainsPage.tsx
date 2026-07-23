import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Input, Label } from '@/components/ui';

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
  dnsRecords: Array<{ id: string; type: string; host: string; value: string; status: string }>;
};

export function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domainInput, setDomainInput] = useState('');
  const [selected, setSelected] = useState<Domain | null>(null);
  const [instructions, setInstructions] = useState<{
    title: string;
    tip: string;
    steps: Array<{ step: number; title: string; description: string; record?: { type: string; host: string; value: string; status: string } }>;
  } | null>(null);
  const [message, setMessage] = useState('');

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
    const data = await api.post<{ domain: Domain; instructions: typeof instructions }>('/api/domains', {
      domain: domainInput,
    });
    setDomainInput('');
    setSelected(data.domain);
    setInstructions(data.instructions);
    await load();
  }

  async function verify(id: string) {
    setMessage('Verifying DNS…');
    const data = await api.post<{ domain: Domain; instructions: typeof instructions; results: unknown[] }>(
      `/api/domains/${id}/verify`,
    );
    setSelected(data.domain);
    setInstructions(data.instructions);
    setMessage(`Verification complete. Status: ${data.domain.status}`);
    await load();
  }

  async function openWizard(domain: Domain) {
    setSelected(domain);
    const data = await api.get<{ instructions: typeof instructions }>(`/api/domains/${domain.id}/instructions`);
    setInstructions(data.instructions);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Domain authentication</h1>
        <p className="text-ink-muted">Configure SPF, DKIM, DMARC, tracking domain, and return-path</p>
      </div>

      {message && (
        <div className="border border-primary/40 bg-primary/10 px-4 py-2 text-sm text-primary">{message}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <form onSubmit={addDomain} className="flex gap-2">
              <div className="flex-1">
                <Label>Add sending domain</Label>
                <Input
                  placeholder="mail.yourcompany.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="mt-6">
                Add
              </Button>
            </form>
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
            <p className="px-1 text-sm text-ink-muted">Add a domain above to start SPF / DKIM / DMARC setup.</p>
          ) : null}
        </div>

        <Card className="min-h-[480px]">
          {selected && instructions ? (
            <div>
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-display text-2xl">{instructions.title}</h2>
                  <p className="text-sm text-ink-muted mt-1">{instructions.tip}</p>
                </div>
                <Button onClick={() => verify(selected.id)}>
                  <RefreshCw className="h-4 w-4" /> Verify DNS
                </Button>
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
            <div className="h-full flex items-center justify-center text-ink-muted text-sm">
              Select or add a domain to open the authentication wizard
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
