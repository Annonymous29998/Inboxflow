import { describe, expect, it } from 'vitest';
import { mergeAdminNote, mergeOperatorPulse, readAdminNote, readOperatorPulse, sumPulses } from './operator-pulse.js';

describe('operator pulse', () => {
  it('reads empty settings as zeros', () => {
    expect(readOperatorPulse(null).emailsSent).toBe(0);
  });

  it('merges pulse without dropping other sendSettings', () => {
    const next = mergeOperatorPulse(
      { workspaceLocal: true, smtpAllowDirect: false },
      {
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        sending: 1,
        campaignsSent: 2,
        emailsSent: 40,
        emailsFailed: 3,
        recentCampaigns: [],
      },
    );
    expect(next.workspaceLocal).toBe(true);
    expect((next.operatorPulse as { emailsSent: number }).emailsSent).toBe(40);
  });

  it('sums tenant pulses and keeps newest campaigns', () => {
    const sum = sumPulses([
      {
        lastSeenAt: 'a',
        sending: 1,
        campaignsSent: 2,
        emailsSent: 10,
        emailsFailed: 1,
        recentCampaigns: [
          { id: '1', name: 'Old', status: 'SENT', sentCount: 10, openedCount: 1, updatedAt: '2026-01-01' },
        ],
      },
      {
        lastSeenAt: 'b',
        sending: 0,
        campaignsSent: 1,
        emailsSent: 5,
        emailsFailed: 0,
        recentCampaigns: [
          { id: '2', name: 'New', status: 'SENT', sentCount: 5, openedCount: 0, updatedAt: '2026-02-01' },
        ],
      },
    ]);
    expect(sum.emailsSent).toBe(15);
    expect(sum.campaignsSent).toBe(3);
    expect(sum.recentCampaigns[0]?.id).toBe('2');
  });

  it('stores admin notes beside operator pulse', () => {
    const next = mergeAdminNote({ operatorPulse: { emailsSent: 4 } }, 'Called about invoice.');
    expect(readAdminNote(next)).toBe('Called about invoice.');
    expect((next.operatorPulse as { emailsSent: number }).emailsSent).toBe(4);
  });
});
