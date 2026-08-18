import { api } from '@/lib/api';

export type SendRecipient = {
  id: string;
  contactId: string;
  email: string;
  displayName: string;
};

export type SendActivity = {
  email: string;
  status: 'SENT' | 'FAILED' | 'BOUNCED' | 'QUEUED' | 'OPENED' | 'CLICKED' | 'DELIVERED';
  error?: string | null;
  at: string;
  url?: string | null;
  /** Repeat opens/clicks for this contact (totals stay unique people). */
  times?: number;
};

export type SendStatus = {
  success: boolean;
  status: string;
  name?: string;
  subject?: string | null;
  senderEmail?: string | null;
  totalRecipients: number;
  sentCount: number;
  /** ESP-confirmed delivery (not SMTP accept alone) */
  deliveredCount?: number;
  failedCount: number;
  bouncedCount?: number;
  pendingCount: number;
  openedCount?: number;
  clickedCount?: number;
  completedAt?: string | null;
  jobId?: string | null;
  lastEmail?: string | null;
  recentSent?: Array<{ email: string; at?: string | null }>;
  recentFailures?: Array<{ email: string; error: string }>;
  recentBounces?: Array<{ email: string; error: string }>;
  recentOpens?: Array<{ email: string; at: string }>;
  recentClicks?: Array<{ email: string; at: string; url?: string | null }>;
  /** Send queue log — SENT / FAILED / BOUNCED */
  activity?: SendActivity[];
  /** Verified opens/clicks — separate from send log */
  engagementActivity?: SendActivity[];
  /** Live queue stage: sending | between_emails | batch_pause */
  queueStage?: string;
  pauseUntil?: string | null;
  betweenEmailMs?: number | null;
  batchPauseMs?: number | null;
  batchNumber?: number | null;
  queueBatchSize?: number | null;
};

export type JobProgressEvent = {
  id: string;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  total: number;
  processed: number;
  percent: number;
  meta?: {
    sent?: number;
    failed?: number;
    pending?: number;
    stage?: string;
    lastEmail?: string;
    report?: unknown;
    [k: string]: unknown;
  } | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  campaignId?: string | null;
  resourceId?: string | null;
};

export const campaignSendService = {
  async prepareSend(
    campaignId: string,
    input: { providerId?: string | null; force?: boolean; scrub?: boolean },
  ): Promise<{ success: boolean; recipients: SendRecipient[]; report?: unknown; totalRecipients?: number; jobId?: string | null }> {
    return api.post<{ success: boolean; recipients: SendRecipient[]; report?: unknown; totalRecipients?: number; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/prepare-send`,
      input,
    );
  },

  async startBackgroundSend(
    campaignId: string,
    input: {
      providerId?: string | null;
      force?: boolean;
      queueSettings?: Record<string, unknown>;
    },
  ): Promise<{ success: boolean; totalRecipients: number; status: string; background?: boolean; jobId?: string | null }> {
    if (input.queueSettings) {
      await api.patch(`/api/campaigns/${campaignId}`, { queueSettings: input.queueSettings });
    }

    const prepared = await api.post<{ success: boolean; recipients: SendRecipient[]; report?: unknown; totalRecipients?: number; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/prepare-send`,
      {
        providerId: input.providerId,
        force: input.force,
        scrub: true,
      },
    );

    const queued = await api.post<{ success: boolean; status: string; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/send`,
      {
        mode: 'queue',
        providerId: input.providerId,
        force: input.force,
      },
    );

    return {
      success: true,
      totalRecipients: prepared.totalRecipients ?? prepared.recipients.length,
      status: queued.status ?? 'SENDING',
      background: true,
      jobId: prepared.jobId ?? queued.jobId ?? null,
    };
  },

  async getSendStatus(campaignId: string): Promise<SendStatus> {
    return api.get(`/api/campaigns/${campaignId}/send-status`);
  },

  async sendOne(
    campaignId: string,
    input: { recipientId: string; providerId?: string | null; jobId?: string },
  ) {
    return api.post<{ success: boolean; messageId?: string; error?: string; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/send-one`,
      input,
    );
  },

  async finalizeSend(campaignId: string, input: { cancelled?: boolean; jobId?: string }) {
    return api.post<{ sentCount: number; failedCount: number; pendingCount?: number; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/finalize-send`,
      input,
    );
  },

  async cancel(campaignId: string) {
    await api.post(`/api/campaigns/${campaignId}/cancel`);
  },

  async pause(campaignId: string): Promise<{ success: boolean; status: string }> {
    return api.post<{ success: boolean; status: string }>(`/api/campaigns/${campaignId}/pause`);
  },

  async resume(campaignId: string): Promise<{ success: boolean; status: string; pendingCount?: number }> {
    return api.post<{ success: boolean; status: string; pendingCount?: number }>(
      `/api/campaigns/${campaignId}/resume`,
    );
  },

  async retryFailed(campaignId: string): Promise<{ success: boolean; retried: number }> {
    return api.post<{ success: boolean; retried: number }>(
      `/api/campaigns/${campaignId}/retry-failed`,
    );
  },

  async testMatrix(
    campaignId: string,
    input: { to: string; subjects: string[]; fromNames?: string[]; noSubjectPrefix?: boolean },
  ) {
    return api.post<{
      success: boolean;
      sent: number;
      total: number;
      providerName?: string;
      providerHost?: string | null;
      fromEmail?: string;
      results: Array<{
        subject: string;
        fromName: string;
        success: boolean;
        error?: string;
      }>;
    }>(`/api/campaigns/${campaignId}/test-matrix`, input);
  },

  async exportConfig(campaignId: string) {
    return api.get<{ version: number; campaign: Record<string, unknown> }>(
      `/api/campaigns/${campaignId}/export-config`,
    );
  },

  async importConfig(campaign: Record<string, unknown>) {
    return api.post<{ campaign: { id: string } }>('/api/campaigns/import-config', { campaign });
  },

  streamProgress(
    jobId: string,
    callbacks: {
      onUpdate?: (u: JobProgressEvent) => void;
      onError?: (e: Error) => void;
      onDone?: () => void;
    } = {},
  ): { cancel: () => void } {
    return api.events(`/api/jobs/${jobId}/stream`, {
      onEvent: (evt, d) => {
        if (evt !== 'job' || !d || typeof d !== 'object') return;
        callbacks.onUpdate?.(d as JobProgressEvent);
      },
      onError: callbacks.onError,
      onDone: callbacks.onDone,
    });
  },

  streamSendStatus(
    campaignId: string,
    callbacks: {
      onUpdate?: (u: SendStatus) => void;
      onError?: (e: Error) => void;
      onDone?: () => void;
    } = {},
  ): { cancel: () => void } {
    return api.events(`/api/campaigns/${campaignId}/send-status/stream`, {
      onEvent: (evt, d) => {
        if (evt !== 'status' || !d || typeof d !== 'object') return;
        callbacks.onUpdate?.(d as SendStatus);
      },
      onError: callbacks.onError,
      onDone: callbacks.onDone,
    });
  },
};
