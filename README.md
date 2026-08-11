# ToolTracker

ToolTracker is LTA's tool check-in / check-out tracking system. It keeps a live record of which tools exist, where they live (department → toolbox → drawer), who has them checked out, whether they're overdue for calibration, and whether they're out for QA calibration. A single Node/Express server exposes a JSON API backed by PostgreSQL and serves a small set of static front-end pages for shop-floor and admin use, installable as a PWA on any phone, tablet, or desktop.

## Entry Points (`public/`)

The server serves everything in `public/` as static files. There are four pages, each independently installable as its own app (see [Progressive Web App](#progressive-web-app-pwa) below):

- **`index.html`** — The hub. A simple landing page with links to the other three tools.
- **`kiosk.html`** — Shop-floor scanning station. A technician identifies themselves with a badge/username **and PIN**, then scans tool barcodes (camera or a USB barcode gun) to check tools in or out, run toolbox audits, report a damaged/missing tool, or send a tool to QA for calibration. Every checkout and check-in additionally requires a second person — any other active account, any role — to sign off with their own PIN (a "buddy check"). Meant to run on a shared PC, tablet, or phone at the point of use.
- **`admin.html`** — Admin portal for managing personnel (users, roles, PINs), inventory infrastructure (departments, toolboxes, drawers, tools), running reports, and seeing which departments still need their mandatory audit for the current shift.
- **`dashboard.html`** — Read-only telemetry dashboard: counts of tools in/out, flagged tools, upcoming/overdue calibrations, and a click-through detail view for any tool. Each department/toolbox drill-down mirrors the global view's layout, scoped to that location.

## Feature Overview

Beyond basic check-in/check-out, the app enforces a few real operational controls:

- **Dual-PIN sign-off (buddy check)**: every checkout and check-in requires the technician's own PIN plus a second, different active person's PIN — any role, not just supervisors. There is no "solo" checkout path.
- **Mandatory shift audits**: each department must log a toolbox audit at least once per shift window (morning 04:00–14:00, afternoon 14:00–04:00 overnight) before anyone can check tools **out** of that department that shift. Check-ins are never blocked. A live audit-status widget shows the current window and each department's status on both the dashboard and the kiosk idle screen. See `getAuditWindowStart()` in `server.js`.
- **QA calibration transfers**: reporting a tool as "Needs Calibration" starts a two-leg, two-party chain of custody — the tool moves to a QA department, QA explicitly accepts it, calibrates it, and sends it back; the home department explicitly accepts the return. Tracked in the `tool_transfers` table.
- **Reserved IDs on damaged/missing tools**: reporting a tool Broken/Missing/Worn flags it and reserves its barcode ID until an admin creates an explicit replacement. Reportable whether the tool is currently checked in *or* checked out — reporting one that's `Out` implicitly ends that checkout, since there's no correct way to represent a tool that broke or went missing while someone had it as anything other than no longer in their possession.
- **Role management**: a `dept_admin`+ user can promote or demote any subordinate's role up to and including their own level (never higher), from the same click-to-open detail card used everywhere else in the admin portal — see [Security Notes](#security-notes) for the underlying hierarchy rule.
- **Cross-department access grants**: a `super_admin` can give a specific `dept_admin` full manager access to departments beyond their own home one (for someone who oversees more than one department in practice), from a checkbox list in that user's detail card. A granted department is treated identically to the dept_admin's home department everywhere department-scoped access is checked (creating users, generating reports) — see `user_department_access` in `migrations/005_department_access_grants.sql` and `accessibleDeptIds` in `server.js`.
- **CSV backup / import / export**: full inventory and toolbox-structure export to CSV from the admin portal, plus a bulk import path (Barcode ID is the match key — an existing tool is updated, a new one is created) for round-tripping through a spreadsheet.
- **Account security**: PINs are bcrypt-hashed, brute-force attempts are throttled both by IP and by individual badge, and every admin action is re-checked against the database's current role on every request — see [Security Notes](#security-notes).
- **Real HTTPS everywhere**: camera access requires a secure context on every device except `localhost`. See [HTTPS & Remote Access](#https--remote-access-caddy--duckdns) below for how this is solved without per-device certificate installs.
- **Progressive Web App**: installable home-screen icons for Kiosk/Admin/Dashboard separately, with app-shell caching for resilience against brief network hiccups (not full offline data sync — see [Future Improvements](#future-improvements)).
- **Automatic per-tool barcode label**: creating a tool (single-tool ingest form or CSV import) automatically generates a Data Matrix label PNG for it, stored as `tools.barcode_image_url` -- a separate file/field from `photo_url` (the tool's actual picture) -- and viewable/selectable from its card in the admin panel.
- **Data Matrix label generation for print/engraving**: `scripts/generate-tool-labels.js` and `scripts/generate-size-test-sheet.js` produce print- and laser-engraving-ready barcode labels straight from the live tool list, at an exact confirmed-scannable physical size. See [Generating Tool Labels](#generating-tool-labels) below.

## Running Locally (PC / Dev)

The **Raspberry Pi is the only real deployment** — see [Raspberry Pi Migration](#raspberry-pi-migration) below. Running locally on a PC is for writing and testing code changes *before* deploying them (via `npm run deploy`, see [Deploying changes to the Pi](#deploying-changes-to-the-pi)); it's never meant to serve real traffic to real devices, so there's no HTTPS/Caddy/domain step here at all — plain `http://localhost:3000` is enough, since browsers already treat literal `localhost` as a secure context (camera access works fine for local testing without any certificate).

1. **Configure environment variables:**
   ```
   cp .env.example .env
   ```
   Then fill in `.env`: generate a `SESSION_SECRET` with the command in `.env.example`'s comment, and set `DB_PASSWORD` (any value for a fresh database — see the next step). Leave `NODE_ENV` and `BASE_STORAGE_PATH` unset for local dev. `.env` is git-ignored; never commit real values, and never reuse the Pi's values here.

2. **Start the database:**
   ```
   docker-compose up
   ```
   This brings up a PostgreSQL container (`db`, exposed on `5432`) using the `DB_PASSWORD` from `.env`. (Metabase used to run alongside it here but was removed — it was sharing this same database for its own internal metadata, which filled it with 150+ unrelated tables, and nobody was using it.)

3. **First time only — create the schema:**
   ```
   docker exec -i tooltracker_server-db-1 psql -U tooladmin -d tooltracker < migrations/000_initial_schema.sql
   docker exec -i tooltracker_server-db-1 psql -U tooladmin -d tooltracker < migrations/001_beta_feedback.sql
   docker exec -i tooltracker_server-db-1 psql -U tooladmin -d tooltracker < migrations/002_pin_hashing.sql
   node scripts/backfill-pin-hashes.js
   docker exec -i tooltracker_server-db-1 psql -U tooladmin -d tooltracker < migrations/003_scoped_unique_identifiers.sql
   ```
   `000` is the full base schema (all 6 core tables). `001` adds `tool_transfers` and `tools.serial_number`. `002` adds the `pin_hash`/lockout columns and a `role` CHECK constraint — the backfill script must run immediately after it and before starting a `server.js` that reads `pin_hash` (see [Security Notes](#security-notes)). `003` scopes `badge_id`/`username`/`email` uniqueness to active users only, so deactivating someone frees their identifiers for reuse without needing a hard delete. All four SQL files are safe to re-run (`IF NOT EXISTS`/`DROP ... IF EXISTS` throughout); the backfill script is also safe to re-run (it only touches rows where `pin_hash` is still `NULL`).

4. **Start the API and static server:**
   ```
   node server.js
   ```
   This runs the Express app on port `3000`. Exits immediately with a clear error if `SESSION_SECRET` or `DB_PASSWORD` isn't set.

5. **Open the app:** `http://localhost:3000/`.

## HTTPS & Remote Access (Caddy + DuckDNS)

This entire section describes infrastructure that lives **only on the Pi**, set up once during [Raspberry Pi Migration](#raspberry-pi-migration). It's documented here as reference for how it works and how to redo it (new Pi, lost `Caddyfile`, etc.) — it is not a step to run on a dev PC.

Browsers only allow camera access (`getUserMedia`) on HTTPS, or the special-cased `localhost`. A self-signed certificate doesn't solve this cleanly — every single device (every phone, every tablet) would need that certificate manually installed and trusted, which doesn't scale past one or two test devices, and iOS Safari in particular won't grant camera access off a self-signed cert even after you click through the warning.

The actual fix: a **real, publicly-trusted certificate** (free, via Let's Encrypt) for a DNS name that happens to point at the Pi's **local** IP address. This works because:
- DNS resolution happens over the public internet, but the actual connection stays entirely on the local network — nothing needs to be reachable from outside. There is no port-forwarding and no public exposure anywhere in this setup.
- Let's Encrypt can verify domain ownership via a DNS TXT record (the "DNS-01 challenge"), which doesn't require the server to be internet-facing at all.
- Once issued, the certificate is trusted by every browser/OS on the planet automatically — zero per-device setup, ever.

### One-time setup (already done — this is how it was set up, for reference)

1. Create a free subdomain at [duckdns.org](https://www.duckdns.org) (sign in with GitHub/Google/etc — no new password). Note the domain name and the account token shown at the top of the page.
2. Point that DuckDNS domain's IP field at the Pi's **local LAN IP** (not its public IP — DuckDNS will auto-fill your public IP by default, which is wrong for this purpose. Get the real local IP via `hostname -I` on the Pi).
3. Use the pre-built `caddy-for-raspberry-pi/caddy-linux-arm64` binary (already has the DuckDNS plugin built in — no download needed; only re-fetch it if this ARM64 binary is ever lost, via `curl -sL -o caddy "https://caddyserver.com/api/download?os=linux&arch=arm64&p=github.com/caddy-dns/duckdns"`).
4. Copy `Caddyfile.example` to `Caddyfile` and fill in your actual DuckDNS domain and token (this file is gitignored — it holds a secret, never commit it):
   ```
   your-subdomain.duckdns.org {
       tls {
           dns duckdns YOUR_DUCKDNS_TOKEN_HERE
       }
       reverse_proxy localhost:3000
   }
   ```
5. The Caddy binary needs permission to bind to ports 80/443 without running as root: `sudo setcap cap_net_bind_service=+ep caddy-for-raspberry-pi/caddy-linux-arm64` (one-time; this is a Linux capability grant, not something Windows needs).
6. Run it (or, in production, let `tooltracker-caddy.service` run it — see [Raspberry Pi Migration](#raspberry-pi-migration)) — on first launch it automatically requests and installs the certificate (takes a few seconds) and **renews it automatically forever after**, as long as Caddy keeps running and has occasional internet access (renewal happens well before the ~90-day expiry).

### If the Pi's local IP ever changes

`tooltracker-duckdns-update.timer` (see [Disaster Recovery & Resilience](#disaster-recovery--resilience)) handles this automatically every 5 minutes now, so this is no longer something that needs noticing and fixing by hand. It exists specifically because there's no DHCP reservation for the Pi yet (pending router access) — a real reservation is still the better long-term fix (one less moving part), but the auto-updater means that's no longer urgent.

### Firewall

Raspberry Pi OS has no firewall enabled by default (no `ufw`/`firewalld`), so nothing extra is needed for LAN devices to reach ports 80/443/3000 on the Pi. If a firewall is ever enabled for hardening, allow at least 443 (HTTPS) and optionally 80 (HTTP→HTTPS redirect) — port 3000 never needs to be reachable from other devices, since Caddy reaches the Node app over `localhost` only.

## Progressive Web App (PWA)

Each of the three main pages has its own web app manifest (`manifest-kiosk.json`, `manifest-admin.json`, `manifest-dashboard.json`), so installing "from" a given page creates a home-screen icon that opens straight to that page:

- **iOS Safari**: open the page → Share button → "Add to Home Screen."
- **Android Chrome / Desktop Chrome/Edge**: open the page → browser menu → "Install app" (or an install icon in the address bar).

`sw.js` (registered on every page via `sw-register.js`) caches the app's own static files for resilience against brief network drops, but is deliberately **network-first**: it always tries the real server first so code/bug fixes show up immediately when online, only falling back to the cached copy if the network request genuinely fails. It never caches `/api/*` calls — live data always comes from the real server or fails honestly.

## Generating Tool Labels

Every tool gets a Data Matrix label PNG automatically the moment it's created (see `generateBarcodeLabel()` in `server.js`), stored at `tools.barcode_image_url` and viewable from its card in the admin panel -- generous padding around the code and its human-readable ID, since it's meant for on-screen viewing/selection, not precision engraving. Run `npm run backfill-barcode-labels` once to generate labels for any tool created before this feature existed (safe to re-run; it only touches tools missing one).

For **physical printing/engraving** specifically, two separate, free, offline scripts (using `bwip-js`, no external service) generate Data Matrix barcodes straight from the live `tools` table at an exact, confirmed-scannable physical size (deliberately zero padding, unlike the auto-generated on-screen label above -- padding here would either enlarge the physical label or shrink the code to compensate, neither desirable once a size is confirmed scannable), so printed/engraved codes can never drift out of sync with the database:

```
npm run generate-labels [target-size-mm]     # one PNG + one SVG per tool, in tool_labels/
npm run generate-size-test [qr_code]         # one real tool's code at several candidate sizes, for physical scan-testing
```

- **PNG** files are sized for printing on adhesive labels (300+ DPI, with correct embedded physical-size metadata so "print at 100%" is accurate).
- **SVG** files are vector, meant for importing into laser engraving software (LightBurn, etc.) at an exact real-world millimeter size.
- **Before engraving/printing a full batch**, run `generate-size-test` and physically scan each candidate size with the actual kiosk/admin camera under real shop lighting — the achievable minimum size depends heavily on print/engrave contrast and the camera's minimum focus distance, not just math. See the generated `tool_labels/size_test/README.txt` for the test procedure.

## Raspberry Pi Migration

### Initial Pi setup (blank SD card → reachable over SSH)

Skip this part if the Pi already has an OS on it and you can SSH in.

1. On the Windows PC, download **Raspberry Pi Imager** from [raspberrypi.com/software](https://www.raspberrypi.com/software/) and install it.
2. Insert the SD card into the PC (a USB adapter works fine), open Imager:
   - **Device**: pick the specific Pi model (e.g. Raspberry Pi 4).
   - **Operating System**: `Raspberry Pi OS (other)` → `Raspberry Pi OS Lite (64-bit)`. Must be **64-bit** — the pre-staged `caddy-linux-arm64` binary and Docker's ARM64 images both require it. Lite (no desktop) is the right choice for a headless appliance.
   - **Storage**: select the SD card. Double-check this — Imager will erase whatever's selected.
3. Click **Next**, then **Edit Settings** when prompted (this is the important part — it lets the Pi boot already configured, with no monitor/keyboard ever needed):
   - **General tab**: set a hostname (e.g. `tooltracker`), a username + password (recent Raspberry Pi OS no longer ships a default `pi`/`raspberry` login — you're creating the real account here), and Wi-Fi SSID/password if not using Ethernet (Ethernet is more reliable for something meant to stay put and run unattended).
   - **Services tab**: enable SSH, "Use password authentication."
   - Save, then **Write** (takes a few minutes; it'll verify the write afterward).
4. Move the card to the Pi, connect Ethernet (or rely on the Wi-Fi config above) and power, and wait about a minute for first boot.
5. From the Windows PC: `ssh <username>@<hostname>.local` (e.g. `ssh jwhite@tooltracker.local` — this relies on mDNS, which Raspberry Pi OS supports out of the box). If that name doesn't resolve, find the Pi's IP from the router's DHCP client list instead and `ssh <username>@<ip>`.
6. Once in: `sudo apt update && sudo apt full-upgrade -y`, then reboot (`sudo reboot`) if the kernel was updated.
7. Install Node.js and Docker, both of which ship ARM64 builds:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt install -y nodejs git
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   ```
   Log out and back in (or `newgrp docker`) for the `docker` group membership to take effect. Confirm both installed correctly: `node -v` and `docker compose version`.
8. Give the Pi a **static/reserved IP** via a DHCP reservation on the router now, before going further — the DuckDNS setup later assumes this IP never changes.

   > **Note**: a fresh Docker install provides `docker compose` (a subcommand, no hyphen) rather than the older standalone `docker-compose` binary this README otherwise uses interchangeably with it. Both do the same thing; use whichever is actually installed (`docker compose version` vs `docker-compose --version` to check).

`server.js` writes uploaded photos to `public/uploads` and activity logs to `logs/`, both resolved relative to `BASE_STORAGE_PATH` (read from `.env`, see `.env.example`) — defaults to this project's own directory if unset, which is correct for local PC dev. This is a `.env` setting rather than a line of code specifically so `server.js` stays byte-identical on every deployment: a `git pull` on the Pi should never conflict with an environment-specific code edit.

### Mounting the external drive at a stable path

Mount the USB drive by its filesystem **UUID** in `/etc/fstab`, at a fixed path (this is what `BASE_STORAGE_PATH` in `.env` will point at), rather than relying on whatever auto-mount path the OS happens to assign (which can change between drives, or even between boots):

```bash
lsblk -f                       # find the drive's UUID (e.g. /dev/sda1)
sudo mkdir -p /mnt/external_drive/ToolTracker_Data
sudo blkid /dev/sda1           # copy the UUID= value
```

Add a line like this to `/etc/fstab` (as root, e.g. `sudo nano /etc/fstab`):
```
UUID=xxxx-xxxx-xxxx-xxxx  /mnt/external_drive/ToolTracker_Data  ext4  defaults,nofail  0  2
```
`nofail` matters — without it, a missing drive at boot (loose cable, drive swapped out) can hang the whole boot process instead of just failing to mount. Then `sudo mount -a` to mount it immediately without rebooting, and `df -h` to confirm it's there.

The payoff: since `BASE_STORAGE_PATH` points at this fixed path rather than a device-specific one, swapping to a new or larger drive later never requires touching the app's code or config. To migrate to a new drive:
1. Format the new drive and get its UUID (same commands as above).
2. With the app stopped (`sudo systemctl stop tooltracker`, so nothing writes mid-copy), mount the new drive at a temporary path and copy everything over: `sudo rsync -avh /mnt/external_drive/ToolTracker_Data/ /mnt/new_drive_temp/`.
3. Verify the copy (`diff -rq` between old and new, or at minimum compare `du -sh` on both).
4. Update the UUID in `/etc/fstab` to the new drive, unmount both, then `sudo mount -a` to bring the new one up at the real path.
5. `sudo systemctl start tooltracker`. The 16GB (or whatever size) old drive is now free to reuse or retire.

Steps to move to the Pi:

1. Get the code onto the Pi via a **read-only GitHub deploy key** scoped to just this repo, rather than copying files by hand or reusing a personal key with broader access:
   - On the Pi: `ssh-keygen -t ed25519 -f ~/.ssh/tooltracker_deploy_key -N ''`
   - Add the resulting `~/.ssh/tooltracker_deploy_key.pub` at `github.com/<owner>/<repo>/settings/keys` → **Add deploy key** (leave "Allow write access" unchecked — the Pi only ever needs to pull)
   - On the Pi, point SSH at that key for GitHub specifically (append to `~/.ssh/config`):
     ```
     Host github.com
         IdentityFile ~/.ssh/tooltracker_deploy_key
         IdentitiesOnly yes
     ```
   - `git clone git@github.com:<owner>/<repo>.git`
   - This also sets up the ongoing workflow: commit and `git push` from the PC like normal, then `git pull` on the Pi to update it — no manual file copying, ever again. See the deploy script further down for turning that into one command.
2. Run `npm install` on the Pi (installs the same dependencies fresh for its architecture — every dependency in `package.json` is pure JS or ships prebuilt ARM64 binaries, no native build step needed).
3. Create `.env` on the Pi (`cp .env.example .env`, then fill it in) — this is a **separate** file from the dev machine's, with its **own** freshly generated `SESSION_SECRET` (never reuse the dev one). Set `DB_PASSWORD` to match whatever you set up for the Pi's own Postgres container, set `NODE_ENV=production` this time (unlike local dev) so the session cookie requires HTTPS, and set `BASE_STORAGE_PATH` to wherever the external drive is mounted (see above).
4. Run all four migration files (plus the PIN-hash backfill) against the Pi's own Postgres instance — a fresh database, so this is the "first time only" path in [Running Locally](#running-locally-pc--dev) step 3, not a repeat of anything from the dev machine.
5. Use the pre-built `caddy-for-raspberry-pi/caddy-linux-arm64` binary (already has the DuckDNS plugin built in — no need to re-download), and grant it permission to bind ports 80/443 without running as root: `sudo setcap cap_net_bind_service=+ep caddy-for-raspberry-pi/caddy-linux-arm64` (a Linux-only step; Windows never needed this).
6. Copy `Caddyfile` over too (it's git-ignored since it holds the DuckDNS token — copy it manually, or recreate it from `Caddyfile.example` with the same token as the current deployment so the existing DuckDNS domain keeps working).
7. Update the DuckDNS IP field to the Pi's local IP (give it a DHCP reservation so this never has to change again, once router access allows it).
8. Set up both processes to survive reboots and crashes via systemd, so a crash or reboot doesn't require someone to manually notice and restart things:

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

   Then `sudo systemctl enable --now tooltracker tooltracker-caddy`. Also give the Postgres container the same treatment (`docker-compose` already restarts `always`, but confirm Docker itself starts on boot: `sudo systemctl enable docker`). No extra systemd config is needed for `.env` — `dotenv` looks for it in the current working directory by default, and `WorkingDirectory` above already points at the project folder where it lives.

9. (Optional but recommended) Schedule log pruning (`npm run prune-logs`, see [Maintenance](#maintenance)) to run monthly instead of remembering to do it by hand, via a systemd timer:

    ```ini
    # /etc/systemd/system/tooltracker-prune-logs.service
    [Unit]
    Description=ToolTracker log retention cleanup

    [Service]
    Type=oneshot
    WorkingDirectory=/path/to/ToolTracker_Server
    ExecStart=/usr/bin/node scripts/prune-old-logs.js
    ```

    ```ini
    # /etc/systemd/system/tooltracker-prune-logs.timer
    [Unit]
    Description=Run ToolTracker log pruning monthly

    [Timer]
    OnCalendar=monthly
    Persistent=true

    [Install]
    WantedBy=timers.target
    ```

    `sudo systemctl enable --now tooltracker-prune-logs.timer`. `Persistent=true` means a run that was missed (e.g. the Pi was off when it would have fired) happens shortly after the next boot instead of silently skipping that month.

### Deploying changes to the Pi

Once the deploy key and `tooltracker.service` above are set up, day-to-day changes are one command from the PC (Git Bash):
```bash
npm run deploy
```
This pushes local commits to GitHub, then pulls them on the Pi and restarts `tooltracker.service` (see `scripts/deploy-to-pi.sh`) so the change actually takes effect. Static file changes (`public/*.html`/`*.js`/`*.css`) don't strictly need the restart — they take effect on next page load either way — but it's harmless to restart for those too. Assumes commits are already made locally and the Pi is reachable at `tooltracker.local` with your SSH key already authorized on it.

## Disaster Recovery & Resilience

Three separate, complementary protections, each against a different failure mode:

### 1. Database lives on the external drive, not the SD card

`docker-compose.yml` bind-mounts Postgres's data directory under `BASE_STORAGE_PATH` (see `.env.example`) instead of using a Docker-managed named volume, which would otherwise default to living on the SD card. SD cards fail far more often than a proper external drive, and losing one used to mean losing every tool/user/audit record — even though photos and logs already lived safely on the external drive. This is already set up; nothing to redo unless migrating to new storage. To do that migration again by hand (e.g. a new Pi, or a bigger drive):

1. `docker exec tooltracker_server-db-1 pg_dump -U tooladmin -d tooltracker -F c -f /tmp/backup.dump`, then `docker cp` it out somewhere safe (twice — see [Maintenance](#maintenance) for the exact commands).
2. `sudo systemctl stop tooltracker` (stop writes), then `docker compose down` (stops the container, does **not** delete the old volume/data).
3. Create the new target directory and `sudo chown -R 999:999` it (`999` is the `postgres` user *inside* the official `postgres:15` image — confirm with `docker run --rm postgres:15 id postgres` if that ever changes), then `sudo chmod 700` it.
4. Update `BASE_STORAGE_PATH` in `.env` if the target changed, then `docker compose up -d` — this initializes a fresh, empty database at the new location.
5. Restore: `docker exec -i tooltracker_server-db-1 pg_restore -U tooladmin -d tooltracker --no-owner < backup.dump` (the "already exists" errors it prints if the schema init raced ahead of you are harmless noise, not a failure — verify with a real query afterward, e.g. `SELECT * FROM users`, rather than trusting the absence of errors).
6. `sudo systemctl start tooltracker`, verify the app works, *then* remove the old volume (`docker volume ls`, `docker volume rm <name>`) once you're confident.

### 2. Automated off-Pi backups (Google Drive via rclone)

Protects against a different failure than #1: losing the *entire* Pi (stolen, destroyed, both drives fail at once), not just the SD card specifically. `scripts/backup-to-drive.sh` dumps the database and uploads it to Google Drive via `rclone`, keeping the most recent 30 backups and pruning older ones. Runs automatically once a day via `tooltracker-backup.timer`. One-time setup (already done for this deployment):

1. Install rclone: `curl https://rclone.org/install.sh | sudo bash`.
2. `rclone config` → `n` (new remote) → name it `gdrive` → type `drive` → leave `client_id`/`client_secret` blank (see the client-id note below) → scope `3` (`drive.file` — rclone can only see/manage files *it* creates, not your other Drive contents) → leave `service_account_file` blank → no advanced config → confirm continuing with the shared client_id → **no** to "use web browser" (the Pi has none) → it prints a `rclone authorize "drive" "<token>"` command.
3. Run that exact command on any machine that *does* have a browser (rclone needs to be installed there too, even temporarily) — it opens a Google sign-in/consent page, then prints a config token back.
4. Paste that token into the Pi's still-open `config_token>` prompt → `n` (not a Shared/Team Drive) → confirm the remote.
5. Verify: `rclone lsd gdrive:` should succeed with no error (an empty result is expected — nothing's been uploaded yet).
6. Create the service + timer:
   ```ini
   # /etc/systemd/system/tooltracker-backup.service
   [Unit]
   Description=ToolTracker off-Pi database backup

   [Service]
   Type=oneshot
   User=tooltracker
   WorkingDirectory=/home/tooltracker/ToolTracker_Server
   ExecStart=/bin/bash scripts/backup-to-drive.sh
   ```
   ```ini
   # /etc/systemd/system/tooltracker-backup.timer
   [Unit]
   Description=Run ToolTracker database backup daily

   [Timer]
   OnCalendar=daily
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```
   `sudo systemctl enable --now tooltracker-backup.timer`.

**The shared client_id warning**: rclone prints a notice that its shared Google Drive `client_id` "is being retired and will stop working during 2026." This was accepted for now to get backups working immediately without a separate Google Cloud project — but it means backups could silently start failing at some point this year. Creating your own `client_id` (a Google Cloud Console project + OAuth credentials, no Workspace admin needed) removes this risk entirely; see [rclone's guide](https://rclone.org/drive/#making-your-own-client-id). Worth revisiting before year-end regardless of whether it's failed yet.

**A different, non-technical risk worth knowing about**: this remote is authorized against one person's Google account (`jwhite@ltaresearch.com`), not a company-owned service account. If that account's access to this app ever changes (leaves the company, revokes the grant, loses 2FA access, etc.), backups stop working silently until someone notices and re-authorizes with a different account. A Google Cloud **service account** (a machine identity with its own key file, owned by the organization rather than a person) would remove this single-point-of-failure, but needs a Google Cloud project, which is a separate ask from Workspace access and may need IT involvement. Worth it eventually; not blocking for now.

To restore from one of these backups: download it from the `ToolTracker_Backups` folder in Drive (`rclone copy gdrive:ToolTracker_Backups/<file> .`), then follow step 5 of the migration procedure above.

### 3. DuckDNS stays in sync with the Pi's local IP automatically

Covered in [If the Pi's local IP ever changes](#if-the-pis-local-ip-ever-changes) above — `scripts/update-duckdns-ip.sh` runs every 5 minutes via `tooltracker-duckdns-update.timer`, so a DHCP lease change (no router-level reservation yet) gets corrected automatically instead of silently breaking access for everyone until it's noticed. Setup, if redoing this on a new Pi:

1. Add `DUCKDNS_DOMAIN` (just the subdomain, e.g. `lta-tooltracker`, not the full `.duckdns.org`) and `DUCKDNS_TOKEN` (same value already in the git-ignored `Caddyfile`) to `.env`.
2. Create the service + timer:
   ```ini
   # /etc/systemd/system/tooltracker-duckdns-update.service
   [Unit]
   Description=ToolTracker DuckDNS IP updater

   [Service]
   Type=oneshot
   User=tooltracker
   WorkingDirectory=/home/tooltracker/ToolTracker_Server
   ExecStart=/bin/bash scripts/update-duckdns-ip.sh
   ```
   ```ini
   # /etc/systemd/system/tooltracker-duckdns-update.timer
   [Unit]
   Description=Run ToolTracker DuckDNS IP updater every 5 minutes

   [Timer]
   OnBootSec=1min
   OnUnitActiveSec=5min

   [Install]
   WantedBy=timers.target
   ```
   `sudo systemctl enable --now tooltracker-duckdns-update.timer`.

This doesn't cover a genuine internet outage (DNS resolution for a public domain still needs internet the *first* time a device looks it up, even though the actual app traffic is 100% local afterward — see [Feature Overview](#feature-overview)) — only the "Pi's local IP silently changed" failure mode. A real DHCP reservation is still the cleaner permanent fix once router access allows it; this just means that's no longer urgent.

## Maintenance

- **Deploying a code change**: on the Pi (the only real deployment), just `npm run deploy` from the PC — see [Deploying changes to the Pi](#deploying-changes-to-the-pi). It restarts `tooltracker.service` for you, which is the systemd-managed way this now always happens; there's no manual process-killing involved on the Pi.
- **Restarting during local PC dev**: static files (`public/*.html`, `*.js`, `*.css`) take effect on the next page load with no restart needed. Changes to `server.js` require killing and restarting the local `node server.js` process. **Before starting a new one, always check nothing is already listening on port 3000** — a stray process from a previous session silently serving old code was a repeated source of confusing bugs during development:
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server.js*" } | Select-Object ProcessId, CommandLine
  ```
  Kill any match with `Stop-Process -Id <id> -Force` before starting a fresh one.
- **Database backups**: automatic and off-Pi now — `tooltracker-backup.timer` runs `scripts/backup-to-drive.sh` daily, uploading to Google Drive and keeping the most recent 30 (see [Disaster Recovery & Resilience](#disaster-recovery--resilience)). Before any risky schema change or bulk edit specifically, still take a fresh manual one first rather than relying on last night's: `docker exec tooltracker_server-db-1 pg_dump -U tooladmin -d tooltracker -F c -f /tmp/backup.dump`, then copy it out with `docker cp`.
- **Certificate renewal**: fully automatic, no action needed — `tooltracker-caddy.service` just needs to keep running, which systemd (`Restart=always`) already guarantees.
- **Logs**: `logs/hourly/<DEPT>/` and `logs/daily/<DEPT>/` grow daily and are gitignored (not committed) — but the actual bytes involved are small even over years (terse text lines, not binary data), so this is about intentional retention policy more than real disk pressure. `npm run prune-logs` deletes anything older than the retention window set at the top of `scripts/prune-old-logs.js` (2 years by default); pass `--dry-run` to preview what it would delete without touching anything. Runs automatically on the Pi via `tooltracker-prune-logs.timer` (monthly).
- **Photo storage**: uploaded photos (`public/uploads/`) are automatically resized (max 1600px) and re-compressed to JPEG on upload, and the previous file is deleted whenever a photo is replaced or its entity is deleted (see `deletePhotoFile()` in `server.js`) — so growth tracks the number of *distinct* photos actually taken, not every re-upload or replacement.
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
- **bcrypt** — PIN hashing
- **express-session** + **connect-pg-simple** — Postgres-backed admin session cookies (survive a server restart; no separate session store to run)
- **express-rate-limit** — IP-based brute-force throttling on every PIN-checking endpoint
- **helmet** — HTTP security headers, including a locked-down Content-Security-Policy
- **multer** — handles multipart photo uploads
- **sharp** — image processing for uploaded photos; also used to rasterize PWA icons
- **bwip-js** — Data Matrix barcode generation for tool labels
- **csv-parse** / **csv-stringify** — bulk inventory CSV import/export
- **html5-qrcode** (front-end) — camera-based barcode scanning in the browser
- **Caddy** — reverse proxy providing automatic, real HTTPS via Let's Encrypt (DNS-01 challenge against DuckDNS)
- **cors** — cross-origin support for the API

## Security Notes

- **Credentials**: database credentials live in `.env` (see `.env.example`), read via environment variables by both `server.js` and `docker-compose.yml` — nothing is hardcoded in source control. `SESSION_SECRET` and `DB_PASSWORD` are fatal-if-missing on startup rather than silently falling back to an insecure default.
- **PINs are bcrypt-hashed** (`users.pin_hash`), checked via `bcrypt.compare()` everywhere a PIN is verified. The original plaintext `pin` column still exists in the schema (see `migrations/002_pin_hashing.sql`) but is no longer read or written by any code path — it's kept temporarily for a burn-in period before a future migration drops it, not because it's still in use (see [Future Improvements](#future-improvements)).
- **Brute-force lockout**: an IP-based rate limiter (`authLimiter`) throttles every PIN-checking endpoint, plus a per-badge, DB-backed lockout (`failed_pin_attempts`/`locked_until`) that locks an individual account after repeated bad PINs regardless of source IP.
- **Admin authorization**: every admin-only route is gated by `requireRole(minWeight)` middleware that re-checks the requester's role against the database on every single request (never trusting the session's cached snapshot) — a deactivated or demoted admin loses access immediately, not just once their session naturally expires. Role changes themselves (see [Feature Overview](#feature-overview)) are capped at the acting admin's own weight — a `dept_admin` can never create or promote someone to `super_admin`. A `X-Requested-With` header is required on every mutating admin request as lightweight CSRF defense. The kiosk stays deliberately sessionless — its security model is "prove it's you, right now" per transaction via badge+PIN, which persistent login would defeat.
- **Cross-department access is grant-only, not peer-to-peer**: `requireRole` attaches `accessibleDeptIds` (a dept_admin's home department plus any explicitly granted ones) to every request. Only a `super_admin` can call `PUT /api/users/:badge_id/department-access` (also `requireRole(4)`) — a `dept_admin` can never grant another `dept_admin` extra departments, which would otherwise let peers hand each other access and bypass the hierarchy rule above.
- **HTTP hardening**: `helmet` with a locked-down Content-Security-Policy, plus explicit CORS configuration.
- There is no email delivery in this system by design — new-user and PIN-reset credentials are always shown directly to the admin in a handout modal, to be relayed to the person in person.

## Future Improvements

Roughly in priority order:

1. **rclone's own client_id** — currently using rclone's shared Google Drive client_id, which is being retired sometime in 2026 and could break the automated backup silently when it does. Create a dedicated one (a Google Cloud Console project, no Workspace admin needed) — see [Disaster Recovery & Resilience](#disaster-recovery--resilience).
2. **A company-owned backup identity** — the Drive backup is currently authorized against one person's Google account rather than a service account; see the same section for why that's a single-point-of-failure worth removing eventually.
3. **Drop the legacy plaintext `users.pin` column** once `pin_hash` has run in production through a full burn-in period — see [Security Notes](#security-notes).
4. **DHCP reservation for the Pi** — pending until router access is granted. No longer urgent now that `tooltracker-duckdns-update.timer` corrects a changed IP automatically (see [Disaster Recovery & Resilience](#disaster-recovery--resilience)), but still the cleaner permanent fix.
5. **Real automated tests.** Everything so far has been verified by hand (manual `curl` testing against the live database during development) — there is no test suite. Worth adding at least basic API contract tests before this grows further.
6. **Offline-first multi-site sync** — deliberately deferred. The single-shop, single-server setup doesn't need it; it becomes worth the real design cost (particularly: how to handle the same physical tool being checked out from two offline devices before they reconcile) once there's an actual second site or road-use scenario, not before.
7. **Dual-PIN sign-off for the hardware sensor endpoints** (`/api/hardware/unlock`, `/api/hardware/sensor`) — these still only require a single badge, since there's no physical hardware deployed yet. Needs the same treatment as `/api/transactions` before any real sensor/lock hardware goes live.
8. **`tools.box_id` cleanup** — a legacy column, currently unused; intentionally left alone per an earlier decision to revisit later rather than touch it opportunistically.
