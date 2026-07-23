import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { templateService } from '@/services/template.service';
import { NewTemplateModal } from '@/components/templates/NewTemplateModal';
import { Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { Sparkles, Trash2 } from 'lucide-react';
import { toast } from '@/stores/toast';

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
  const [templates, setTemplates] = useState<
    Array<{ id: string; name: string; description?: string | null; isPublic: boolean; organizationId?: string | null }>
  >([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);

  async function load() {
    const d = await api.get<{ templates: typeof templates }>('/api/templates');
    setTemplates(d.templates);
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function duplicate(id: string) {
    try {
      await api.post(`/api/templates/${id}/duplicate`);
      await load();
      toast.success('Template duplicated');
    } catch (err) {
      toast.error('Could not duplicate', err instanceof Error ? err.message : undefined);
    }
  }

  async function createTemplate(input: { name: string; file: File | null }) {
    try {
      if (input.file) {
        const content = await input.file.text();
        const format = input.file.name.endsWith('.mjml') ? 'mjml' : 'html';
        await templateService.importHtml({
          filename: input.file.name,
          content,
          format,
          templateName: input.name,
          saveAsTemplate: true,
        });
        toast.success('Template imported', input.name);
      } else {
        await api.post('/api/templates', {
          name: input.name,
          htmlContent: '<p>Hello {{firstName}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
        });
        toast.success('Template created', input.name);
      }
      await load();
    } catch (err) {
      toast.error('Could not create template', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }

  async function remove(t: (typeof templates)[number]) {
    if (!confirm(`Delete “${t.name}”? This cannot be undone.`)) return;
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Templates</h1>
          <p className="text-ink-muted">Save, duplicate, and reuse email designs</p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setNewTemplateOpen(true)}>
          New template
        </Button>
      </div>

      <NewTemplateModal
        open={newTemplateOpen}
        onClose={() => setNewTemplateOpen(false)}
        onCreate={createTemplate}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => (
          <Card key={t.id}>
            <div className="font-medium">{t.name}</div>
            <p className="mt-1 text-sm text-ink-muted">
              {t.description || (t.isPublic ? 'Public template' : 'Private')}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to={`/app/campaigns/new?template=${t.id}`}
                className="inline-flex h-8 items-center justify-center border border-border bg-background px-3 text-xs hover:border-primary hover:bg-primary/10"
              >
                Use in campaign
              </Link>
              <Button variant="outline" size="sm" onClick={() => void duplicate(t.id)}>
                Duplicate
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={deletingId === t.id}
                onClick={() => void remove(t)}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {!templates.length ? (
        <Card className="py-10 text-center">
          <p className="mb-4 text-sm text-ink-muted">
            No templates yet. Click New template to name and import an HTML design, or start blank.
          </p>
          <Button onClick={() => setNewTemplateOpen(true)}>New template</Button>
        </Card>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const [keys, setKeys] = useState<Array<{ id: string; name: string; keyPrefix: string; createdAt: string }>>([]);
  const [providers, setProviders] = useState<
    Array<{ id: string; name: string; type: string; isDefault: boolean; isActive: boolean }>
  >([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [address, setAddress] = useState('');
  const [sessions, setSessions] = useState<Array<{ id: string; userAgent?: string; ipAddress?: string; createdAt: string }>>([]);

  async function load() {
    const [k, pvd, s, me] = await Promise.all([
      api.get<{ keys: typeof keys }>('/api/api-keys'),
      api.get<{ providers: typeof providers }>('/api/providers'),
      api.get<{ sessions: typeof sessions }>('/api/auth/sessions'),
      api.get<{ user: { organization?: { physicalAddress?: string } } }>('/api/auth/me'),
    ]);
    setKeys(k.keys);
    setProviders(pvd.providers);
    setSessions(s.sessions);
    setAddress(me.user.organization?.physicalAddress || '');
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
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Organization, API keys, and sessions</p>
      </div>

      <Card>
        <h2 className="mb-3 font-medium">Physical mailing address (CAN-SPAM)</h2>
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
      </Card>

      <Card>
        <h2 className="mb-1 font-medium">Email providers</h2>
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
            <p className="text-sm text-muted-foreground">No providers configured yet.</p>
          ) : null}
        </div>
        <Link
          to="/app/smtp"
          className="inline-flex items-center justify-center gap-2 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
        >
          Open SMTP Manager
        </Link>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">API keys</h2>
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
        {!keys.length ? <p className="text-sm text-muted-foreground">No API keys yet.</p> : null}
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">Active sessions</h2>
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
      </Card>
    </div>
  );
}

export function AdminPage() {
  const [users, setUsers] = useState<
    Array<{ id: string; email: string; firstName: string; lastName: string; role: string; status: string }>
  >([]);
  const [health, setHealth] = useState<{ status: string; database: string } | null>(null);
  const [logs, setLogs] = useState<Array<{ id: string; action: string; resource: string; createdAt: string }>>([]);

  useEffect(() => {
    Promise.all([
      api.get<{ users: typeof users }>('/api/admin/users'),
      api.get<{ status: string; database: string }>('/api/admin/health'),
      api.get<{ logs: typeof logs }>('/api/admin/audit-logs'),
    ])
      .then(([u, h, l]) => {
        setUsers(u.users);
        setHealth(h);
        setLogs(l.logs);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Admin</h1>
        <p className="text-ink-muted">Users, system health, and audit logs</p>
      </div>

      <Card>
        <h2 className="font-medium mb-2">System health</h2>
        <p className="text-sm">
          API: {health?.status || '…'} · Database: {health?.database || '…'}
        </p>
      </Card>

      <Card>
        <h2 className="font-medium mb-3">Users</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-muted border-b border-border">
              <th className="pb-2">Name</th>
              <th className="pb-2">Email</th>
              <th className="pb-2">Role</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border/50">
                <td className="py-2">
                  {u.firstName} {u.lastName}
                </td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2 className="font-medium mb-3">Audit logs</h2>
        {!logs.length && <p className="text-sm text-ink-muted">No audit entries yet.</p>}
        {logs.map((l) => (
          <div key={l.id} className="text-sm py-2 border-b border-border/50">
            {l.action} · {l.resource} · {new Date(l.createdAt).toLocaleString()}
          </div>
        ))}
      </Card>
    </div>
  );
}
