# Inbox Flow

Inbox Flow is a desktop mailer plus a small public site. The brand name is Inbox Flow. The public site that recipients and the Windows app talk to is **https://novasreach.xyz**.

A user composes a letter, picks SMTP they already have, and sends. The message leaves from that user's PC through their SMTP host. Opens, clicks, and unsubscribe links point at that user's tracking domain when its CNAME and HTTPS certificate are ready. Until then they point at novasreach.xyz on port 443. The site records those events. The desktop app pulls them back into the campaign on that PC.

Inbox Flow prepares the letter the way a normal mailer does: HTML and plain text, repaired links, a signed unsubscribe link, and `List-Unsubscribe`. It signs with DKIM only when a key was stored for that From domain. It does not force a message into the inbox. If the letter is prepared and the domain records are live, a reject or a junk folder points at the SMTP host, the From domain's reputation, or the list.

Users do **not** need the inboxflow.io domain. Each account can add one tracking domain, separate from the address they send from. It does not need a website. Every SMTP profile shares it. Delete it and add another to switch later sends. Mail already sent keeps the links it was given.

The current Windows installer line is **1.2.27**:

- Release: https://github.com/Annonymous29998/Inboxflow/releases/tag/desktop-1.2.27
- Setup file: https://github.com/Annonymous29998/Inboxflow/releases/download/desktop-1.2.27/InboxFlow-Setup-1.2.27.exe

Installing a newer EXE over an older one keeps `%APPDATA%\Inbox Flow`.

This file is the map for the project. It covers what the app does, how to build it, where it is deployed, and the steps to deploy it again.

## How the two halves fit

```
Windows PC (Inbox Flow.exe)
  Electron window loads http://127.0.0.1:5000
  Local API + SQLite hold contacts, letters, SMTP, campaigns
  Login, license, and link signatures go to https://novasreach.xyz

Recipient's mailbox
  Opens the letter
  Fetches https://novasreach.xyz/api/t/...

novasreach.xyz (Lightsail)
  nginx serves the website from /var/www/inboxflow
  nginx proxies /api and /health to 127.0.0.1:3001
  pm2 process inboxflow-api runs the Fastify API
```

Port 5000 is only the local window on the PC. It is not part of the link in the email. A recipient is not on that PC, so `127.0.0.1:5000` cannot be the tracking URL.

Created users keep their workspace on the PC (`smtpAllowDirect` is false, or `workspaceLocal` is true). Contacts, lists, campaigns, templates, SMTP profiles, and domains stay in the local SQLite file. Auth and license stay on the public site.

## Repository map

```
apps/api        Fastify API, Prisma, send path, tracking, domains
apps/web        React + Vite desktop-style UI
apps/desktop    Electron shell, local proxy, Windows installer
apps/api/prisma schema.prisma (Postgres) and schema.sqlite.prisma (desktop)
.github/workflows/windows-exe.yml
                Builds and publishes the Windows installer on push to main
```

API route groups, registered in `apps/api/src/app.ts`:

| Prefix | What it is |
|---|---|
| `/health` | Process is up |
| `/api/auth` | Sign-in, license, bind |
| `/api/contacts`, `/api/lists`, `/api/segments` | People and lists |
| `/api/campaigns` | Letters, queue, send-one, tracking apply |
| `/api/providers` | SMTP profiles |
| `/api/domains` | DNS records and verification |
| `/api/templates`, `/api/import` | Letters and HTML import |
| `/api/analytics`, `/api/deliverability`, `/api/logs` | Stats, checks, TUI log |
| `/api/admin` | Operator tools |
| `/api/workspace` | Pulse, tracking mint, tracking events |
| `/api/t` | Open pixel, click, unsubscribe |
| `/api/webhooks` | Provider webhooks |
| `/docs` | API docs, off in production |

The web UI lives in `apps/web/src/pages`. The mailer screens are campaigns, contacts, SMTP manager, domains, analytics, and the queue console. Admin screens are under `pages/admin`.

## What happens when a letter is sent

The live path is `apps/api/src/services/email/campaign-send.ts`.

