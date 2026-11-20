import {
  DEMO_ACCESS_TOKEN,
  DEMO_STAFF_ACCESS_TOKEN,
  DEMO_STAFF_ID,
  MAILER_UI_DEMO,
  demoMailerUser,
  demoStaffUser,
  readDemoBound,
} from '@/lib/demo-mailer';
import { parseContactImportRows } from '@/lib/parse-contact-import';
import {
  DEMO_SEED_VERSION,
  demoCampaignAnalytics,
  demoDashboard,
  demoDomains,
  demoLogs,
  demoMailerSeed,
  demoRecipients,
  demoSendStatus,
} from '@/lib/demo-mailer-seed';

const KEY = 'inboxflow-demo-workspace';
const VER_KEY = 'inboxflow-demo-workspace-v';

type Row = Record<string, unknown> & { id: string };

type Workspace = {
  campaigns: Row[];
  contacts: Row[];
  lists: Row[];
  providers: Row[];
  templates: Row[];
  domains: Row[];
};

function empty(): Workspace {
  return { campaigns: [], contacts: [], lists: [], providers: [], templates: [], domains: [] };
}

function seedWs(): Workspace {
  const s = demoMailerSeed();
  return {
    campaigns: s.campaigns as Row[],
    contacts: s.contacts as Row[],
    lists: s.lists as Row[],
    providers: s.providers as Row[],
    templates: s.templates as Row[],
    domains: demoDomains() as Row[],
  };
}

