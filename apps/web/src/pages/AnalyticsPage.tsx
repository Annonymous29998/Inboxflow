import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { Button, Card, Select } from '@/components/ui';

export function AnalyticsPage() {
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<{
    campaign: {
      name: string;
      sentCount: number;
      openedCount: number;
      clickedCount: number;
      bouncedCount: number;
      deliverabilityScore: number | null;
    };
    timeline: Array<{ date: string; opened: number; clicked: number; delivered: number }>;
    topLinks: Array<{ url: string; clicks: number }>;
    devices: Array<{ device: string; count: number }>;
    emailClients: Array<{ client: string; count: number }>;
  } | null>(null);

  useEffect(() => {
    api.get<{ campaigns: Array<{ id: string; name: string }> }>('/api/campaigns').then((d) => {
      setCampaigns(d.campaigns);
      if (d.campaigns[0]) setSelectedId(d.campaigns[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    api.get<typeof detail>(`/api/analytics/campaigns/${selectedId}`).then(setDetail).catch(console.error);
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
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Analytics</h1>
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

      {!campaigns.length ? (
        <Card className="py-10 text-center">
          <p className="mb-4 text-sm text-ink-muted">Send a campaign first to unlock analytics.</p>
          <Link
            to="/app/campaigns/new"
            className="inline-flex items-center justify-center bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
          >
            New campaign
          </Link>
        </Card>
      ) : null}

      {detail && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-5">
            {[
              ['Sent', detail.campaign.sentCount],
              ['Opened', detail.campaign.openedCount],
              ['Clicked', detail.campaign.clickedCount],
              ['Bounced', detail.campaign.bouncedCount],
              ['Deliverability', detail.campaign.deliverabilityScore ?? '—'],
            ].map(([label, value]) => (
              <Card key={String(label)}>
                <div className="text-xs text-ink-muted uppercase">{label}</div>
                <div className="text-2xl font-semibold mt-1">{value}</div>
              </Card>
            ))}
          </div>

          <Card>
            <h2 className="font-display text-xl mb-4">Engagement over time</h2>
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
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <h2 className="font-display text-xl mb-4">Top devices</h2>
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
            </Card>
            <Card>
              <h2 className="font-display text-xl mb-4">Email clients</h2>
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
            </Card>
          </div>

          <Card>
            <h2 className="font-display text-xl mb-4">Top links (heatmap proxy)</h2>
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
              {!detail.topLinks.length && <p className="text-sm text-ink-muted">No click data yet.</p>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
