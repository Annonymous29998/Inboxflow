/** Demo mailer sandbox — UI design data only. Not operator/admin data. */

const LETTER = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4faf8;padding:24px;font-family:Georgia,serif">
<div style="max-width:600px;margin:0 auto;background:#fff;padding:40px">
  <p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#0f766e">Inbox Flow</p>
  <h1 style="font-size:28px;margin:8px 0 16px">Your spring catalog is ready</h1>
  <p style="font-size:16px;line-height:1.6;color:#1a1a1a">{Hi|Hello} {{firstName}}, the new drop is live. Open the catalog, pick a size, and we will hold stock for 48 hours.</p>
  <p style="text-align:center;margin:28px 0"><a href="https://inboxflow.io/catalog" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 28px;text-decoration:none;font-weight:600">Browse catalog</a></p>
  <p style="font-size:14px;line-height:1.6;text-align:center"><a href="https://inboxflow.io/lookbook">Spring lookbook</a> · <a href="https://inboxflow.io/size-guide">Size guide</a></p>
  <p style="margin-top:40px;font-size:12px;color:#666;text-align:center">{{physical_address}}<br/><a href="{{unsubscribe_url}}" style="color:#666">Unsubscribe</a></p>
</div></body></html>`;

function daysAgo(n: number, hour = 14) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 20, 0, 0);
  return d.toISOString();
}

export const DEMO_SEED_VERSION = '5';

export function demoMailerSeed() {
  const listWarm = {
    id: 'demo-list-warm',
    name: 'Warm list · April',
    _count: { members: 8 },
  };
  const listNew = {
    id: 'demo-list-new',
    name: 'New signups',
    _count: { members: 4 },
  };

  const people = [
    ['ava.nguyen', 'Ava', 'Nguyen', listWarm.id, 'SUBSCRIBED'],
    ['marcus.cole', 'Marcus', 'Cole', listWarm.id, 'SUBSCRIBED'],
    ['priya.shah', 'Priya', 'Shah', listWarm.id, 'SUBSCRIBED'],
    ['leo.martin', 'Leo', 'Martin', listWarm.id, 'SUBSCRIBED'],
    ['hana.kim', 'Hana', 'Kim', listWarm.id, 'SUBSCRIBED'],
    ['owen.blake', 'Owen', 'Blake', listWarm.id, 'UNSUBSCRIBED'],
    ['sofia.rossi', 'Sofia', 'Rossi', listWarm.id, 'SUBSCRIBED'],
    ['noah.patel', 'Noah', 'Patel', listWarm.id, 'BOUNCED'],
    ['elena.ward', 'Elena', 'Ward', listNew.id, 'SUBSCRIBED'],
    ['james.okonkwo', 'James', 'Okonkwo', listNew.id, 'SUBSCRIBED'],
    ['mia.chen', 'Mia', 'Chen', listNew.id, 'SUBSCRIBED'],
    ['theo.berg', 'Theo', 'Berg', listNew.id, 'SUBSCRIBED'],
  ] as const;

  const contacts = people.map(([local, firstName, lastName, listId, status], i) => ({
    id: `demo-contact-${i + 1}`,
    email: `${local}@example.com`,
    firstName,
    lastName,
    listId,
    status,
    source: 'import',
    createdAt: daysAgo(18 - i),
    listMemberships: [
      { list: { id: listId, name: listId === listWarm.id ? listWarm.name : listNew.name } },
    ],
  }));

  const smtpHostinger = {
    id: 'demo-smtp-hostinger',
    name: 'Hostinger · hello@',
    type: 'SMTP',
    isActive: true,
    isDefault: true,
    lastTestStatus: 'Connected',
    priority: 10,
    hourlyLimit: 200,
    host: 'smtp.hostinger.com',
    port: '465',
    encryption: 'SSL',
    user: 'hello@demo.inboxflow.io',
    fromEmail: 'hello@demo.inboxflow.io',
    fromName: 'Inbox Flow Demo',
    fromIdentities: [
      { email: 'hello@demo.inboxflow.io', name: 'Inbox Flow Demo' },
      { email: 'news@demo.inboxflow.io', name: 'IF News' },
    ],
    outboundPath: 'bind',
    bindIp: '203.0.113.40',
    viaApiKey: false,
    sentToday: 420,
    dailyLimit: 2000,
    successCount: 1840,
    failCount: 12,
    successRate: 99,
    issues: [],
  };

  const smtpSocks = {
    id: 'demo-smtp-socks',
    name: 'Relay · SOCKS5',
    type: 'SMTP',
    isActive: true,
    isDefault: false,
    lastTestStatus: 'Connected',
    priority: 5,
    hourlyLimit: 80,
    host: 'smtp.bulko.io',
    port: '2525',
    encryption: 'STARTTLS',
    user: 'demo-relay',
    fromEmail: 'relay@demo.inboxflow.io',
    fromName: 'Relay',
    fromIdentities: [{ email: 'relay@demo.inboxflow.io', name: 'Relay' }],
    outboundPath: 'socks',
    socksHost: '10.0.0.8',
    socksPort: '1080',
    socksUser: 'proxy',
    viaApiKey: false,
    sentToday: 80,
    dailyLimit: 500,
    successCount: 210,
    failCount: 4,
    successRate: 98,
    issues: [],
  };

  const tplCatalog = {
    id: 'demo-tpl-catalog',
    name: 'Spring catalog',
    htmlContent: LETTER,
    updatedAt: daysAgo(2),
  };
  const tplPlain = {
    id: 'demo-tpl-plain',
    name: 'Plain notice',
    htmlContent: LETTER.replace('Your spring catalog is ready', 'A quick note'),
    updatedAt: daysAgo(6),
  };

  const queue = {
    batchSize: 20,
    batchPauseMs: 2000,
    betweenEmailMs: 200,
    maxPerMinute: 80,
    sendChannel: 'smtp' as const,
    providerIds: [smtpHostinger.id, smtpSocks.id],
  };

  const campaignSent = {
    id: 'demo-campaign-sent',
    name: 'April catalog',
    type: 'REGULAR',
    status: 'SENT',
    subject: 'Your spring catalog is ready',
    senderName: 'Inbox Flow Demo',
    senderEmail: 'hello@demo.inboxflow.io',
    htmlContent: LETTER,
    listId: listWarm.id,
    templateId: tplCatalog.id,
    templatePool: [tplCatalog.id],
    providerId: smtpHostinger.id,
    queueSettings: queue,
    trackOpens: true,
    trackClicks: true,
    sentCount: 1840,
    openedCount: 612,
    clickedCount: 94,
    deliveredCount: 1798,
    failedCount: 12,
    bouncedCount: 8,
    totalRecipients: 1852,
    deliverabilityScore: 82,
    sentAt: daysAgo(1, 9),
    createdAt: daysAgo(4),
    updatedAt: daysAgo(1, 11),
    pending: 0,
  };

  const campaignSending = {
    id: 'demo-campaign-sending',
    name: 'Signup welcome',
    type: 'REGULAR',
    status: 'SENDING',
    subject: 'Welcome — start here',
    senderName: 'Inbox Flow Demo',
    senderEmail: 'hello@demo.inboxflow.io',
    htmlContent: LETTER,
    listId: listNew.id,
    templateId: tplPlain.id,
    templatePool: [tplPlain.id],
    providerId: smtpHostinger.id,
    queueSettings: queue,
    trackOpens: true,
    trackClicks: true,
    sentCount: 210,
    openedCount: 48,
    clickedCount: 11,
    deliveredCount: 204,
    failedCount: 3,
    totalRecipients: 400,
    pending: 187,
    createdAt: daysAgo(0, 8),
    updatedAt: new Date().toISOString(),
  };

  const campaignDraft = {
    id: 'demo-campaign-draft',
    name: 'May restock',
    type: 'REGULAR',
    status: 'DRAFT',
    subject: 'Back in stock this week',
    senderName: 'Inbox Flow Demo',
    senderEmail: 'hello@demo.inboxflow.io',
    htmlContent: LETTER,
    listId: listWarm.id,
    templateId: tplCatalog.id,
    templatePool: [tplCatalog.id],
    providerId: smtpHostinger.id,
    queueSettings: queue,
    trackOpens: true,
    trackClicks: true,
    sentCount: 0,
    openedCount: 0,
    clickedCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    totalRecipients: 8,
    createdAt: daysAgo(0, 10),
    updatedAt: daysAgo(0, 10),
  };

  return {
    lists: [listWarm, listNew],
    contacts,
    providers: [smtpHostinger, smtpSocks],
    templates: [tplCatalog, tplPlain],
    campaigns: [campaignSending, campaignDraft, campaignSent],
  };
}

export function demoLogs() {
  const rows: Array<{ id: string; level: string; category: string; message: string; createdAt: string }> = [
    { id: 'log-1', level: 'INFO', category: 'smtp', message: 'Connected to smtp.hostinger.com:465', createdAt: daysAgo(0, 8) },
    { id: 'log-2', level: 'SUCCESS', category: 'queue', message: 'April catalog · 20 accepted (batch 1)', createdAt: daysAgo(1, 9) },
    { id: 'log-3', level: 'SUCCESS', category: 'delivery', message: 'Email delivered · ava.nguyen@example.com', createdAt: daysAgo(1, 9) },
    { id: 'log-4', level: 'INFO', category: 'tracking', message: 'Open · priya.shah@example.com', createdAt: daysAgo(1, 10) },
    { id: 'log-5', level: 'INFO', category: 'tracking', message: 'Click · https://inboxflow.io · marcus.cole@example.com', createdAt: daysAgo(1, 10) },
    { id: 'log-6', level: 'WARNING', category: 'delivery', message: 'Temporary bounce · noah.patel@example.com', createdAt: daysAgo(1, 9) },
    { id: 'log-7', level: 'ERROR', category: 'smtp', message: 'Relay auth retry then recovered (SOCKS5)', createdAt: daysAgo(0, 8) },
    { id: 'log-8', level: 'SUCCESS', category: 'queue', message: 'Signup welcome · sending 210 / 400', createdAt: daysAgo(0, 8) },
    { id: 'log-9', level: 'INFO', category: 'system', message: 'Bind PC 203.0.113.40 · tracking origin http://203.0.113.40:5000', createdAt: daysAgo(0, 7) },
    { id: 'log-10', level: 'SUCCESS', category: 'smtp', message: 'Test Connection · Hostinger · hello@', createdAt: daysAgo(2, 16) },
  ];
  return rows;
}

export function demoDomains() {
  return [
    {
      id: 'demo-domain-1',
      domain: 'demo.inboxflow.io',
      status: 'VERIFIED',
      spfValid: true,
      dkimValid: true,
      dmarcValid: true,
      trackingValid: true,
      returnPathValid: true,
      reputationScore: 86,
      hasDkimPrivateKey: true,
      dkimSelector: 'inboxflow',
      dnsRecords: [
        { id: 'dns-1', type: 'TXT', host: '@', value: 'v=spf1 include:_spf.hostinger.com ~all', status: 'VALID' },
        { id: 'dns-2', type: 'CNAME', host: 'inboxflow._domainkey', value: 'inboxflow._domainkey.demo.inboxflow.io', status: 'VALID' },
        { id: 'dns-3', type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none; rua=mailto:dmarc@demo.inboxflow.io', status: 'VALID' },
      ],
      smtpCredentials: [],
    },
  ];
}

export function demoCampaignAnalytics(campaign: Record<string, unknown>) {
  const sent = Number(campaign.sentCount || 0);
  const opened = Number(campaign.openedCount || 0);
  const clicked = Number(campaign.clickedCount || 0);
  const delivered = Number(campaign.deliveredCount || sent);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    campaign: {
      name: campaign.name,
      status: campaign.status,
      sentCount: sent,
      openedCount: opened,
      clickedCount: clicked,
      bouncedCount: Number(campaign.bouncedCount || 0),
      deliverabilityScore: campaign.deliverabilityScore ?? 80,
      sentAt: campaign.sentAt ?? null,
    },
    timeline: days.map((date, i) => ({
      date,
      opened: Math.round((opened / 7) * (0.6 + (i % 3) * 0.2)),
      clicked: Math.round((clicked / 7) * (0.5 + (i % 2) * 0.3)),
      delivered: Math.round((delivered / 7) * (0.8 + (i % 4) * 0.05)),
    })),
    topLinks: [
      { url: 'https://inboxflow.io', clicks: Math.max(clicked, 1) },
      { url: 'https://inboxflow.io/catalog', clicks: Math.max(Math.round(clicked * 0.4), 0) },
    ],
    devices: [
      { device: 'Desktop', count: Math.round(opened * 0.55) },
      { device: 'Mobile', count: Math.round(opened * 0.38) },
      { device: 'Tablet', count: Math.max(opened - Math.round(opened * 0.93), 0) },
    ],
    emailClients: [
      { client: 'Gmail', count: Math.round(opened * 0.48) },
      { client: 'Apple Mail', count: Math.round(opened * 0.22) },
      { client: 'Outlook', count: Math.round(opened * 0.18) },
      { client: 'Other', count: Math.max(opened - Math.round(opened * 0.88), 0) },
    ],
  };
}

export function demoRecipients(contacts: Array<Record<string, unknown>>, campaign: Record<string, unknown>) {
  const listId = String(campaign.listId || '');
  const pool = contacts.filter((c) => !listId || c.listId === listId);
  const rows = pool.map((c, i) => {
    const bounced = c.status === 'BOUNCED';
    const unsub = c.status === 'UNSUBSCRIBED';
    const opened = !bounced && !unsub && i % 3 !== 2;
    const clicked = opened && i % 4 === 0;
    return {
      id: `rcpt-${campaign.id}-${c.id}`,
      email: String(c.email),
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
      status: bounced ? 'BOUNCED' : unsub ? 'UNSUBSCRIBED' : opened ? (clicked ? 'CLICKED' : 'OPENED') : 'DELIVERED',
      delivered: !bounced,
      opened,
      clicked,
      bounced,
      openCount: opened ? 1 + (i % 2) : 0,
      clickCount: clicked ? 1 : 0,
      sentAt: String(campaign.sentAt || campaign.updatedAt || ''),
      openedAt: opened ? String(campaign.updatedAt || '') : null,
      clickedAt: clicked ? String(campaign.updatedAt || '') : null,
      error: bounced ? '550 mailbox unavailable' : null,
    };
  });
  const summary = {
    sent: Number(campaign.sentCount || rows.length),
    delivered: Number(campaign.deliveredCount || rows.filter((r) => r.delivered).length),
    opened: Number(campaign.openedCount || rows.filter((r) => r.opened).length),
    clicked: Number(campaign.clickedCount || rows.filter((r) => r.clicked).length),
    failed: Number(campaign.failedCount || 0),
    bounced: Number(campaign.bouncedCount || rows.filter((r) => r.bounced).length),
  };
  return { rows, summary };
}

export function demoSendStatus(campaign: Record<string, unknown>, contacts: Array<Record<string, unknown>>) {
  const { rows } = demoRecipients(contacts, campaign);
  const sent = Number(campaign.sentCount || 0);
  const failed = Number(campaign.failedCount || 0);
  const pending = Number(campaign.pending || 0);
  return {
    success: true,
    status: campaign.status,
    name: campaign.name,
    subject: campaign.subject,
    senderEmail: campaign.senderEmail,
    totalRecipients: Number(campaign.totalRecipients || rows.length),
    sentCount: sent,
    deliveredCount: Number(campaign.deliveredCount || sent),
    failedCount: failed,
    bouncedCount: Number(campaign.bouncedCount || 0),
    pendingCount: pending,
    openedCount: Number(campaign.openedCount || 0),
    clickedCount: Number(campaign.clickedCount || 0),
    completedAt: campaign.status === 'SENT' ? campaign.sentAt : null,
    jobId: campaign.status === 'SENDING' ? 'demo-job-sending' : null,
    lastEmail: rows[0]?.email || null,
    queueStage: campaign.status === 'SENDING' ? 'sending' : 'idle',
    pauseUntil: null,
    betweenEmailMs: 200,
    batchPauseMs: 2000,
    batchNumber: 11,
    queueBatchSize: 20,
    recentSent: rows.filter((r) => r.delivered).slice(0, 8).map((r) => ({ email: r.email, at: r.sentAt })),
    recentFailures: rows.filter((r) => r.error).map((r) => ({ email: r.email, error: r.error })),
    recentBounces: rows.filter((r) => r.bounced).map((r) => ({ email: r.email, error: r.error })),
    recentOpens: rows.filter((r) => r.opened).slice(0, 8).map((r) => ({ email: r.email, at: r.openedAt })),
    recentClicks: rows.filter((r) => r.clicked).slice(0, 8).map((r) => ({ email: r.email, at: r.clickedAt, url: 'https://inboxflow.io' })),
    activity: rows.map((r) => ({
      email: r.email,
      status: r.bounced ? 'BOUNCED' : r.clicked ? 'CLICKED' : r.opened ? 'OPENED' : 'DELIVERED',
      error: r.error,
      at: r.sentAt || new Date().toISOString(),
    })),
    engagementActivity: [],
  };
}

export function demoDashboard(campaigns: Array<Record<string, unknown>>, contacts: Array<Record<string, unknown>>) {
  const subscribed = contacts.filter((c) => c.status === 'SUBSCRIBED').length;
  const unsubscribed = contacts.filter((c) => c.status === 'UNSUBSCRIBED').length;
  const sent = campaigns.reduce((n, c) => n + Number(c.sentCount || 0), 0);
  const opened = campaigns.reduce((n, c) => n + Number(c.openedCount || 0), 0);
  const clicked = campaigns.reduce((n, c) => n + Number(c.clickedCount || 0), 0);
  const failed = campaigns.reduce((n, c) => n + Number(c.failedCount || 0), 0);
  return {
    stats: {
      totalContacts: contacts.length,
      subscribedContacts: subscribed,
      unsubscribedContacts: unsubscribed,
      activeCampaigns: campaigns.filter((c) => c.status === 'SENDING' || c.status === 'PAUSED').length,
      scheduledCampaigns: 0,
      emailsSent: sent,
      deliveryRate: sent ? (sent - failed) / sent : 0,
      bounceRate: sent ? 8 / sent : 0,
      openRate: sent ? opened / sent : 0,
      clickRate: sent ? clicked / sent : 0,
      spamComplaintRate: 0,
      domainHealth: 'GOOD',
      senderReputationScore: 86,
      domainsConfigured: 1,
      domainsVerified: 1,
    },
    recentCampaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      subject: c.subject ?? null,
      sentCount: Number(c.sentCount || 0),
      pendingCount: Number(c.pending || 0),
      totalRecipients: Number(c.totalRecipients || 0),
      openedCount: Number(c.openedCount || 0),
      clickedCount: Number(c.clickedCount || 0),
      deliverabilityScore: c.deliverabilityScore ?? 80,
      updatedAt: String(c.updatedAt || ''),
    })),
  };
}
