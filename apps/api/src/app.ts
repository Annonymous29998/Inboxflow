import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/routes.js';
import { contactRoutes } from './modules/contacts/routes.js';
import { campaignRoutes } from './modules/campaigns/routes.js';
import { deliverabilityRoutes } from './modules/deliverability/routes.js';
import { domainRoutes } from './modules/domains/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { trackingRoutes, webhookRoutes } from './modules/tracking/routes.js';
import {
  listRoutes,
  segmentRoutes,
  templateRoutes,
} from './modules/lists/routes.js';
import { providerRoutes } from './modules/providers/routes.js';
import { apiKeyRoutes } from './modules/api-keys/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { systemLogRoutes } from './modules/system-logs/routes.js';
import { importRoutes } from './modules/import/routes.js';
import { AppError } from './utils/errors.js';

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === 'development',
    trustProxy: true,
  });

  // Allow DELETE/POST with Content-Type: application/json and an empty body
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(cookie, {
    secret: env.JWT_ACCESS_SECRET,
    parseOptions: {},
  });
  await app.register(jwt, { secret: env.JWT_ACCESS_SECRET });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
  });

  const enableDocs =
    env.ENABLE_API_DOCS === true ||
    (env.ENABLE_API_DOCS !== false && env.NODE_ENV !== 'production');

  if (enableDocs) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Inbox Flow API',
          description: 'Email marketing platform API focused on deliverability best practices',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
          },
        },
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error && typeof error === 'object' && 'validation' in error) {
      return reply.status(400).send({
        error: 'Validation error',
        details: (error as { validation: unknown }).validation,
      });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: env.APP_NAME,
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(contactRoutes, { prefix: '/api/contacts' });
  await app.register(campaignRoutes, { prefix: '/api/campaigns' });
  await app.register(deliverabilityRoutes, { prefix: '/api/deliverability' });
  await app.register(domainRoutes, { prefix: '/api/domains' });
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(listRoutes, { prefix: '/api/lists' });
  await app.register(segmentRoutes, { prefix: '/api/segments' });
  await app.register(templateRoutes, { prefix: '/api/templates' });
  await app.register(providerRoutes, { prefix: '/api/providers' });
  await app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(systemLogRoutes, { prefix: '/api/logs' });
  await app.register(importRoutes, { prefix: '/api/import' });
  await app.register(trackingRoutes, { prefix: '/api/t' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });

  // Public unsubscribe also at /api/unsubscribe for List-Unsubscribe compatibility
  app.route({
    method: ['GET', 'POST'],
    url: '/api/unsubscribe',
    handler: async (request, reply) => {
      const q = request.query as { c?: string; e?: string; cid?: string; s?: string };
      const params = new URLSearchParams();
      if (q.c) params.set('c', q.c);
      if (q.e) params.set('e', q.e);
      if (q.cid) params.set('cid', q.cid);
      if (q.s) params.set('s', q.s);
      return reply.redirect(`/api/t/unsubscribe?${params.toString()}`);
    },
  });

  return app;
}
