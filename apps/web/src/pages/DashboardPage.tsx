import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Users,
  Mail,
  Calendar,
  Send,
  TrendingUp,
  AlertTriangle,
  MousePointerClick,
  ShieldAlert,
  Globe,
  Activity,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Card } from '@/components/ui';
import { formatNumber, formatPercent, scoreColor } from '@/lib/utils';

type DashboardData = {
  stats: {
    totalContacts: number;
    activeCampaigns: number;
    scheduledCampaigns: number;
    emailsSent: number;
    deliveryRate: number;
    bounceRate: number;
    openRate: number;
    clickRate: number;
    spamComplaintRate: number;
    domainHealth: string;
    senderReputationScore: number;
    domainsConfigured: number;
    domainsVerified: number;
  };
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    subject: string | null;
    sentCount: number;
    openedCount: number;
    clickedCount: number;
    deliverabilityScore: number | null;
    updatedAt: string;
  }>;
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<DashboardData>('/api/analytics/dashboard')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, []);

  const stats = data?.stats;

  const cards = [
    { label: 'Total Contacts', value: formatNumber(stats?.totalContacts ?? 0), icon: Users },
    { label: 'Active Campaigns', value: formatNumber(stats?.activeCampaigns ?? 0), icon: Mail },
    { label: 'Scheduled', value: formatNumber(stats?.scheduledCampaigns ?? 0), icon: Calendar },
    { label: 'Emails Sent', value: formatNumber(stats?.emailsSent ?? 0), icon: Send },
    { label: 'Delivery Rate', value: formatPercent(stats?.deliveryRate ?? 0), icon: TrendingUp },
    { label: 'Bounce Rate', value: formatPercent(stats?.bounceRate ?? 0), icon: AlertTriangle },
    { label: 'Open Rate', value: formatPercent(stats?.openRate ?? 0), icon: Mail },
    { label: 'Click Rate', value: formatPercent(stats?.clickRate ?? 0), icon: MousePointerClick },
    { label: 'Spam Complaints', value: formatPercent(stats?.spamComplaintRate ?? 0), icon: ShieldAlert },
    {
      label: 'Domain Health',
      value: (stats?.domainHealth || '—').replace('_', ' '),
      icon: Globe,
    },
    {
      label: 'Sender Reputation',
      value: String(stats?.senderReputationScore ?? 0),
      icon: Activity,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">Performance overview and deliverability health</p>
        </div>
        <Link
          to="/app/campaigns/new"
          className="inline-flex min-h-10 w-full items-center justify-center bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:brightness-110 sm:w-auto"
        >
          New campaign
        </Link>
      </div>

      {error ? (
        <div className="border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">
          <span className="text-primary">$</span> loading metrics…
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-4">
        {cards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
          >
            <Card className="h-full p-3 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-ink-muted sm:text-xs">{card.label}</div>
                <card.icon className="h-4 w-4 shrink-0 text-primary" />
              </div>
              <div className="mt-2 text-lg font-semibold tracking-tight capitalize sm:mt-3 sm:text-2xl">{card.value}</div>
            </Card>
          </motion.div>
        ))}
      </div>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-2xl">Recent campaigns</h2>
          <Link to="/app/campaigns" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted border-b border-border">
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Sent</th>
                <th className="pb-3 font-medium">Opens</th>
                <th className="pb-3 font-medium">Clicks</th>
                <th className="pb-3 font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentCampaigns || []).map((c) => (
                <tr key={c.id} className="border-b border-border/60 last:border-0">
                  <td className="py-3">
                    <Link to={`/app/campaigns/${c.id}`} className="font-medium hover:text-primary">
                      {c.name}
                    </Link>
                    <div className="text-xs text-ink-muted truncate max-w-xs">{c.subject}</div>
                  </td>
                  <td>
                    <Badge tone={c.status === 'SENT' ? 'success' : c.status === 'DRAFT' ? 'neutral' : 'info'}>
                      {c.status}
                    </Badge>
                  </td>
                  <td>{c.sentCount}</td>
                  <td>{c.openedCount}</td>
                  <td>{c.clickedCount}</td>
                  <td>
                    {c.deliverabilityScore != null ? (
                      <span style={{ color: scoreColor(c.deliverabilityScore) }} className="font-semibold">
                        {c.deliverabilityScore}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {!data?.recentCampaigns?.length && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-ink-muted">
                    No campaigns yet. Create your first one to see analytics here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