1. The letter is personalized per contact (`personalize.ts`).
2. `hardenOutboundMime` rewrites common spam phrases in text nodes, then `shapeOutboundLetter` turns the body into a normal message: a full HTML document with a charset, repaired `www.` and empty links, a flat subject, and a plain-text part beside the HTML.
3. If the workspace is on the PC, the desktop calls `POST /api/workspace/tracking-mint` on novasreach.xyz. The cloud signs the links with the cloud JWT secret and stores a tracking row. The desktop secret is different, so a signature made only on the PC would not verify on the site.
4. Every recipient gets their own unsubscribe URL. A desktop link looks like:

   `https://track.theirdomain.com/api/t/unsubscribe?o=WORKSPACE&c=CONTACT&cid=CAMPAIGN&s=SIGNATURE`

   Before that tracking name has HTTPS, the host is `novasreach.xyz` instead.

   `o` is the workspace, `c` is that one person, `cid` is the campaign, `s` is the signature of those three. One sender address on an SMTP profile is always used. From addresses rotate only when that profile has several and the campaign is set to rotate.
5. Inbox Flow adds its own signed unsubscribe link even when the letter already has a different one. The letter's own link stays. If the letter already uses `{{unsubscribe_url}}`, that placeholder is already Inbox Flow's link, so a second copy is not added.
6. The message is sent with both HTML and plain text, plus `List-Unsubscribe`. On an `https` link, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is added. DKIM is attached only when that From domain has a stored key.
7. SMTP can go direct, bind to a local address that is really on the machine, or through a SOCKS proxy. A public NAT address that is not on the network card is skipped. The SMTP username is the mailbox login. A SOCKS username is only for the proxy.

Queue sending is paced: batches, a pause between batches, a short pause between messages, and a per-minute cap. The recommended pacing in the API overwrites a custom typed pace.

## Opens, clicks, and unsubscribe

Public routes are in `apps/api/src/modules/tracking/routes.ts`.

- Open: `GET /api/t/o/:campaignId/:contactId.gif` with `o` and `s` on a desktop link. A bad signature returns the blank image and is not counted.
- Click: `GET /api/t/c/:campaignId/:contactId?t=TICKET`. A bad ticket is rejected.
- Unsubscribe: `GET` or `POST /api/t/unsubscribe`.

A person who opens the link sees a page first. The underlined **unsubscribe from this** link is the step that unsubscribes them. Closing the page leaves them subscribed. A mailbox one-click POST (`List-Unsubscribe=One-Click`) still unsubscribes immediately, with no confirm page. A link with no valid signature returns **Invalid unsubscribe link** and changes nothing.

The site writes a `TrackingRelayEvent` for that workspace. It does not hold the PC's contacts. The desktop window, only when its host is `localhost` or `127.0.0.1`, polls `GET /api/workspace/tracking-events` about every 25 seconds, applies the events to the local campaign, then acknowledges them. One workspace cannot apply another workspace's events. The app has to be open for a new unsubscribe to land in the local list before the next send.

## Domains

The Domains page holds one tracking domain per account. Adding it creates one record.

| Record | Type | Host | Value |
|---|---|---|---|
| Tracking | CNAME | `track` | `novasreach.xyz` |

Leave the DNS proxy off so the CNAME stays visible. The domain does not need a website. The status becomes `VERIFIED` only after that CNAME is visible and the server has an HTTPS certificate for `track.thatdomain`. Until both are true, opens, clicks, and unsubscribe stay on `https://novasreach.xyz`. The certificate is requested by `POST /api/workspace/tracking-host` on the public site. The desktop proxy forwards that path. The server script is `scripts/issue-tracking-cert.sh`, installed as root at `/usr/local/sbin/inboxflow-issue-tracking-cert`, and it only accepts a `track.` hostname.

A second domain is refused until the current one is deleted. The next verified domain is used on later sends only.

While the API is running it looks up domains that are not verified yet, about every 30 seconds (`startDomainPropagationWatch` in `apps/api/src/modules/domains/domain-dns.ts`). On the Domains page, the same Verify DNS request runs quietly about every 20 seconds for domains that are still waiting. That updates only those domain rows. It does not send mail and it does not reload campaigns, contacts, or SMTP.

SPF, DKIM, and DMARC still belong on the domain in the From address, at the user's DNS host. This page does not create those records. Inbox Flow signs with DKIM only when a key was stored for that From domain.

## SMTP

SMTP profiles are managed in the app, not from `.env`. Each profile has host, port, username, password, encryption, sender name, sender email, reply-to, daily and hourly limits, priority, and notes. A profile is tested with a real SMTP `verify()` before it is marked active. Presets exist for Amazon SES, Mailgun, SendGrid, Postmark, Gmail, Outlook, Zoho, and custom SMTP.

Rotation across SMTP servers is `round_robin`, `weighted`, or `failover`, and it respects the daily and hourly limits. That rotation is load and reliability. It is not a way to hide the sender.

