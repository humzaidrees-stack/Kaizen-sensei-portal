# Kaizen Sensei portal

Phone-first portal for the sensei at Kaizen Pilates (Saadiyat, Abu Dhabi, `Asia/Dubai`).

Sensei sign in and set weekly availability, book time off, and pick up open shifts. When time off overlaps a class they teach, that class goes on the board immediately. A class whose Mindbody instructor is the placeholder **Kaizen Sensei** is an open shift too. The front desk is told (WhatsApp, otherwise email, otherwise the alert log), posts the list to the existing sensei WhatsApp group with one tap, and approves a pick-up. Approval writes the substitute back to Mindbody when a service login is configured. If that write is skipped or fails, the shift stays filled and shows the note to update the class in Mindbody by hand.

The scheduling rules, API, and screens follow the November 2026 reference app. This version runs on Vercel: static files in `public/`, one Node serverless function, Postgres, and a cron job instead of `setInterval`.

## Roles

| Role | Login (demo) | Can do |
|---|---|---|
| Sensei | `KP101` … | Own availability, own time off, own classes, claim open shifts. Cannot see or change anyone else's. |
| Front desk | `DESK` | Shifts, schedule, everyone's time off, post to WhatsApp, approve or assign pick-ups. No instructor admin, no Mindbody settings, no revenue or member data. |
| Manager | `ADMIN` | Everything the desk can do, plus instructors, PINs, Mindbody sync and import, and their own schedule tabs. |

There is no first-come auto-approve. A manager or the desk confirms every pick-up.

Sign-in is still ID + PIN. PINs are scrypt-hashed. The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `COOKIE_SECURE=1`. Six wrong PINs for an ID lock it for 15 minutes (stored in Postgres, so it holds across serverless instances). Mindbody staff login can replace PIN login later: `createSessionForStaff()` in `src/auth.js` opens our session from a Mindbody staff id. The browser never sees Mindbody credentials.

## Local development

Node 22.13 or newer, and Postgres 14+.

```bash
npm install
createdb kaizen_sensei          # or: docker run -d --name kaizen-pg -e POSTGRES_PASSWORD=kaizen -e POSTGRES_USER=kaizen -e POSTGRES_DB=kaizen_sensei -p 5432:5432 postgres:16
cp .env.example .env            # set DATABASE_URL
npm run migrate
SEED_FIXED_PINS=1 npm run seed  # local demo only. Writes data/DEMO_LOGINS.txt
npm run dev                     # http://localhost:8791
```

`SEED_FIXED_PINS=1` uses predictable PINs so a demo is easy to share. Do not use it on a production database. Without it, seed generates random PINs and writes them to `data/DEMO_LOGINS.txt`.

Fixed demo PINs:

| ID | PIN | Who |
|---|---|---|
| ADMIN | 246810 | Studio manager |
| DESK | 135790 | Front desk |
| KP101 | 101101 | Charmaine Al Mulaifi |
| KP102 | 102102 | Christina Sagawe |
| KP103 | 103103 | Claudia Guerra Cafoncelli |
| KP104 | 104104 | Dezi Olle |
| KP105 | 105105 | Fiona Marie |
| KP106 | 106106 | Gaby Lee |
| KP107 | 107107 | Iona de Maudesley |
| KP108 | 108108 | Jaime Cooke |
| KP109 | 109109 | Natacha Benbernou |
| KP110 | 110110 | Rena |
| KP111 | 111111 | Venus Ng |

The seed loads `sample-data/november_schedule.csv` (six weeks from today) and `sample-data/Availability_Submissions_November_2026-10-26.csv`, plus the time off from the reference app. It works with no Mindbody credentials. `npm run seed` wipes the scheduling tables. In production it refuses to run unless `ALLOW_SEED_RESET=1`.

```bash
npm test
npm run build
```

Tests use `TEST_DATABASE_URL`, or `postgres://kaizen:kaizen@127.0.0.1:5432/kaizen_sensei_test` if that is unset. Create that database once (`createdb kaizen_sensei_test`).

## Environment variables

