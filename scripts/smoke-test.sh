#!/usr/bin/env bash
# Inbox Flow — smoke test
# Usage: bash scripts/smoke-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

API="${API_URL:-http://localhost:3001}"
WEB="${WEB_URL:-http://localhost:5173}"
EMAIL="${SMOKE_EMAIL:-${SEED_ADMIN_EMAIL:-admin@inboxflow.com}}"
PASS="${SMOKE_PASSWORD:-${SEED_ADMIN_PASSWORD:-}}"

pass=0
fail=0

check() {
  local name="$1"
  local ok="$2"
  local detail="${3:-}"
  if [ "$ok" = "1" ]; then
    printf 'PASS  %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s — %s\n' "$name" "$detail"
    fail=$((fail + 1))
  fi
}

echo "Inbox Flow smoke test"
echo "API=$API  WEB=$WEB"
echo

code=$(curl -s -o /tmp/icoffee-smoke-health.json -w "%{http_code}" "$API/health" || true)
check "API /health" "$([ "$code" = "200" ] && echo 1 || echo 0)" "HTTP $code"

code=$(curl -s -o /dev/null -w "%{http_code}" "$WEB/" || true)
check "Web /" "$([ "$code" = "200" ] && echo 1 || echo 0)" "HTTP $code"

code=$(curl -s -o /tmp/icoffee-smoke-login.json -w "%{http_code}" -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true)
token=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/tmp/icoffee-smoke-login.json','utf8')).accessToken||'')}catch(e){console.log('')}")
check "Auth login $EMAIL" "$([ "$code" = "200" ] && [ -n "$token" ] && echo 1 || echo 0)" "HTTP $code"

if [ -n "$token" ]; then
  AUTH="Authorization: Bearer $token"

  for path in \
    /api/auth/me \
    /api/providers \
    /api/campaigns \
    /api/contacts \
    /api/lists \
    /api/analytics/dashboard \
    /api/logs \
    /api/admin/organization
  do
    code=$(curl -s -o /tmp/icoffee-smoke-ep.json -w "%{http_code}" "$API$path" -H "$AUTH" || true)
    check "GET $path" "$([ "$code" = "200" ] && echo 1 || echo 0)" "HTTP $code"
  done

  code=$(curl -s -o /tmp/icoffee-smoke-import.json -w "%{http_code}" -X POST "$API/api/import/html" \
    -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"filename":"smoke.html","format":"html","content":"<html><body><p>Hello</p><a href=\"https://inboxflow.io\">x</a><p>Unsubscribe</p></body></html>"}' || true)
  check "POST /api/import/html" "$([ "$code" = "200" ] && echo 1 || echo 0)" "HTTP $code"

  code=$(curl -s -o /tmp/icoffee-smoke-smtp.json -w "%{http_code}" -X POST "$API/api/providers/test" \
    -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"type":"SMTP","config":{"host":"json","port":"465","secure":"false","fromEmail":"noreply@inboxflow.io","fromName":"Inbox Flow"}}' || true)
  ok=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('/tmp/icoffee-smoke-smtp.json','utf8')); console.log(j.result&&j.result.success?1:0)}catch(e){console.log(0)}")
  check "POST /api/providers/test" "$([ "$code" = "200" ] && [ "$ok" = "1" ] && echo 1 || echo 0)" "HTTP $code"

  code=$(curl -s -o /tmp/icoffee-smoke-rot.json -w "%{http_code}" -X PATCH "$API/api/admin/organization" \
    -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"sendSettings":{"smtpRotation":{"enabled":true,"mode":"round_robin"}}}' || true)
  check "PATCH smtp rotation" "$([ "$code" = "200" ] && echo 1 || echo 0)" "HTTP $code"

  # Security regression checks
  code=$(curl -s -o /tmp/icoffee-smoke-reg.json -w "%{http_code}" -X POST "$API/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d '{"email":"hacker@example.com","password":"Password123!","firstName":"H","lastName":"X","organizationName":"Hack"}' || true)
  check "Register disabled (expect 403)" "$([ "$code" = "403" ] && echo 1 || echo 0)" "HTTP $code"

  code=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/t/c/camp1/contact1?u=https://evil.example" || true)
  check "Unsigned click blocked (expect 400)" "$([ "$code" = "400" ] && echo 1 || echo 0)" "HTTP $code"

  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/webhooks/sendgrid" \
    -H 'Content-Type: application/json' -d '[]' || true)
  check "Webhook without secret blocked" "$([ "$code" = "401" ] || [ "$code" = "400" ] && echo 1 || echo 0)" "HTTP $code"
fi

echo
echo "RESULT  passed=$pass failed=$fail"
if [ "$fail" -eq 0 ]; then
  echo "READY — smoke checks passed. You can proceed with manual UI testing."
  exit 0
fi
echo "NOT READY — fix failures above before manual testing."
exit 1