The health line `6ok/0fail · 6 total` is the count of accepted sends and failed sends. It is not a count of From addresses and it is not the rotation setting.

## Where data lives

| Data | Where |
|---|---|
| Desktop contacts, campaigns, SMTP, domains | `%APPDATA%\Inbox Flow\workspace.db` |
| Desktop login and license | novasreach.xyz |
| Tracking events before the PC pulls them | Postgres on the server, tables `TrackingLink` and `TrackingRelayEvent` (created at API startup, not by `prisma db push`) |
| Website files | `/var/www/inboxflow` on the server |
| API process | `/home/ubuntu/Inboxflow`, pm2 name `inboxflow-api`, port 3001 |

Do not run `prisma db push` against the server database if it would drop columns. The relay tables are created with `CREATE TABLE IF NOT EXISTS`.

The desktop proxy forwards `/api/auth`, `/api/admin`, `/api/workspace/pulse`, `/api/workspace/tracking-mint`, `/api/workspace/tracking-events`, and `/api/workspace/tracking-host` to novasreach.xyz. `POST /api/campaigns/tracking-apply` stays on the PC.

Sign-in is the only public entry. There is no public signup. Demo and license logins may use an `@inboxflow.io` address. That is a username the app accepts. It is not a mailbox on a domain this project controls.

## Build

Node 20 or newer. From the repository root:

```bash
npm ci
npm run build
npm test
```

`npm run build` does two things, in order:

1. API (`apps/api`): generates the Postgres Prisma client and the SQLite Prisma client, compiles TypeScript, and copies `src/generated` into `dist/generated`. Output is `apps/api/dist`.
2. Web (`apps/web`): Vite production build. Output is `apps/web/dist`.

That build is what both deploys use. The public site is served from those two `dist` folders. The Windows installer is built from the same folders by GitHub Actions, not by a Mac `electron-builder` run.

`apps/desktop` is Electron. `apps/desktop/src/main.cjs` starts the local API, listens on port 5000, and opens the window at localhost. The packaged web files come from `apps/web/dist`. The packaged API comes from `apps/api/dist`. `npm run desktop:prepare` builds both and stages them for the installer. The installer itself is produced on a Windows runner.

## Where it is deployed

There are two deploy targets. A letter uses both.

| What | Where | Who uses it |
|---|---|---|
| Public site and API | `https://novasreach.xyz` on Lightsail `13.38.60.67` | Recipients (open, click, unsubscribe) and the desktop login |
| Windows app | GitHub release `desktop-<version>` | The person sending mail, on their PC |

Lightsail layout:

| Piece | Path |
|---|---|
| SSH | `ubuntu@13.38.60.67` |
| nginx site root | `/var/www/inboxflow` |
| API checkout | `/home/ubuntu/Inboxflow` |
| API files nginx does not serve | `/home/ubuntu/Inboxflow/apps/api/dist` |
| Process | pm2 name `inboxflow-api`, cwd `/home/ubuntu/Inboxflow`, command `npm run start -w @inboxflow/api`, port `3001` |
| Health | `https://novasreach.xyz/health` and `http://127.0.0.1:3001/health` on the server |

nginx proxies `/api` and `/health` to port 3001. The SSH private key is not in this repo. The file used from this machine is `LightsailDefaultKey-eu-west-3.pem`.

GitHub:

- Repository: https://github.com/Annonymous29998/Inboxflow
- Workflow: `.github/workflows/windows-exe.yml` on `windows-latest`
- Release example: https://github.com/Annonymous29998/Inboxflow/releases/tag/desktop-1.2.27

The window inside the EXE loads the bundled localhost app. Updating only novasreach.xyz changes tracking and unsubscribe pages. It does not change the screens inside an already installed EXE. Ship both when the send path or the UI changes.

## Deploy the public site

From the repository root, after `npm run build`:

```bash
KEY="$HOME/Downloads/LightsailDefaultKey-eu-west-3.pem"
HOST="ubuntu@13.38.60.67"
RSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

rsync -az -e "$RSH" apps/api/dist/ "$HOST:/home/ubuntu/Inboxflow/apps/api/dist/"
rsync -az -e "$RSH" apps/web/dist/ "$HOST:/tmp/inboxflow-web/"
ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" \
  'sudo rsync -a --delete /tmp/inboxflow-web/ /var/www/inboxflow/ && rsync -a --delete /tmp/inboxflow-web/ /home/ubuntu/Inboxflow/apps/web/dist/ && pm2 restart inboxflow-api'
sleep 4
curl -sS https://novasreach.xyz/health
```

