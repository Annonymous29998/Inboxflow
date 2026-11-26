import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isDesktopHybrid } from '../../config/db-kind.js';
import { AppError, sendError } from '../../utils/errors.js';
import {
  newestCloudSession,
  rememberCloudAuthorization,
} from '../../services/email/desktop-cloud-auth.js';

function fromThisPc(ip: string | undefined): boolean {
  const host = String(ip || '');
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
}

/** The window hands its sign-in to the send process. Localhost only. */
export async function desktopSessionRoutes(app: FastifyInstance) {
  app.post('/cloud-session', async (request, reply) => {
    try {
      if (!isDesktopHybrid()) throw new AppError(404, 'Not found');
      if (!fromThisPc(request.ip)) throw new AppError(403, 'Local only');
      const body = z
        .object({
          organizationId: z.string().min(1).max(80),
          accessToken: z.string().min(1),
          refreshToken: z.string().min(1).optional(),
        })
        .parse(request.body ?? {});
      rememberCloudAuthorization(body.organizationId, `Bearer ${body.accessToken}`, body.refreshToken);
      return reply.send({ ok: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/cloud-session', async (request, reply) => {
    try {
      if (!isDesktopHybrid()) throw new AppError(404, 'Not found');
      if (!fromThisPc(request.ip)) throw new AppError(403, 'Local only');
      return reply.send({ session: newestCloudSession() });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