function load(): Workspace {
  if (typeof window === 'undefined') return empty();
  try {
    const ver = window.sessionStorage.getItem(VER_KEY);
    const raw = window.sessionStorage.getItem(KEY);
    if (ver !== DEMO_SEED_VERSION || !raw) {
      const seeded = seedWs();
      save(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<Workspace>;
    return {
      campaigns: parsed.campaigns || [],
      contacts: parsed.contacts || [],
      lists: parsed.lists || [],
      providers: parsed.providers || [],
      templates: parsed.templates || [],
      domains: parsed.domains || demoDomains() as Row[],
    };
  } catch {
    return seedWs();
  }
}

function save(ws: Workspace) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(KEY, JSON.stringify(ws));
  window.sessionStorage.setItem(VER_KEY, DEMO_SEED_VERSION);
}

function nid() {
  return `demo-${crypto.randomUUID()}`;
}

function splitPath(path: string) {
  const q = path.indexOf('?');
  const pathname = q >= 0 ? path.slice(0, q) : path;
  const search = q >= 0 ? path.slice(q + 1) : '';
  const params = new URLSearchParams(search);
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  return { pathname, params, parts };
}

export function isDemoAccessToken(token?: string | null) {
  return (
    MAILER_UI_DEMO &&
    (token === DEMO_ACCESS_TOKEN || token === DEMO_STAFF_ACCESS_TOKEN)
  );
}

function demoSessionUser() {
  try {
    const raw = window.sessionStorage.getItem('inboxflow-auth');
    const id = raw ? (JSON.parse(raw) as { state?: { user?: { id?: string } } }).state?.user?.id : '';
    if (id === DEMO_STAFF_ID) return demoStaffUser();
  } catch {
    /* ignore */
  }
  const bound = readDemoBound();
  return demoMailerUser(bound?.boundIp || '');
}

export async function demoMailerRequest<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const body = (options.body && typeof options.body === 'object' ? options.body : {}) as Record<string, unknown>;
  const { params, parts } = splitPath(path);
  const ws = load();
  const now = new Date().toISOString();

  if (parts[0] === 'api' && parts[1] === 'auth') {
    if (parts[2] === 'me') {
      return { user: demoSessionUser() } as T;
    }
    if (parts[2] === 'sessions') {
      return {
        sessions: [
          {
            id: 'demo-session-1',
            userAgent: 'Inbox Flow Demo',
            ip: '203.0.113.40',
            createdAt: new Date().toISOString(),
            current: true,
          },
        ],
      } as T;
    }
    if (parts[2] === 'logout') return { ok: true } as T;
    return { ok: true } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'api-keys') {
    if (method === 'GET') return { keys: [] } as T;
    if (method === 'POST') {
      return {
        key: { id: nid(), name: String(body.name || 'Key'), keyPrefix: 'if_demo', secret: 'demo-secret', createdAt: now },
      } as T;
    }
    return { ok: true } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'logs') {
    if (method === 'DELETE') return { ok: true } as T;
    let logs = demoLogs();
    const level = params.get('level');
    const category = params.get('category');
    const search = (params.get('search') || '').toLowerCase();
    if (level) logs = logs.filter((l) => l.level === level);
    if (category) logs = logs.filter((l) => l.category === category);
    if (search) logs = logs.filter((l) => l.message.toLowerCase().includes(search));
    const limit = Math.max(1, Number(params.get('limit') || 50));
    return { logs: logs.slice(0, limit) } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'analytics') {
    if (parts[2] === 'dashboard') {
      return demoDashboard(ws.campaigns, ws.contacts) as T;
    }
    if (parts[2] === 'campaigns' && parts[3]) {
      const campaign = ws.campaigns.find((c) => c.id === parts[3]);
      if (!campaign) return {} as T;
      if (parts[4] === 'recipients') {
        const { rows, summary } = demoRecipients(ws.contacts, campaign);
        const filter = params.get('filter') || 'ALL';
        const search = (params.get('search') || '').toLowerCase();
        let filtered = rows;
        if (filter === 'OPENED') filtered = rows.filter((r) => r.opened);
        else if (filter === 'CLICKED') filtered = rows.filter((r) => r.clicked);
        else if (filter === 'BOUNCED') filtered = rows.filter((r) => r.bounced);
        else if (filter === 'FAILED') filtered = rows.filter((r) => r.error);
        if (search) filtered = filtered.filter((r) => r.email.toLowerCase().includes(search));
        const page = Math.max(1, Number(params.get('page') || 1));
        const limit = Math.max(1, Number(params.get('limit') || 50));
        const start = (page - 1) * limit;
        return {
          recipients: filtered.slice(start, start + limit),
          summary,
          total: filtered.length,
          pages: Math.max(1, Math.ceil(filtered.length / limit)),
        } as T;
      }
      return demoCampaignAnalytics(campaign) as T;
    }
    return {} as T;
  }

  if (parts[0] === 'api' && parts[1] === 'domains') {
    if (method === 'GET' && !parts[2]) {
      return { domains: ws.domains, smtpHosts: ['smtp.hostinger.com'] } as T;
    }
    if (method === 'POST' && !parts[2]) {
      const domain: Row = {
        id: nid(),
        domain: String(body.domain || 'example.com'),
        status: 'PENDING',
        spfValid: false,
        dkimValid: false,
        dmarcValid: false,
        trackingValid: false,
        returnPathValid: false,
        reputationScore: 0,
        dnsRecords: [],
      };
      ws.domains.unshift(domain);
      save(ws);
      return { domain, instructions: { title: 'Add DNS', tip: 'Demo domain — no live DNS.' } } as T;
    }
    const domain = ws.domains.find((d) => d.id === parts[2]);
    if (parts[3] === 'verify') {
      return { domain: domain || null, verified: true } as T;
    }
    if (parts[3] === 'instructions') {
      return { instructions: { title: 'DNS records', tip: 'Demo workspace — records are sample only.' } } as T;
    }
    if (method === 'DELETE' && domain) {
      ws.domains = ws.domains.filter((d) => d.id !== parts[2]);
      save(ws);
    }
    return { domain: domain || null } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'campaigns') {
    const id = parts[2];
    if (!id || id === 'queue-console' || id === 'import-config') {
      if (method === 'GET' && id === 'queue-console') {
        return {
          campaigns: ws.campaigns.map((c) => ({
            ...c,
            pending: Number(c.pending ?? 0),
            sent: Number(c.sentCount ?? c.sent ?? 0),
            failed: Number(c.failedCount ?? c.failed ?? 0),
            opened: Number(c.openedCount ?? c.opened ?? 0),
            clicked: Number(c.clickedCount ?? c.clicked ?? 0),
            total: Number(c.totalRecipients ?? c.total ?? 0),
            updatedAt: String(c.updatedAt || now),
          })),
        } as T;
      }
      if (method === 'GET' && !id) {
        const page = Math.max(1, Number(params.get('page') || 1));
        const limit = Math.max(1, Number(params.get('limit') || 20));
        const start = (page - 1) * limit;
        const slice = ws.campaigns.slice(start, start + limit);
        return { campaigns: slice, total: ws.campaigns.length, page, limit } as T;
      }
      if (method === 'POST') {
        const campaign: Row = {
          id: nid(),
          name: String(body.name || ''),
          type: body.type || 'REGULAR',
          status: body.status || 'DRAFT',
          sentCount: 0,
          openedCount: 0,
          clickedCount: 0,
          deliveredCount: 0,
          failedCount: 0,
          totalRecipients: 0,
          createdAt: now,
          updatedAt: now,
          ...body,
        };
        ws.campaigns.unshift(campaign);
        save(ws);
        return { campaign } as T;
      }
      return { campaigns: [], total: 0 } as T;
    }
    const idx = ws.campaigns.findIndex((c) => c.id === id);
    if (parts[3] === 'send-status') {
      const campaign = idx >= 0 ? ws.campaigns[idx] : null;
      if (!campaign) return { success: false } as T;
      return demoSendStatus(campaign, ws.contacts) as T;
    }
    if (parts[3] === 'check-audience') {
      const listId = String(idx >= 0 ? ws.campaigns[idx]?.listId || '' : '');
      const pool = listId ? ws.contacts.filter((c) => c.listId === listId) : ws.contacts;
      const skipped = pool.filter((c) => c.status === 'BOUNCED' || !String(c.email || '').includes('@'));
      return {
        total: pool.length,
        sendable: pool.length - skipped.length,
        skipped: skipped.length,
        samples: skipped.slice(0, 8).map((c) => ({ email: c.email, reason: 'Demo skip', code: 'syntax' })),
      } as T;
    }
    if (parts[3] === 'remove-bounces') {
      const before = ws.contacts.length;
      ws.contacts = ws.contacts.filter((c) => c.status !== 'BOUNCED');
      save(ws);
      return { removed: before - ws.contacts.length, bounced: before - ws.contacts.length } as T;
    }
    if (method === 'GET') {
      if (idx < 0) return { campaign: null } as T;
      return { campaign: ws.campaigns[idx] } as T;
    }
    if (method === 'PATCH' && idx >= 0) {
      ws.campaigns[idx] = { ...ws.campaigns[idx], ...body, updatedAt: now };
      save(ws);
      return { campaign: ws.campaigns[idx] } as T;
    }
    if (method === 'DELETE' && idx >= 0) {
      ws.campaigns.splice(idx, 1);
      save(ws);
      return { ok: true } as T;
    }
    if (method === 'POST') return { ok: true, success: true, status: 'DRAFT' } as T;
    return { ok: true } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'contacts') {
    if (method === 'GET') {
      const listId = params.get('listId');
      const search = (params.get('search') || '').toLowerCase();
      const status = params.get('status');
      let rows = listId ? ws.contacts.filter((c) => c.listId === listId) : ws.contacts;
      if (status) rows = rows.filter((c) => c.status === status);
      if (search) {
        rows = rows.filter((c) =>
          [c.email, c.firstName, c.lastName].some((v) => String(v || '').toLowerCase().includes(search)),
        );
      }
      const page = Math.max(1, Number(params.get('page') || 1));
      const limit = Math.max(1, Number(params.get('limit') || 50));
      const start = (page - 1) * limit;
      return {
        contacts: rows.slice(start, start + limit),
        total: rows.length,
        page,
        pages: Math.max(1, Math.ceil(rows.length / limit)),
      } as T;
    }
    if (parts[2] === 'import' && method === 'POST') {
      const emails = parseContactImportRows(String(body.content || '')).map((r) => r.email);
      let listId = String(body.listId || '');
      const listName = String(body.listName || '').trim();
      if (!listId) {
        const list: Row = { id: nid(), name: listName || 'Untitled list', _count: { members: 0 } };
        ws.lists.unshift(list);
        listId = list.id;
      }
      const seen = new Set(
        ws.contacts.map((c) => String(c.email || '').toLowerCase()).filter(Boolean),
      );
      let created = 0;
      for (const email of emails) {
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        created++;
        ws.contacts.unshift({
          id: nid(),
          email,
          listId,
          status: 'SUBSCRIBED',
          source: 'import',
          createdAt: now,
        });
      }
      const list = ws.lists.find((l) => l.id === listId);
      if (list) list._count = { members: ws.contacts.filter((c) => c.listId === listId).length };
      save(ws);
      return { created, total: emails.length, addedToList: created, listId } as T;
    }
    if (method === 'POST') {
      const contact: Row = {
        id: nid(),
        email: String(body.email || ''),
        firstName: body.firstName ?? null,
        lastName: body.lastName ?? null,
        status: 'SUBSCRIBED',
        source: 'manual',
        createdAt: now,
        ...body,
      };
      ws.contacts.unshift(contact);
      save(ws);
      return { contact } as T;
    }
    if (method === 'DELETE' && parts[2]) {
      ws.contacts = ws.contacts.filter((c) => c.id !== parts[2]);
      save(ws);
      return { ok: true } as T;
    }
    return { ok: true } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'lists') {
    if (method === 'GET') return { lists: ws.lists } as T;
    if (method === 'POST') {
      const list: Row = { id: nid(), name: String(body.name || 'List'), _count: { members: 0 }, ...body };
      ws.lists.unshift(list);
      save(ws);
      return { list } as T;
    }
    return { lists: [] } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'providers') {
    const asProvider = (p: Row) => {
      let fromIdentities = p.fromIdentities;
      if (typeof fromIdentities === 'string') {
        try {
          fromIdentities = JSON.parse(fromIdentities);
        } catch {
          fromIdentities = [];
        }
      }
      return { ...p, fromIdentities: Array.isArray(fromIdentities) ? fromIdentities : [] };
    };
    if (method === 'GET' && !parts[2]) return { providers: ws.providers.map(asProvider) } as T;
    if (method === 'GET' && parts[2]) {
      const found = ws.providers.find((p) => p.id === parts[2]);
      return { provider: found ? asProvider(found) : null } as T;
    }
    if (method === 'POST' && !parts[2]) {
      const cfg =
        body.config && typeof body.config === 'object' ? (body.config as Record<string, string>) : {};
      const provider: Row = {
        id: nid(),
        name: String(body.name || cfg.fromEmail || cfg.host || 'SMTP'),
        type: String(body.type || 'SMTP'),
        isActive: body.isActive !== false,
        isDefault: Boolean(body.isDefault),
        lastTestStatus: 'Pending',
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        fromEmail: cfg.fromEmail,
        fromName: cfg.fromName,
        outboundPath: cfg.outboundPath || 'bind',
        bindIp: cfg.bindIp,
        socksHost: cfg.socksHost,
        socksPort: cfg.socksPort,
        viaApiKey: false,
      };
      ws.providers.unshift(provider);
      save(ws);
      return { provider } as T;
    }
    if (parts[2] && parts[3] === 'test') {
      return { result: { success: true, message: 'Connected (demo)' }, issues: [] } as T;
    }
    if (method === 'PATCH' && parts[2]) {
      const i = ws.providers.findIndex((p) => p.id === parts[2]);
      if (i >= 0) {
        const cfg =
          body.config && typeof body.config === 'object' ? (body.config as Record<string, string>) : {};
        ws.providers[i] = { ...ws.providers[i], ...body, ...cfg };
        save(ws);
        return { provider: ws.providers[i] } as T;
      }
    }
    if (method === 'DELETE' && parts[2]) {
      ws.providers = ws.providers.filter((p) => p.id !== parts[2]);
      save(ws);
    }
    return { ok: true } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'templates') {
    if (method === 'GET' && !parts[2]) return { templates: ws.templates } as T;
    if (method === 'GET' && parts[2]) {
      return { template: ws.templates.find((t) => t.id === parts[2]) || null } as T;
    }
    if (method === 'POST') {
      const template: Row = { id: nid(), name: String(body.name || 'Template'), ...body };
      ws.templates.unshift(template);
      save(ws);
      return { template } as T;
    }
    if (method === 'PATCH' && parts[2]) {
      const i = ws.templates.findIndex((t) => t.id === parts[2]);
      if (i >= 0) {
        ws.templates[i] = { ...ws.templates[i], ...body, id: ws.templates[i]!.id };
        save(ws);
        return { template: ws.templates[i] } as T;
      }
      return { template: null } as T;
    }
    if (method === 'DELETE' && parts[2]) {
      ws.templates = ws.templates.filter((t) => t.id !== parts[2]);
      save(ws);
      return { ok: true } as T;
    }
    return { templates: [] } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'import') {
    const html = String(body.content || '');
    const template: Row = {
      id: nid(),
      name: String(body.templateName || body.name || 'Imported letter'),
      htmlContent: html,
    };
    ws.templates.unshift(template);
    save(ws);
    return { html, plainText: '', template, validation: { warnings: [], flags: [] } } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'organization') {
    return { organization: { name: 'Demo Workspace', physicalAddress: '1 Demo Street, Remote' } } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'ai') {
    return { results: ['Subject A — catalog drop', 'Subject B — restock this week'], source: 'demo' } as T;
  }

  if (parts[0] === 'api' && parts[1] === 'workspace') return { ok: true } as T;

  if (method === 'GET') return {} as T;
  return { ok: true, success: true } as T;
}