Copy `.env.example`. Never commit real values.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string. On Vercel, use the Marketplace Postgres (Neon) **pooled** URL (host contains `-pooler`). |
| `STUDIO_TZ` | | IANA timezone. Default `Asia/Dubai`. |
| `COOKIE_SECURE` | | `1` on Vercel (https). `0` or unset for local http. |
| `PORT` | | Local server only. Default `8791`. |
| `APP_BASE_URL` | | Public origin with no trailing slash, included in desk alert text. Example `https://sensei.example.com`. |
| `CRON_SECRET` | Yes in production | Bearer token for `GET /api/cron/sync`. The route returns 401 until this is set. |
| `ADMIN_PIN` | | Optional PIN for the ADMIN login created by seed. |
| `DESK_PIN` | | Optional PIN for the DESK login created by seed. |
| `SEED_FIXED_PINS` | | `1` only for a local demo. Never on production. |
| `ALLOW_SEED_RESET` | | `1` to allow `npm run seed` when `NODE_ENV=production`. |
| `MB_API_KEY` | | Mindbody Public API v6 key. Leave blank to stay on CSV/seed data. |
| `MB_SITE_ID` | | Mindbody site id. Both key and site id are required before sync does anything. |
| `MB_USERNAME` | | Service staff user allowed to change class instructors. |
| `MB_PASSWORD` | | Password for that user. Without the pair, approvals are not written back. |
| `MB_LOCATION_IDS` | | Optional comma-separated location ids. Blank means all locations. |
| `MB_SYNC_WEEKS` | | How many weeks of classes to pull. Default `6`. |
| `WA_TOKEN` | | WhatsApp Cloud API token. All four WhatsApp variables are required, or WhatsApp is skipped. |
| `WA_PHONE_NUMBER_ID` | | Phone number id from the WhatsApp Cloud API. |
| `WA_TEMPLATE_NAME` | | Approved utility template name. Body is a single variable `{{1}}`. |
| `FRONT_DESK_WA_E164` | | Front desk mobile in country-code digits, for example `9715xxxxxxx`. Messages go here only, never to sensei. |
| `WA_TEMPLATE_LANG` | | Template language. Default `en`. |
| `RESEND_API_KEY` | | Email fallback when WhatsApp is unset or the send fails. |
| `ALERT_EMAIL_FROM` | | From address Resend will accept. |
| `ALERT_EMAIL_TO` | | Front desk inbox. |
| `PG_POOL_MAX` | | Pool size per instance. Default `4`. |

If WhatsApp is not configured, the portal tries email. If email is not configured either, it writes the alert to the `alerts` table and the server log and continues. Booking time off never fails because a notification could not be sent.

Desk alerts are sent only from 08:00 inclusive until 21:00 exclusive, Asia/Dubai. Outside that window they are queued. The cron route sends the queue when it runs inside the window. One message per time-off booking (not per class). A Kaizen Sensei class, a pick-up request, and a shift still open inside 48 hours each get their own message.

Suggested utility template (submit in Meta Business Manager, category Utility):

```text
{{1}}
```

The value is a single line, for example `Christina is away 6 to 21 Dec. 14 classes need cover.`

## Deploy on Vercel (kaizenwell team)

1. Install the CLI and log in with an account that belongs to the **kaizenwell** team: `npm i -g vercel && vercel login`.
2. From this repo: `vercel link` and choose the **kaizenwell** team, then create a new project (or pick the existing Sensei project). Framework preset: **Other**. Root directory: this repo.
3. In the Vercel dashboard for that project, open **Storage** → **Create** → **Neon** (Marketplace Postgres). Attach it to the project. Copy the **pooled** `DATABASE_URL` into the project's environment variables if the integration did not add it itself. Do this for Production and Preview.
4. Set the rest of the variables from the table above. At minimum for a real deploy: `DATABASE_URL`, `COOKIE_SECURE=1`, `CRON_SECRET` (a long random string), `STUDIO_TZ=Asia/Dubai`, `APP_BASE_URL` (the production URL). Add Mindbody and WhatsApp variables when those accounts are ready. Leave them empty until then; the app still runs on seeded data.
5. Deploy: `vercel deploy --prod`. The build runs `npm run build`, which applies SQL migrations when `DATABASE_URL` is present. To migrate by hand: `DATABASE_URL="…" npm run migrate`.
6. Seed only a demo database, never production member data (there is none in this app, but seed wipes the tables): `ALLOW_SEED_RESET=1 SEED_FIXED_PINS=0 npm run seed` with production `DATABASE_URL` in the environment. Prefer random PINs and read `data/DEMO_LOGINS.txt` locally. Do not set `SEED_FIXED_PINS=1` against production.
7. Confirm `GET /api/health` returns `{"ok":true}` and a sensei can sign in.

### Cron (Hobby)

The kaizenwell Vercel project is on the **Hobby** plan. Hobby rejects a cron that runs more than once a day (`cron_jobs_limits_reached`), so `vercel.json` schedules `GET /api/cron/sync` once a day at `0 1 * * *`. That is 01:00 UTC, which is **05:00 Asia/Dubai** (no daylight saving). Vercel calls it with `Authorization: Bearer $CRON_SECRET`.

05:00 is before the desk alert window (08:00–21:00). The daily run still pulls Mindbody and queues anything new. It does not send WhatsApp or email. The queue goes out on the next run that falls inside the window.

The 30-minute run is GitHub Actions, in `.github/workflows/sync.yml` (`*/30 * * * *`, plus **Run workflow** for a manual trigger). It `curl`s the full sync URL. Time off does not wait for either job: saving or removing it reconciles open shifts in that request.

