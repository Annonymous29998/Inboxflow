# Inbox Flow

Production-ready email marketing platform focused on **maximum inbox placement through best practices** — not filter evasion.

Stack: React + Vite · Supabase Postgres · Supabase Edge Functions (email) · optional Fastify API for local dev

**Nexlogs-style sending:** browser sequential delivery → Edge Function per recipient — no Redis, no Render API required. See [docs/DEPLOYMENT_SUPABASE.md](docs/DEPLOYMENT_SUPABASE.md).

## Features

- Authentication (JWT + refresh, 2FA, email verification, sessions, API keys)
- Contact CRM (CSV import/export, tags, lists, segments, suppression)
- Campaign builder + drag-and-drop email editor
- Deliverability analyzer & inbox readiness score (pre-send)
- Subject line optimizer + AI copy assistant (OpenAI)
- Domain authentication wizard (SPF / DKIM / DMARC / tracking / return-path)
- Multi-provider sending (SES, Mailgun, Postmark, SendGrid, SMTP) with failover & queues
- Tracking (opens, clicks, unsubscribes, bounces) + analytics
- Admin panel, audit logs, Docker deployment

## Quick start (no Docker)

Requires local **PostgreSQL** (or Supabase) for development.

```bash
brew services start postgresql@16
bash scripts/setup-local.sh
npm run dev
```

### Manual steps

```bash
cp .env.example .env
# DATABASE_URL already points at localhost Postgres
# SMTP_HOST=json logs emails to the console (no Mailpit needed)

# Create DB once:
psql -d postgres -c "CREATE USER inboxflow WITH PASSWORD 'inboxflow' CREATEDB;"
psql -d postgres -c "CREATE DATABASE inboxflow OWNER inboxflow;"

npm install
npm run db:generate -w @inboxflow/api
npm run db:push -w @inboxflow/api
npm run db:setup-queues -w @inboxflow/api
npm run db:seed -w @inboxflow/api
npm run dev
```

- Web: http://localhost:5173  
- API docs: http://localhost:3001/docs  

Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `.env` before seeding. Sign in at `/login` with those credentials.

### Optional: Docker infra only

If you prefer containers for Postgres/Redis/Mailpit:

```bash
docker compose up -d postgres redis mailpit minio
```

Then set `SMTP_HOST=localhost` and `SMTP_PORT=1025` in `.env`.


## Architecture

```
apps/
  api/     Fastify API, workers, Prisma, deliverability engine
  web/     React SPA dashboard
docker/    Production Dockerfiles + nginx
```

### Sending flow

1. User builds campaign → **Analyze** runs deliverability checks  
2. High-risk campaigns require `force=true` to send  
3. Campaign job expands recipients (list/segment − suppressions)  
4. BullMQ email workers rate-limit sends with provider failover  
5. Tracking pixels / click redirects / one-click unsubscribe record events  

### Deliverability philosophy

Inbox Flow **warns and recommends**. It does not strip content automatically or claim guaranteed inbox delivery. Scores cover authentication, content, HTML, images, links, compliance, accessibility, mobile, and personalization.

## Environment

See `.env.example` for all variables. Critical ones:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL (Supabase) — includes job queues via pgmq |
| `JWT_*` | Auth secrets |
| `OPENAI_API_KEY` | AI assistant (optional; fallback templates used if empty) |
| `S3_*` | Asset storage |

## Production

```bash
docker compose --profile full up -d --build
```

Run API and worker as separate processes in production:

```bash
RUN_WORKERS=false node dist/index.js   # API
node dist/workers/index.js             # Worker
```

## Tests

```bash
npm test -w @inboxflow/api
```

## Compliance notes

- Physical address required in org settings (CAN-SPAM)
- List-Unsubscribe + one-click unsubscribe headers
- Suppression list for hard bounces / unsubscribes / complaints
- Consent fields on contacts

## License

Proprietary — for your project use.
