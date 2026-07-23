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
};

export const campaignSendService = {
  async prepareSend(
    campaignId: string,
    input: { providerId?: string | null; force?: boolean; scrub?: boolean },
  ): Promise<{ success: boolean; recipients: SendRecipient[]; report?: unknown }> {
    if (edgeFunctionsEnabled) {
      return invokeEdgeFunction<{ success: boolean; recipients: SendRecipient[] }>(
        'send-campaign-email',
        { action: 'prepare', campaignId, ...input },
      );
    }

    return api.post<{ success: boolean; recipients: SendRecipient[]; report?: unknown }>(
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
  ): Promise<{ success: boolean; totalRecipients: number; status: string; background?: boolean }> {
    if (edgeFunctionsEnabled) {
      return invokeEdgeFunction('send-campaign-email', {
        action: 'background-start',
        campaignId,
        ...input,
      });
    }

    // Persist queue pacing before enqueue so the API worker can honor it
    if (input.queueSettings) {
      await api.patch(`/api/campaigns/${campaignId}`, { queueSettings: input.queueSettings });
    }

    const prepared = await api.post<{ success: boolean; recipients: SendRecipient[] }>(
      `/api/campaigns/${campaignId}/prepare-send`,
      {
        providerId: input.providerId,
        force: input.force,
        scrub: true,
      },
    );

    const queued = await api.post<{ success: boolean; status: string }>(
      `/api/campaigns/${campaignId}/send`,
      {
        mode: 'queue',
        providerId: input.providerId,
        force: input.force,
      },
    );

    return {
      success: true,
      totalRecipients: prepared.recipients.length,
      status: queued.status ?? 'SENDING',
      background: true,
    };
  },

  async getSendStatus(campaignId: string): Promise<SendStatus> {
    if (edgeFunctionsEnabled) {
      return invokeEdgeFunction('send-campaign-email', { action: 'status', campaignId });
    }

    return api.get(`/api/campaigns/${campaignId}/send-status`);
  },

  async sendOne(
    campaignId: string,
    input: { recipientId: string; providerId?: string | null },
  ) {
    if (edgeFunctionsEnabled) {
      return invokeEdgeFunction<{ success: boolean; messageId?: string; error?: string }>(
        'send-campaign-email',
        { action: 'send-one', campaignId, ...input },
      );
    }

    return api.post<{ success: boolean; messageId?: string; error?: string }>(
      `/api/campaigns/${campaignId}/send-one`,
      input,
    );
  },

  async finalizeSend(campaignId: string, input: { cancelled?: boolean }) {
    if (edgeFunctionsEnabled) {
      return invokeEdgeFunction<{ success: boolean; sentCount: number; failedCount: number }>(
        'send-campaign-email',
        { action: 'finalize', campaignId, ...input },
      );
    }

    return api.post<{ sentCount: number; failedCount: number }>(
      `/api/campaigns/${campaignId}/finalize-send`,
      input,
    );
  },

  async cancel(campaignId: string) {
    await api.post(`/api/campaigns/${campaignId}/cancel`);
  },
};
