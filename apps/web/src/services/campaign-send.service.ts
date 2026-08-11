import { api } from '@/lib/api';
import { edgeFunctionsEnabled } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/lib/invoke-edge';

export type SendRecipient = {
  id: string;
  contactId: string;
  email: string;
  displayName: string;
};

export type SendStatus = {
  success: boolean;
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  completedAt?: string | null;
  jobId?: string | null;
  recentFailures?: Array<{ email: string; error: string }>;
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
    try {
      if (edgeFunctionsEnabled) {
        return await invokeEdgeFunction<{ success: boolean; recipients: SendRecipient[]; totalRecipients?: number; jobId?: string | null }>(
          'send-campaign-email',
          { action: 'prepare', campaignId, ...input },
        );
      }
    } catch {
      // Fall through — edge functions unreachable
    }

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
    try {
      if (edgeFunctionsEnabled) {
        return await invokeEdgeFunction('send-campaign-email', {
          action: 'background-start',
          campaignId,
          ...input,
        });
      }
    } catch {
      // Fall through — edge functions unreachable
    }

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
    try {
      if (edgeFunctionsEnabled) {
        return await invokeEdgeFunction('send-campaign-email', { action: 'status', campaignId });
      }
    } catch {
      // Fall through — edge functions unreachable
    }

    return api.get(`/api/campaigns/${campaignId}/send-status`);
  },

  async sendOne(
    campaignId: string,
    input: { recipientId: string; providerId?: string | null; jobId?: string },
  ) {
    try {
      if (edgeFunctionsEnabled) {
        return await invokeEdgeFunction<{ success: boolean; messageId?: string; error?: string; jobId?: string | null }>(
          'send-campaign-email',
          { action: 'send-one', campaignId, ...input },
        );
      }
    } catch {
      // Fall through — edge functions unreachable
    }

    return api.post<{ success: boolean; messageId?: string; error?: string; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/send-one`,
      input,
    );
  },

  async finalizeSend(campaignId: string, input: { cancelled?: boolean; jobId?: string }) {
    try {
      if (edgeFunctionsEnabled) {
        return await invokeEdgeFunction<{ success: boolean; sentCount: number; failedCount: number; pendingCount?: number; jobId?: string | null }>(
          'send-campaign-email',
          { action: 'finalize', campaignId, ...input },
        );
      }
    } catch {
      // Fall through — edge functions unreachable
    }

    return api.post<{ sentCount: number; failedCount: number; pendingCount?: number; jobId?: string | null }>(
      `/api/campaigns/${campaignId}/finalize-send`,
      input,
    );
  },

  async cancel(campaignId: string) {
    await api.post(`/api/campaigns/${campaignId}/cancel`);
  },

  async pause(campaignId: string): Promise<{ success: boolean; status: string }> {
    if (edgeFunctionsEnabled) {
      try {
        return await invokeEdgeFunction<{ success: boolean; status: string }>('send-campaign-email', { action: 'pause', campaignId });
      } catch {
        // fall through to API
      }
    }
    return api.post<{ success: boolean; status: string }>(`/api/campaigns/${campaignId}/pause`);
  },

  async resume(campaignId: string): Promise<{ success: boolean; status: string; pendingCount?: number }> {
    if (edgeFunctionsEnabled) {
      try {
        return await invokeEdgeFunction<{ success: boolean; status: string; pendingCount?: number }>('send-campaign-email', { action: 'resume', campaignId });
      } catch {
        // fall through to API
      }
    }
    return api.post<{ success: boolean; status: string; pendingCount?: number }>(
      `/api/campaigns/${campaignId}/resume`,
    );
  },

  async retryFailed(campaignId: string): Promise<{ success: boolean; retried: number }> {
    if (edgeFunctionsEnabled) {
      try {
        return await invokeEdgeFunction<{ success: boolean; retried: number }>('send-campaign-email', { action: 'retryFailed', campaignId });
      } catch {
        // fall through to API
      }
    }
    return api.post<{ success: boolean; retried: number }>(
      `/api/campaigns/${campaignId}/retry-failed`,
    );
  },

  async testMatrix(
    campaignId: string,
    input: { to: string; subjects: string[]; fromNames?: string[] },
  ) {
    return api.post<{
      success: boolean;
      sent: number;
      total: number;
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
};