Both callers can overlap. The route takes a Postgres advisory lock and, if a sync is already running, returns `200` with `{ "skipped": true, "reason": "sync_in_progress" }` instead of starting a second one. A finished sync is safe to repeat: classes are replaced for the window, filled shifts stay filled, and each desk alert is deduped.

#### GitHub repository secrets

On the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Required | Value |
|---|---|---|
| `SYNC_URL` | Yes | Full URL of the sync route, for example `https://<project>.vercel.app/api/cron/sync`. No trailing slash on the host, and include the path. |
| `CRON_SECRET` | Yes | The same string as the Vercel environment variable `CRON_SECRET`. |
| `VERCEL_BYPASS_SECRET` | Only if Deployment Protection is on | The project's **Protection Bypass for Automation** secret (Vercel → Project → Settings → Deployment Protection). |

Until `SYNC_URL` and `CRON_SECRET` are both set, the workflow prints a notice and exits successfully, so the schedule does not fail on an unconfigured repo. `CRON_SECRET` on GitHub must match Vercel or the route returns 401 and the workflow fails.

Vercel Authentication (Deployment Protection) answers external requests, including this workflow, before the function runs. Vercel's own daily cron is not blocked. If protection is on, create the bypass secret in Vercel, copy it into `VERCEL_BYPASS_SECRET`, and the workflow sends it as `x-vercel-protection-bypass`. The app still requires `Authorization: Bearer`. The bypass header on its own does not authorise the route. Leaving protection on without that secret makes `curl` fail on Vercel's login response.

To run it once by hand: GitHub → Actions → Sync → Run workflow.

GitHub may start a scheduled run a few minutes late. A private repo that sits idle for about 60 days can also have scheduled workflows paused until someone pushes or runs one by hand.

## Mindbody

Reads (only when `MB_API_KEY` and `MB_SITE_ID` are set):

- `GET /class/classes` for the next `MB_SYNC_WEEKS` (default 6)
- `GET /staff/staff` for the instructor link screen

Write, on approval, only when `MB_USERNAME` and `MB_PASSWORD` are also set and the class id is a real Mindbody id (not `demo:` or `csv:`):

- `POST /usertoken/issue` for the service user
- `POST /class/substituteclassteacher` with `{ ClassId, StaffId }`

The staff user token is cached for six hours. Keys stay in server environment variables and are not referenced by `public/`.

Until Mindbody is connected, a manager can import a CSV (`date`, `start`, `class`, `instructor`; `end` and `location` optional) from the Mindbody screen. Names like `Sagawe, Christina` are matched. Linking a Mindbody staff id on the instructor row is what makes the substitute write possible.

## What the screens do

Sensei: **My classes** (next four weeks), **Open shifts** (tagged in or outside their weekly hours), **Availability** (Monday–Sunday, 06:00–22:00, one-hour blocks), **Time off** (whole days or part of a day, with the classes it will post). Pick up is refused when they are away, already teaching, or it is their own class.

Front desk: **Shifts**, **Schedule**, **Time off**. **Post to WhatsApp** opens `wa.me` with the next two weeks of open shifts already written, so the desk can pick the existing sensei group and send. Approving a request, or assigning someone who is free, fills the shift.

Manager: those screens, plus **Instructors**, **Mindbody**, and **My classes / My hours / My time off**.

Add to the home screen uses the name **Kaizen Sensei** (`manifest.webmanifest`).

## Project layout

| Path | What it is |
|---|---|
| `public/` | The phone UI, brand assets, web app manifest |
| `api/[...path].js` | Vercel serverless entry |
| `src/logic.js` | Scheduling rules (the reference cross-check) |
| `src/routes.js` | API |
| `src/mindbody.js` | Mindbody Public API v6 client |
| `src/alerts.js` | Desk WhatsApp / email / log |
| `src/auth.js` | PIN login, sessions, future staff-login hook |
| `db/migrations/` | Postgres schema |
| `db/seed.js` | Demo roster, template, and form answers |
| `sample-data/` | The November CSVs |
| `scripts/dev-server.js` | Local static server plus the same API |
| `src/sync-lock.js` | One-at-a-time guard for the sync route |
| `.github/workflows/sync.yml` | GitHub Actions sync every 30 minutes |

## Tests

`npm test` covers the scheduling rules (placeholder, time off overlap, closing a shift when the reason is gone, leaving a filled shift alone, availability, conflicts, candidates) and the API (login lockout, HttpOnly cookie, sensei isolation, desk vs manager, time off → claim → approve → Mindbody note or write, CSV import, cron auth including the Vercel bypass header, the sync lock, alert quiet hours, WhatsApp template, email fallback).

## Not in this version

Client notes (KW-39) and roster check-in (KW-40) are not built. They depend on member health data and a Mindbody write that this scheduling portal does not have. The KW-23 class roster is not joined in, because that screen is not part of the reference app and it shows member readings. The sensei home here is the scheduling home from the reference: my classes, open shifts, availability, and time off.
