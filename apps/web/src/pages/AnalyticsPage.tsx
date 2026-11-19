import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api';
import { Button, PageLoading, Select } from '@/components/ui';
import { CampaignRecipientsPanel } from '@/components/campaigns/CampaignRecipientsPanel';
import { uiCacheGet, uiCacheSet } from '@/lib/ui-cache';

export function AnalyticsPage() {
  const [searchParams] = useSearchParams();
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>(
    () => uiCacheGet('analytics:campaigns') ?? [],
  );
  const [selectedId, setSelectedId] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'recipients'>('overview');
  const [loadingList, setLoadingList] = useState(() => !(uiCacheGet('analytics:campaigns') as unknown[] | null)?.length);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detail, setDetail] = useState<{
    campaign: {
      name: string;
      status?: string;
      sentCount: number;
      openedCount: number;
      clickedCount: number;
      bouncedCount: number;
      deliverabilityScore: number | null;
      sentAt?: string | null;
    };
    timeline: Array<{ date: string; opened: number; clicked: number; delivered: number }>;
    topLinks: Array<{ url: string; clicks: number }>;
    devices: Array<{ device: string; count: number }>;
    emailClients: Array<{ client: string; count: number }>;
  } | null>(null);

  useEffect(() => {
    if (!campaigns.length) setLoadingList(true);
    api
      .get<{ campaigns: Array<{ id: string; name: string }> }>('/api/campaigns')
      .then((d) => {
        setCampaigns(d.campaigns);
        uiCacheSet('analytics:campaigns', d.campaigns);
        const fromQuery = searchParams.get('campaign') || '';
        const pick =
          (fromQuery && d.campaigns.some((c) => c.id === fromQuery) && fromQuery) ||
          d.campaigns[0]?.id ||
          '';
        setSelectedId((prev) => (fromQuery && d.campaigns.some((c) => c.id === fromQuery) ? fromQuery : prev || pick));
      })
      .catch(console.error)
      .finally(() => setLoadingList(false));
  }, [searchParams]);

  useEffect(() => {
    if (!selectedId) return;
    type Detail = NonNullable<typeof detail>;
    const cachedDetail = uiCacheGet<Detail>(`analytics:${selectedId}`);
    if (cachedDetail) {
      setDetail(cachedDetail);
      setLoadingDetail(false);
    } else {
      setLoadingDetail(true);
    }
    api
      .get<Detail>(`/api/analytics/campaigns/${selectedId}`)
      .then((d) => {
        setDetail(d);
        uiCacheSet(`analytics:${selectedId}`, d);
      })
      .catch(console.error)
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  function exportCsv() {
    if (!detail) return;
    const rows = [
      ['metric', 'value'],
      ['sent', detail.campaign.sentCount],
      ['opened', detail.campaign.openedCount],
      ['clicked', detail.campaign.clickedCount],
      ['bounced', detail.campaign.bouncedCount],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'campaign-analytics.csv';
    a.click();
  }

  return (
    <div className="mailer-root page-root space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mailer-hint" style={{ marginTop: 0 }}>
            deliverability · analytics
          </p>
          <h1 className="page-title text-primary">Analytics</h1>
          <p className="page-sub">Opens, clicks, devices, and deliverability trends</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full sm:w-64"
            disabled={!campaigns.length}
          >
            {!campaigns.length ? <option value="">No campaigns yet</option> : null}
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Button variant="outline" onClick={exportCsv} disabled={!detail}>
            Export CSV
          </Button>
          <Button variant="outline" onClick={() => window.print()} disabled={!detail}>
            Export PDF
          </Button>
        </div>
      </div>

      {loadingList ? <PageLoading label="Loading analytics…" /> : null}

      {!loadingList && !campaigns.length ? (
        <div className="mailer-panel">
          <div className="mailer-pad py-10 text-center">
            <p className="mailer-hint" style={{ marginTop: 0 }}>
              Send a campaign first to unlock analytics.
            </p>
            <Link to="/app/campaigns/new" className="mt-3 inline-flex text-primary underline">
              New campaign
            </Link>
          </div>
        </div>
      ) : null}

      {loadingDetail && selectedId ? <PageLoading label="Loading campaign stats…" /> : null}

      {detail && !loadingDetail && (
        <div className="mailer-tabs">
          {(['overview', 'recipients'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={activeTab === tab ? 'on' : undefined}
            >
              {tab === 'recipients' ? `Recipients (${detail.campaign.sentCount})` : 'Overview'}
            </button>
          ))}
        </div>
      )}

      {detail && !loadingDetail && activeTab === 'recipients' && selectedId ? (
        <CampaignRecipientsPanel
          campaignId={selectedId}
          campaignName={detail.campaign.name}
          sentAt={detail.campaign.sentAt}
          campaignStatus={detail.campaign.status}
          compact
        />
      ) : null}

      {detail && !loadingDetail && activeTab === 'overview' && (
        <>
          <div className="mailer-statgrid">
            {[
              ['Sent', detail.campaign.sentCount],
              ['Opened', detail.campaign.openedCount],
              ['Clicked', detail.campaign.clickedCount],
              ['Bounced', detail.campaign.bouncedCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="mailer-stat">
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>

          <div className="mailer-panel">
            <div className="mailer-pad">
            <h2 className="mb-4 text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Engagement over time</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={detail.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(120 20% 18%)" />
                  <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'hsl(120 10% 55%)' }} />
                  <YAxis tick={{ fontSize: 12, fill: 'hsl(120 10% 55%)' }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="opened" stroke="hsl(120 90% 48%)" strokeWidth={2} />
                  <Line type="monotone" dataKey="clicked" stroke="hsl(120 70% 38%)" strokeWidth={2} />
                  <Line type="monotone" dataKey="delivered" stroke="hsl(120 40% 60%)" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="mailer-panel">
              <div className="mailer-pad">
              <h2 className="mb-4 text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Top devices</h2>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={detail.devices}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(120 20% 18%)" />
                    <XAxis dataKey="device" tick={{ fontSize: 12, fill: 'hsl(120 10% 55%)' }} />
                    <YAxis tick={{ fontSize: 12, fill: 'hsl(120 10% 55%)' }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="hsl(120 80% 42%)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              </div>
            </div>
            <div className="mailer-panel">
              <div className="mailer-pad">
              <h2 className="mb-4 text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Email clients</h2>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={detail.emailClients}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(120 20% 18%)" />
                    <XAxis dataKey="client" tick={{ fontSize: 12, fill: 'hsl(120 10% 55%)' }} />
                    <YAxis tick={{ fontSize: 12, fill: 'hsl(120 10% 55%)' }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="hsl(120 60% 45%)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              </div>
            </div>
          </div>

          <div className="mailer-panel">
            <div className="mailer-pad">
            <h2 className="mb-4 text-sm uppercase tracking-wide text-[var(--mailer-dim)]">Top links</h2>
            <div className="space-y-2">
              {detail.topLinks.map((link) => {
                const max = Math.max(...detail.topLinks.map((l) => l.clicks), 1);
                return (
                  <div key={link.url} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="truncate max-w-[80%]">{link.url}</span>
                      <span className="font-medium">{link.clicks}</span>
                    </div>
                    <div className="h-2 overflow-hidden border border-border bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${(link.clicks / max) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {!detail.topLinks.length && <p className="mailer-hint" style={{ marginTop: 0 }}>No click data yet.</p>}
            </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
