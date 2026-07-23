# Deployment Guide

## Recommended production stack (Nexlogs-style)

**Vercel + Supabase only** for email sending — no Render API, no Redis.

See **[DEPLOYMENT_SUPABASE.md](./DEPLOYMENT_SUPABASE.md)** for Edge Function setup, secrets, and Vercel env vars.

| Component | Service |
|-----------|---------|
| Frontend | Vercel |
| Database | Supabase Postgres |
| Campaign send / SMTP / tracking | Supabase Edge Functions |
| Queue | None (browser sequential send) |

## Prerequisites

- Node.js 20+
- Supabase project (Postgres + Edge Functions)
- SMTP credentials (Hostinger, Gmail app password, SES, etc.)
- S3-compatible storage for template assets (optional)

## Local development

```bash
cp .env.example .env
npm install
cd apps/api && npx prisma db push && npm run db:seed
cd ../..
npm run dev
```

Use `VITE_USE_EDGE_FUNCTIONS=false` and `VITE_API_URL=http://localhost:3001` for local hybrid dev.

## Production checklist

1. Rotate all secrets (`JWT_*`, `ENCRYPTION_KEY`)
2. Set `NODE_ENV=production`
3. Deploy Supabase Edge Functions (`send-campaign-email`, `manage-smtp`, `email-track`)
4. Set matching secrets on Supabase (`JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`, `SMTP_*`, `APP_URL`)
5. Deploy frontend to Vercel with `VITE_USE_EDGE_FUNCTIONS=true`
6. Run `npx prisma db push` against Supabase Postgres
7. Run `npm run db:enable-rls -w @inboxflow/api` (or apply `enable-rls.sql`)
8. Configure organization physical address (CAN-SPAM)

## Optional: background queue workers

Only needed if you explicitly enable pgmq dispatch (`RUN_WORKERS=true`):

```bash
npm run db:setup-queues -w @inboxflow/api
RUN_WORKERS=true npm run worker -w @inboxflow/api
```

Nexlogs-style sequential sending does **not** require workers.

## Health checks

- Fastify API (if used): `GET /health`
- Edge Functions: Supabase Dashboard → Edge Functions → Logs

## Security

- SMTP credentials encrypted at rest (AES-256-GCM)
- Edge Functions verify Inbox Flow JWT (same secret as Fastify)
- RLS enabled on Supabase tables (Prisma bypasses via postgres role)
