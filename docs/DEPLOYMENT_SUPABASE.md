# Supabase-only email sending (Nexlogs-style)

Deploy **Vercel (frontend) + Supabase (database + Edge Functions)** — no Render API, no Redis, **no SMTP secrets in Supabase**.

| Layer | Service |
|-------|---------|
| Frontend | Vercel |
| Database | Supabase Postgres |
| SMTP profiles | Added in app → stored encrypted in `EmailProvider` table |
| Send / test SMTP | Supabase Edge Functions (`manage-smtp`, `send-campaign-email`, `campaign-background-worker`) |
| Queue | Server-side background worker (self-chaining Edge Function — safe to close browser tab) |

This matches Nexlogs: you add SMTP in **Settings → SMTP Manager** in the UI. Credentials are encrypted in Postgres and only decrypted inside Edge Functions at send time.

## 1. Edge Function secrets (no SMTP_*)

Set only these in **Supabase Dashboard → Edge Functions → Secrets**:

```bash
supabase secrets set \
  JWT_ACCESS_SECRET="same-as-your-fastify-jwt-secret" \
  ENCRYPTION_KEY="same-as-your-api-encryption-key" \
  APP_URL=https://your-vercel-app.vercel.app
```

Do **not** set `SMTP_USER`, `SMTP_PASS`, etc. Add SMTP accounts in the app instead.

## 2. Deploy Edge Functions

```bash
supabase functions deploy send-campaign-email
supabase functions deploy campaign-background-worker
supabase functions deploy manage-smtp
supabase functions deploy email-track
```

## 3. Vercel environment variables

```env
VITE_USE_EDGE_FUNCTIONS=true
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## 4. Add SMTP (like Nexlogs)

1. Open **Settings → SMTP Manager**
2. Click **Add SMTP** — enter host, port, username, password, from address
3. Click **Test Connection**
4. **Save & Activate**

Edge Functions read your profile from the database using `ENCRYPTION_KEY` to decrypt the password.

## 5. Inbox-friendly sending

Before send, Inbox Flow runs Nexlogs-style checks:

- **Clean spam words** — auto-replaces trigger phrases (act now, free money, click here, etc.)
- **Inbox placement checks** — subject length/caps, spam phrases, Gmail Promotions layout, SMTP ready, recipients
- **Auto-sanitize on send** — cleaned subject + HTML saved before delivery
- **Server re-validation** — Edge Function scrubs again before each SMTP send
- **List-Unsubscribe headers** + throttled background send (10/batch, 5s pause — continues after tab close)

Send is blocked until all checks pass.

## 6. Local development

**Hybrid (API + local SMTP Manager):**

```env
VITE_USE_EDGE_FUNCTIONS=false
VITE_API_URL=http://localhost:3001
npm run dev
```

**Edge-only send:**

```env
VITE_USE_EDGE_FUNCTIONS=true
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Deploy functions to Supabase; SMTP still added via UI.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No active SMTP profile | Add + test SMTP in SMTP Manager |
| ENCRYPTION_KEY not configured | Set secret on Supabase; must match API `.env` |
| Unauthorized on send | Log in again; `JWT_ACCESS_SECRET` must match |
| Spam phrase still present | Use **Clean spam words** or rephrase manually |
