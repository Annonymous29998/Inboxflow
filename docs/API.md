# API Documentation

Base URL: `http://localhost:3001`

Interactive OpenAPI UI: `/docs`

## Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create org + admin user |
| POST | `/api/auth/login` | Login (optional 2FA) |
| POST | `/api/auth/refresh` | Rotate refresh token |
| POST | `/api/auth/logout` | Revoke session |
| POST | `/api/auth/forgot-password` | Request reset email |
| POST | `/api/auth/reset-password` | Reset with token |
| POST | `/api/auth/verify-email` | Verify email |
| GET | `/api/auth/me` | Current user |
| GET | `/api/auth/sessions` | List sessions |
| DELETE | `/api/auth/sessions/:id` | Revoke session |
| POST | `/api/auth/2fa/setup` | Begin TOTP setup |
| POST | `/api/auth/2fa/enable` | Enable 2FA |
| POST | `/api/auth/2fa/disable` | Disable 2FA |

## Core resources

- `GET/POST /api/contacts` · `POST /api/contacts/import` · `GET /api/contacts/export/csv`
- `GET/POST /api/campaigns` · `POST /api/campaigns/:id/analyze` · `POST /api/campaigns/:id/send`
- `POST /api/deliverability/analyze` · `POST /api/deliverability/subject`
- `GET/POST /api/domains` · `POST /api/domains/:id/verify`
- `GET /api/analytics/dashboard` · `GET /api/analytics/campaigns/:id`
- `POST /api/ai/generate` · `POST /api/ai/improve-subject`
- `GET/POST /api/lists` · `/api/segments` · `/api/templates` · `/api/providers` · `/api/api-keys`
- `POST /api/providers/test` — test SMTP/API config before saving (`sendTestEmail` optional)
- `POST /api/providers/:id/test` — test a saved provider
- `GET /api/admin/users` · `/api/admin/health` · `/api/admin/audit-logs`

## Tracking (public)

- `GET /api/t/o/:campaignId/:contactId.gif` — open pixel
- `GET /api/t/c/:campaignId/:contactId?u=` — click redirect
- `GET|POST /api/t/unsubscribe` — one-click unsubscribe
- `POST /api/webhooks/:provider` — ESP webhooks

## Auth headers

```
Authorization: Bearer <accessToken>
# or
x-api-key: if_...
```
