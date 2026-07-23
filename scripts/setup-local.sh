#!/usr/bin/env bash
# Docker-free local setup (Postgres / Supabase)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Checking Postgres..."
if ! pg_isready >/dev/null 2>&1; then
  echo "Postgres is not running. Start it with: brew services start postgresql@16"
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env (SMTP_HOST=json for console email logging)"
fi

echo "==> Ensuring database role and database exist..."
psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='inboxflow'" | grep -q 1 \
  || psql -d postgres -c "CREATE USER inboxflow WITH PASSWORD 'inboxflow' CREATEDB;"
psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='inboxflow'" | grep -q 1 \
  || psql -d postgres -c "CREATE DATABASE inboxflow OWNER inboxflow;"
psql -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE inboxflow TO inboxflow;" >/dev/null
psql -d inboxflow -c "GRANT ALL ON SCHEMA public TO inboxflow;" >/dev/null 2>&1 || true

echo "==> Linking env for Prisma (apps/api/.env)..."
cp -f .env apps/api/.env

echo "==> Installing npm dependencies..."
unset npm_config_devdir || true
npm install --no-audit --no-fund

echo "==> Prisma generate + schema push + queues + seed..."
npm run db:generate -w @inboxflow/api
npm run db:push -w @inboxflow/api
npm run db:setup-queues -w @inboxflow/api
npm run db:seed -w @inboxflow/api

echo ""
echo "Setup complete (no Docker)."
echo "  Start:  npm run dev"
echo "  Web:    http://localhost:5173"
echo "  API:    http://localhost:3001/docs"
echo "  Login:  use SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from .env"
echo ""
echo "Emails are logged to the API console (SMTP_HOST=json)."
