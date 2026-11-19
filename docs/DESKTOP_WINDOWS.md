# Inbox Flow — Windows / RDP (Blue Sender-style)

Install the EXE **on the RDP (Windows VPS)**. SMTP then leaves from **that machine’s IP**, not Lightsail.

| Mode | `INBOXFLOW_MODE` | Where SMTP opens | Opens / clicks |
|---|---|---|---|
| **RDP / local (this is what you want)** | `rdp` or `local` | This PC / RDP public IP | Yes, if `PUBLIC_URL` is reachable from the internet |
| Thin / hybrid (`remote`) | `remote` | This PC for created users (SQLite in AppData); Lightsail for your admin login | Tracking on `PUBLIC_URL` if set |
| Thin client (old) | `remote` with no local API | Lightsail | Tracking still on Lightsail |

## How it compares to Blue Sender

- **Send / fail / bounce / mailbox full** come from the live SMTP conversation on this box (`250` = sent, `550 5.1.1` = hard bounce, mailbox full = soft bounce). You see that per recipient in Logs.
- **Opens and clicks** are **not** SMTP. Gmail loads a pixel / click URL on your public host. Set `PUBLIC_URL` to `http://YOUR.RDP.PUBLIC.IP:5000` (or `https://mail.yourdomain.com`) and open that port. If `PUBLIC_URL` stays `localhost`, send still works; opens/clicks stay at 0.
- Bind IP / SOCKS apply on this RDP box.

## Config

Edit `%APPDATA%\Inbox Flow\inboxflow.env` (created on first launch):

```
INBOXFLOW_MODE=rdp
LOCAL_PORT=5000
PUBLIC_URL=http://YOUR.RDP.PUBLIC.IP:5000
DATABASE_URL=postgresql://inboxflow:inboxflow@127.0.0.1:5432/inboxflow
RUN_WORKERS=true
```

Browser in the RDP session: `http://localhost:5000`. Tracking links in the email use `PUBLIC_URL`.

## Notes

- Local/RDP mode needs Postgres on that machine (or a DB URL it can reach).
- `remote` (default thin EXE): **you** (platform admin) still log into the shared database. Users you create keep contacts, campaigns, templates, and SMTP in `%APPDATA%\Inbox Flow\workspace.db` on **their** PC. Login still uses the shared server.
- SSH / “send through someone else’s RDP” is not this. You run Inbox Flow **on** the server you already own.
