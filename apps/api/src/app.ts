import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { existsSync } from 'fs';
import { parseUrlEncodedBody } from './utils/form-body.js';
import { join } from 'path';
import { env } from './config/env.js';
import { sendError } from './utils/errors.js';
import { Sentry } from './instrument.js';

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === 'development',
    trustProxy: true,
    // A letter plus its attachments is stored in editorJson. Ten files, 25 MB of bytes, become about 34 MB of base64.
    bodyLimit: 40 * 1024 * 1024,
  });

  // /health registered BEFORE any middleware or heavy imports.
  // Railway 30s healthcheck window needs 200 OK on attempt 1;
  // we can't afford to load 14 route modules + Prisma client + heavy deps inside first few seconds on free tier 512MB.
  Sentry.setupFastifyErrorHandler(app);

  if (env.NODE_ENV !== 'production') {
    app.get('/api/sentry-test-error', async () => {
      const err = new Error(`Sentry test error ${Date.now()}`);
      Sentry.captureException(err);
      await Sentry.flush(2000);
      throw err;
    });
  }

  app.get('/health', async () => ({
    status: 'ok',
    service: env.APP_NAME,
    time: new Date().toISOString(),
    features: {
      pulse: true,
      adminNote: true,
      resetLicense: true,
      subscriptions: true,
      sentry: Boolean(Sentry.getClient()),
    },
  }));

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

  // Gmail and Microsoft POST one-click unsubscribe as form data, not JSON.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, parseUrlEncodedBody(typeof body === 'string' ? body : ''));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
    max: (request) => {
      const path = String(request.url || '').split('?')[0];
      if (path.startsWith('/api/auth/login') || path.startsWith('/api/auth/register')) return 20;
      return Math.max(env.RATE_LIMIT_MAX, 5_000);
    },
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    allowList: (request) => {
      const path = String(request.url || '').split('?')[0];
      return (
        path === '/health' ||
        path.startsWith('/api/t/') ||
        path === '/api/contacts/import' ||
        path.startsWith('/api/jobs/') ||
        path.includes('/send-one') ||
        path.includes('/send-status')
      );
    },
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
    return sendError(reply, error);
  });

  // Register routes BEFORE listen(). Fastify rejects app.register() after the root
  // plugin has booted (AVV_ERR_ROOT_PLG_BOOTED), which left /health up but all
  // /api/* routes as 404 when registration ran in a detached background task.
  const [
    { authRoutes },
    { contactRoutes },
    { campaignRoutes },
    { deliverabilityRoutes },
    { domainRoutes },
    { analyticsRoutes },
    { aiRoutes },
    lists,
    { providerRoutes },
    { apiKeyRoutes },
    { adminRoutes },
    { workspacePulseRoutes },
    { desktopSessionRoutes },
    { systemLogRoutes },
    { importRoutes },
    { jobRoutes },
    tracking,
  ] = await Promise.all([
    import('./modules/auth/routes.js'),
    import('./modules/contacts/routes.js'),
    import('./modules/campaigns/routes.js'),
    import('./modules/deliverability/routes.js'),
    import('./modules/domains/routes.js'),
    import('./modules/analytics/routes.js'),
    import('./modules/ai/routes.js'),
    import('./modules/lists/routes.js'),
    import('./modules/providers/routes.js'),
    import('./modules/api-keys/routes.js'),
    import('./modules/admin/routes.js'),
    import('./modules/workspace/pulse-routes.js'),
    import('./modules/desktop/session-routes.js'),
    import('./modules/system-logs/routes.js'),
    import('./modules/import/routes.js'),
    import('./modules/jobs/routes.js'),
    import('./modules/tracking/routes.js'),
  ]);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(contactRoutes, { prefix: '/api/contacts' });
  await app.register(campaignRoutes, { prefix: '/api/campaigns' });
  await app.register(deliverabilityRoutes, { prefix: '/api/deliverability' });
  await app.register(domainRoutes, { prefix: '/api/domains' });
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(lists.listRoutes, { prefix: '/api/lists' });
  await app.register(lists.segmentRoutes, { prefix: '/api/segments' });
  await app.register(lists.templateRoutes, { prefix: '/api/templates' });
  await app.register(providerRoutes, { prefix: '/api/providers' });
  await app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(workspacePulseRoutes, { prefix: '/api/workspace' });
  await app.register(desktopSessionRoutes, { prefix: '/api/desktop' });
  await app.register(systemLogRoutes, { prefix: '/api/logs' });
  await app.register(importRoutes, { prefix: '/api/import' });
  await app.register(jobRoutes, { prefix: '/api/jobs' });
  await app.register(tracking.trackingRoutes, { prefix: '/api/t' });
  await app.register(tracking.webhookRoutes, { prefix: '/api/webhooks' });
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

  // Desktop EXE: serve the Vite SPA from the same origin as /api (never novasreach.xyz).
  const webRoot = String(process.env.DESKTOP_WEB_ROOT || '').trim();
  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}
