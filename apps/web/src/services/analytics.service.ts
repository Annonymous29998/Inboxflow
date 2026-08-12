import { api } from '@/lib/api';

export type DashboardData = {
  stats: {
    totalContacts: number;
    subscribedContacts: number;
    unsubscribedContacts: number;
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
    pendingCount?: number;
    totalRecipients?: number;
    openedCount: number;
    clickedCount: number;
    deliverabilityScore: number | null;
    updatedAt: string;
  }>;
};

export const analyticsService = {
  getDashboard(): Promise<DashboardData> {
    return api.get<DashboardData>('/api/analytics/dashboard?live=1');
  },

  streamDashboard(
    callbacks: {
      onUpdate?: (data: DashboardData) => void;
      onError?: (e: Error) => void;
      onDone?: () => void;
    } = {},
  ): { cancel: () => void } {
    return api.events('/api/analytics/dashboard/stream', {
      onEvent: (evt, d) => {
        if (evt !== 'dashboard' || !d || typeof d !== 'object') return;
        callbacks.onUpdate?.(d as DashboardData);
      },
      onError: callbacks.onError,
      onDone: callbacks.onDone,
    });
  },
};
