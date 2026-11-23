import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signRelayUnsubscribe, signUnsubscribe } from '../../utils/signed-urls.js';
import { parseUrlEncodedBody } from '../../utils/form-body.js';

vi.mock('../../services/email/tracking-relay.js', () => ({
  recordRelayEvent: vi.fn(async () => undefined),
}));

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    contact: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    suppressionList: { upsert: vi.fn(async () => ({})) },
    campaignRecipient: {
      findFirst: vi.fn(async () => ({
        id: 'recipient',
        openedAt: new Date(),
        clickedAt: new Date(),
        deliveredAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
    campaign: { update: vi.fn(async () => ({})) },
    trackingEvent: { create: vi.fn(async () => ({})) },
  },
}));

import { prisma } from '../../config/prisma.js';
import { recordRelayEvent } from '../../services/email/tracking-relay.js';
import { trackingRoutes } from './routes.js';

const recorded = vi.mocked(recordRelayEvent);
const contactFind = vi.mocked(prisma.contact.findUnique);
const contactUpdate = vi.mocked(prisma.contact.update);

describe('unsubscribe confirm', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, parseUrlEncodedBody(typeof body === 'string' ? body : ''));
      },
    );
    await app.register(trackingRoutes, { prefix: '/api/t' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    recorded.mockClear();
    contactFind.mockReset();
    contactUpdate.mockClear();
    contactFind.mockResolvedValue({
      id: 'ct',
      status: 'SUBSCRIBED',
      organizationId: 'org',
      email: 'person@example.com',
    } as never);
  });

  it('does not unsubscribe until the underlined link is used', async () => {
    const s = signRelayUnsubscribe('org', 'ct', 'camp');
    const first = await app.inject({
      method: 'GET',
      url: `/api/t/unsubscribe?o=org&c=ct&cid=camp&s=${encodeURIComponent(s)}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('You are about to stop receiving mail from this sender.');
    expect(first.body).toContain('>unsubscribe from this</a>');
    expect(first.body).toContain('confirm=1');
    expect(first.body).not.toContain('You have been unsubscribed');
    expect(recorded).not.toHaveBeenCalled();

    const href = (first.body.match(/href="([^"]+)"/)?.[1] || '').replace(/&amp;/g, '&');
    const second = await app.inject({ method: 'GET', url: href });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('You have been unsubscribed');
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledWith({
      organizationId: 'org',
      campaignId: 'camp',
      contactId: 'ct',
      type: 'UNSUBSCRIBED',
    });
  });

  it('still unsubscribes immediately on the mailbox one-click POST', async () => {
    const s = signRelayUnsubscribe('org', 'ct', 'camp');
    const res = await app.inject({
      method: 'POST',
      url: `/api/t/unsubscribe?o=org&c=ct&cid=camp&s=${encodeURIComponent(s)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You have been unsubscribed');
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsigned link and a link signed for another workspace', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/t/unsubscribe?o=org&c=ct&cid=camp' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('Invalid unsubscribe link');
    expect(recorded).not.toHaveBeenCalled();

    const other = signRelayUnsubscribe('other-workspace', 'ct', 'camp');
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/t/unsubscribe?o=org&c=ct&cid=camp&s=${encodeURIComponent(other)}&confirm=1`,
    });
    expect(wrong.statusCode).toBe(400);
    expect(recorded).not.toHaveBeenCalled();
    expect(contactUpdate).not.toHaveBeenCalled();
  });

  it('gives each local recipient their own confirm step', async () => {
    const s = signUnsubscribe('ct', 'camp');
    const first = await app.inject({
      method: 'GET',
      url: `/api/t/unsubscribe?c=ct&cid=camp&s=${encodeURIComponent(s)}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('unsubscribe from this');
    expect(contactFind).not.toHaveBeenCalled();
    expect(contactUpdate).not.toHaveBeenCalled();

    const done = await app.inject({
      method: 'GET',
      url: `/api/t/unsubscribe?c=ct&cid=camp&s=${encodeURIComponent(s)}&confirm=1`,
    });
    expect(done.body).toContain('You have been unsubscribed');
    expect(contactUpdate).toHaveBeenCalledWith({
      where: { id: 'ct' },
      data: expect.objectContaining({ status: 'UNSUBSCRIBED' }),
    });
  });
});
