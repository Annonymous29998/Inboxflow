#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo "Installing dependencies..."
npm install

echo "Generating Prisma client..."
npm run db:generate -w @inboxflow/api

echo "Pushing schema..."
npm run db:push -w @inboxflow/api

echo "Seeding..."
npm run db:seed -w @inboxflow/api

echo ""
echo "Setup complete. Start with: npm run dev"
echo "Sign in with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from .env"
