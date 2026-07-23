# Cursor prompt — Compare Nexlogs SMTP / email sending vs Inbox Flow

Open the **Nexlogs** project in Cursor, then paste **Prompt A** in Agent mode.
After it answers, open **Inbox Flow** (`Email sender`) and paste **Prompt B** if you want a gap list against this codebase.

---

## Prompt A — Run inside Nexlogs (paste first)

```
You are auditing the Nexlogs marketing/email sending system so we can compare it with another app (Inbox Flow).

Explore the Nexlogs codebase thoroughly (do not invent features). Focus on:

## 1. SMTP Manager
- Files: MarketingSmtpManager, marketing-smtp.service, manage-smtp edge functions, marketing-smtp shared helpers, DB migrations for SMTP accounts
- How users add SMTP (host, port, encryption, user, password, from name/email)
- How passwords are encrypted/stored
- Test connection: does it only `verify()` or also send a real test email?
- Port failover (465 ↔ 587)?
- Presets (Gmail, Outlook, SES, etc.)?
- Labels, enable/disable, daily/hourly limits, rotation?

## 2. Campaign / broadcast sending
- How emails are sent (browser sequential? Edge Function? queue worker?)
- Does sending continue if the browser tab is closed?
- Batch size, delays, pause/resume/cancel
- Template import (HTML/MJML/ZIP)
- Unsubscribe handling (app-injected URL vs template-only)
- Tracking (opens/clicks)
- Spam content filter / deliverability checks before send

## 3. Secrets & deployment
- Which Supabase Edge secrets are required (JWT, ENCRYPTION_KEY, APP_URL, SMTP_*, etc.)?
- Are SMTP credentials only in DB (UI-managed) or also in env secrets?

## Output format (required)
Return a structured report the user can paste back to Inbox Flow:

### Nexlogs SMTP — how it works
(step-by-step: add SMTP → test → activate → send)

### Exact test flow
- API/edge action names
- Whether a real email is sent on test
- Required fields (test recipient?)

### Feature checklist
Table with columns: Feature | Present in Nexlogs? | File path(s) | Notes

Include at least:
- Add/edit/delete SMTP
- Test connection (verify only)
- Test & send real email
- Port failover 465/587
- Encrypted password storage
- SMTP rotation
- Background send (tab-independent)
- HTML template import
- Deliverability / spam scrub
- Domain SPF/DKIM UI
- Unsubscribe injection

### Code snippets
Quote the key functions for: verify SMTP, send one email, prepare campaign (paths + short excerpts).

### Gaps vs a typical ESP UI
Anything Nexlogs does that users often miss when rebuilding.

Be accurate. Cite real file paths. If something does not exist in Nexlogs, say so clearly.
```

---

## Prompt B — Run inside Inbox Flow after you have Nexlogs report

```
I have a Nexlogs SMTP/email audit report (pasted below).

Compare it to THIS Inbox Flow codebase and produce:

1. **Bugs / mismatches** — features that look present in Inbox Flow UI but are not wired (e.g. Test & send not sending)
2. **Missing vs Nexlogs** — features Nexlogs has that Inbox Flow lacks
3. **Extra in Inbox Flow** — things we have that Nexlogs does not
4. **Recommended fixes** — prioritized short list (P0 / P1 / P2)

Focus folders:
- apps/web/src/pages/SmtpManagerPage.tsx
- apps/web/src/services/smtp.service.ts
- apps/api/src/services/email/
- supabase/functions/manage-smtp/
- supabase/functions/send-campaign-email/
- supabase/functions/campaign-background-worker/

--- NEXLOGS REPORT ---
[PASTE NEXLOGS AGENT OUTPUT HERE]
--- END ---
```

---

## Quick note (already found in Inbox Flow)

**Bug:** The **Test & send** button called `testConnection(true)` but ignored the flag — it only ran SMTP `verify()` and never sent mail. That is being fixed so `sendTestEmail` + `testEmailTo` are passed to the API / Edge Function.