The first health check right after `pm2 restart` often fails because the process has just started. Run the curl again. A good result is `"status":"ok"`.

Tracking-domain certificates also need, on the server:

- `scripts/issue-tracking-cert.sh` installed as root at `/usr/local/sbin/inboxflow-issue-tracking-cert`. It writes the HTTP challenge into `/var/www/inboxflow`, which the existing port 80 default server already serves. Do not add a second `default_server`.
- sudoers allowing `ubuntu` to run only that script with `sudo -n`
- `TRACKING_CERT_ISSUE=1` in the API environment before `pm2 restart inboxflow-api --update-env`

The API refuses any hostname that is not `track.` plus a domain, and it checks the CNAME points at novasreach.xyz before it asks certbot.

Do not run `prisma db push` on the server database. Relay tables are created at API startup with `CREATE TABLE IF NOT EXISTS`.

If pm2 has no `inboxflow-api` process, start it from the server checkout:

```bash
cd /home/ubuntu/Inboxflow
pm2 start npm --name inboxflow-api -- run start -w @inboxflow/api
pm2 save
```

## Deploy the Windows installer

The installer is not uploaded by hand. GitHub Actions builds it when `main` changes.

1. Bump the same version in all three places. If the last release is `1.2.24`, the next is `1.2.25`. A repeated tag fails the release step.
   - `apps/desktop/package.json` field `version`
   - `package-lock.json` version under `apps/desktop`
   - `.github/workflows/windows-exe.yml` artifact name, `tag_name`, release title, and the `.exe` / `.zip` file names
2. Commit and push to `main`. The workflow also runs on `workflow_dispatch`.
3. The workflow runs only when the push touches `apps/desktop`, `apps/api`, `apps/web`, the workflow file, `package.json`, or `package-lock.json`.
4. On the runner the steps are: `npm ci`, build API and web (`npm run desktop:prepare`), download portable Node, `electron-builder` NSIS plus zip, verify the package, silent-install and launch, publish the release.
5. Open `https://github.com/Annonymous29998/Inboxflow/releases/tag/desktop-<version>` and confirm both `InboxFlow-Setup-<version>.exe` and `.zip` are attached.

`deleteAppDataOnUninstall` is false, so installing over an older EXE keeps `%APPDATA%\Inbox Flow\workspace.db`.

A second push to `main` while that workflow is still running cancels the in-progress build (`cancel-in-progress: true`). Wait until the release exists before pushing another installer change.

## Run it locally

Node 20 or newer.

```bash
cp .env.example .env
npm install
npm run db:generate -w @inboxflow/api
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:3001
- API docs: http://localhost:3001/docs

`.env.example` lists the variables. The ones the API refuses to boot without are `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `ENCRYPTION_KEY` (each secret at least 32 characters). Campaign SMTP is configured in the app. `SMTP_HOST=json` only logs the app's own transactional mail to the console.

`npm run build` builds the API (Prisma clients for Postgres and SQLite, then TypeScript) and then the web app.

Tests:

```bash
npm test
```

That runs the API Vitest suite. There is no separate browser end-to-end suite. The Windows workflow is the installer check: build, silent install, launch.

## Code to open first

| Question | File |
|---|---|
| Send one letter | `apps/api/src/services/email/campaign-send.ts` |
| HTML and plain text shape | `apps/api/src/services/email/outbound-shape.ts` |
| Phrase cleanup | `apps/api/src/modules/deliverability/spam-scrubber.ts` |
| Unsubscribe and click signatures | `apps/api/src/utils/signed-urls.ts` |
| Public open, click, unsubscribe | `apps/api/src/modules/tracking/routes.ts` |
| Unsubscribe page | `apps/api/src/modules/tracking/unsubscribe-page.ts` |
| Cloud tracking rows and PC apply | `apps/api/src/services/email/tracking-relay.ts` |
| Which URL goes in the letter | `apps/api/src/services/email/public-url.ts` |
| What stays on the PC | `apps/api/src/services/email/workspace-residency.ts` |
| DNS records and auto-check | `apps/api/src/modules/domains/domain-dns.ts` |
| SPF includes per SMTP host | `apps/api/src/modules/deliverability/smtp-auth-hints.ts` |
| Desktop window and proxy | `apps/desktop/src/main.cjs` |
| PC polls the site for events | `apps/web/src/lib/operator-pulse.ts` |

Older notes in `docs/` describe earlier deployment ideas (Supabase edge sends, a hosted-only app). When they disagree with this file, trust this file and the code paths above.
