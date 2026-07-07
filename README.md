# ToolTracker

ToolTracker is LTA's tool check-in / check-out tracking system. It keeps a live record of which tools exist, where they live (department → toolbox → drawer), who has them checked out, whether they're overdue for calibration, and whether they're out for QA calibration. A single Node/Express server exposes a JSON API backed by PostgreSQL and serves a small set of static front-end pages for shop-floor and admin use, installable as a PWA on any phone, tablet, or desktop.

## Entry Points (`public/`)

The server serves everything in `public/` as static files. There are four pages, each independently installable as its own app (see [Progressive Web App](#progressive-web-app-pwa) below):

- **`index.html`** — The hub. A simple landing page with links to the other three tools.
- **`kiosk.html`** — Shop-floor scanning station. A technician identifies themselves with a badge/username **and PIN**, then scans tool barcodes (camera or a USB barcode gun) to check tools in or out, run toolbox audits, report a damaged/missing tool, or send a tool to QA for calibration. Every checkout and check-in additionally requires a second person (`tool_rep` or higher) to sign off with their own PIN. Meant to run on a shared PC, tablet, or phone at the point of use.
- **`admin.html`** — Admin portal for managing personnel (users, roles, PINs), inventory infrastructure (departments, toolboxes, drawers, tools), running reports, and seeing which departments still need their mandatory audit for the current shift.
- **`dashboard.html`** — Read-only telemetry dashboard: counts of tools in/out, flagged tools, upcoming/overdue calibrations, and a click-through detail view for any tool. Each department/toolbox drill-down mirrors the global view's layout, scoped to that location.

## Feature Overview

Beyond basic check-in/check-out, the app enforces a few real operational controls:

- **Dual-PIN sign-off**: every checkout and check-in requires the technician's own PIN plus a second, different `tool_rep`+ person's PIN. There is no "solo" checkout path.
- **Mandatory shift audits**: each department must log a toolbox audit at least once per shift window (morning 04:00–14:00, afternoon 14:00–04:00 overnight) before anyone can check tools **out** of that department that shift. Check-ins are never blocked. See `getAuditWindowStart()` in `server.js`.
- **QA calibration transfers**: reporting a tool as "Needs Calibration" starts a two-leg, two-party chain of custody — the tool moves to a QA department, QA explicitly accepts it, calibrates it, and sends it back; the home department explicitly accepts the return. Tracked in the `tool_transfers` table.
- **Reserved IDs on damaged/missing tools**: reporting a tool Broken/Missing/Worn flags it and reserves its barcode ID until an admin creates an explicit replacement.
- **Real HTTPS everywhere**: camera access requires a secure context on every device except `localhost`. See [HTTPS & Remote Access](#https--remote-access-caddy--duckdns) below for how this is solved without per-device certificate installs.
- **Progressive Web App**: installable home-screen icons for Kiosk/Admin/Dashboard separately, with app-shell caching for resilience against brief network hiccups (not full offline data sync — see [Future Improvements](#future-improvements)).
- **Data Matrix label generation**: `scripts/generate-tool-labels.js` and `scripts/generate-size-test-sheet.js` produce print- and laser-engraving-ready barcode labels straight from the live tool list. See [Generating Tool Labels](#generating-tool-labels) below.

## Running Locally (PC / Dev)

1. **Start the database:**
   ```
   docker-compose up
   ```
   This brings up a PostgreSQL container (`db`, exposed on `5432`). (Metabase used to run alongside it here but was removed — it was sharing this same database for its own internal metadata, which filled it with 150+ unrelated tables, and nobody was using it.)

2. **First time only — create the schema:**
   ```
   docker exec -i tooltracker_server-db-1 psql -U tooladmin -d tooltracker < migrations/000_initial_schema.sql
   docker exec -i tooltracker_server-db-1 psql -U tooladmin -d tooltracker < migrations/001_beta_feedback.sql
   ```
   `000` is the full base schema (all 6 core tables); `001` is the one real incremental migration since (adds `tool_transfers` and `tools.serial_number`). Both are safe to re-run (they use `IF NOT EXISTS` throughout).

3. **Start the API and static server:**
   ```
   node server.js
   ```
   This runs the Express app on port `3000` (HTTP only — see below for HTTPS).

4. **(Optional but recommended) Start Caddy for real HTTPS:**
   ```
   ./caddy.exe run
   ```
   Needed for camera access from any device other than this PC via `localhost`. See the next section for one-time setup.

5. **Open the app:** `http://localhost:3000/` (this PC only) or `https://<your-duckdns-name>.duckdns.org/` (any device, once Caddy is set up).

## HTTPS & Remote Access (Caddy + DuckDNS)

Browsers only allow camera access (`getUserMedia`) on HTTPS, or the special-cased `localhost`. A self-signed certificate doesn't solve this cleanly — every single device (every phone, every tablet) would need that certificate manually installed and trusted, which doesn't scale past one or two test devices, and iOS Safari in particular won't grant camera access off a self-signed cert even after you click through the warning.

The actual fix: a **real, publicly-trusted certificate** (free, via Let's Encrypt) for a DNS name that happens to point at this machine's **local** IP address. This works because:
- DNS resolution happens over the public internet, but the actual connection stays entirely on the local network — nothing needs to be reachable from outside.
- Let's Encrypt can verify domain ownership via a DNS TXT record (the "DNS-01 challenge"), which doesn't require the server to be internet-facing at all.
- Once issued, the certificate is trusted by every browser/OS on the planet automatically — zero per-device setup, ever.

### One-time setup (already done for this deployment, documented here for the next one)

1. Create a free subdomain at [duckdns.org](https://www.duckdns.org) (sign in with GitHub/Google/etc — no new password). Note the domain name and the account token shown at the top of the page.
2. Point that DuckDNS domain's IP field at this machine's **local LAN IP** (not its public IP — DuckDNS will auto-fill your public IP by default, which is wrong for this purpose. Get the real local IP via `ipconfig` on Windows or `ip addr` on Linux).
3. Get a Caddy binary with the DuckDNS DNS plugin built in — no local Go/xcaddy install needed:
   ```
   curl -sL -o caddy.exe "https://caddyserver.com/api/download?os=windows&arch=amd64&p=github.com/caddy-dns/duckdns"
   ```
   (swap `os=windows&arch=amd64` for `os=linux&arch=arm64` on the Raspberry Pi — already pre-downloaded at `caddy-for-raspberry-pi/caddy-linux-arm64` for exactly this).
4. Copy `Caddyfile.example` to `Caddyfile` and fill in your actual DuckDNS domain and token (this file is gitignored — it holds a secret, never commit it):
   ```
   your-subdomain.duckdns.org {
       tls {
           dns duckdns YOUR_DUCKDNS_TOKEN_HERE
       }
       reverse_proxy localhost:3000
   }
   ```
5. Run `./caddy.exe run` — on first launch it automatically requests and installs the certificate (takes a few seconds) and **renews it automatically forever after**, as long as Caddy keeps running and has occasional internet access (renewal happens well before the ~90-day expiry).

### If the local IP ever changes

If this machine (or the Pi, later) gets a new local IP — e.g. after a router reset — update the IP field on the DuckDNS page to match. To avoid this entirely, give the machine a **static/reserved IP** via a DHCP reservation on your router (recommended, one-time setup).

### Firewall

Only two ports need to be open to the network: **443** (HTTPS, what Caddy actually serves) and optionally **80** (so a stray `http://` request gets redirected to `https://` instead of failing). Port 3000 does **not** need to be exposed — Caddy reaches the Node app over `localhost`, which never touches the firewall. Example (run as Administrator):
```powershell
New-NetFirewallRule -DisplayName "ToolTracker HTTPS (443)" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "ToolTracker HTTP redirect (80)" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Any
```

## Progressive Web App (PWA)

Each of the three main pages has its own web app manifest (`manifest-kiosk.json`, `manifest-admin.json`, `manifest-dashboard.json`), so installing "from" a given page creates a home-screen icon that opens straight to that page:

- **iOS Safari**: open the page → Share button → "Add to Home Screen."
- **Android Chrome / Desktop Chrome/Edge**: open the page → browser menu → "Install app" (or an install icon in the address bar).

`sw.js` (registered on every page via `sw-register.js`) caches the app's own static files for resilience against brief network drops, but is deliberately **network-first**: it always tries the real server first so code/bug fixes show up immediately when online, only falling back to the cached copy if the network request genuinely fails. It never caches `/api/*` calls — live data always comes from the real server or fails honestly.

## Generating Tool Labels

Two free, offline scripts (using `bwip-js`, no external service) generate Data Matrix barcodes straight from the live `tools` table, so printed/engraved codes can never drift out of sync with the database:

```
npm run generate-labels [target-size-mm]     # one PNG + one SVG per tool, in tool_labels/
npm run generate-size-test [qr_code]         # one real tool's code at several candidate sizes, for physical scan-testing
```

- **PNG** files are sized for printing on adhesive labels (300+ DPI, with correct embedded physical-size metadata so "print at 100%" is accurate).
- **SVG** files are vector, meant for importing into laser engraving software (LightBurn, etc.) at an exact real-world millimeter size.
- **Before engraving/printing a full batch**, run `generate-size-test` and physically scan each candidate size with the actual kiosk/admin camera under real shop lighting — the achievable minimum size depends heavily on print/engrave contrast and the camera's minimum focus distance, not just math. See the generated `tool_labels/size_test/README.txt` for the test procedure.

## Raspberry Pi Migration

`server.js` writes uploaded photos to `public/uploads` and activity logs to `logs/`, both resolved relative to one constant near the top of the file:

```js
const BASE_STORAGE_PATH = __dirname; // Option A: Windows PC (Development)
// const BASE_STORAGE_PATH = '/mnt/external_drive/ToolTracker_Data'; // Option B: Raspberry Pi (Production)
```

Steps to move to the Pi:

1. Flip `BASE_STORAGE_PATH` to the external-drive path (uncomment Option B, comment out Option A).
2. Run `npm install` on the Pi (installs the same dependencies fresh for its architecture).
3. Run the two migration files against the Pi's Postgres instance (see [Running Locally](#running-locally-pc--dev) step 2).
4. Use the pre-built `caddy-for-raspberry-pi/caddy-linux-arm64` binary (already has the DuckDNS plugin built in — no need to re-download).
5. Update the DuckDNS IP field to the Pi's local IP (give it a DHCP reservation so this never has to change again).
6. Set up both processes to survive reboots and crashes — **this is not done yet, do it before relying on this in production**. On Linux, a systemd unit for each is the standard approach:

   ```ini
   # /etc/systemd/system/tooltracker.service
   [Unit]
   Description=ToolTracker Node server
   After=network.target postgresql.service

   [Service]
   WorkingDirectory=/path/to/ToolTracker_Server
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   ```ini
   # /etc/systemd/system/tooltracker-caddy.service
   [Unit]
   Description=ToolTracker Caddy reverse proxy
   After=network.target tooltracker.service

   [Service]
   WorkingDirectory=/path/to/ToolTracker_Server
   ExecStart=/path/to/ToolTracker_Server/caddy-for-raspberry-pi/caddy-linux-arm64 run --config Caddyfile
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   Then `sudo systemctl enable --now tooltracker tooltracker-caddy`. Also give the Postgres container the same treatment (`docker-compose` already restarts `always`, but confirm Docker itself starts on boot: `sudo systemctl enable docker`).

## Maintenance

- **Restarting after a code change**: static files (`public/*.html`, `*.js`, `*.css`) take effect on the next page load with no restart needed. Changes to `server.js` require killing and restarting the Node process. **Before starting a new one, always check nothing is already listening on port 3000** — a stray process from a previous session silently serving old code was a repeated source of confusing bugs during development:
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server.js*" } | Select-Object ProcessId, CommandLine
  ```
  Kill any match with `Stop-Process -Id <id> -Force` before starting a fresh one. (Once the systemd units above are in place, `systemctl restart tooltracker` handles this correctly on its own.)
- **Database backups**: `docker exec tooltracker_server-db-1 pg_dump -U tooladmin -d tooltracker -F c -f /tmp/backup.dump`, then copy it out with `docker cp`. Do this before any risky schema change or bulk edit. No automated backup schedule exists yet — see [Future Improvements](#future-improvements).
- **Certificate renewal**: fully automatic, no action needed — just make sure Caddy keeps running (see the systemd unit above once on the Pi).
- **Logs**: `logs/hourly/<DEPT>/` and `logs/daily/<DEPT>/` grow daily and are gitignored (not committed). They currently grow forever with no rotation/cleanup — worth revisiting once real usage volume is known.
- **Regenerating tool labels**: re-run `npm run generate-labels` any time tools are added — see [Generating Tool Labels](#generating-tool-labels).

## Troubleshooting

- **Camera says "permission denied" on a phone**: almost always means the page was loaded over plain `http://` from a non-`localhost` address. Use the real `https://` DuckDNS URL instead.
- **Camera opens but shows the wrong (front-facing) camera**: fixed in the current code (`facingMode: "environment"` is requested explicitly rather than guessing a device index) — if this regresses, check `executeCameraScan()` in `kiosk.js` and `initCameraCore()` in `admin.js`.
- **Camera preview looks stretched/squished on phone rotation**: the `.camera-reader` CSS class locks the preview to a fixed 1:1 aspect ratio for exactly this reason — make sure any new camera preview element uses that class.
- **A page seems to be serving old/stale behavior after a fix**: check for a stray `node.exe` still holding port 3000 from a previous session (see [Maintenance](#maintenance) above) before assuming the fix didn't work.
- **iOS page zooms in on tapping a text field and won't zoom back out**: any input/select with a font-size under 16px triggers this — it's a platform quirk with no fix after the fact, only prevention. `.form-input`/`.form-select` are set to exactly 16px for this reason; don't reduce it.

## Tech Stack

- **Express** — HTTP API and static file serving
- **PostgreSQL** via **pg** — primary datastore (departments, users, toolboxes, drawers, tools, audit_logs, tool_transfers)
- **multer** — handles multipart photo uploads
- **sharp** — image processing for uploaded photos; also used to rasterize PWA icons
- **bwip-js** — Data Matrix barcode generation for tool labels
- **html5-qrcode** (front-end) — camera-based barcode scanning in the browser
- **Caddy** — reverse proxy providing automatic, real HTTPS via Let's Encrypt (DNS-01 challenge against DuckDNS)
- **cors** — cross-origin support for the API

## Security Notes

- Database credentials are hardcoded in both `server.js` (the `pg` `Pool` config) and `docker-compose.yml`. Fine for local dev, but should move into environment variables before any real production exposure.
- There is no email delivery in this system by design — new-user and PIN-reset credentials are always shown directly to the admin in a handout modal, to be relayed to the person in person.
- User PINs are stored in **plain text** in the `users.pin` column, not hashed. This is a real weakness worth addressing before this system holds anything more sensitive than shop-floor tool access — see [Future Improvements](#future-improvements).

## Future Improvements

Roughly in priority order:

1. **Automated backups** for the Postgres database — currently manual (`pg_dump` on demand), no schedule.
2. **PIN hashing** — plaintext PIN storage should move to a hashed scheme (bcrypt/argon2) before this is trusted with anything more sensitive.
3. **systemd services on the Pi** (both Node and Caddy) so a crash or reboot doesn't require someone to manually notice and restart things — see [Raspberry Pi Migration](#raspberry-pi-migration).
4. **Real automated tests.** Everything so far has been verified by hand (manual `curl` testing against the live database during development) — there is no test suite. Worth adding at least basic API contract tests before this grows further.
5. **Offline-first multi-site sync** — deliberately deferred. The single-shop, single-server setup doesn't need it; it becomes worth the real design cost (particularly: how to handle the same physical tool being checked out from two offline devices before they reconcile) once there's an actual second site or road-use scenario, not before.
6. **Dual-PIN sign-off for the hardware sensor endpoints** (`/api/hardware/unlock`, `/api/hardware/sensor`) — these still only require a single badge, since there's no physical hardware deployed yet. Needs the same treatment as `/api/transactions` before any real sensor/lock hardware goes live.
7. **`tools.box_id` cleanup** — a legacy column, currently unused; intentionally left alone per an earlier decision to revisit later rather than touch it opportunistically.
