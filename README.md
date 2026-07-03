# ToolTracker

ToolTracker is LTA's tool check-in / check-out tracking system. It keeps a live record of which tools exist, where they live (department → toolbox → drawer), who has them checked out, and whether they're overdue for calibration or flagged as broken/missing/worn. A single Node/Express server exposes a JSON API backed by PostgreSQL and serves a small set of static front-end pages for shop-floor and admin use.

## Entry Points (`public/`)

The server serves everything in `public/` as static files. There are four pages:

- **`index.html`** — The hub. A simple landing page with links to the other three tools.
- **`kiosk.html`** — Shop-floor scanning station. Technicians scan/enter a badge ID and scan tool barcodes (via the device camera) to check tools in or out, run toolbox audits, and report damaged/missing tools. This is meant to run on a shared PC or tablet at the point of use.
- **`admin.html`** — Admin portal for managing personnel (users, roles, PINs) and inventory infrastructure (departments, toolboxes, drawers, tools), including creating new tools/boxes and uploading photos.
- **`dashboard.html`** — Global telemetry dashboard: counts of tools in/out, flagged tools, upcoming/overdue calibrations, and recent activity, intended for a "boss's dashboard" style view (Metabase, described below, complements this with deeper ad-hoc reporting).

## Running Locally (PC / Dev)

1. **Start the database (and Metabase reporting UI):**
   ```
   docker-compose up
   ```
   This brings up a PostgreSQL container (`db`, exposed on `5432`) and a Metabase container (`metabase`, exposed on `3001`) for ad-hoc reporting against the same database.

2. **Start the API and static server:**
   ```
   node server.js
   ```
   This runs the Express app on port `3000`, serving both the `/api/*` JSON endpoints and the static pages in `public/`.

3. **Open the app:**
   Navigate to [http://localhost:3000/](http://localhost:3000/) — this loads `index.html`, the hub for the other three pages.

There is no build step and no custom npm scripts defined yet — `package.json` only has the default placeholder `test` script (`npm test` will just exit with an error).

## Tech Stack

- **Express** — HTTP API and static file serving
- **PostgreSQL** via **pg** — primary datastore (users, departments, toolboxes, drawers, tools, audit logs)
- **multer** — handles multipart photo uploads (users, tools, toolboxes, drawers)
- **sharp** — image processing for uploaded photos
- **html5-qrcode** (front-end, used in `kiosk.html` / `admin.html`) — camera-based barcode/QR scanning in the browser, no dedicated scanner hardware required
- **cors** — cross-origin support for the API

## Planned Raspberry Pi Migration

`server.js` currently writes uploaded photos to `public/uploads` and rotating hourly/daily activity logs to a `logs` folder, both resolved relative to a single constant near the top of the file:

```js
const BASE_STORAGE_PATH = __dirname; // Option A: Windows PC (Development)
// const BASE_STORAGE_PATH = '/mnt/external_drive/ToolTracker_Data'; // Option B: Raspberry Pi (Production)
```

The plan is to eventually run the server on a Raspberry Pi with an external drive for storage. When that happens, flipping `BASE_STORAGE_PATH` to the external drive path is meant to be the only change needed to move photo uploads and logs off the Pi's SD card and onto more durable external storage.

## Security Note

Database credentials are currently **hardcoded** in both `server.js` (the `pg` `Pool` config) and `docker-compose.yml` (`POSTGRES_PASSWORD` / `MB_DB_PASS`). This is fine for local development convenience but must not ship as-is. The `dotenv` package is already listed as a dependency but is not yet wired up — before any real deployment, credentials should be moved into environment variables (loaded via `dotenv`) and out of source control.
