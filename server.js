// quiet: true suppresses dotenv's startup console message, which as of v17 rotates in
// promotional "tips" for the maintainer's other products -- unrelated noise in server logs.
require('dotenv').config({ quiet: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { Pool, types } = require('pg');

// Every "timestamp" column in this schema is `timestamp without time zone`, and every row is
// written while the DB session's timezone is UTC (see docker-compose.yml -- the stock
// postgres:15 image defaults to Etc/UTC) -- so the wall-clock digits stored ARE UTC. But
// node-postgres's default parser for that type (OID 1114) builds the returned JS Date using
// the *Node process's own local timezone*, not UTC, silently shifting every timestamp this
// app ever reads back by the server's local UTC offset (discovered via the audit-compliance
// endpoint reporting 0 audits for a window real audits fell well inside). Overriding the
// parser to treat the digits as UTC fixes every timestamp read app-wide (audit_logs,
// tool_incidents, calibration_records, etc.) without touching a single stored value or
// requiring a schema migration to `timestamptz`.
types.setTypeParser(1114, (val) => new Date(val + 'Z'));
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const bcrypt = require('bcrypt');
const { parse: parseCsv } = require('csv-parse/sync');
const { stringify: stringifyCsv } = require('csv-stringify/sync');
const { generatePngAtSize, generateLinearBarcodePng, addNameRow } = require('./scripts/lib/datamatrix');
const { buildZip } = require('./scripts/lib/zip');

const app = express();

// Trust exactly one hop of reverse proxy (Caddy sits directly in front of this app in every
// real deployment -- see the Caddyfile). Without this, Express has no way to know the
// request in front of Caddy was actually HTTPS (breaking the session cookie's `secure` flag
// in production -- the cookie silently never gets set, which is why login appeared to
// succeed but every subsequent request came back "Not logged in"), and express-rate-limit
// refuses to trust the client IP in X-Forwarded-For, throwing on every request instead of
// rate-limiting correctly. `1` (not `true`) means only the immediate hop is trusted, so a
// client can't spoof its own IP by prepending a fake X-Forwarded-For entry.
app.set('trust proxy', 1);

// ==========================================
// MIDDLEWARE
// ==========================================
// Every real request from this app's own frontend is same-origin (relative /api/... fetches
// from whatever host served the page) -- CORS doesn't even apply to those. This allowlist is
// defense-in-depth against a hypothetical future separate frontend, not a fix for an active
// same-origin problem. credentials:true is required now that session cookies exist -- a
// wildcard origin can't be combined with credentialed requests, browsers will refuse it.
const ALLOWED_ORIGINS = [
    'https://lta-tooltracker.duckdns.org',
    'http://localhost:3000',
];
app.use(cors({
    origin: (origin, callback) => {
        // No Origin header at all (same-origin requests, curl, server-to-server) -- always allowed.
        // A disallowed origin resolves to callback(null, false), NOT an Error -- CORS is
        // enforced by the requesting browser refusing to read a response with no matching
        // Access-Control-Allow-Origin header, not by the server refusing to respond at all
        // (non-browser clients like curl aren't CORS-bound regardless). Passing an Error
        // here instead would fall through to Express's default error handler and leak a
        // full stack trace (including filesystem paths) in the response body.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(null, false);
    },
    credentials: true,
}));

// helmet's defaults are used as-is except for the CSP's script-src (and script-src-attr,
// see below), which is deliberately relaxed to allow 'unsafe-inline', since
// admin.html/kiosk.html use inline onclick= handlers throughout (33 and 23 respectively)
// that a strict default CSP would silently break with no visible error besides a browser
// console warning. Refactoring every inline handler to addEventListener so a fully strict
// CSP is possible is a legitimate future improvement, but it's a large, separable,
// non-security-driven refactor -- not this pass. The rest of helmet's defaults still apply,
// including X-Frame-Options (real clickjacking protection for the admin panel) and
// X-Content-Type-Options.
//
// html5-qrcode (the camera-scanning library both pages use) used to be loaded from
// unpkg.com at runtime, which needed an explicit CSP allowance here -- and meant scanning
// broke with a confusing "Html5Qrcode is not defined" error on any device with no internet
// access or an unreachable CDN, silently defeating this app's whole offline-resilient
// design (DuckDNS fallback, service-worker asset caching, etc). It's now vendored locally
// as public/html5-qrcode.min.js (see 'script-src': ["'self'", ...] below -- no external
// host needed at all) the same way the icon set was vendored instead of pulled from a CDN.
//
// IMPORTANT: script-src-attr is a SEPARATE directive from script-src that specifically
// governs inline event-handler attributes (onclick=, onchange=, etc.) -- CSP Level 3 does
// not fall back to script-src for it. Helmet's own defaults set script-src-attr to 'none'
// unconditionally, which silently blocked every onclick= in the app (i.e. every button in
// admin.html and kiosk.html) even with 'unsafe-inline' already added to script-src above.
// This one shipped broken once already for exactly that reason -- do not drop this override.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'script-src': ["'self'", "'unsafe-inline'"],
            'script-src-attr': ["'self'", "'unsafe-inline'"],
        },
    },
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// STORAGE PATH CONFIGURATION (PC vs RPI)
// ==========================================
// Read from .env (see .env.example) rather than a manual comment-toggle in this file --
// server.js is meant to be the exact same file on every deployment (git pull on the Pi
// should never conflict with a local edit here), so the one thing that actually differs
// per machine -- where uploaded photos and logs live -- belongs in each machine's own
// git-ignored .env, the same way DB_PASSWORD/SESSION_SECRET/NODE_ENV already do. Defaults to
// this file's own directory (correct for local PC dev) if unset.
const BASE_STORAGE_PATH = process.env.BASE_STORAGE_PATH || __dirname;

const UPLOAD_DIR = path.join(BASE_STORAGE_PATH, 'public', 'uploads');
const LOG_DIR = path.join(BASE_STORAGE_PATH, 'logs');

// Serve uploaded photos dynamically
app.use('/uploads', express.static(UPLOAD_DIR));

// ==========================================
// DATABASE CONFIGURATION
// ==========================================
// Credentials come from environment variables (.env, see .env.example) rather than being
// hardcoded in source control -- docker-compose.yml reads the same DB_PASSWORD value via
// its own .env lookup, so both sides always agree. Only the password is fatal-if-missing;
// user/host/database/port aren't secrets and default to the values docker-compose.yml
// itself uses, so a bare .env with just DB_PASSWORD set is enough to run locally.
if (!process.env.DB_PASSWORD) {
    console.error('FATAL: DB_PASSWORD is not set. Copy .env.example to .env and set it to match docker-compose.yml.');
    process.exit(1);
}
const pool = new Pool({
    user: process.env.DB_USER || 'tooladmin',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'tooltracker',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

// ==========================================
// ADMIN SESSIONS
// ==========================================
// Postgres-backed sessions for the admin panel only -- the kiosk stays sessionless by
// design (its security model is "prove it's you, right now" per transaction via badge+PIN,
// which persistent login would defeat). connect-pg-simple stores sessions in this same
// database (createTableIfMissing auto-creates a "session" table) rather than in-memory, so
// logins survive a server restart and there's no separate store to stand up.
if (!process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET is not set. Copy .env.example to .env and generate a real secret.');
    process.exit(1);
}
app.use(session({
    store: new pgSession({ pool, createTableIfMissing: true, tableName: 'session' }),
    secret: process.env.SESSION_SECRET,
    name: 'tt.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true, // sliding expiry -- each request while active extends the session
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Caddy terminates real TLS in front of this app
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000, // 8 hours -- one work shift
    },
}));

// IP-based brute-force throttle for every PIN-checking endpoint. Deliberately generous
// (the kiosk is a single shared walk-up device -- many legitimate people share one IP all
// day) since the precise, per-badge defense is the DB-backed lockout below; this just
// catches raw volume regardless of which badge is being targeted. In-memory store is fine
// here (unlike sessions) -- losing counters on a restart just means a few more free
// attempts, not a loss of durable state.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Separate, more generous limiter for the token-gated calendar feed (see
// GET /api/calendar/calibration.ics) -- authLimiter's 20/15min is sized for human login
// attempts, not a URL that calendar apps and multiple subscribed devices poll on their own
// schedule; this still bounds a token-guessing attempt without breaking normal subscriptions.
const calendarFeedLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================
/**
 * Maps a role name to a numeric weight so role hierarchy can be compared
 * with simple integer comparisons (higher weight = more privileged).
 * @param {string} role - one of 'super_admin', 'dept_admin', 'tool_rep', 'technician'
 * @returns {number} weight for that role, or 0 if the role is unrecognized
 */
const getRoleWeight = (role) => {
    const weights = { 'super_admin': 4, 'dept_admin': 3, 'tool_rep': 2, 'technician': 1 };
    return weights[role] || 0;
};

/**
 * Express middleware factory: rejects the request (401/403) unless the current admin
 * session belongs to an active user whose role weight meets minWeight. On success,
 * attaches the authenticated user to req.authUser for the handler to use.
 *
 * The role is re-checked against the DB on every request rather than trusted from the
 * session's cached snapshot -- a deactivated or demoted admin loses access immediately
 * this way, not after the session naturally expires. This is also the sole source of
 * truth for authorization from here on: handlers must never use a client-supplied
 * `requester` field from req.body/req.query to decide what someone is allowed to do,
 * only req.authUser (sourced from the verified, server-side session).
 * @param {number} minWeight - minimum getRoleWeight() the session's user must have
 */
function requireRole(minWeight) {
    return async (req, res, next) => {
        if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
        try {
            // LEFT JOINs in user_department_access (see migrations/005) so every request
            // carries the full set of departments this user can act in -- their home
            // department plus any a super_admin has explicitly granted them, e.g. a
            // dept_admin who oversees more than one department in practice. array_agg over a
            // LEFT JOIN with no matches produces a one-element array containing NULL, not an
            // empty array, hence the FILTER -- see accessibleDeptIds below.
            const result = await pool.query(
                `SELECT u.user_id, u.role, u.dept_id, u.is_active,
                        COALESCE(array_agg(uda.dept_id) FILTER (WHERE uda.dept_id IS NOT NULL), '{}') AS granted_dept_ids
                 FROM users u
                 LEFT JOIN user_department_access uda ON uda.user_id = u.user_id
                 WHERE u.badge_id = $1
                 GROUP BY u.user_id`,
                [req.session.user.badge_id]
            );
            if (result.rows.length === 0 || !result.rows[0].is_active) {
                req.session.destroy(() => {});
                return res.status(403).json({ error: 'Account no longer active.' });
            }
            const row = result.rows[0];
            const weight = getRoleWeight(row.role);
            if (weight < minWeight) return res.status(403).json({ error: 'Insufficient permissions.' });
            req.authUser = {
                badge_id: req.session.user.badge_id,
                role: row.role,
                dept_id: row.dept_id,
                weight,
                user_id: row.user_id,
                // Home department plus every granted one, deduplicated -- the single set to
                // check anywhere a department-scoped action used to only check dept_id.
                accessibleDeptIds: [...new Set([row.dept_id, ...row.granted_dept_ids].filter(id => id !== null))],
            };
            next();
        } catch (err) {
            res.status(500).json({ error: 'Authorization check failed.' });
        }
    };
}

/**
 * Resolves a badge_id to { user_id, role, dept_id, accessibleDeptIds } -- accessibleDeptIds
 * is home dept_id plus any explicitly granted ones (see migrations/005), same shape as
 * req.authUser in requireRole() above. Does NOT special-case super_admin as "unrestricted":
 * matching every other use of accessibleDeptIds in this file, callers check
 * role === 'super_admin' themselves wherever unrestricted access should apply. Returns null
 * for an unknown or deactivated badge. Shared by endpoints that need department-access info
 * outside the session-based requireRole path -- currently just the kiosk's one-off
 * badge+PIN-authenticated audit submission, which has no session to attach req.authUser to.
 */
async function getUserAccess(badgeId) {
    const result = await pool.query(
        `SELECT u.user_id, u.role, u.dept_id,
                COALESCE(array_agg(uda.dept_id) FILTER (WHERE uda.dept_id IS NOT NULL), '{}') AS granted_dept_ids
         FROM users u
         LEFT JOIN user_department_access uda ON uda.user_id = u.user_id
         WHERE u.badge_id = $1 AND u.is_active = true
         GROUP BY u.user_id`,
        [badgeId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        user_id: row.user_id,
        role: row.role,
        dept_id: row.dept_id,
        accessibleDeptIds: [...new Set([row.dept_id, ...row.granted_dept_ids].filter(id => id !== null))],
    };
}

/**
 * Lightweight CSRF defense for the session-cookie-based admin endpoints: requires a
 * custom header that cross-site <form>/<img> CSRF vectors cannot set, only same-origin
 * fetch() calls can (which is all admin.js ever does). Combined with the session
 * cookie's sameSite:'lax' (which already blocks the cookie from being sent on cross-site
 * POST/PUT/DELETE), this covers the realistic CSRF surface for this app without a full
 * token-issuance flow.
 */
function requireFetchHeader(req, res, next) {
    if (req.get('X-Requested-With') !== 'ToolTracker') {
        return res.status(403).json({ error: 'Invalid request origin.' });
    }
    next();
}

/**
 * Generates a random 6-digit numeric PIN (as a string), used for login
 * and manager-override authentication.
 * @returns {string} a 6-digit PIN, e.g. "042817"
 */
const generatePin = () => Math.floor(100000 + Math.random() * 900000).toString();

// PINs are hashed with bcrypt (see users.pin_hash) rather than stored in the plaintext
// pin column, which is kept temporarily as a rollback safety net during rollout (see
// migrations/002_pin_hashing.sql). Cost factor 12 is a reasonable balance for a 6-digit
// numeric PIN checked at login time on modest hardware (a few hundred ms per check).
const PIN_HASH_COST_FACTOR = 12;
const hashPin = (pin) => bcrypt.hash(pin, PIN_HASH_COST_FACTOR);

// Per-badge brute-force lockout, backed by users.failed_pin_attempts/locked_until (see
// migrations/002_pin_hashing.sql) rather than in-memory, so it survives a restart and is
// shared correctly even if this app is ever run behind a load balancer with multiple
// instances. Complements the IP-based authLimiter above -- this catches sustained
// targeting of one specific (publicly-discoverable via /api/roster) badge_id regardless
// of source IP; authLimiter catches raw volume regardless of which badge is targeted.
const MAX_FAILED_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Checks whether badgeId is currently locked out from failed PIN attempts.
 * @returns {Promise<{locked: boolean, until?: Date}>}
 */
async function checkLockout(badgeId) {
    const res = await pool.query('SELECT locked_until FROM users WHERE badge_id = $1', [badgeId]);
    const lockedUntil = res.rows[0]?.locked_until;
    if (lockedUntil && new Date(lockedUntil) > new Date()) {
        return { locked: true, until: lockedUntil };
    }
    return { locked: false };
}

/**
 * Increments failed_pin_attempts for badgeId; sets locked_until once
 * MAX_FAILED_PIN_ATTEMPTS is reached. Call after every failed PIN check where the
 * badge_id is known to exist. Logs a LOCKOUT_TRIGGERED audit_logs row the moment the
 * threshold is actually crossed (not on every attempt while already locked -- callers
 * check checkLockout() first and never reach this again until the lockout expires and
 * a fresh attempt fails) -- otherwise there is zero visibility into brute-force attempts
 * against the system. user_id is left NULL rather than attributed to the targeted
 * account, since a failed PIN attempt does not prove who the actual caller is.
 */
async function recordFailedPinAttempt(badgeId) {
    const res = await pool.query(
        `UPDATE users SET failed_pin_attempts = failed_pin_attempts + 1,
                locked_until = CASE WHEN failed_pin_attempts + 1 >= $2 THEN NOW() + ($3 || ' milliseconds')::interval ELSE locked_until END
         WHERE badge_id = $1 RETURNING failed_pin_attempts`,
        [badgeId, MAX_FAILED_PIN_ATTEMPTS, LOCKOUT_DURATION_MS]
    );
    // Exact equality, not >= -- logs once at the moment the threshold is crossed, not
    // again on every attempt thereafter (e.g. concurrent requests racing past checkLockout).
    if (res.rows[0]?.failed_pin_attempts === MAX_FAILED_PIN_ATTEMPTS) {
        await pool.query(
            "INSERT INTO audit_logs (user_id, action, notes) VALUES (NULL, 'LOCKOUT_TRIGGERED', $1)",
            [`Badge ${badgeId} locked out after ${MAX_FAILED_PIN_ATTEMPTS} failed PIN attempts.`]
        );
    }
}

/** Clears the failed-attempt counter and any active lockout for badgeId. Call after every successful PIN check. */
async function resetFailedPinAttempts(badgeId) {
    await pool.query('UPDATE users SET failed_pin_attempts = 0, locked_until = NULL WHERE badge_id = $1', [badgeId]);
}

const LOCKOUT_RESPONSE = { error: 'Account temporarily locked due to repeated failed attempts. Try again later.', code: 'LOCKED' };

// Two mandatory audit windows per day: "morning" begins at 04:00 and runs until the
// afternoon window begins at 14:00; "afternoon" begins at 14:00 and runs overnight until
// the next morning window begins at 04:00 -- it spans midnight, which is why this is
// plain JS date math rather than a SQL check against ::date. A naive calendar-day match
// would incorrectly split the overnight portion of the afternoon window into "yesterday"
// and "today", making it impossible to satisfy across the midnight boundary.
const AUDIT_MORNING_START_HOUR = 4;
const AUDIT_AFTERNOON_START_HOUR = 14;

/**
 * Returns the Date marking when the mandatory-audit window containing `asOf` began.
 * @param {Date} [asOf] - defaults to right now
 */
function getAuditWindowStart(asOf = new Date()) {
    const hour = asOf.getHours();
    const windowStart = new Date(asOf);
    windowStart.setMinutes(0, 0, 0);
    if (hour >= AUDIT_MORNING_START_HOUR && hour < AUDIT_AFTERNOON_START_HOUR) {
        windowStart.setHours(AUDIT_MORNING_START_HOUR);
    } else if (hour >= AUDIT_AFTERNOON_START_HOUR) {
        windowStart.setHours(AUDIT_AFTERNOON_START_HOUR);
    } else {
        // hour < AUDIT_MORNING_START_HOUR -- still inside the afternoon window that began yesterday
        windowStart.setDate(windowStart.getDate() - 1);
        windowStart.setHours(AUDIT_AFTERNOON_START_HOUR);
    }
    return windowStart;
}

/**
 * Returns the Date the given audit window (as returned by getAuditWindowStart) ends --
 * i.e. when the next window begins. Used to show "time remaining in this window" on the
 * dashboard/kiosk audit-status widgets; kept as one shared helper rather than duplicating
 * this date math in both client files.
 * @param {Date} windowStart - a value returned by getAuditWindowStart()
 */
function getAuditWindowEnd(windowStart) {
    const windowEnd = new Date(windowStart);
    if (windowStart.getHours() === AUDIT_MORNING_START_HOUR) {
        windowEnd.setHours(AUDIT_AFTERNOON_START_HOUR);
    } else {
        windowEnd.setDate(windowEnd.getDate() + 1);
        windowEnd.setHours(AUDIT_MORNING_START_HOUR);
    }
    return windowEnd;
}

/**
 * Returns the Date marking when the shift window immediately BEFORE windowStart began --
 * the mirror image of getAuditWindowEnd(), stepping backward instead of forward. Used by the
 * dashboard's audit-compliance trend chart to walk back through the last N shift windows.
 * @param {Date} windowStart - a value returned by getAuditWindowStart()
 */
function getPreviousAuditWindowStart(windowStart) {
    const prev = new Date(windowStart);
    if (windowStart.getHours() === AUDIT_MORNING_START_HOUR) {
        prev.setDate(prev.getDate() - 1);
        prev.setHours(AUDIT_AFTERNOON_START_HOUR);
    } else {
        prev.setHours(AUDIT_MORNING_START_HOUR);
    }
    return prev;
}

/**
 * AUDIT GATE: returns the list of toolboxes in the given department that still
 * need an AUDIT since windowStart. A toolbox only counts if it currently has at
 * least one non-retired, non-transferred tool in it. Empty array => department passes.
 * @param {import('pg').PoolClient|import('pg').Pool} client - DB client/pool to query with
 * @param {number} deptId - department to check
 * @param {Date} [windowStart] - defaults to the start of the CURRENT mandatory-audit window (see getAuditWindowStart)
 * @returns {Promise<Array<{box_id: number, name: string}>>} pending toolboxes (empty = audited since windowStart)
 * @note windowStart/windowEnd are computed with LOCAL-time Date methods (correct -- shifts
 *   reset at 4am/2pm shop time, not UTC), but audit_logs.timestamp is `timestamp without
 *   time zone` written in UTC (DB session timezone is UTC). node-postgres serializes a bound
 *   Date parameter as local-time digits + offset (e.g. "04:00:00-07:00"); Postgres's literal
 *   parser for `timestamp without time zone` silently DISCARDS that offset and takes the
 *   digits as-is, giving a boundary that's off by the local UTC offset unless the parameter is
 *   explicitly cast to `::timestamptz` first (forces offset-aware parsing, then Postgres
 *   promotes the timestamp-without-tz column for the comparison using its own UTC session
 *   timezone -- the correct absolute-instant comparison). Every query comparing one of these
 *   Date objects against audit_logs.timestamp must cast the parameter this way.
 */
const getAuditGatePendingToolboxes = async (client, deptId, windowStart = getAuditWindowStart()) => {
    const query = `
        WITH auditable_boxes AS (
          SELECT b.box_id, b.name FROM toolboxes b WHERE b.dept_id = $1
            AND EXISTS (SELECT 1 FROM tools t JOIN drawers dr ON t.drawer_id = dr.drawer_id
                        WHERE dr.box_id = b.box_id AND t.status NOT IN ('Retired','Pending Transfer','In Calibration'))
        ), audited_in_window AS (
          SELECT DISTINCT b.box_id FROM audit_logs a
            JOIN tools t ON a.tool_id = t.tool_id JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
            WHERE a.action='AUDIT' AND a.timestamp >= $2::timestamptz AND b.dept_id = $1
        )
        SELECT ab.box_id, ab.name FROM auditable_boxes ab LEFT JOIN audited_in_window at ON ab.box_id = at.box_id WHERE at.box_id IS NULL;
    `;
    const result = await client.query(query, [deptId, windowStart]);
    return result.rows;
};

/**
 * Shared core of the audit-gate completion check: which toolboxes are still pending for
 * a window, and -- only if none are -- who completed the most recent AUDIT in it. Both
 * the admin-panel status endpoint and the daily log formatter build their own output
 * shape from this single query pair instead of each re-running it independently.
 * @returns {Promise<{pending: Array<{box_id: number, name: string}>, completion: {timestamp: Date, full_name: string, badge_id: string}|null}>}
 */
async function getAuditWindowCompletionInfo(deptId, windowStart) {
    const pending = await getAuditGatePendingToolboxes(pool, deptId, windowStart);
    if (pending.length > 0) return { pending, completion: null };
    const completedRes = await pool.query(
        `SELECT a.timestamp, u.full_name, u.badge_id
         FROM audit_logs a JOIN users u ON a.user_id = u.user_id
         JOIN tools t ON a.tool_id = t.tool_id JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
         WHERE a.action = 'AUDIT' AND a.timestamp >= $2::timestamptz AND b.dept_id = $1
         ORDER BY a.timestamp DESC LIMIT 1`,
        [deptId, windowStart]
    );
    return { pending, completion: completedRes.rows[0] || null };
}

/**
 * Describes a department's audit status for one specific window (used by the daily log to
 * report on both the morning and afternoon windows, not just whichever is active "now").
 * @returns {Promise<string>} e.g. "Completed at 06:15 by Jane Doe (AVI001)" or "NOT audited"
 */
async function describeAuditWindowStatus(deptId, windowStart) {
    const { pending, completion } = await getAuditWindowCompletionInfo(deptId, windowStart);
    if (pending.length > 0) return 'NOT audited';
    if (!completion) return 'Completed (no auditable toolboxes)';
    const completedTime = new Date(completion.timestamp).toTimeString().slice(0, 5);
    return `Completed at ${completedTime} by ${completion.full_name} (${completion.badge_id})`;
}

/**
 * TOOL STATUS STATE MACHINE: validates whether an admin-driven status change
 * (via PUT /api/tools/:id) is legal, without touching the DB.
 * - 'Out', 'Pending Transfer', and 'In Calibration' can never be *entered* here -- 'Out' only
 *   happens via a real kiosk checkout, the other two only via the transfer endpoints.
 * - While 'Pending Transfer' or 'In Calibration', no change is allowed at all.
 * - While 'Out': can only move to Missing/Broken/Worn (reporting an issue on a tool that's
 *   currently checked out implicitly ends the checkout -- see POST /api/kiosk/report-issue --
 *   rather than requiring it to be checked in "clean" first and flagged as a separate step
 *   afterward, which was impossible to do correctly and blocked reporting a tool broken or
 *   lost while someone actually had it). Retiring an Out tool directly isn't allowed -- it
 *   must pass through one of the three flagged states first, same as from every other status.
 * - Otherwise: 'In' <-> (Missing, Broken, Worn) freely, any of those -> Retired, Retired is terminal.
 * @param {string} currentStatus - the tool's status before the update
 * @param {string} requestedStatus - the status being requested
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
const checkToolStatusTransition = (currentStatus, requestedStatus) => {
    if (requestedStatus === currentStatus) return { allowed: true };

    if (currentStatus === 'Pending Transfer' || currentStatus === 'In Calibration') return { allowed: false, code: 'TOOL_IN_TRANSFER' };

    if (requestedStatus === 'Out' || requestedStatus === 'Pending Transfer' || requestedStatus === 'In Calibration') {
        return { allowed: false, code: 'INVALID_STATUS_TRANSITION' };
    }

    if (currentStatus === 'Out') {
        if (['Missing', 'Broken', 'Worn'].includes(requestedStatus)) return { allowed: true };
        return { allowed: false, code: 'TOOL_IS_OUT' };
    }

    if (currentStatus === 'In') {
        if (['Missing', 'Broken', 'Worn', 'Retired'].includes(requestedStatus)) return { allowed: true };
        return { allowed: false, code: 'INVALID_STATUS_TRANSITION' };
    }

    if (['Missing', 'Broken', 'Worn'].includes(currentStatus)) {
        if (requestedStatus === 'In' || requestedStatus === 'Retired') return { allowed: true };
        return { allowed: false, code: 'INVALID_STATUS_TRANSITION' };
    }

    if (currentStatus === 'Retired') return { allowed: false, code: 'INVALID_STATUS_TRANSITION' };

    return { allowed: false, code: 'INVALID_STATUS_TRANSITION' };
};

/**
 * Checks whether `serialNumber` (normalized for case and surrounding whitespace, so "SN-1"
 * and "sn-1 " collide) already belongs to a DIFFERENT tool, for a friendly rejection message
 * before the write is attempted. Mirrors the database-level guard in
 * migrations/011_serial_number_uniqueness.sql (a partial unique index) -- that index is what
 * actually prevents a duplicate under concurrency or from a write path that skips this check
 * (e.g. a future one); this call exists only to turn that into a clear message instead of a
 * raw 23505 constraint violation.
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} serialNumber
 * @param {number} [excludeToolId] - the tool being edited, if any, so leaving a tool's own
 *   serial unchanged never collides with itself
 * @returns {Promise<{tool_id: number, qr_code: string, name: string, status: string}|null>}
 */
async function findDuplicateSerial(client, serialNumber, excludeToolId) {
    if (!serialNumber || !serialNumber.trim()) return null;
    const result = await client.query(
        `SELECT tool_id, qr_code, name, status FROM tools
         WHERE LOWER(TRIM(serial_number)) = LOWER(TRIM($1)) AND ($2::int IS NULL OR tool_id != $2)
         LIMIT 1`,
        [serialNumber, excludeToolId || null]
    );
    return result.rows[0] || null;
}

/** Friendly message for findDuplicateSerial()'s result -- names the existing tool and, if
 *  it's away for calibration, points at receiving it back instead of re-adding it. */
function duplicateSerialErrorMessage(existing) {
    const awayForCal = existing.status === 'Pending Transfer' || existing.status === 'In Calibration';
    const hint = awayForCal ? ' It is currently out for calibration -- receive it back instead of adding a new one.' : '';
    return `Serial number is already registered to "${existing.name}" (${existing.qr_code}).${hint}`;
}

/**
 * Opens a sub-tolerance trace-back investigation for a tool (or extends the one already
 * open, if any -- at most one OPEN investigation per tool at a time, see
 * migrations/013_trace_investigations.sql), then auto-populates it with a review row for
 * every checkout of that tool inside the suspect window that doesn't already have one.
 *
 * Called from within the same transaction as the calibration record that triggered it (both
 * calibration-recording endpoints call this on a Fail result), so a failed calibration and
 * its investigation either both commit or both roll back together. Also usable for a
 * manually-opened investigation, which is why the merge branch below folds a second trigger
 * into the same investigation instead of erroring or forking a duplicate.
 */
async function openOrExtendTraceInvestigation(client, { toolId, reason, windowStart, windowEnd, triggeringCalId, openedByUserId }) {
    const existing = await client.query(
        `SELECT investigation_id, window_start, window_end FROM trace_investigations WHERE tool_id = $1 AND status = 'OPEN'`,
        [toolId]
    );

    let investigationId, finalWindowStart, finalWindowEnd;
    if (existing.rows.length > 0) {
        const row = existing.rows[0];
        investigationId = row.investigation_id;
        // Merged to the widest envelope across every trigger this investigation has ever
        // seen, NOT just this call's own window -- and the review-seeding query below uses
        // that same merged envelope, so a second trigger with a disjoint range (e.g. a manual
        // open folded into an existing auto-opened investigation) can't leave a silent gap
        // between the two windows that never gets seeded.
        finalWindowStart = (!row.window_start || (windowStart && new Date(windowStart) < new Date(row.window_start))) ? windowStart : row.window_start;
        finalWindowEnd = new Date(windowEnd) > new Date(row.window_end) ? windowEnd : row.window_end;
        await client.query(
            `UPDATE trace_investigations SET window_start = $1, window_end = $2, triggering_cal_id = COALESCE($3, triggering_cal_id)
             WHERE investigation_id = $4`,
            [finalWindowStart, finalWindowEnd, triggeringCalId || null, investigationId]
        );
    } else {
        finalWindowStart = windowStart || null;
        finalWindowEnd = windowEnd;
        const insertRes = await client.query(
            `INSERT INTO trace_investigations (tool_id, triggering_cal_id, reason, window_start, window_end, opened_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING investigation_id`,
            [toolId, triggeringCalId || null, reason, finalWindowStart, finalWindowEnd, openedByUserId]
        );
        investigationId = insertRes.rows[0].investigation_id;
    }

    // Each review is seeded from one checkout in the (merged) window, with its return time
    // (the next check-in after it, if any) captured alongside so the reviewer can see the
    // full loan at a glance without cross-referencing audit_logs separately. One INSERT...
    // SELECT rather than a query-then-loop-inserting-one-row-at-a-time -- a long suspect
    // window can mean dozens of checkouts, and this all runs inside the same transaction as
    // the calibration record that triggered it.
    await client.query(
        `INSERT INTO trace_reviews (investigation_id, audit_log_id, work_order, custodian_name, used_at, returned_at)
         SELECT $4, al.log_id, al.work_order, u.full_name, al.timestamp, inLog.timestamp
         FROM audit_logs al
         LEFT JOIN users u ON al.user_id = u.user_id
         LEFT JOIN LATERAL (
             SELECT timestamp FROM audit_logs
             WHERE tool_id = al.tool_id AND action = 'CHECKIN_TOOL' AND timestamp >= al.timestamp
             ORDER BY timestamp ASC LIMIT 1
         ) inLog ON true
         WHERE al.tool_id = $1 AND al.action = 'CHECKOUT_TOOL'
           AND al.timestamp <= $2
           AND ($3::timestamp IS NULL OR al.timestamp >= $3)
           AND NOT EXISTS (SELECT 1 FROM trace_reviews tr WHERE tr.investigation_id = $4 AND tr.audit_log_id = al.log_id)`,
        [toolId, finalWindowEnd, finalWindowStart, investigationId]
    );

    return investigationId;
}

/**
 * Shared by both calibration-recording endpoints for the "this attempt failed" path: finds
 * the last PASSING calibration before this one (the start of the suspect window -- null if
 * there isn't one, meaning suspect since the tool's own creation) and opens/extends the
 * tool's trace-back investigation through it. Kept as one function specifically because both
 * call sites need to stay in lockstep -- they already share the same investigation schema and
 * merge behavior via openOrExtendTraceInvestigation, so the trigger logic around it shouldn't
 * drift into two slightly different copies either.
 */
async function triggerFailedCalibration(client, { toolId, calDate, provider, certificateNumber, calId, userId }) {
    // Ordered by recorded_at (a real timestamp), not cal_date (a bare DATE with no
    // sub-day precision) -- a Pass and a Fail logged for the same tool on the same calendar
    // day (e.g. an initial failed attempt, adjusted, and re-calibrated same-day) would
    // otherwise be unorderable by cal_date alone, since neither is strictly "less than" the
    // other. recorded_at (when each record was actually entered) is always distinct.
    const prevPassRes = await client.query(
        `SELECT cal_date FROM calibration_records
         WHERE tool_id = $1 AND result = 'Pass'
           AND recorded_at < (SELECT recorded_at FROM calibration_records WHERE cal_id = $2)
         ORDER BY recorded_at DESC LIMIT 1`,
        [toolId, calId]
    );
    return openOrExtendTraceInvestigation(client, {
        toolId,
        reason: `Calibration failed ${calDate} (${provider}, cert ${certificateNumber})`,
        windowStart: prevPassRes.rows[0]?.cal_date || null,
        // End-of-day, not the bare cal_date (which would default to midnight) -- audit_logs
        // timestamps have real time-of-day precision, so a bare-midnight upper bound would
        // exclude every checkout that happened LATER that same day, i.e. nearly all of them.
        windowEnd: `${calDate}T23:59:59`,
        triggeringCalId: calId,
        openedByUserId: userId
    });
}

// ==========================================
// PHOTO UPLOAD SETUP (MULTER)
// ==========================================
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const entityType = req.body.entity_type || 'misc';
        cb(null, entityType + '-' + uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB Limit
});

/**
 * Deletes a previously-uploaded file (a photo, or a generated barcode label under
 * uploads/barcodes/) given its stored `/uploads/...` URL, silently no-oping on a null/empty
 * URL or a file that's already gone. Shared by the photo upload endpoint (cleaning up the
 * file a new upload just replaced) and every entity DELETE endpoint (cleaning up that
 * entity's photo and, for tools, its barcode label too) -- previously nothing ever deleted
 * these files, so every re-upload or deletion left the old file behind on disk forever.
 *
 * Strips only the leading "/uploads/" prefix (not path.basename()) so a URL pointing into a
 * subdirectory like "/uploads/barcodes/AVI-000001.png" resolves to the correct nested file
 * rather than being flattened to just "AVI-000001.png" directly under UPLOAD_DIR, which
 * would silently no-op (the flattened path was never actually written there). This is only
 * ever called with a photo_url/barcode_image_url this server itself generated (never a
 * client-supplied path), so trusting the rest of the path is safe -- there's no
 * path-traversal risk from user input here.
 */
function deletePhotoFile(photoUrl) {
    if (!photoUrl) return;
    const relativePath = photoUrl.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOAD_DIR, relativePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ==========================================
// BARCODE LABEL GENERATION (DATA MATRIX + LINEAR/CODE 128)
// ==========================================
const BARCODE_LABEL_DIR = path.join(UPLOAD_DIR, 'barcodes');
if (!fs.existsSync(BARCODE_LABEL_DIR)) {
    fs.mkdirSync(BARCODE_LABEL_DIR, { recursive: true });
}

const BARCODE_LABEL_PADDING = 20; // bwip-js module units -- visually confirmed to give clear breathing room around the code and its human-readable ID without looking excessive; see scripts/lib/datamatrix.js for why this differs from the 0-padding bulk print/engrave scripts
const BARCODE_LABEL_TEXT_YOFFSET = -12; // bwip-js's own default gap between the code and the human-readable ID reads as touching/too tight on screen -- visually confirmed clear at -12; see textOptions() in scripts/lib/datamatrix.js for the sign convention
const BARCODE_LABEL_BACKGROUND = 'FFFFFF'; // bwip-js's own background is fully transparent (alpha 0, not opaque white) -- invisible against the dark image-lightbox modal in admin.js. See generatePngAtSize() in scripts/lib/datamatrix.js.

// Three named sizes generated and stored for every tool (migrations/010_barcode_size_variants.sql)
// -- a batch print run can then pick whichever actually fits a given tool instead of one
// compromise size for everything. dmMm/linearScale anchored to
// scripts/generate-size-test-sheet.js's own already-validated candidate range (3-20mm)
// rather than arbitrary numbers. "medium" is this feature's original (and still default)
// size, unchanged, so existing labels/filenames/columns for it never move.
const BARCODE_SIZES = {
    small: { dmMm: 10, linearScale: 2 },
    medium: { dmMm: 15, linearScale: 3 },
    large: { dmMm: 20, linearScale: 5 },
};

// Maps "<format>-<size>" to the tools column that size/format combination is stored in.
// "medium" reuses the two pre-existing columns from migrations 004/008; small/large are new.
const BARCODE_LABEL_COLUMNS = {
    'datamatrix-small': 'barcode_image_url_small',
    'datamatrix-medium': 'barcode_image_url',
    'datamatrix-large': 'barcode_image_url_large',
    'linear-small': 'linear_barcode_image_url_small',
    'linear-medium': 'linear_barcode_image_url',
    'linear-large': 'linear_barcode_image_url_large',
};

/**
 * Generates one size/format combination of a tool's barcode label and saves it to
 * public/uploads/barcodes/, returning the /uploads/... URL to store in the matching
 * tools column (see BARCODE_LABEL_COLUMNS). "medium" keeps the exact filenames this feature
 * originally used (no suffix) so existing rows/files for that size never need to move;
 * small/large get a filename suffix. This is a distinct file/column from a tool's photo_url
 * (its actual picture) -- auto-generated from the barcode value, not a manual upload.
 *
 * The filename is derived directly from qr_code rather than the random-suffixed pattern
 * multer uses for photo uploads: a tool's barcode value is immutable once set (retiring a
 * tool mangles its OLD qr_code with a "-RET-<id>" suffix rather than reusing it -- see
 * POST /api/tools), so there's no collision risk and no old file to clean up on replacement
 * the way user-uploaded photos need (see deletePhotoFile()). Overwrites any existing file at
 * that path, which is exactly what's wanted when re-called after a rename.
 * @param {string} qrCode
 * @param {string} [name] - the tool's name, rendered as a second row below the ID (see
 *   addNameRow in scripts/lib/datamatrix.js); omitted/blank leaves just the code + ID.
 * @param {'small'|'medium'|'large'} size
 * @param {'datamatrix'|'linear'} format
 * @returns {Promise<string>} the saved image's /uploads/... URL
 */
async function generateOneBarcodeLabel(qrCode, name, size, format) {
    const safeName = qrCode.replace(/[^A-Za-z0-9_-]/g, '_');
    const sizeSuffix = size === 'medium' ? '' : `-${size}`;
    const { dmMm, linearScale } = BARCODE_SIZES[size];

    let png, filename;
    if (format === 'datamatrix') {
        ({ png } = await generatePngAtSize(qrCode, dmMm, 1200, true, BARCODE_LABEL_PADDING, BARCODE_LABEL_TEXT_YOFFSET, BARCODE_LABEL_BACKGROUND));
        filename = `${safeName}${sizeSuffix}.png`;
    } else {
        ({ png } = await generateLinearBarcodePng(qrCode, linearScale, BARCODE_LABEL_BACKGROUND));
        filename = `${safeName}-1d${sizeSuffix}.png`;
    }
    const labeled = await addNameRow(png, name);
    fs.writeFileSync(path.join(BARCODE_LABEL_DIR, filename), labeled);
    return `/uploads/barcodes/${filename}`;
}

/**
 * Generates all 6 label images (2 formats x 3 sizes) for a tool and returns them keyed by
 * their DB column name, ready to spread into saveBarcodeLabelUrls(). Used at every place a
 * tool's labels get (re)generated -- creation, rename, CSV import create/update -- so all
 * six always exist together rather than some sizes silently lagging behind the others.
 * @param {string} qrCode
 * @param {string} [name]
 * @returns {Promise<Record<string,string>>} column name -> /uploads/... URL
 */
async function generateAllBarcodeLabels(qrCode, name) {
    const urls = {};
    for (const format of ['datamatrix', 'linear']) {
        for (const size of ['small', 'medium', 'large']) {
            urls[BARCODE_LABEL_COLUMNS[`${format}-${size}`]] = await generateOneBarcodeLabel(qrCode, name, size, format);
        }
    }
    return urls;
}

/**
 * Writes all 6 barcode label URLs (see generateAllBarcodeLabels) onto a tool in one UPDATE.
 * @param {'tool_id'|'qr_code'} idColumn - which column identifies the row
 * @param {number|string} idValue
 * @param {Record<string,string>} urls - as returned by generateAllBarcodeLabels()
 */
async function saveBarcodeLabelUrls(idColumn, idValue, urls) {
    await pool.query(
        `UPDATE tools SET barcode_image_url = $1, barcode_image_url_small = $2, barcode_image_url_large = $3,
                linear_barcode_image_url = $4, linear_barcode_image_url_small = $5, linear_barcode_image_url_large = $6
         WHERE ${idColumn} = $7`,
        [urls.barcode_image_url, urls.barcode_image_url_small, urls.barcode_image_url_large,
         urls.linear_barcode_image_url, urls.linear_barcode_image_url_small, urls.linear_barcode_image_url_large,
         idValue]
    );
}

// ==========================================
// 1. SYSTEM & INVENTORY FETCHING
// ==========================================
// Health check: confirms the API is up and can reach the database.
app.get('/api/status', async (req, res) => {
    try { 
        const result = await pool.query('SELECT NOW()'); 
        res.json({ message: 'Online', db_time: result.rows[0].now }); 
    } catch (err) { 
        res.status(500).json({ error: 'DB connection failed' }); 
    }
});

// Fetch the full tool inventory with toolbox/drawer/department names joined in. No role check.
app.get('/api/tools', async (req, res) => {
    try {
        const query = `
            SELECT t.*, b.name AS toolbox_name, dr.name AS drawer_name, d.name AS department_name,
                   EXISTS(SELECT 1 FROM calibration_records cr WHERE cr.tool_id = t.tool_id) AS has_cal_record,
                   EXISTS(SELECT 1 FROM trace_investigations ti WHERE ti.tool_id = t.tool_id AND ti.status = 'OPEN') AS has_open_investigation
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON dr.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            ORDER BY t.name ASC;
        `;
        const result = await pool.query(query); 
        res.json({ success: true, tools: result.rows });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to fetch tools.' }); 
    }
});

// Full calibration history for one tool -- every completed calibration cycle (see
// calibration_records / POST /api/transfers/:id/complete-cal), newest first, so an admin or
// auditor can see who calibrated it, against what standard, and under what certificate
// number, not just the current due date. requireRole(2) matches the existing view-inventory
// threshold (tool_rep+), same as the rest of the admin tool detail view.
app.get('/api/tools/:id/calibration-history', requireRole(2), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT cr.cal_id, cr.cal_date, cr.due_date, cr.provider, cr.certificate_number,
                    cr.standard_used, cr.notes, cr.recorded_at, cr.result, u.full_name AS recorded_by_name
             FROM calibration_records cr
             LEFT JOIN users u ON cr.recorded_by_user_id = u.user_id
             WHERE cr.tool_id = $1
             ORDER BY cr.cal_date DESC, cr.recorded_at DESC`,
            [req.params.id]
        );
        res.json({ success: true, records: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch calibration history.' });
    }
});

// Logs a calibration record directly from the admin panel -- NOT tied to a QA transfer, so
// existing inventory (whose last_cal_date/cal_due_date were set by the ingest form, a direct
// edit, or CSV import, with no calibration_records row at all) can get a traceable record
// backfilled, and a shop can log a calibration that happened outside the formal kiosk QA
// transfer workflow. requireRole(2) matches the existing tool-edit threshold (tool_rep+).
// Keeps tools.last_cal_date/cal_due_date/is_calibrated in sync afterward, but recomputed from
// the single most-recent calibration_records row for this tool (by cal_date) rather than
// just whatever was submitted -- so backfilling an OLD record after a newer one already
// exists doesn't clobber the tool's current due date with stale data.
app.post('/api/tools/:id/calibration-history', requireFetchHeader, requireRole(2), async (req, res) => {
    const { cal_date, due_date, provider, certificate_number, standard_used, notes, result } = req.body;
    if (!cal_date || !due_date) return res.status(400).json({ error: 'Calibration date and due date are both required.' });
    if (!provider || !certificate_number) return res.status(400).json({ error: 'Calibration provider and certificate/reference number are both required for a traceable record.' });
    const calResult = result === 'Fail' ? 'Fail' : 'Pass';

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const toolRes = await client.query('SELECT tool_id, last_cal_date FROM tools WHERE tool_id = $1', [req.params.id]);
        if (toolRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tool not found.' }); }
        const currentLastCal = toolRes.rows[0].last_cal_date;

        const calRes = await client.query(
            `INSERT INTO calibration_records (tool_id, cal_date, due_date, provider, certificate_number, standard_used, notes, recorded_by_user_id, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING cal_id`,
            [req.params.id, cal_date, due_date, provider, certificate_number, standard_used || null, notes || null, req.authUser.user_id, calResult]
        );

        // Only advance the tool's snapshot fields if this record is now the most recent
        // calibration event for it. Comparing against calibration_records alone (e.g. "is
        // this the newest row for this tool") isn't enough: existing inventory can have a
        // last_cal_date that predates ANY calibration_records row (set directly by the
        // ingest form, a plain edit, or CSV import, with no traceable record behind it at
        // all) -- backfilling an older historical record for that tool must not regress a
        // legacy date that's already there just because it happens to be untracked.
        if (!currentLastCal || new Date(cal_date) >= new Date(currentLastCal)) {
            // A failed calibration doesn't bring the tool into compliance -- back-date its due
            // date to the failure itself so the existing checkout hard-stop (CAL_EXPIRED)
            // blocks it immediately as a secondary signal (the primary one is the trace-back
            // investigation opened below, checked directly via CAL_INVESTIGATION_OPEN).
            const effectiveDueDate = calResult === 'Fail' ? cal_date : due_date;
            await client.query(
                'UPDATE tools SET last_cal_date = $1, cal_due_date = $2, is_calibrated = true WHERE tool_id = $3',
                [cal_date, effectiveDueDate, req.params.id]
            );
        } else {
            await client.query('UPDATE tools SET is_calibrated = true WHERE tool_id = $1', [req.params.id]);
        }

        await client.query(
            "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'CAL_COMPLETE', $2, $3)",
            [req.authUser.user_id, req.params.id, `Calibration logged directly by admin: ${provider} (cert ${certificate_number})${calResult === 'Fail' ? ' -- FAILED' : ''}`]
        );

        if (calResult === 'Fail') {
            await triggerFailedCalibration(client, {
                toolId: req.params.id, calDate: cal_date, provider, certificateNumber: certificate_number,
                calId: calRes.rows[0].cal_id, userId: req.authUser.user_id
            });
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Add Calibration Record Error:', err);
        res.status(500).json({ error: 'Failed to log calibration record.' });
    } finally {
        client.release();
    }
});

// Compute the next sequential numeric suffix for a tool QR code with the given prefix.
// Finds the lowest unused sequence number for the given prefix, not just MAX+1 -- so a
// deleted tool's number (e.g. AVI-000002) gets reused on the next ingest instead of being
// permanently skipped while numbering marches on past the current max. Retired/replaced
// tools keep their original number suffixed with '-RET-<tool_id>' (see POST /api/tools) --
// those are excluded from the used-number set entirely, since blindly stripping non-digits
// from a mangled code like "AVI-000002-RET-45" would concatenate both number groups into
// garbage (e.g. "00000245") and corrupt the gap calculation.
app.get('/api/tools/next-id', async (req, res) => {
    const { prefix } = req.query;
    if (!prefix) return res.status(400).json({ error: 'Prefix required.' });

    try {
        const query = `
            WITH used_numbers AS (
                SELECT CAST(NULLIF(regexp_replace(qr_code, '\\D', '', 'g'), '') AS INTEGER) AS num
                FROM tools WHERE qr_code LIKE $1 AND qr_code NOT LIKE '%-RET-%'
            )
            SELECT MIN(gs.num) AS next_number
            FROM generate_series(1, (SELECT COALESCE(MAX(num), 0) FROM used_numbers) + 1) AS gs(num)
            WHERE NOT EXISTS (SELECT 1 FROM used_numbers u WHERE u.num = gs.num);
        `;
        const result = await pool.query(query, [`${prefix}%`]);
        const nextSequence = String(result.rows[0].next_number).padStart(6, '0');
        res.json({ success: true, next_sequence: nextSequence });
    } catch (err) {
        res.status(500).json({ error: 'Failed to calculate ID.' });
    }
});

// ==========================================
// 2. AUTHENTICATION
// ==========================================
// Standard login: verify badge_id/username + PIN and that the account is active.
app.post('/api/login', authLimiter, async (req, res) => {
    const { login_id, pin } = req.body;
    try {
        const query = `
            SELECT user_id, badge_id, full_name, username, role, is_active, pin_hash
            FROM users WHERE (badge_id ILIKE $1 OR username ILIKE $1)
        `;
        const result = await pool.query(query, [login_id]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid Credentials.' });
        const candidate = result.rows[0];

        const lockout = await checkLockout(candidate.badge_id);
        if (lockout.locked) return res.status(423).json(LOCKOUT_RESPONSE);

        if (!(await bcrypt.compare(pin, candidate.pin_hash))) {
            await recordFailedPinAttempt(candidate.badge_id);
            return res.status(401).json({ error: 'Invalid Credentials.' });
        }
        if (!candidate.is_active) return res.status(403).json({ error: 'Profile deactivated.' });

        await resetFailedPinAttempts(candidate.badge_id);
        const { pin_hash, ...user } = candidate;
        req.session.user = { badge_id: user.badge_id };
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// Restores admin login state on page reload -- admin.js calls this on load instead of
// always showing the login wall. req.session.user only ever holds badge_id (see
// /api/login); role/dept/name are re-fetched fresh here rather than trusted from a
// stale session snapshot, same reasoning as requireRole().
app.get('/api/session', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
    try {
        const result = await pool.query(
            'SELECT user_id, badge_id, full_name, username, role, is_active FROM users WHERE badge_id = $1',
            [req.session.user.badge_id]
        );
        if (result.rows.length === 0 || !result.rows[0].is_active) {
            req.session.destroy(() => {});
            return res.status(401).json({ error: 'Not logged in.' });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('tt.sid');
        if (err) return res.status(500).json({ error: 'Logout failed.' });
        res.json({ success: true });
    });
});

// Kiosk login: identify a user by badge_id/username + PIN for quick kiosk access.
app.post('/api/kiosk-auth', authLimiter, async (req, res) => {
    const { login_id, pin } = req.body;
    try {
        // granted_dept_ids rides along here (same pattern as requireRole in the admin session
        // path) so the kiosk can filter/group the audit toolbox picker to what this person can
        // actually access, without a second round trip -- kiosk-auth is a one-off identity
        // check per action, not a persistent session, so this is the one place to get it from.
        const query = `
            SELECT u.user_id, u.badge_id, u.full_name, u.role, u.is_active, u.dept_id, u.pin_hash,
                   COALESCE(array_agg(uda.dept_id) FILTER (WHERE uda.dept_id IS NOT NULL), '{}') AS granted_dept_ids
            FROM users u
            LEFT JOIN user_department_access uda ON uda.user_id = u.user_id
            WHERE (u.badge_id ILIKE $1 OR u.username ILIKE $1)
            GROUP BY u.user_id
        `;
        const result = await pool.query(query, [login_id]);

        // Same message whether login_id is unknown or the pin is wrong, to avoid enumeration.
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid Credentials.', code: 'BAD_CREDENTIALS' });
        const candidate = result.rows[0];

        const lockout = await checkLockout(candidate.badge_id);
        if (lockout.locked) return res.status(423).json(LOCKOUT_RESPONSE);

        if (!(await bcrypt.compare(pin, candidate.pin_hash))) {
            await recordFailedPinAttempt(candidate.badge_id);
            return res.status(401).json({ error: 'Invalid Credentials.', code: 'BAD_CREDENTIALS' });
        }
        if (!candidate.is_active) return res.status(403).json({ error: 'Profile deactivated.', code: 'INACTIVE_USER' });

        await resetFailedPinAttempts(candidate.badge_id);
        const { pin_hash, ...user } = candidate;
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// ==========================================
// 3. USER MANAGEMENT & SELF-SERVICE
// ==========================================
// List active users with a lower role weight than the requester (any authenticated requester).
app.get('/api/users', requireRole(1), async (req, res) => {
    try {
        // Fetching photo_url for the UI. granted_dept_ids feeds the department-access admin
        // UI (super_admin only) -- lets a dept_admin's extra departments show up alongside
        // their home one without a separate round trip per row.
        const query = `
            SELECT u.user_id, u.badge_id, u.username, u.email, u.full_name, u.role, u.dept_id, d.name AS department_name, u.photo_url,
                   COALESCE(array_agg(uda.dept_id) FILTER (WHERE uda.dept_id IS NOT NULL), '{}') AS granted_dept_ids
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.dept_id
            LEFT JOIN user_department_access uda ON uda.user_id = u.user_id
            WHERE u.is_active = true
            GROUP BY u.user_id, d.name
            ORDER BY u.full_name ASC
        `;
        const result = await pool.query(query);
        const filteredUsers = result.rows.filter(u => getRoleWeight(u.role) < req.authUser.weight);

        res.json({ success: true, users: filteredUsers });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

// Public roster listing of all active users (no role check, no requester needed).
app.get('/api/roster', async (req, res) => {
    try {
        // Fetching photo_url for the UI
        const query = `
            SELECT u.badge_id, u.username, u.full_name, u.role, d.name AS department_name, u.photo_url 
            FROM users u LEFT JOIN departments d ON u.dept_id = d.dept_id 
            WHERE u.is_active = true ORDER BY u.full_name ASC
        `;
        const result = await pool.query(query);
        res.json({ success: true, roster: result.rows });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to fetch roster.' }); 
    }
});

// Create a new user account. The assigned role may be up to and including the requester's
// own weight (not strictly below it) -- the same inclusive rule PUT /api/users/:badge_id/role
// already uses, so a super_admin can create another super_admin directly instead of only
// being able to reach that end state via the two-step "create lower, then promote" path.
// Generates badge_id/username/PIN and "sends" a welcome email.
app.post('/api/users', requireFetchHeader, requireRole(1), async (req, res) => {
    const { full_name, email, dept_id, role } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        if (!['super_admin', 'dept_admin', 'tool_rep', 'technician'].includes(role)) {
            throw new Error('Invalid role.');
        }
        if (req.authUser.weight < getRoleWeight(role)) throw new Error('Hierarchy Violation.');

        // A super_admin may create a user in any department (or none). Everyone else is
        // restricted to their own accessible departments -- normally just their home one, but
        // a dept_admin granted access to additional departments (see migrations/005 and
        // PUT /api/users/:badge_id/department-access) can create users in any of those too,
        // not only their own. Silently defaulting to their home department would let a
        // dept_admin's UI selection of a department they don't actually have access to
        // create the user somewhere else entirely without any error -- reject it instead.
        let finalDeptId;
        if (req.authUser.role === 'super_admin') {
            finalDeptId = dept_id || null;
        } else {
            const requestedDeptId = dept_id ? parseInt(dept_id, 10) : req.authUser.dept_id;
            if (!req.authUser.accessibleDeptIds.includes(requestedDeptId)) {
                throw new Error('You do not have access to that department.');
            }
            finalDeptId = requestedDeptId;
        }
        if (!email || !email.includes('@')) throw new Error('Valid email address required.');
        const username = email.split('@')[0].toLowerCase();

        // A super_admin isn't required to belong to a department -- matching the existing
        // department-less super_admin account already in this system -- so a missing dept_id
        // falls back to a fixed "ADMIN-" prefix instead of a department-derived one. Every
        // other role must resolve to a real department.
        let prefix;
        if (finalDeptId) {
            const deptRes = await client.query('SELECT prefix_code FROM departments WHERE dept_id = $1', [finalDeptId]);
            if (deptRes.rows.length === 0) throw new Error('Invalid Department selected.');
            prefix = deptRes.rows[0].prefix_code;
        } else if (role === 'super_admin') {
            prefix = 'ADMIN-';
        } else {
            throw new Error('Invalid Department selected.');
        }

        const maxRes = await client.query(`SELECT MAX(CAST(NULLIF(regexp_replace(badge_id, '\\D', '', 'g'), '') AS INTEGER)) as max_num FROM users WHERE badge_id LIKE $1`, [`${prefix}%`]);
        const badge_id = prefix + String((maxRes.rows[0].max_num || 0) + 1).padStart(3, '0');

        const newPin = generatePin();
        const insertQuery = `INSERT INTO users (badge_id, full_name, email, username, dept_id, role, pin_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
        const result = await client.query(insertQuery, [badge_id, full_name, email, username, finalDeptId, role, await hashPin(newPin)]);

        await client.query('COMMIT');
        // The plaintext PIN only ever exists in memory for this one response -- it's never
        // stored (pin_hash is what was inserted above). There's no email delivery, so the
        // admin panel shows it directly via showCredentialsModal() for manual handout.
        const { pin_hash, ...newUser } = result.rows[0];
        res.json({ success: true, user: { ...newUser, pin: newPin } });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message || 'Failed to create user.' });
    } finally {
        client.release();
    }
});

// Reset a user's PIN. Requester must outrank the target user (getRoleWeight hierarchy check).
app.post('/api/users/:badge_id/reset-pin', requireFetchHeader, requireRole(1), async (req, res) => {
    const { badge_id } = req.params;
    try {
        const target = await pool.query('SELECT role FROM users WHERE badge_id = $1', [badge_id]);

        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        if (req.authUser.weight <= getRoleWeight(target.rows[0].role)) return res.status(403).json({ error: 'Hierarchy Violation.' });

        const newPin = generatePin();
        await pool.query(
            'UPDATE users SET pin_hash = $1, failed_pin_attempts = 0, locked_until = NULL WHERE badge_id = $2',
            [await hashPin(newPin), badge_id]
        );
        // Return the new PIN so the admin panel can display it directly -- there is no
        // email delivery; relaying credentials to the person is a manual admin step.
        res.json({ success: true, new_pin: newPin });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset PIN.' });
    }
});

// Deactivate a user account. Requester must outrank the target user (getRoleWeight hierarchy check).
app.put('/api/users/:badge_id/deactivate', requireFetchHeader, requireRole(1), async (req, res) => {
    const { badge_id } = req.params;
    try {
        const target = await pool.query('SELECT role FROM users WHERE badge_id = $1', [badge_id]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        if (req.authUser.weight <= getRoleWeight(target.rows[0].role)) return res.status(403).json({ error: 'Hierarchy Violation.' });

        await pool.query('UPDATE users SET is_active = false WHERE badge_id = $1', [badge_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed.' });
    }
});

// Change a user's role. Requester must outrank the target's CURRENT role (getRoleWeight
// hierarchy check, same pattern as reset-pin/deactivate above) -- so nobody can touch a peer
// or superior's account. The NEW role, however, may be set up to AND INCLUDING the requester's
// own weight, not strictly below it like account creation requires -- this is the one
// deliberate exception to the strict-inequality pattern used elsewhere, so a dept_admin can
// promote a subordinate up to a peer dept_admin, and a super_admin can eventually promote
// someone to super_admin (creation alone can never do this, since requireRole there demands
// weight > target weight, which no one can satisfy for the top role).
app.put('/api/users/:badge_id/role', requireFetchHeader, requireRole(3), async (req, res) => {
    const { badge_id } = req.params;
    const { role } = req.body;
    try {
        if (!['super_admin', 'dept_admin', 'tool_rep', 'technician'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role.' });
        }
        const target = await pool.query('SELECT role FROM users WHERE badge_id = $1', [badge_id]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        if (req.authUser.weight <= getRoleWeight(target.rows[0].role)) return res.status(403).json({ error: 'Hierarchy Violation.' });
        if (getRoleWeight(role) > req.authUser.weight) return res.status(403).json({ error: 'Cannot promote a user above your own role.' });

        await pool.query('UPDATE users SET role = $1 WHERE badge_id = $2', [role, badge_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update role.' });
    }
});

// Replace a user's full set of granted cross-department access (delete-then-reinsert, not
// incremental add/remove) -- matches the "set the whole role" UX of the endpoint above rather
// than exposing separate grant/revoke calls. super_admin-only (requireRole(4)): a dept_admin
// granting another dept_admin extra departments would let peers hand each other access,
// bypassing the hierarchy checks the rest of this file enforces.
app.put('/api/users/:badge_id/department-access', requireFetchHeader, requireRole(4), async (req, res) => {
    const { badge_id } = req.params;
    const dept_ids = Array.isArray(req.body.dept_ids) ? req.body.dept_ids.map(id => parseInt(id, 10)) : [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const target = await client.query('SELECT user_id FROM users WHERE badge_id = $1', [badge_id]);
        if (target.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found.' }); }
        const userId = target.rows[0].user_id;

        if (dept_ids.length > 0) {
            const validDepts = await client.query('SELECT dept_id FROM departments WHERE dept_id = ANY($1::int[])', [dept_ids]);
            if (validDepts.rows.length !== new Set(dept_ids).size) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'One or more departments do not exist.' });
            }
        }

        await client.query('DELETE FROM user_department_access WHERE user_id = $1', [userId]);
        for (const deptId of new Set(dept_ids)) {
            await client.query(
                'INSERT INTO user_department_access (user_id, dept_id, granted_by_user_id) VALUES ($1, $2, $3)',
                [userId, deptId, req.authUser.user_id]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Department Access Update Error:', err);
        res.status(500).json({ error: 'Failed to update department access.' });
    } finally {
        client.release();
    }
});

// Self-service: let the logged-in admin update their own username and/or PIN. Scoped to
// req.authUser.badge_id (the verified session), never a client-supplied badge -- this
// used to let anyone change *any* badge's credentials by passing it as `requester`.
app.put('/api/users/me/update', requireFetchHeader, requireRole(1), async (req, res) => {
    const { new_username, new_pin } = req.body;
    try {
        if (new_username) await pool.query('UPDATE users SET username = $1 WHERE badge_id = $2', [new_username, req.authUser.badge_id]);
        if (new_pin) {
            if (!/^\d{4,10}$/.test(new_pin)) {
                return res.status(400).json({ error: 'PIN must be 4-10 digits.' });
            }
            await pool.query(
                'UPDATE users SET pin_hash = $1, failed_pin_attempts = 0, locked_until = NULL WHERE badge_id = $2',
                [await hashPin(new_pin), req.authUser.badge_id]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update account.' });
    }
});

// ==========================================
// 4. INFRASTRUCTURE & STORAGE MANAGEMENT
// ==========================================

// Fetch all departments, toolboxes, and drawers in one payload (no role check).
app.get('/api/storage', async (req, res) => {
    try {
        const depts = await pool.query('SELECT * FROM departments ORDER BY name');
        const boxes = await pool.query('SELECT * FROM toolboxes ORDER BY name');
        const drawers = await pool.query('SELECT * FROM drawers ORDER BY name');
        res.json({ success: true, departments: depts.rows, toolboxes: boxes.rows, drawers: drawers.rows });
    } catch (err) { 
        console.error("Storage GET Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Create a new department. Requires super_admin (getRoleWeight >= 4).
app.post('/api/departments', requireFetchHeader, requireRole(4), async (req, res) => {
    const { name, prefix_code } = req.body;
    try {
        const result = await pool.query('INSERT INTO departments (name, prefix_code) VALUES ($1, $2) RETURNING *', [name, prefix_code.toUpperCase()]);
        res.json({ success: true, department: result.rows[0] });
    } catch (err) {
        console.error("Department POST Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Rename a department. prefix_code is intentionally not editable here -- it's already
// baked into every existing toolbox/tool barcode ID under this department, so changing it
// after creation would desync those IDs from the department's current prefix. Requires
// super_admin (getRoleWeight >= 4), matching create/delete.
app.put('/api/departments/:id', requireFetchHeader, requireRole(4), async (req, res) => {
    const { name } = req.body;
    try {
        await pool.query('UPDATE departments SET name = $1 WHERE dept_id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update department.' });
    }
});

// Auto-generate a Barcode ID for Toolboxes (e.g. AVI-BOX-001). No role check.
// Same lowest-unused-number logic as /api/tools/next-id -- reuses a deleted box's number
// instead of always incrementing past the historical max.
app.get('/api/toolboxes/next-id', async (req, res) => {
    const { prefix } = req.query;
    if (!prefix) return res.status(400).json({ error: 'Prefix required.' });

    try {
        const query = `
            WITH used_numbers AS (
                SELECT CAST(NULLIF(regexp_replace(qr_code, '\\D', '', 'g'), '') AS INTEGER) AS num
                FROM toolboxes WHERE qr_code LIKE $1
            )
            SELECT MIN(gs.num) AS next_number
            FROM generate_series(1, (SELECT COALESCE(MAX(num), 0) FROM used_numbers) + 1) AS gs(num)
            WHERE NOT EXISTS (SELECT 1 FROM used_numbers u WHERE u.num = gs.num);
        `;
        const result = await pool.query(query, [`${prefix}BOX-%`]);
        const nextSequence = String(result.rows[0].next_number).padStart(3, '0');
        res.json({ success: true, next_sequence: `${prefix}BOX-${nextSequence}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to calculate Box ID.' });
    }
});

// Smart Builder: Create Box AND its Drawers in one transaction. Requires dept_admin+ (getRoleWeight >= 3).
app.post('/api/toolboxes', requireFetchHeader, requireRole(3), async (req, res) => {
    const { name, dept_id, qr_code, drawer_count } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Create the Toolbox with its Barcode ID
        const boxRes = await client.query(
            'INSERT INTO toolboxes (dept_id, name, qr_code) VALUES ($1, $2, $3) RETURNING *', 
            [dept_id, name, qr_code || null]
        );
        const newBox = boxRes.rows[0];

        // 2. Auto-generate the requested number of drawers
        const numDrawers = parseInt(drawer_count) || 0;
        for (let i = 1; i <= numDrawers; i++) {
            await client.query(
                'INSERT INTO drawers (box_id, name) VALUES ($1, $2)', 
                [newBox.box_id, `Drawer ${i}`]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, toolbox: newBox });
    } catch (err) { 
        await client.query('ROLLBACK');
        console.error("Toolbox Bulk POST Error:", err);
        res.status(500).json({ error: err.message }); 
    } finally {
        client.release();
    }
});

// Create a new drawer inside a toolbox. Requires dept_admin+ (getRoleWeight >= 3).
app.post('/api/drawers', requireFetchHeader, requireRole(3), async (req, res) => {
    const { box_id, name } = req.body;
    try {
        const result = await pool.query('INSERT INTO drawers (box_id, name) VALUES ($1, $2) RETURNING *', [box_id, name]);
        res.json({ success: true, drawer: result.rows[0] });
    } catch (err) { 
        console.error("Drawer POST Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Delete a department, but only if it has no toolboxes assigned to it. Requires super_admin.
app.delete('/api/departments/:id', requireFetchHeader, requireRole(4), async (req, res) => {
    try {
        const check = await pool.query('SELECT COUNT(*) FROM toolboxes WHERE dept_id = $1', [req.params.id]);
        if (parseInt(check.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        await pool.query('DELETE FROM departments WHERE dept_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to delete Department.' }); 
    }
});

// Delete a toolbox, but only if it has no drawers and no tools assigned to it. Requires dept_admin+.
app.delete('/api/toolboxes/:id', requireFetchHeader, requireRole(3), async (req, res) => {
    try {
        const checkDrawers = await pool.query('SELECT COUNT(*) FROM drawers WHERE box_id = $1', [req.params.id]);
        // FIX: tools has no box_id column; tools relate to toolboxes only via drawer_id -> drawers.box_id.
        // Count tools whose drawer belongs to this toolbox instead of filtering tools.box_id directly.
        const checkTools = await pool.query('SELECT COUNT(*) FROM tools t LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id WHERE dr.box_id = $1', [req.params.id]);
        if (parseInt(checkDrawers.rows[0].count) > 0 || parseInt(checkTools.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        const result = await pool.query('DELETE FROM toolboxes WHERE box_id = $1 RETURNING photo_url', [req.params.id]);
        deletePhotoFile(result.rows[0]?.photo_url);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete Toolbox.' });
    }
});

// Delete a drawer, but only if it has no tools assigned to it. Requires dept_admin+.
app.delete('/api/drawers/:id', requireFetchHeader, requireRole(3), async (req, res) => {
    try {
        const checkTools = await pool.query('SELECT COUNT(*) FROM tools WHERE drawer_id = $1', [req.params.id]);
        if (parseInt(checkTools.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        const result = await pool.query('DELETE FROM drawers WHERE drawer_id = $1 RETURNING photo_url', [req.params.id]);
        deletePhotoFile(result.rows[0]?.photo_url);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete Drawer.' });
    }
});

// ==========================================
// 5. ASSET CREATION & DELETION
// ==========================================
// Create a new tool, optionally retiring/replacing an existing tool_id. Requires tool_rep+ (getRoleWeight >= 2).
app.post('/api/tools', requireFetchHeader, requireRole(2), async (req, res) => {
    const { qr_code, name, description, replacement_url, drawer_id, replaced_tool_id, is_calibrated, last_cal_date, cal_due_date, serial_number, part_number } = req.body;
    try {
        const duplicate = await findDuplicateSerial(pool, serial_number);
        if (duplicate) {
            return res.status(409).json({ error: duplicateSerialErrorMessage(duplicate), code: 'DUPLICATE_SERIAL' });
        }
        const client = await pool.connect();
        let newToolId;
        try {
            await client.query('BEGIN');
            if (replaced_tool_id) {
                await client.query("UPDATE tools SET qr_code = qr_code || '-RET-' || tool_id, status = 'Retired' WHERE tool_id = $1", [replaced_tool_id]);
            }

            // Updated to include description, replacement_url, serial_number, and part_number
            const insertQuery = `INSERT INTO tools (qr_code, name, description, replacement_url, drawer_id, status, is_calibrated, last_cal_date, cal_due_date, serial_number, part_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING tool_id`;
            const insertRes = await client.query(insertQuery, [qr_code, name, description || null, replacement_url || null, drawer_id || null, 'In', is_calibrated || false, last_cal_date || null, cal_due_date || null, serial_number || null, part_number || null]);
            newToolId = insertRes.rows[0].tool_id;

            if (replaced_tool_id) {
                await client.query('UPDATE tools SET replaced_by_id = $1 WHERE tool_id = $2', [newToolId, replaced_tool_id]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK'); throw err;
        } finally {
            client.release();
        }

        // Auto-generate this tool's Data Matrix + Code 128 label images now that qr_code is
        // committed. Done outside the transaction (a filesystem write, not something to roll
        // back) and best-effort -- a label-generation failure shouldn't block tool creation
        // itself, since the tool record is already valid and useful without one (it can be
        // filled in later via scripts/backfill-barcode-labels.js).
        try {
            const labelUrls = await generateAllBarcodeLabels(qr_code, name);
            await saveBarcodeLabelUrls('tool_id', newToolId, labelUrls);
        } catch (labelErr) {
            console.error('Barcode label generation failed for', qr_code, labelErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add tool.' });
    }
});

// Delete a tool and its audit log history. Requires tool_rep+ (getRoleWeight >= 2).
app.delete('/api/tools/:tool_id', requireFetchHeader, requireRole(2), async (req, res) => {
    const { tool_id } = req.params;
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM audit_logs WHERE tool_id = $1', [tool_id]);
            const result = await client.query(
                `DELETE FROM tools WHERE tool_id = $1
                 RETURNING photo_url, barcode_image_url, barcode_image_url_small, barcode_image_url_large,
                           linear_barcode_image_url, linear_barcode_image_url_small, linear_barcode_image_url_large`,
                [tool_id]
            );
            await client.query('COMMIT');
            deletePhotoFile(result.rows[0]?.photo_url);
            deletePhotoFile(result.rows[0]?.barcode_image_url);
            deletePhotoFile(result.rows[0]?.barcode_image_url_small);
            deletePhotoFile(result.rows[0]?.barcode_image_url_large);
            deletePhotoFile(result.rows[0]?.linear_barcode_image_url);
            deletePhotoFile(result.rows[0]?.linear_barcode_image_url_small);
            deletePhotoFile(result.rows[0]?.linear_barcode_image_url_large);
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK'); throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete tool.' });
    }
});

// Update a Toolbox. Requires dept_admin+ (getRoleWeight >= 3).
app.put('/api/toolboxes/:id', requireFetchHeader, requireRole(3), async (req, res) => {
    const { name } = req.body;
    try {
        await pool.query('UPDATE toolboxes SET name = $1 WHERE box_id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update toolbox.' }); }
});

// Update a Drawer. Requires dept_admin+ (getRoleWeight >= 3).
app.put('/api/drawers/:id', requireFetchHeader, requireRole(3), async (req, res) => {
    const { name } = req.body;
    try {
        await pool.query('UPDATE drawers SET name = $1 WHERE drawer_id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update drawer.' }); }
});

// Update a Tool (name, description, status, calibration info). Requires tool_rep+ (getRoleWeight >= 2).
app.put('/api/tools/:id', requireFetchHeader, requireRole(2), async (req, res) => {
    const { name, description, replacement_url, status, is_calibrated, last_cal_date, cal_due_date, serial_number, part_number, drawer_id } = req.body;

    // If they checked the box but didn't provide a due date, throw an error
    if (is_calibrated && !cal_due_date) {
        return res.status(400).json({ error: 'Calibration Due Date is required.' });
    }
    if (!drawer_id) {
        return res.status(400).json({ error: 'A drawer/location is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // The entity modal's edit form always identifies a tool by its barcode ID (qr_code),
        // matching how it's looked up/opened everywhere else in admin.js (openEntityModal,
        // globalToolsCache) -- :id here is never the numeric tool_id, despite the route
        // param name. Resolving to the real tool_id up front (rather than trying to use the
        // qr_code text directly in a WHERE tool_id = ... comparison) is what was missing:
        // that mismatch made every save throw "invalid input syntax for type integer".
        const currentRes = await client.query('SELECT tool_id, status, name FROM tools WHERE qr_code = $1', [req.params.id]);
        if (currentRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tool not found.' }); }
        const toolId = currentRes.rows[0].tool_id;
        const previousStatus = currentRes.rows[0].status;
        const previousName = currentRes.rows[0].name;

        const transition = checkToolStatusTransition(previousStatus, status);
        if (!transition.allowed) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'That status change is not allowed.', code: transition.code });
        }

        // Lets a tool be moved to a different drawer -- including in a different toolbox or
        // department -- straight from the edit modal's Location cascade. Not blocked while
        // 'Out': the tool isn't physically in any drawer at that point anyway, so reassigning
        // where it lives once returned is a legitimate, unrelated action.
        const drawerRes = await client.query('SELECT drawer_id FROM drawers WHERE drawer_id = $1', [drawer_id]);
        if (drawerRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid drawer selected.' }); }

        const duplicateSerial = await findDuplicateSerial(client, serial_number, toolId);
        if (duplicateSerial) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: duplicateSerialErrorMessage(duplicateSerial), code: 'DUPLICATE_SERIAL' });
        }

        await client.query(
            `UPDATE tools
             SET name = $1, description = $2, replacement_url = $3, status = $4,
                 is_calibrated = $5, last_cal_date = $6, cal_due_date = $7,
                 serial_number = $8, part_number = $9, drawer_id = $10
             WHERE tool_id = $11`,
            [name, description || null, replacement_url || null, status,
             is_calibrated || false, last_cal_date || null, cal_due_date || null,
             serial_number || null, part_number || null, drawer_id, toolId]
        );

        // If this save just moved the tool OUT of a flagged state (Missing/Broken/Worn),
        // auto-close whatever OPEN tool_incidents row is behind it and log the resolution --
        // previously this whole path left no trace at all of who resolved a lost/broken tool
        // report or when. Doesn't require going through the dedicated resolve endpoint below;
        // that one exists for collecting resolution notes, but a plain edit-form save that
        // happens to change the status still gets the incident properly closed either way.
        if (['Missing', 'Broken', 'Worn'].includes(previousStatus) && previousStatus !== status) {
            const openIncidentRes = await client.query(
                "SELECT incident_id FROM tool_incidents WHERE tool_id = $1 AND status = 'OPEN' ORDER BY reported_at DESC LIMIT 1",
                [toolId]
            );
            if (openIncidentRes.rows.length > 0) {
                const resolution = status === 'Retired' ? 'WRITTEN_OFF' : 'RESOLVED';
                await client.query(
                    `UPDATE tool_incidents SET status = $1, resolved_by_user_id = $2, resolved_at = NOW() WHERE incident_id = $3`,
                    [resolution, req.authUser.user_id, openIncidentRes.rows[0].incident_id]
                );
                await client.query(
                    "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'INCIDENT_RESOLVED', $2, $3)",
                    [req.authUser.user_id, toolId, `Status changed from ${previousStatus} to ${status} via tool edit`]
                );
            }
        }

        await client.query('COMMIT');

        // Done outside the transaction (a filesystem write, not something to roll back) and
        // best-effort, same reasoning as label generation on tool creation -- a rename that
        // saved fine shouldn't be reported as failed just because regenerating its label
        // image (which just shows the name below the ID, see addNameRow) hit an error.
        if (name !== previousName) {
            try {
                const labelUrls = await generateAllBarcodeLabels(req.params.id, name);
                await saveBarcodeLabelUrls('tool_id', toolId, labelUrls);
            } catch (labelErr) {
                console.error('Barcode label regeneration failed for', req.params.id, labelErr.message);
            }
        }

        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Tool Update Error:", err);
        res.status(500).json({ error: 'Failed to update tool.' });
    } finally {
        client.release();
    }
});

// Sets (or clears) where a tool sits on its drawer's photo, for the visual shadow-board map
// (see migrations/009_tool_positions.sql). Deliberately separate from PUT /api/tools/:id --
// dragging a marker on a photo is a distinct, frequent, low-stakes action that shouldn't
// require going through the full tool edit form (and its calibration/status validation) --
// and it doesn't touch anything else about the tool, so it doesn't need a transaction.
// position_x/position_y are fractional (0.0-1.0) relative to the photo's own dimensions, not
// pixels -- pass both as numbers to place, or both as null to unplace (e.g. "remove marker").
// Requires tool_rep+, matching the same threshold as editing a tool's other fields.
app.put('/api/tools/:id/position', requireFetchHeader, requireRole(2), async (req, res) => {
    const { position_x, position_y } = req.body;
    const bothNumbers = typeof position_x === 'number' && typeof position_y === 'number';
    const bothNull = position_x === null && position_y === null;
    if (!bothNumbers && !bothNull) {
        return res.status(400).json({ error: 'position_x and position_y must both be numbers (to place) or both null (to unplace).' });
    }
    if (bothNumbers && (position_x < 0 || position_x > 1 || position_y < 0 || position_y > 1)) {
        return res.status(400).json({ error: 'position_x and position_y must be fractional values between 0 and 1.' });
    }
    try {
        const result = await pool.query(
            'UPDATE tools SET position_x = $1, position_y = $2 WHERE qr_code = $3 RETURNING tool_id',
            [position_x, position_y, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Tool not found.' });
        res.json({ success: true });
    } catch (err) {
        console.error("Tool Position Update Error:", err);
        res.status(500).json({ error: 'Failed to update tool position.' });
    }
});

// Full incident history for one tool -- every reported Missing/Broken/Worn cycle (see
// tool_incidents / migrations/007), newest first, so an admin can see the full lifecycle:
// when it was reported, where it was last known to be, and how/when/by whom it was
// resolved. requireRole(2) matches the existing view-inventory threshold (tool_rep+).
app.get('/api/tools/:id/incidents', requireRole(2), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ti.incident_id, ti.incident_type, ti.reported_at, ti.last_known_status, ti.last_known_location,
                    ti.description, ti.status, ti.resolution_notes, ti.resolved_at,
                    ru.full_name AS reported_by_name, xu.full_name AS resolved_by_name
             FROM tool_incidents ti
             LEFT JOIN users ru ON ti.reported_by_user_id = ru.user_id
             LEFT JOIN users xu ON ti.resolved_by_user_id = xu.user_id
             WHERE ti.tool_id = $1
             ORDER BY ti.reported_at DESC`,
            [req.params.id]
        );
        res.json({ success: true, incidents: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch incident history.' });
    }
});

// Resolves an OPEN incident from the admin panel, collecting resolution notes -- the
// recommended path (over just editing the tool's status directly, which PUT /api/tools/:id
// above still supports and will auto-close the incident for too, just without notes).
// requireRole(2) matches the tool-edit threshold. resolution must be 'RESOLVED' (tool is
// back in service, status -> 'In') or 'WRITTEN_OFF' (permanently retired, status -> 'Retired').
app.post('/api/tools/:id/incidents/:incident_id/resolve', requireFetchHeader, requireRole(2), async (req, res) => {
    const { resolution, resolution_notes } = req.body;
    if (!['RESOLVED', 'WRITTEN_OFF'].includes(resolution)) {
        return res.status(400).json({ error: "Resolution must be 'RESOLVED' or 'WRITTEN_OFF'." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const incidentRes = await client.query(
            "SELECT incident_id, tool_id, incident_type FROM tool_incidents WHERE incident_id = $1 AND tool_id = $2 AND status = 'OPEN'",
            [req.params.incident_id, req.params.id]
        );
        if (incidentRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Open incident not found for this tool.' });
        }
        const incident = incidentRes.rows[0];

        const newStatus = resolution === 'WRITTEN_OFF' ? 'Retired' : 'In';
        const transitionRes = await client.query('SELECT status FROM tools WHERE tool_id = $1', [incident.tool_id]);
        const transition = checkToolStatusTransition(transitionRes.rows[0].status, newStatus);
        if (!transition.allowed) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'That resolution is not allowed from this tool\'s current state.', code: transition.code });
        }

        await client.query('UPDATE tools SET status = $1, status_reason = NULL WHERE tool_id = $2', [newStatus, incident.tool_id]);
        await client.query(
            `UPDATE tool_incidents SET status = $1, resolution_notes = $2, resolved_by_user_id = $3, resolved_at = NOW() WHERE incident_id = $4`,
            [resolution, resolution_notes || null, req.authUser.user_id, incident.incident_id]
        );
        await client.query(
            "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'INCIDENT_RESOLVED', $2, $3)",
            [req.authUser.user_id, incident.tool_id, `${incident.incident_type} incident ${resolution.toLowerCase()}${resolution_notes ? ': ' + resolution_notes : ''}`]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Resolve Incident Error:', err);
        res.status(500).json({ error: 'Failed to resolve incident.' });
    } finally {
        client.release();
    }
});

// ==========================================
// 5.5 BULK INVENTORY BACKUP / IMPORT / EXPORT
// ==========================================
// Column set matches exactly what the regular tool create/edit UI already manages (see
// addNewTool()/saveEntityUpdates() in admin.js) -- no more, no less -- so a round trip
// through this CSV never touches a field the normal edit screen wouldn't. Department/
// Toolbox/Drawer are flattened into columns rather than raw ids so the file is directly
// Excel-editable; Barcode ID is the natural key tying a row back to a specific tool.
const TOOLS_CSV_COLUMNS = ['Department', 'Toolbox', 'Drawer', 'Barcode ID', 'Tool Name', 'Description', 'Serial Number', 'Part Number', 'Status', 'Requires Calibration', 'Last Calibrated', 'Calibration Due', 'Replacement URL'];

/** Formats a DATE column (returned by pg as a JS Date or null) as YYYY-MM-DD for CSV, or '' if null. */
const formatCsvDate = (d) => d ? d.toISOString().split('T')[0] : '';

// Full inventory export: one row per tool, hierarchy flattened into columns. Requires
// tool_rep+ (getRoleWeight >= 2) -- same threshold as viewing the inventory tree itself,
// since this is just that same data packaged as a file.
app.get('/api/tools/export', requireRole(2), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT d.name AS department, b.name AS toolbox, dr.name AS drawer,
                   t.qr_code, t.name, t.description, t.serial_number, t.part_number, t.status,
                   t.is_calibrated, t.last_cal_date, t.cal_due_date, t.replacement_url
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON dr.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            ORDER BY d.name ASC, b.name ASC, dr.name ASC, t.name ASC
        `);

        const rows = result.rows.map(t => ({
            'Department': t.department || '',
            'Toolbox': t.toolbox || '',
            'Drawer': t.drawer || '',
            'Barcode ID': t.qr_code,
            'Tool Name': t.name,
            'Description': t.description || '',
            'Serial Number': t.serial_number || '',
            'Part Number': t.part_number || '',
            'Status': t.status,
            'Requires Calibration': t.is_calibrated ? 'TRUE' : 'FALSE',
            'Last Calibrated': formatCsvDate(t.last_cal_date),
            'Calibration Due': formatCsvDate(t.cal_due_date),
            'Replacement URL': t.replacement_url || '',
        }));

        const csv = stringifyCsv(rows, { header: true, columns: TOOLS_CSV_COLUMNS });
        const filename = `tooltracker-inventory-${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (err) {
        console.error("Tools Export Error:", err);
        res.status(500).json({ error: 'Failed to export inventory.' });
    }
});

// Toolbox/drawer structure export: one row per drawer, independent of whether it has any
// tools in it. This is what actually captures an empty toolbox/drawer for backup purposes
// -- the tools export above only lists structure that currently has at least one tool
// assigned. Export only in this pass (no matching import) -- see plan notes.
app.get('/api/toolboxes/export', requireRole(2), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT d.name AS department, b.name AS toolbox, b.qr_code AS toolbox_barcode, dr.name AS drawer
            FROM drawers dr
            JOIN toolboxes b ON dr.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            ORDER BY d.name ASC, b.name ASC, dr.name ASC
        `);

        const columns = ['Department', 'Toolbox', 'Toolbox Barcode', 'Drawer'];
        const rows = result.rows.map(r => ({
            'Department': r.department || '',
            'Toolbox': r.toolbox,
            'Toolbox Barcode': r.toolbox_barcode || '',
            'Drawer': r.drawer,
        }));

        const csv = stringifyCsv(rows, { header: true, columns });
        const filename = `tooltracker-structure-${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (err) {
        console.error("Structure Export Error:", err);
        res.status(500).json({ error: 'Failed to export structure.' });
    }
});

// Bulk-download every non-retired tool's barcode label image as one ZIP -- the only way to
// get all of them off the Pi previously was pulling files by hand over SSH, which doesn't
// scale past a handful of tools and isn't something a non-technical admin can do at all.
// Built on a hand-rolled ZIP writer (scripts/lib/zip.js, stored/uncompressed -- the PNGs are
// already compressed at the image level) rather than a dependency, same reasoning as the
// hand-rolled PNG pHYs chunk in datamatrix.js. Flat archive (no per-department folders) to
// match how the CSV exports above are flat too -- filenames are already the barcode ID, which
// is enough to tell labels apart when printing.
// Scope is one of: ?dept_id=, ?box_id=, ?qr_code= (single tool), or none of those for
// every non-retired tool. Exactly one may be given -- combining them would be ambiguous
// about which takes precedence, so it's rejected rather than silently picking one.
app.get('/api/tools/labels/export', requireRole(2), async (req, res) => {
    const { dept_id, box_id, qr_code } = req.query;
    const scopeCount = [dept_id, box_id, qr_code].filter(v => v !== undefined && v !== '').length;
    if (scopeCount > 1) {
        return res.status(400).json({ error: 'Provide at most one of dept_id, box_id, or qr_code.' });
    }

    try {
        const result = await pool.query(
            `SELECT t.qr_code, t.barcode_image_url, t.barcode_image_url_small, t.barcode_image_url_large,
                    t.linear_barcode_image_url, t.linear_barcode_image_url_small, t.linear_barcode_image_url_large
             FROM tools t
             LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
             LEFT JOIN toolboxes b ON dr.box_id = b.box_id
             WHERE (t.barcode_image_url IS NOT NULL OR t.linear_barcode_image_url IS NOT NULL)
               AND t.status != 'Retired'
               AND ($1::int IS NULL OR b.dept_id = $1)
               AND ($2::int IS NULL OR b.box_id = $2)
               AND ($3::text IS NULL OR t.qr_code = $3)
             ORDER BY t.qr_code ASC`,
            [dept_id || null, box_id || null, qr_code || null]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No barcode labels to export for that selection.' });
        }

        // Organized as <format>/<size>/<qr_code>.png rather than one flat list -- format
        // (datamatrix vs. code128) matters for which scanner can read it at all, size for
        // which physical label stock it fits, so whoever's printing a batch for a specific
        // scanner/stock can grab just the one folder they need.
        const files = [];
        for (const tool of result.rows) {
            for (const [formatDir, format] of [['datamatrix', 'datamatrix'], ['code128', 'linear']]) {
                for (const size of ['small', 'medium', 'large']) {
                    const url = tool[BARCODE_LABEL_COLUMNS[`${format}-${size}`]];
                    if (!url) continue;
                    try {
                        files.push({ name: `${formatDir}/${size}/${tool.qr_code}.png`, data: fs.readFileSync(path.join(BARCODE_LABEL_DIR, path.basename(url))) });
                    } catch (readErr) {
                        console.error(`Skipping missing ${formatDir}/${size} label file for`, tool.qr_code, readErr.message);
                    }
                }
            }
        }

        const zip = buildZip(files);
        const scopeLabel = qr_code ? `-${qr_code}` : dept_id ? `-dept${dept_id}` : box_id ? `-box${box_id}` : '';
        const filename = `tooltracker-barcode-labels${scopeLabel}-${new Date().toISOString().split('T')[0]}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(zip);
    } catch (err) {
        console.error("Label Export Error:", err);
        res.status(500).json({ error: 'Failed to export labels.' });
    }
});

// Memory storage for the CSV import upload -- the file only needs to be parsed once, never
// persisted to disk (unlike the photo-upload multer instance below, which does need to keep
// the uploaded file).
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/** Lenient boolean parser for the "Requires Calibration" CSV column: accepts true/false/yes/no/1/0 case-insensitively. */
const parseCsvBoolean = (val) => ['true', 'yes', '1'].includes(String(val || '').trim().toLowerCase());

/**
 * Bulk tool import from the Tools CSV format (see TOOLS_CSV_COLUMNS). Best-effort, not
 * all-or-nothing -- one bad row (typo'd department/toolbox/drawer, illegal status change)
 * is reported and skipped, every other valid row in the same file still goes through, and
 * the full per-row report is returned so the operator can see exactly what happened.
 * Requires dept_admin+ (getRoleWeight >= 3) -- one tier above plain tool creation, since a
 * single file can create or change many tools at once.
 *
 * A row's Department/Toolbox/Drawer must already exist (looked up by exact name, scoped
 * correctly at each level) -- structure is never auto-created from a CSV row. A typo would
 * otherwise silently create a phantom duplicate toolbox, exactly the class of bug the
 * ingest-form cascade fix (see fetchNextToolId/populateBoxSelect in admin.js) just closed.
 * If Barcode ID matches an existing tool, that tool is updated (status changes still go
 * through the same checkToolStatusTransition() state machine PUT /api/tools/:id enforces);
 * otherwise a new tool is created.
 */
app.post('/api/tools/import', requireFetchHeader, requireRole(3), csvUpload.single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No CSV file provided.' });

    let records;
    try {
        records = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
        return res.status(400).json({ error: 'Could not parse CSV file: ' + err.message });
    }

    const results = [];
    let created = 0, updated = 0, errors = 0;

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2; // +2: 1-indexed, plus the header row itself
        const qr_code = (row['Barcode ID'] || '').trim();

        try {
            if (!qr_code) throw new Error('Barcode ID is required.');
            if (!row['Tool Name']?.trim()) throw new Error('Tool Name is required.');

            const deptRes = await pool.query('SELECT dept_id FROM departments WHERE name = $1', [(row['Department'] || '').trim()]);
            if (deptRes.rows.length === 0) throw new Error(`No department named "${row['Department']}" -- check for typos, or create it first.`);
            const deptId = deptRes.rows[0].dept_id;

            const boxRes = await pool.query('SELECT box_id FROM toolboxes WHERE name = $1 AND dept_id = $2', [(row['Toolbox'] || '').trim(), deptId]);
            if (boxRes.rows.length === 0) throw new Error(`No toolbox named "${row['Toolbox']}" in department "${row['Department']}" -- check for typos, or create it first.`);
            const boxId = boxRes.rows[0].box_id;

            const drawerRes = await pool.query('SELECT drawer_id FROM drawers WHERE name = $1 AND box_id = $2', [(row['Drawer'] || '').trim(), boxId]);
            if (drawerRes.rows.length === 0) throw new Error(`No drawer named "${row['Drawer']}" in toolbox "${row['Toolbox']}" -- check for typos, or create it first.`);
            const drawerId = drawerRes.rows[0].drawer_id;

            const is_calibrated = parseCsvBoolean(row['Requires Calibration']);
            const cal_due_date = row['Calibration Due']?.trim() || null;
            if (is_calibrated && !cal_due_date) throw new Error('Calibration Due is required when Requires Calibration is TRUE.');

            const fields = {
                name: row['Tool Name'].trim(),
                description: row['Description']?.trim() || null,
                serial_number: row['Serial Number']?.trim() || null,
                part_number: row['Part Number']?.trim() || null,
                replacement_url: row['Replacement URL']?.trim() || null,
                is_calibrated,
                last_cal_date: row['Last Calibrated']?.trim() || null,
                cal_due_date,
            };
            const requestedStatus = row['Status']?.trim() || 'In';

            const existingRes = await pool.query('SELECT tool_id, status, name FROM tools WHERE qr_code = $1', [qr_code]);

            if (existingRes.rows.length > 0) {
                const existing = existingRes.rows[0];
                const transition = checkToolStatusTransition(existing.status, requestedStatus);
                if (!transition.allowed) throw new Error(`Status change from "${existing.status}" to "${requestedStatus}" is not allowed (${transition.code}).`);

                const duplicateSerial = await findDuplicateSerial(pool, fields.serial_number, existing.tool_id);
                if (duplicateSerial) throw new Error(duplicateSerialErrorMessage(duplicateSerial));

                // drawer_id is included here (not just on create) so a re-imported row that
                // changed its Department/Toolbox/Drawer columns actually moves the tool --
                // the same export -> bulk-edit -> re-import round trip this endpoint exists
                // for should be able to relocate tools, not just edit their other fields.
                await pool.query(
                    `UPDATE tools SET name = $1, description = $2, replacement_url = $3, status = $4,
                            is_calibrated = $5, last_cal_date = $6, cal_due_date = $7,
                            serial_number = $8, part_number = $9, drawer_id = $10
                     WHERE tool_id = $11`,
                    [fields.name, fields.description, fields.replacement_url, requestedStatus,
                     fields.is_calibrated, fields.last_cal_date, fields.cal_due_date,
                     fields.serial_number, fields.part_number, drawerId, existing.tool_id]
                );
                updated++;

                // Same reasoning as PUT /api/tools/:id -- a renamed tool's label is stale
                // until regenerated, and a bulk export -> rename in Excel -> re-import is
                // exactly the workflow where a bunch of names would otherwise go stale at
                // once. Best-effort: a label failure shouldn't turn a successful row edit
                // into a reported error.
                let updateMessage = 'Updated existing tool.';
                if (fields.name !== existing.name) {
                    try {
                        const labelUrls = await generateAllBarcodeLabels(qr_code, fields.name);
                        await saveBarcodeLabelUrls('tool_id', existing.tool_id, labelUrls);
                    } catch (labelErr) {
                        console.error('Barcode label regeneration failed for', qr_code, labelErr.message);
                        updateMessage = 'Updated existing tool (barcode label regeneration failed -- can be regenerated later).';
                    }
                }
                results.push({ row: rowNum, barcode: qr_code, result: 'updated', message: updateMessage });
            } else {
                const duplicateSerial = await findDuplicateSerial(pool, fields.serial_number);
                if (duplicateSerial) throw new Error(duplicateSerialErrorMessage(duplicateSerial));

                await pool.query(
                    `INSERT INTO tools (qr_code, name, description, replacement_url, drawer_id, status, is_calibrated, last_cal_date, cal_due_date, serial_number, part_number)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [qr_code, fields.name, fields.description, fields.replacement_url, drawerId, 'In',
                     fields.is_calibrated, fields.last_cal_date, fields.cal_due_date, fields.serial_number, fields.part_number]
                );
                created++;

                // Best-effort, same reasoning as POST /api/tools -- a label-generation
                // failure shouldn't turn an otherwise-successful row into a reported error.
                let message = 'Created new tool.';
                try {
                    const labelUrls = await generateAllBarcodeLabels(qr_code, fields.name);
                    await saveBarcodeLabelUrls('qr_code', qr_code, labelUrls);
                } catch (labelErr) {
                    console.error('Barcode label generation failed for', qr_code, labelErr.message);
                    message = 'Created new tool (barcode label generation failed -- can be filled in later).';
                }
                results.push({ row: rowNum, barcode: qr_code, result: 'created', message });
            }
        } catch (err) {
            errors++;
            results.push({ row: rowNum, barcode: qr_code || '(missing)', result: 'error', message: err.message });
        }
    }

    res.json({ success: true, results, summary: { created, updated, errors } });
});

// ==========================================
// 6. PHOTO UPLOAD ENDPOINT
// ==========================================
// Upload a photo and attach it to a user/tool/toolbox/drawer record. Requires tool_rep+ (getRoleWeight >= 2)
// for tool photos, and dept_admin+ (getRoleWeight >= 3) for user/toolbox/drawer photos.
app.post('/api/upload', requireFetchHeader, requireRole(2), upload.single('photo'), async (req, res) => {
    const { entity_type, entity_id } = req.body;

    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
    if (!entity_type || !entity_id) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Tracks whichever file currently represents "the new photo" -- starts as multer's raw
    // upload, reassigned to the compressed copy below if that step succeeds. The catch block
    // at the bottom always cleans up whatever this currently points at, so a failure after
    // compression doesn't leak the compressed file the same way a failure before it doesn't
    // leak the original.
    let finalPath = req.file.path;
    let finalFilename = req.file.filename;

    try {
        if (req.authUser.weight < 3 && (entity_type === 'user' || entity_type === 'toolbox' || entity_type === 'drawer')) {
            throw new Error('You only have permission to upload tool assets.');
        }

        let table = '';
        let idColumn = '';
        if (entity_type === 'user') { table = 'users'; idColumn = 'badge_id'; }
        else if (entity_type === 'tool') { table = 'tools'; idColumn = 'qr_code'; }
        else if (entity_type === 'toolbox') { table = 'toolboxes'; idColumn = 'box_id'; }
        else if (entity_type === 'drawer') { table = 'drawers'; idColumn = 'drawer_id'; }
        else throw new Error('Invalid entity type.');

        // Compress/resize before this ever becomes a permanent photo_url -- phone camera
        // photos routinely land at 3-8MB with no benefit at the sizes this app actually
        // displays them (a ~40px thumbnail up to a lightbox capped well under full screen), and
        // this matters a lot on a Pi with a fixed-size external drive for public/uploads.
        // Written to a temp path first, then renamed over the final name, since sharp refuses
        // to use the same path for input and output (which would otherwise happen whenever the
        // original upload was already a .jpg). Falls back to keeping the untouched original if
        // sharp can't process it (e.g. an exotic format that slipped past the client's
        // accept="image/*") rather than blocking the upload entirely.
        try {
            const compressedFilename = path.parse(req.file.filename).name + '.jpg';
            const compressedPath = path.join(UPLOAD_DIR, compressedFilename);
            const tempPath = compressedPath + '.tmp';
            await sharp(req.file.path)
                .rotate() // apply EXIF orientation before it's stripped, so sideways/upside-down phone photos still display upright
                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 82 })
                .toFile(tempPath);
            fs.unlinkSync(req.file.path);
            fs.renameSync(tempPath, compressedPath);
            finalPath = compressedPath;
            finalFilename = compressedFilename;
        } catch (compressErr) {
            console.error('Photo compression failed, keeping original upload:', compressErr.message);
        }

        // Look up the entity's current photo (if any) before overwriting it, so the old file
        // can be cleaned up once the new one is confirmed saved -- previously every re-upload
        // for the same entity left the old file behind forever (a real storage leak on fixed
        // external storage), since multer gives every upload a unique filename and nothing
        // ever pointed back at the old one to delete it.
        const oldRes = await pool.query(`SELECT photo_url FROM ${table} WHERE ${idColumn} = $1`, [entity_id]);
        const oldPhotoUrl = oldRes.rows[0]?.photo_url;

        const photoUrl = `/uploads/${finalFilename}`;
        const query = `UPDATE ${table} SET photo_url = $1 WHERE ${idColumn} = $2 RETURNING *`;
        const result = await pool.query(query, [photoUrl, entity_id]);

        if (result.rows.length === 0) throw new Error(`Record not found in ${table}.`);

        if (oldPhotoUrl && oldPhotoUrl !== photoUrl) deletePhotoFile(oldPhotoUrl);

        res.json({ success: true, photo_url: photoUrl, message: 'Upload successful.' });
    } catch (err) {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        res.status(403).json({ error: err.message || 'Upload failed.' });
    }
});

// ==========================================
// 7. KIOSK TRANSACTIONS & AUDITS
// ==========================================
// Process Tool Check-in / Check-out. Requires dual-PIN sign-off for every transaction (technician
// badge+pin, PLUS a buddy-check sign-off PIN belonging to any other active person -- no role
// restriction, any coworker can confirm) and, for checkouts, a same-day AUDIT of the tool's home
// department (see getAuditGatePendingToolboxes).
app.post('/api/transactions', authLimiter, async (req, res) => {
    const { badge_id, pin, action, qr_codes, manager_pin, work_order } = req.body;
    const trimmedWorkOrder = (work_order || '').trim() || null;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Authenticate the Technician (badge_id + pin)
        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, dept_id, role, full_name, badge_id, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        // 2. Buddy sign-off PIN is now always required, for both checkout and check-in.
        if (!manager_pin) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Buddy sign-off PIN is required.', code: 'SIGNOFF_REQUIRED' });
        }

        // Hashed PINs can't be matched via a SQL WHERE clause (no signer badge_id is known
        // ahead of time -- the sign-off is identified purely by whoever's PIN matches), so
        // every active user is fetched and checked in turn. Any active person qualifies as
        // the buddy (no role restriction -- a technician can sign off another technician),
        // the only real requirement is being a different person (checked next). Shop-scale
        // candidate counts (dozens at most) make this negligible at bcrypt's cost factor.
        const candidatesRes = await client.query(
            "SELECT user_id, full_name, badge_id, role, pin_hash FROM users WHERE is_active = true"
        );
        let signoff = null;
        for (const candidate of candidatesRes.rows) {
            if (await bcrypt.compare(manager_pin, candidate.pin_hash)) {
                signoff = candidate;
                break;
            }
        }
        if (!signoff) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Invalid Buddy PIN.', code: 'BAD_PIN' });
        }

        // 3. The sign-off person cannot be the same person as the technician.
        if (signoff.user_id === user.user_id) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sign-off must be from a different person than the technician.', code: 'SIGNOFF_SAME_PERSON' });
        }

        const auditGateCache = {};
        const logNotes = `Signed off by: ${signoff.full_name} (${signoff.badge_id})`;

        // 4. Process each tool
        for (let qr of qr_codes) {
            // Get tool info AND its owning (home) department
            const toolQuery = `
                SELECT t.tool_id, t.name, t.status, t.is_calibrated, t.cal_due_date, b.dept_id AS tool_dept_id,
                       EXISTS(SELECT 1 FROM calibration_records cr WHERE cr.tool_id = t.tool_id) AS has_cal_record,
                       EXISTS(SELECT 1 FROM trace_investigations ti WHERE ti.tool_id = t.tool_id AND ti.status = 'OPEN') AS has_open_investigation
                FROM tools t
                LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
                LEFT JOIN toolboxes b ON dr.box_id = b.box_id
                WHERE t.qr_code = $1
            `;
            const toolRes = await client.query(toolQuery, [qr]);
            if (toolRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: `Tool ${qr} not found.`, code: 'TOOL_NOT_FOUND' });
            }
            const tool = toolRes.rows[0];

            if (action === 'CHECKOUT_TOOL') {
                // A0. TRACE-BACK INVESTIGATION HOLD -- checked directly against
                // trace_investigations.status rather than inferred from cal_due_date, and
                // applies to every tool (not just calibrated ones), since a manually-opened
                // investigation can exist for a non-calibrated tool too. Deliberately NOT
                // folded into the is_calibrated block below: a failed calibration also
                // back-dates cal_due_date so the CAL_EXPIRED check catches it too, but that
                // date is writable through PUT /api/tools/:id and CSV import by anyone with
                // tool-edit access -- checking the investigation's own OPEN status directly
                // means neither of those paths can silently clear the hold.
                if (tool.has_open_investigation) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: `Checkout Blocked: ${tool.name} has an open trace-back investigation!`, code: 'CAL_INVESTIGATION_OPEN' });
                }

                // A. CALIBRATION HARD-STOP -- a calibrated tool needs BOTH a valid (non-expired)
                // due date AND at least one calibration_records row (real evidence it was
                // actually calibrated, not just a manually-typed claim) to be issuable. Missing
                // either is functionally "locked" even though nothing stores a literal "locked"
                // flag -- same reasoning CalTool's dte.ts documents for its own two calibration
                // regimes: an in-date-looking tool with no certificate on file is not actually
                // trustworthy, so it must be as hard a stop as an expired one.
                if (tool.is_calibrated) {
                    if (!tool.cal_due_date) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({ error: `Checkout Blocked: ${tool.name} has no calibration due date on file!`, code: 'CAL_NO_DUE_DATE' });
                    }
                    const today = new Date();
                    const dueDate = new Date(tool.cal_due_date);
                    if (dueDate <= today) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({ error: `Checkout Blocked: ${tool.name} calibration is expired!`, code: 'CAL_EXPIRED' });
                    }
                    if (!tool.has_cal_record) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({ error: `Checkout Blocked: ${tool.name} has no calibration certificate on file!`, code: 'CAL_NO_CERTIFICATE' });
                    }
                }

                // B. TRANSFER LOCK
                if (tool.status === 'Pending Transfer' || tool.status === 'In Calibration') {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: `Checkout Blocked: ${tool.name} is currently in a QA transfer.`, code: 'TOOL_IN_TRANSFER' });
                }

                // C. AUDIT GATE (skip if the tool has no resolvable home department) --
                // uses getAuditGatePendingToolboxes()'s default windowStart (the current
                // morning-or-afternoon window, see getAuditWindowStart), not a calendar day.
                if (tool.tool_dept_id != null) {
                    if (!(tool.tool_dept_id in auditGateCache)) {
                        auditGateCache[tool.tool_dept_id] = await getAuditGatePendingToolboxes(client, tool.tool_dept_id);
                    }
                    const pendingToolboxes = auditGateCache[tool.tool_dept_id];
                    if (pendingToolboxes.length > 0) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({ error: `Checkout Blocked: department has not completed the required audit for this shift.`, code: 'AUDIT_REQUIRED', pending_toolboxes: pendingToolboxes });
                    }
                }

                // Execute Checkout
                await client.query("UPDATE tools SET status = 'Out' WHERE tool_id = $1", [tool.tool_id]);
                await client.query("INSERT INTO audit_logs (user_id, action, tool_id, notes, work_order) VALUES ($1, $2, $3, $4, $5)", [user.user_id, 'CHECKOUT_TOOL', tool.tool_id, logNotes, trimmedWorkOrder]);

            } else if (action === 'CHECKIN_TOOL') {
                // Inherit the work order from this tool's own last checkout rather than asking
                // the operator to retype/remember it at check-in -- a return is naturally tied
                // to whichever job it was taken out for, and that value is already on record.
                const lastCheckoutRes = await client.query(
                    "SELECT work_order FROM audit_logs WHERE tool_id = $1 AND action = 'CHECKOUT_TOOL' ORDER BY timestamp DESC LIMIT 1",
                    [tool.tool_id]
                );
                const inheritedWorkOrder = lastCheckoutRes.rows[0]?.work_order || null;

                await client.query("UPDATE tools SET status = 'In', status_reason = NULL WHERE tool_id = $1", [tool.tool_id]);
                await client.query("INSERT INTO audit_logs (user_id, action, tool_id, notes, work_order) VALUES ($1, $2, $3, $4, $5)", [user.user_id, 'CHECKIN_TOOL', tool.tool_id, logNotes, inheritedWorkOrder]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Transaction Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Fetch the 50 most recent audit log entries. Requires dept_admin+ (getRoleWeight >= 3).
app.get('/api/audit', requireRole(3), async (req, res) => {
    try {
        const query = `
            SELECT a.log_id, a.action, a.timestamp, a.notes, u.full_name AS user_name, u.badge_id, t.qr_code, t.name AS tool_name 
            FROM audit_logs a LEFT JOIN users u ON a.user_id = u.user_id LEFT JOIN tools t ON a.tool_id = t.tool_id 
            ORDER BY a.timestamp DESC LIMIT 50;
        `;
        const result = await pool.query(query); 
        res.json({ success: true, logs: result.rows });
    } catch (err) { 
        res.status(500).json({ error: 'Failed.' }); 
    }
});

// Process a full Toolbox Audit from the Kiosk. No minimum role (any active badge may audit
// their own department), but department-scoped roles are restricted to tools they can
// actually access -- see getUserAccess().
app.post('/api/audits/submit', async (req, res) => {
    const { badge_id, results } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const access = await getUserAccess(badge_id);
        if (!access) throw new Error('Invalid badge.');
        const userId = access.user_id;

        // Department-scoped roles may only audit tools in a department they can access;
        // super_admin is unrestricted. Checked against the actual department of every
        // tool_id in the submission (not just whichever toolbox the kiosk UI thinks it's
        // auditing) so this can't be bypassed by posting directly to this endpoint with a
        // different toolbox's tool_ids -- the client-side dropdown filter is a convenience,
        // this is the real enforcement.
        if (access.role !== 'super_admin') {
            const toolIds = results.map(item => item.tool_id);
            const deptCheck = await client.query(
                `SELECT t.tool_id, d.dept_id
                 FROM tools t
                 LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
                 LEFT JOIN toolboxes b ON dr.box_id = b.box_id
                 LEFT JOIN departments d ON b.dept_id = d.dept_id
                 WHERE t.tool_id = ANY($1::int[])`,
                [toolIds]
            );
            const unauthorized = deptCheck.rows.some(row => !access.accessibleDeptIds.includes(row.dept_id));
            if (unauthorized) throw new Error('You do not have access to audit one or more of these tools.');
        }

        // Iterate through the array of audited tools
        for (let item of results) {
            // If the tech marked it Present, it resets to "In". Otherwise, match the flagged issue.
            let newStatus = item.audit_status === 'Present' ? 'In' : item.audit_status;
            
            // 1. Update the Tool's physical status
            await client.query(
                'UPDATE tools SET status = $1, status_reason = $2 WHERE tool_id = $3', 
                [newStatus, item.audit_notes || null, item.tool_id]
            );

            // 2. Insert a definitive log of the audit
            const logNotes = `Audited as ${item.audit_status}` + (item.audit_notes ? ` - ${item.audit_notes}` : '');
            await client.query(
                'INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)', 
                [userId, 'AUDIT', item.tool_id, logNotes]
            );
        }
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Admin-panel-facing: current-audit-window status for every department, reusing the same
// AUDIT GATE helper the checkout flow relies on (empty pending-toolbox list => audited
// since the current window began -- see getAuditWindowStart for the morning/afternoon split).
app.get('/api/audits/today-status', async (req, res) => {
    try {
        const depts = await pool.query('SELECT dept_id, name FROM departments ORDER BY name ASC');
        const windowStart = getAuditWindowStart();
        const windowEnd = getAuditWindowEnd(windowStart);

        const departments = await Promise.all(depts.rows.map(async (dept) => {
            const { pending, completion } = await getAuditWindowCompletionInfo(dept.dept_id, windowStart);
            return {
                dept_id: dept.dept_id,
                name: dept.name,
                audit_completed: pending.length === 0,
                completed_at: completion ? completion.timestamp : null,
                window_start: windowStart,
            };
        }));

        res.json({ success: true, departments, window_start: windowStart, window_end: windowEnd });
    } catch (err) {
        console.error("Audit Today-Status Error:", err);
        res.status(500).json({ error: 'Failed to fetch audit status.' });
    }
});

// ==========================================
// 7.4 WORK ORDERS (optional, dormant until used -- see migrations/012_work_orders.sql)
// ==========================================
// A work order isn't its own entity -- it's a free-text label carried on
// audit_logs.work_order at checkout (and inherited automatically at check-in from the
// tool's own last checkout, see POST /api/transactions). These endpoints just group/query
// that column; nothing here is required for the app's existing checkout/check-in flow to
// keep working exactly as it always has for anyone who never types a work order in.

// Lists every distinct work order that's ever been used, newest activity first, with a
// live count of how many of its tools are still out (via each tool's OWN latest checkout --
// a tool re-issued later under a different work order no longer counts against this one)
// and its open/closed state. No role check -- same visibility level as the dashboard.
app.get('/api/work-orders', async (req, res) => {
    try {
        const result = await pool.query(`
            WITH latest_checkout AS (
                SELECT DISTINCT ON (tool_id) tool_id, work_order
                FROM audit_logs
                WHERE action = 'CHECKOUT_TOOL'
                ORDER BY tool_id, timestamp DESC
            )
            SELECT
                al.work_order,
                COUNT(DISTINCT al.tool_id) AS tool_count,
                COUNT(DISTINCT CASE WHEN t.status = 'Out' AND lc.work_order = al.work_order THEN al.tool_id END) AS out_count,
                MAX(al.timestamp) AS last_activity,
                woc.closed_at, woc.note AS close_note, u.full_name AS closed_by_name
            FROM audit_logs al
            JOIN tools t ON al.tool_id = t.tool_id
            LEFT JOIN latest_checkout lc ON lc.tool_id = t.tool_id
            LEFT JOIN work_order_closures woc ON woc.work_order = al.work_order
            LEFT JOIN users u ON woc.closed_by_user_id = u.user_id
            WHERE al.action = 'CHECKOUT_TOOL' AND al.work_order IS NOT NULL
            GROUP BY al.work_order, woc.closed_at, woc.note, u.full_name
            ORDER BY MAX(al.timestamp) DESC
        `);
        res.json({ success: true, work_orders: result.rows });
    } catch (err) {
        console.error('Work Orders List Error:', err);
        res.status(500).json({ error: 'Failed to fetch work orders.' });
    }
});

// Every tool ever checked out under one work order, most recent activity first, with who
// checked it out/in and when, and its current status.
app.get('/api/work-orders/:work_order/tools', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DISTINCT ON (al.tool_id)
                t.tool_id, t.qr_code, t.name AS tool_name, t.status AS current_status,
                al.timestamp AS checked_out_at, outUser.full_name AS checked_out_by,
                inLog.timestamp AS checked_in_at, inUser.full_name AS checked_in_by
             FROM audit_logs al
             JOIN tools t ON al.tool_id = t.tool_id
             LEFT JOIN users outUser ON al.user_id = outUser.user_id
             LEFT JOIN LATERAL (
                 SELECT timestamp, user_id FROM audit_logs
                 WHERE tool_id = al.tool_id AND action = 'CHECKIN_TOOL' AND work_order = al.work_order AND timestamp >= al.timestamp
                 ORDER BY timestamp ASC LIMIT 1
             ) inLog ON true
             LEFT JOIN users inUser ON inLog.user_id = inUser.user_id
             WHERE al.action = 'CHECKOUT_TOOL' AND al.work_order = $1
             ORDER BY al.tool_id, al.timestamp DESC`,
            [req.params.work_order]
        );
        const closureRes = await pool.query('SELECT closed_at, note FROM work_order_closures WHERE work_order = $1', [req.params.work_order]);
        res.json({ success: true, tools: result.rows, closed_at: closureRes.rows[0]?.closed_at || null });
    } catch (err) {
        console.error('Work Order Tools Error:', err);
        res.status(500).json({ error: 'Failed to fetch work order tools.' });
    }
});

// Closes a work order -- requires every tool checked out under it (by its OWN latest
// checkout) to currently be back. Requires tool_rep+ (getRoleWeight >= 2), matching the
// threshold for other day-to-day inventory actions.
app.post('/api/work-orders/:work_order/close', requireFetchHeader, requireRole(2), async (req, res) => {
    const { note } = req.body;
    try {
        const openRes = await pool.query(
            `WITH latest_checkout AS (
                SELECT DISTINCT ON (tool_id) tool_id, work_order
                FROM audit_logs WHERE action = 'CHECKOUT_TOOL'
                ORDER BY tool_id, timestamp DESC
             )
             SELECT t.qr_code, t.name FROM latest_checkout lc
             JOIN tools t ON t.tool_id = lc.tool_id
             WHERE lc.work_order = $1 AND t.status = 'Out'`,
            [req.params.work_order]
        );
        if (openRes.rows.length > 0) {
            return res.status(409).json({ error: `Cannot close -- ${openRes.rows.length} tool(s) still out (e.g. ${openRes.rows[0].name}).`, code: 'TOOLS_STILL_OUT' });
        }
        await pool.query(
            `INSERT INTO work_order_closures (work_order, note, closed_by_user_id) VALUES ($1, $2, $3)
             ON CONFLICT (work_order) DO UPDATE SET note = $2, closed_by_user_id = $3, closed_at = CURRENT_TIMESTAMP`,
            [req.params.work_order, note || null, req.authUser.user_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Work Order Close Error:', err);
        res.status(500).json({ error: 'Failed to close work order.' });
    }
});

// Reopens a closed work order (deleting the closure row is what "closed" means -- see
// migrations/012_work_orders.sql). Same threshold as closing.
app.post('/api/work-orders/:work_order/reopen', requireFetchHeader, requireRole(2), async (req, res) => {
    try {
        await pool.query('DELETE FROM work_order_closures WHERE work_order = $1', [req.params.work_order]);
        res.json({ success: true });
    } catch (err) {
        console.error('Work Order Reopen Error:', err);
        res.status(500).json({ error: 'Failed to reopen work order.' });
    }
});

// ==========================================
// 7.5 QA TRANSFERS (CALIBRATION HAND-OFF)
// ==========================================
// Lifecycle: AWAITING_QA_ACCEPT -> IN_CALIBRATION -> AWAITING_HOME_ACCEPT -> COMPLETE (or CANCELLED
// while still AWAITING_QA_ACCEPT). tools.drawer_id is never modified during this cycle -- only
// tools.status reflects the tool being temporarily away for calibration.

// Report a tool issue from the kiosk (Broken/Missing/Worn). Requires a valid technician
// badge+pin. Legal from either 'In' or 'Out' (see checkToolStatusTransition) -- reporting a
// tool broken or lost while it's checked out implicitly ends that checkout, since there's no
// "check it in clean, then separately flag it" step that could ever correctly represent a
// tool that broke or went missing in someone's hands. Not legal while 'Pending Transfer',
// 'In Calibration', or 'Retired'.
app.post('/api/kiosk/report-issue', authLimiter, async (req, res) => {
    const { badge_id, pin, qr_code, issue_type, notes } = req.body;

    if (!['Broken', 'Missing', 'Worn'].includes(issue_type)) {
        return res.status(400).json({ error: 'Invalid issue_type. Must be one of: Broken, Missing, Worn.', code: 'INVALID_ISSUE_TYPE' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        // Location/department snapshotted now (as text, not a foreign key) since it
        // describes where the tool WAS when this incident was reported -- if it's later
        // physically moved (or its drawer reassigned), the incident record shouldn't
        // silently follow it.
        const toolRes = await client.query(
            `SELECT t.tool_id, t.status, d.name AS dept_name, b.name AS box_name, dr.name AS drawer_name
             FROM tools t
             LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
             LEFT JOIN toolboxes b ON dr.box_id = b.box_id
             LEFT JOIN departments d ON b.dept_id = d.dept_id
             WHERE t.qr_code = $1`,
            [qr_code]
        );
        if (toolRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Tool not found.', code: 'TOOL_NOT_FOUND' });
        }
        const tool = toolRes.rows[0];

        const transition = checkToolStatusTransition(tool.status, issue_type);
        if (!transition.allowed) {
            await client.query('ROLLBACK');
            const message = transition.code === 'TOOL_IN_TRANSFER'
                ? 'Tool is currently in a QA transfer and cannot be reported right now.'
                : 'This tool cannot be reported in its current state.';
            return res.status(409).json({ error: message, code: transition.code });
        }

        await client.query('UPDATE tools SET status = $1, status_reason = $2 WHERE tool_id = $3', [issue_type, notes || null, tool.tool_id]);
        await client.query('INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)', [user.user_id, 'ISSUE_REPORT', tool.tool_id, notes || null]);

        const locationParts = [tool.dept_name, tool.box_name, tool.drawer_name].filter(Boolean);
        await client.query(
            `INSERT INTO tool_incidents (tool_id, incident_type, reported_by_user_id, last_known_status, last_known_location, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tool.tool_id, issue_type, user.user_id, tool.status, locationParts.join(' / ') || null, notes || null]
        );

        await client.query('COMMIT');
        res.json({ success: true, tool: { tool_id: tool.tool_id, status: issue_type } });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Report Issue Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Initiate a QA transfer for a tool. Home department is resolved server-side from the tool's
// drawer_id -> drawers.box_id -> toolboxes.dept_id; never trusts a client-supplied home dept.
app.post('/api/transfers/initiate', authLimiter, async (req, res) => {
    const { badge_id, pin, qr_code, qa_dept_id, notes } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        const toolQuery = `
            SELECT t.tool_id, t.status, t.drawer_id, b.dept_id AS home_dept_id
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON dr.box_id = b.box_id
            WHERE t.qr_code = $1
        `;
        const toolRes = await client.query(toolQuery, [qr_code]);
        if (toolRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Tool not found.', code: 'TOOL_NOT_FOUND' });
        }
        const tool = toolRes.rows[0];

        if (tool.home_dept_id == null) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Tool has no resolvable home department.', code: 'NO_HOME_DEPT' });
        }

        if (parseInt(qa_dept_id) === tool.home_dept_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'QA department cannot be the same as the home department.', code: 'SAME_DEPT' });
        }

        if (tool.status !== 'In') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Tool must be checked in to start a transfer.', code: 'TOOL_NOT_IN' });
        }

        let transferRes;
        try {
            transferRes = await client.query(
                `INSERT INTO tool_transfers (tool_id, home_dept_id, qa_dept_id, origin_drawer_id, initiated_by_user_id, notes)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING transfer_id, tool_id, home_dept_id, qa_dept_id, status, initiated_at`,
                [tool.tool_id, tool.home_dept_id, qa_dept_id, tool.drawer_id, user.user_id, notes || null]
            );
        } catch (insertErr) {
            if (insertErr.code === '23505') { // unique_violation on the partial "one active transfer" index
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'A transfer is already in progress for this tool.', code: 'TRANSFER_IN_PROGRESS' });
            }
            throw insertErr;
        }
        const transfer = transferRes.rows[0];

        await client.query("UPDATE tools SET status = 'Pending Transfer' WHERE tool_id = $1", [tool.tool_id]);
        await client.query(
            'INSERT INTO audit_logs (user_id, action, tool_id, box_id, notes) VALUES ($1, $2, $3, $4, $5)',
            [user.user_id, 'TRANSFER_INITIATE', tool.tool_id, null, notes || null]
        );

        await client.query('COMMIT');
        res.json({ success: true, transfer });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Transfer Initiate Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Fetch the QA-transfer queues relevant to the requester's own department.
// direction=incoming  -> { incoming: [...AWAITING_QA_ACCEPT for my dept as QA...], in_progress: [...IN_CALIBRATION for my dept as QA...] }
// direction=outgoing  -> { outgoing: [...AWAITING_HOME_ACCEPT + IN_CALIBRATION for my dept as home...] }
app.get('/api/transfers', async (req, res) => {
    const { badge_id, direction } = req.query;
    if (!badge_id) return res.status(401).json({ error: 'Unauthorized.' });

    try {
        const userRes = await pool.query('SELECT dept_id FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) return res.status(403).json({ error: 'Invalid account.' });
        const deptId = userRes.rows[0].dept_id;

        const baseSelect = `
            SELECT tr.transfer_id, tr.tool_id, t.qr_code, t.name AS tool_name,
                   hd.name AS home_dept_name, qd.name AS qa_dept_name,
                   tr.status, tr.initiated_at, tr.notes, u.full_name AS initiated_by_name
            FROM tool_transfers tr
            JOIN tools t ON tr.tool_id = t.tool_id
            LEFT JOIN departments hd ON tr.home_dept_id = hd.dept_id
            LEFT JOIN departments qd ON tr.qa_dept_id = qd.dept_id
            LEFT JOIN users u ON tr.initiated_by_user_id = u.user_id
        `;

        if (direction === 'incoming') {
            const incomingRes = await pool.query(`${baseSelect} WHERE tr.qa_dept_id = $1 AND tr.status = 'AWAITING_QA_ACCEPT' ORDER BY tr.initiated_at ASC`, [deptId]);
            const inProgressRes = await pool.query(`${baseSelect} WHERE tr.qa_dept_id = $1 AND tr.status = 'IN_CALIBRATION' ORDER BY tr.initiated_at ASC`, [deptId]);
            return res.json({ success: true, incoming: incomingRes.rows, in_progress: inProgressRes.rows });
        } else if (direction === 'outgoing') {
            const outgoingRes = await pool.query(
                `${baseSelect} WHERE tr.home_dept_id = $1 AND tr.status IN ('AWAITING_HOME_ACCEPT', 'IN_CALIBRATION') ORDER BY tr.initiated_at ASC`,
                [deptId]
            );
            return res.json({ success: true, outgoing: outgoingRes.rows });
        } else {
            return res.status(400).json({ error: 'direction must be "incoming" or "outgoing".' });
        }
    } catch (err) {
        console.error("Transfers GET Error:", err);
        res.status(500).json({ error: 'Failed to fetch transfers.' });
    }
});

// QA side accepts an incoming transfer and begins calibration.
app.post('/api/transfers/:transfer_id/qa-accept', authLimiter, async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, dept_id, role, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        const transferRes = await client.query('SELECT * FROM tool_transfers WHERE transfer_id = $1', [transfer_id]);
        if (transferRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transfer not found.', code: 'TRANSFER_NOT_FOUND' });
        }
        const transfer = transferRes.rows[0];

        if (transfer.status !== 'AWAITING_QA_ACCEPT') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Transfer is not awaiting QA acceptance.', code: 'INVALID_TRANSFER_STATE' });
        }

        if (user.dept_id !== transfer.qa_dept_id && getRoleWeight(user.role) < 3) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the QA department may accept this transfer.', code: 'WRONG_DEPT' });
        }

        await client.query(
            "UPDATE tool_transfers SET status = 'IN_CALIBRATION', qa_accepted_by_user_id = $1, qa_accepted_at = NOW(), updated_at = NOW() WHERE transfer_id = $2",
            [user.user_id, transfer_id]
        );
        await client.query("UPDATE tools SET status = 'In Calibration' WHERE tool_id = $1", [transfer.tool_id]);
        await client.query(
            "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'TRANSFER_ACCEPT', $2, 'QA department accepted transfer for calibration')",
            [user.user_id, transfer.tool_id]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("QA Accept Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// QA side marks calibration complete and sends the tool back to its home department.
// provider/certificate_number are required (not just last_cal_date/cal_due_date) so every
// completed calibration leaves a permanent, traceable calibration_records row -- see
// migrations/006_calibration_history.sql for why a snapshot on the tools row alone isn't
// enough for FAA-grade calibration traceability.
app.post('/api/transfers/:transfer_id/complete-cal', authLimiter, async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin, last_cal_date, cal_due_date, provider, certificate_number, standard_used, notes, result } = req.body;
    const calResult = result === 'Fail' ? 'Fail' : 'Pass';
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, dept_id, role, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        const transferRes = await client.query('SELECT * FROM tool_transfers WHERE transfer_id = $1', [transfer_id]);
        if (transferRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transfer not found.', code: 'TRANSFER_NOT_FOUND' });
        }
        const transfer = transferRes.rows[0];

        if (transfer.status !== 'IN_CALIBRATION') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Transfer is not currently in calibration.', code: 'INVALID_TRANSFER_STATE' });
        }

        if (user.dept_id !== transfer.qa_dept_id && getRoleWeight(user.role) < 3) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the QA department may complete this calibration.', code: 'WRONG_DEPT' });
        }

        if (!last_cal_date || !cal_due_date) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Calibration date and due date are both required.', code: 'CAL_DUE_DATE_REQUIRED' });
        }
        if (!provider || !certificate_number) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Calibration provider and certificate/reference number are both required for a traceable record.', code: 'CAL_TRACEABILITY_REQUIRED' });
        }

        // A failed calibration still completes the hand-off (the tool returns to its home
        // department -- there's no separate "hold at QA" state), but its due date is
        // back-dated to the calibration date itself as a secondary block signal (the primary
        // one is the trace-back investigation opened below, checked directly via
        // CAL_INVESTIGATION_OPEN, which can't be silently cleared by a later edit the way a
        // due date can).
        const effectiveDueDate = calResult === 'Fail' ? last_cal_date : cal_due_date;
        const toolRes = await client.query(
            `UPDATE tools SET last_cal_date = $1, cal_due_date = $2, is_calibrated = true, status = 'Pending Transfer'
             WHERE tool_id = $3 RETURNING tool_id, last_cal_date, cal_due_date`,
            [last_cal_date, effectiveDueDate, transfer.tool_id]
        );
        const transferUpdRes = await client.query(
            `UPDATE tool_transfers SET status = 'AWAITING_HOME_ACCEPT', cal_completed_by_user_id = $1, cal_completed_at = NOW(), updated_at = NOW()
             WHERE transfer_id = $2 RETURNING transfer_id, tool_id, home_dept_id, qa_dept_id, status, initiated_at`,
            [user.user_id, transfer_id]
        );
        const calRes = await client.query(
            `INSERT INTO calibration_records (tool_id, cal_date, due_date, provider, certificate_number, standard_used, notes, recorded_by_user_id, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING cal_id`,
            [transfer.tool_id, last_cal_date, cal_due_date, provider, certificate_number, standard_used || null, notes || null, user.user_id, calResult]
        );
        await client.query(
            "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'CAL_COMPLETE', $2, $3)",
            [user.user_id, transfer.tool_id, `Calibration completed by ${provider} (cert ${certificate_number}); awaiting home department acceptance${calResult === 'Fail' ? ' -- FAILED' : ''}`]
        );

        if (calResult === 'Fail') {
            await triggerFailedCalibration(client, {
                toolId: transfer.tool_id, calDate: last_cal_date, provider, certificateNumber: certificate_number,
                calId: calRes.rows[0].cal_id, userId: user.user_id
            });
        }

        await client.query('COMMIT');
        res.json({ success: true, transfer: transferUpdRes.rows[0], tool: toolRes.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Complete Cal Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Home department accepts the returned, calibrated tool back.
app.post('/api/transfers/:transfer_id/home-accept', authLimiter, async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, dept_id, role, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        const transferRes = await client.query('SELECT * FROM tool_transfers WHERE transfer_id = $1', [transfer_id]);
        if (transferRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transfer not found.', code: 'TRANSFER_NOT_FOUND' });
        }
        const transfer = transferRes.rows[0];

        if (transfer.status !== 'AWAITING_HOME_ACCEPT') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Transfer is not awaiting home department acceptance.', code: 'INVALID_TRANSFER_STATE' });
        }

        if (user.dept_id !== transfer.home_dept_id && getRoleWeight(user.role) < 3) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the home department may accept this return.', code: 'WRONG_DEPT' });
        }

        // drawer_id was never touched during the transfer, so the tool is already correctly filed.
        await client.query("UPDATE tools SET status = 'In' WHERE tool_id = $1", [transfer.tool_id]);
        await client.query(
            "UPDATE tool_transfers SET status = 'COMPLETE', home_accepted_by_user_id = $1, home_accepted_at = NOW(), updated_at = NOW() WHERE transfer_id = $2",
            [user.user_id, transfer_id]
        );
        await client.query(
            "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'TRANSFER_ACCEPT', $2, 'Home department accepted return of calibrated tool')",
            [user.user_id, transfer.tool_id]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Home Accept Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Cancel a transfer. Only legal while still AWAITING_QA_ACCEPT (before QA has taken possession).
app.post('/api/transfers/:transfer_id/cancel', authLimiter, async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin, reason } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lockout = await checkLockout(badge_id);
        if (lockout.locked) { await client.query('ROLLBACK'); return res.status(423).json(LOCKOUT_RESPONSE); }

        const userRes = await client.query('SELECT user_id, role, pin_hash FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0 || !(await bcrypt.compare(pin, userRes.rows[0].pin_hash))) {
            await recordFailedPinAttempt(badge_id);
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];
        await resetFailedPinAttempts(badge_id);

        const transferRes = await client.query('SELECT * FROM tool_transfers WHERE transfer_id = $1', [transfer_id]);
        if (transferRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transfer not found.', code: 'TRANSFER_NOT_FOUND' });
        }
        const transfer = transferRes.rows[0];

        if (transfer.status !== 'AWAITING_QA_ACCEPT') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Transfer can only be cancelled before QA has accepted it.', code: 'INVALID_TRANSFER_STATE' });
        }

        if (user.user_id !== transfer.initiated_by_user_id && getRoleWeight(user.role) < 3) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the initiator or an admin may cancel this transfer.', code: 'WRONG_DEPT' });
        }

        await client.query("UPDATE tools SET status = 'In' WHERE tool_id = $1", [transfer.tool_id]);
        await client.query(
            "UPDATE tool_transfers SET status = 'CANCELLED', cancelled_reason = $1, updated_at = NOW() WHERE transfer_id = $2",
            [reason || null, transfer_id]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Transfer Cancel Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 7.6 TRACE-BACK INVESTIGATIONS (see migrations/013_trace_investigations.sql)
// ==========================================
// A tool that fails calibration means every task it performed since it was LAST known-good
// is suspect -- these endpoints track that suspect window as an "investigation" with one
// "review" row per checkout inside it, so a supervisor can work through and document what
// each task needs (re-check, nothing, doesn't matter). Investigations auto-open (see
// openOrExtendTraceInvestigation()) the moment a Fail result is logged via either
// calibration-recording endpoint; they can also be opened manually here for a tool that's
// suspect for some other reason (e.g. a customer complaint) without an actual failed
// calibration behind it.

// Shop-wide list, newest first, with review-progress counts. No role check -- same
// visibility level as the dashboard and Work Orders list.
app.get('/api/trace-investigations', async (req, res) => {
    const { status } = req.query;
    try {
        const result = await pool.query(
            `SELECT ti.investigation_id, ti.tool_id, t.qr_code, t.name AS tool_name,
                    ti.reason, ti.window_start, ti.window_end, ti.status, ti.overridden, ti.conclusion,
                    ti.created_at, ti.closed_at,
                    opener.full_name AS opened_by_name, closer.full_name AS closed_by_name,
                    COUNT(tr.review_id) AS review_count,
                    COUNT(tr.review_id) FILTER (WHERE tr.outcome != 'PENDING') AS reviewed_count,
                    COUNT(tr.review_id) FILTER (WHERE tr.outcome = 'OUT_OF_TOLERANCE') AS out_of_tolerance_count
             FROM trace_investigations ti
             JOIN tools t ON t.tool_id = ti.tool_id
             LEFT JOIN users opener ON ti.opened_by_user_id = opener.user_id
             LEFT JOIN users closer ON ti.closed_by_user_id = closer.user_id
             LEFT JOIN trace_reviews tr ON tr.investigation_id = ti.investigation_id
             WHERE ($1::text IS NULL OR ti.status = $1)
             GROUP BY ti.investigation_id, t.qr_code, t.name, opener.full_name, closer.full_name
             ORDER BY ti.created_at DESC`,
            [status || null]
        );
        res.json({ success: true, investigations: result.rows });
    } catch (err) {
        console.error('Trace Investigations List Error:', err);
        res.status(500).json({ error: 'Failed to fetch trace investigations.' });
    }
});

// Investigations for one tool (for the tool detail modal). No role check, matching
// Calibration History/Incident History on the same modal.
app.get('/api/tools/:id/trace-investigations', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ti.investigation_id, ti.reason, ti.window_start, ti.window_end, ti.status,
                    ti.overridden, ti.conclusion, ti.created_at, ti.closed_at,
                    opener.full_name AS opened_by_name, closer.full_name AS closed_by_name,
                    COUNT(tr.review_id) AS review_count,
                    COUNT(tr.review_id) FILTER (WHERE tr.outcome != 'PENDING') AS reviewed_count
             FROM trace_investigations ti
             LEFT JOIN users opener ON ti.opened_by_user_id = opener.user_id
             LEFT JOIN users closer ON ti.closed_by_user_id = closer.user_id
             LEFT JOIN trace_reviews tr ON tr.investigation_id = ti.investigation_id
             WHERE ti.tool_id = $1
             GROUP BY ti.investigation_id, opener.full_name, closer.full_name
             ORDER BY ti.created_at DESC`,
            [req.params.id]
        );
        res.json({ success: true, investigations: result.rows });
    } catch (err) {
        console.error('Tool Trace Investigations Error:', err);
        res.status(500).json({ error: 'Failed to fetch trace investigations.' });
    }
});

// Full detail for one investigation, including every review row, oldest task first.
app.get('/api/trace-investigations/:id', async (req, res) => {
    try {
        const [invRes, reviewsRes] = await Promise.all([
            pool.query(
                `SELECT ti.*, t.qr_code, t.name AS tool_name,
                        opener.full_name AS opened_by_name, closer.full_name AS closed_by_name
                 FROM trace_investigations ti
                 JOIN tools t ON t.tool_id = ti.tool_id
                 LEFT JOIN users opener ON ti.opened_by_user_id = opener.user_id
                 LEFT JOIN users closer ON ti.closed_by_user_id = closer.user_id
                 WHERE ti.investigation_id = $1`,
                [req.params.id]
            ),
            pool.query(
                `SELECT tr.*, checkedWith.qr_code AS checked_with_qr_code, checkedWith.name AS checked_with_name,
                        reviewer.full_name AS reviewed_by_name
                 FROM trace_reviews tr
                 LEFT JOIN tools checkedWith ON tr.checked_with_tool_id = checkedWith.tool_id
                 LEFT JOIN users reviewer ON tr.reviewed_by_user_id = reviewer.user_id
                 WHERE tr.investigation_id = $1
                 ORDER BY tr.used_at ASC`,
                [req.params.id]
            )
        ]);
        if (invRes.rows.length === 0) return res.status(404).json({ error: 'Investigation not found.' });
        res.json({ success: true, investigation: invRes.rows[0], reviews: reviewsRes.rows });
    } catch (err) {
        console.error('Trace Investigation Detail Error:', err);
        res.status(500).json({ error: 'Failed to fetch trace investigation.' });
    }
});

// Manually opens an investigation for a tool that's suspect for some reason other than a
// failed calibration (e.g. a customer complaint about a specific task). requireRole(3)
// (dept_admin+) -- opening one is a judgment call, not a routine day-to-day action.
app.post('/api/tools/:id/trace-investigations', requireFetchHeader, requireRole(3), async (req, res) => {
    const { reason, window_start, window_end } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to open an investigation.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const toolRes = await client.query('SELECT tool_id FROM tools WHERE tool_id = $1', [req.params.id]);
        if (toolRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tool not found.' }); }

        const investigationId = await openOrExtendTraceInvestigation(client, {
            toolId: req.params.id,
            reason: reason.trim(),
            windowStart: window_start || null,
            windowEnd: window_end || new Date().toISOString(),
            triggeringCalId: null,
            openedByUserId: req.authUser.user_id
        });

        await client.query('COMMIT');
        res.json({ success: true, investigation_id: investigationId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Open Trace Investigation Error:', err);
        res.status(500).json({ error: 'Failed to open investigation.' });
    } finally {
        client.release();
    }
});

// Records the outcome of one review row (one checked-out task inside the suspect window).
// requireRole(3), matching who may open/close an investigation.
app.post('/api/trace-investigations/:id/reviews/:review_id', requireFetchHeader, requireRole(3), async (req, res) => {
    const { outcome, notes, checked_with_tool_id } = req.body;
    if (!['IN_TOLERANCE', 'OUT_OF_TOLERANCE', 'NOT_APPLICABLE'].includes(outcome)) {
        return res.status(400).json({ error: 'outcome must be one of: IN_TOLERANCE, OUT_OF_TOLERANCE, NOT_APPLICABLE.' });
    }
    try {
        const result = await pool.query(
            `UPDATE trace_reviews SET outcome = $1, notes = $2, checked_with_tool_id = $3,
                    reviewed_by_user_id = $4, reviewed_at = CURRENT_TIMESTAMP
             WHERE review_id = $5 AND investigation_id = $6
             RETURNING review_id`,
            [outcome, notes || null, checked_with_tool_id || null, req.authUser.user_id, req.params.review_id, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Review not found on this investigation.' });
        res.json({ success: true });
    } catch (err) {
        console.error('Trace Review Update Error:', err);
        res.status(500).json({ error: 'Failed to update review.' });
    }
});

// Closes an investigation -- requires every review to have a recorded outcome first (use
// /override to force-close with reviews still pending). requireRole(3).
app.post('/api/trace-investigations/:id/close', requireFetchHeader, requireRole(3), async (req, res) => {
    const { conclusion } = req.body;
    if (!conclusion || !conclusion.trim()) return res.status(400).json({ error: 'A closing conclusion is required.' });
    try {
        const pendingRes = await pool.query(
            `SELECT COUNT(*) AS pending_count FROM trace_reviews WHERE investigation_id = $1 AND outcome = 'PENDING'`,
            [req.params.id]
        );
        if (Number(pendingRes.rows[0].pending_count) > 0) {
            return res.status(409).json({
                error: `Cannot close -- ${pendingRes.rows[0].pending_count} review(s) still pending. Use override to force-close.`,
                code: 'REVIEWS_STILL_PENDING'
            });
        }
        const result = await pool.query(
            `UPDATE trace_investigations SET status = 'CLOSED', conclusion = $1, closed_by_user_id = $2, closed_at = CURRENT_TIMESTAMP
             WHERE investigation_id = $3 AND status = 'OPEN' RETURNING investigation_id`,
            [conclusion.trim(), req.authUser.user_id, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Investigation not found or already closed.' });
        res.json({ success: true });
    } catch (err) {
        console.error('Trace Investigation Close Error:', err);
        res.status(500).json({ error: 'Failed to close investigation.' });
    }
});

// Force-closes an investigation regardless of pending reviews, with a mandatory reason --
// a permanent record of who waived what and why. requireRole(3).
app.post('/api/trace-investigations/:id/override', requireFetchHeader, requireRole(3), async (req, res) => {
    const { conclusion, override_reason } = req.body;
    if (!conclusion || !conclusion.trim()) return res.status(400).json({ error: 'A closing conclusion is required.' });
    if (!override_reason || !override_reason.trim()) return res.status(400).json({ error: 'A reason for overriding pending reviews is required.' });
    try {
        const result = await pool.query(
            `UPDATE trace_investigations SET status = 'CLOSED', conclusion = $1, closed_by_user_id = $2, closed_at = CURRENT_TIMESTAMP,
                    overridden = true, override_reason = $3
             WHERE investigation_id = $4 AND status = 'OPEN' RETURNING investigation_id`,
            [conclusion.trim(), req.authUser.user_id, override_reason.trim(), req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Investigation not found or already closed.' });
        res.json({ success: true });
    } catch (err) {
        console.error('Trace Investigation Override Error:', err);
        res.status(500).json({ error: 'Failed to override investigation.' });
    }
});

// Reopens a closed investigation (e.g. closed in error). requireRole(3).
app.post('/api/trace-investigations/:id/reopen', requireFetchHeader, requireRole(3), async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE trace_investigations SET status = 'OPEN', closed_by_user_id = NULL, closed_at = NULL
             WHERE investigation_id = $1 AND status = 'CLOSED' RETURNING investigation_id`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Investigation not found or not closed.' });
        res.json({ success: true });
    } catch (err) {
        console.error('Trace Investigation Reopen Error:', err);
        res.status(500).json({ error: 'Failed to reopen investigation.' });
    }
});

// ==========================================
// 8. DASHBOARD & REPORTS
// ==========================================
// Fetch summary stats plus lists of checked-out, flagged, and calibration-tracked tools. No role check.
app.get('/api/dashboard', async (req, res) => {
    try {
        const totalTools = await pool.query("SELECT COUNT(*) FROM tools WHERE status != 'Retired'");
        const totalOut = await pool.query("SELECT COUNT(*) FROM tools WHERE status = 'Out'");
        const totalFlagged = await pool.query("SELECT COUNT(*) FROM tools WHERE status IN ('Missing', 'Broken', 'Worn')");

        // Checked Out Tools
        const outQuery = `
            SELECT t.qr_code, t.name AS tool_name, u.full_name AS user_name, al.timestamp, d.name AS dept_name, b.name AS box_name
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON dr.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            LEFT JOIN LATERAL (SELECT user_id, timestamp FROM audit_logs WHERE tool_id = t.tool_id AND action = 'CHECKOUT_TOOL' ORDER BY timestamp DESC LIMIT 1) al ON true
            LEFT JOIN users u ON al.user_id = u.user_id
            WHERE t.status = 'Out' ORDER BY al.timestamp DESC LIMIT 50;
        `;
        const outTools = await pool.query(outQuery);

        // Maintenance Flagged Tools (Separated)
        const flagQuery = `
            SELECT t.qr_code, t.name AS tool_name, t.status, t.status_reason, d.name AS dept_name, b.name AS box_name
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON dr.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            WHERE t.status IN ('Missing', 'Broken', 'Worn') ORDER BY t.name ASC;
        `;
        const flaggedTools = await pool.query(flagQuery);

        // Calibration Tools (Separated)
        const calQuery = `
            SELECT t.qr_code, t.name AS tool_name, t.cal_due_date, d.name AS dept_name, b.name AS box_name
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON dr.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            WHERE t.is_calibrated = true AND t.status != 'Retired' ORDER BY t.cal_due_date ASC;
        `;
        const calTools = await pool.query(calQuery);

        res.json({
            success: true,
            stats: { total_tools: parseInt(totalTools.rows[0].count), total_out: parseInt(totalOut.rows[0].count), total_flagged: parseInt(totalFlagged.rows[0].count) },
            out_tools: outTools.rows,
            flagged_tools: flaggedTools.rows,
            cal_tools: calTools.rows // Sending the new array to the frontend
        });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch dashboard data.' }); }
});

// Daily checkout/check-in counts for the last N days (default 30), for the dashboard's
// activity-trend chart. No role check, matching the rest of this file's dashboard/telemetry
// endpoints (dashboard.html itself has no auth wall -- it's a read-only global view). Days
// with zero activity are still included (zero-filled client-side, not here) so the chart's
// x-axis stays evenly spaced; this endpoint only returns days that actually have rows.
app.get('/api/dashboard/activity-trend', async (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    try {
        const result = await pool.query(
            `SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS day, action, COUNT(*) AS count
             FROM audit_logs
             WHERE action IN ('CHECKOUT_TOOL', 'CHECKIN_TOOL') AND timestamp >= NOW() - ($1 || ' days')::interval
             GROUP BY day, action
             ORDER BY day ASC`,
            [days]
        );
        res.json({ success: true, days, data: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch activity trend.' });
    }
});

// Mandatory-shift-audit compliance for each of the last N shift windows (default 14, i.e.
// the last 7 days), across every department -- was every currently-auditable toolbox
// actually audited in that window? Unlike getAuditGatePendingToolboxes() (which only checks
// "since windowStart" against right now, fine for the live gate but wrong for a past
// window), this bounds each window on both ends so an audit from a LATER window can't be
// mistaken for satisfying an EARLIER one. "Auditable" is evaluated against tools' CURRENT
// status, same simplification the live gate already makes -- this app doesn't track
// historical tool status, so a window from a week ago is judged by today's inventory shape.
app.get('/api/dashboard/audit-compliance-trend', async (req, res) => {
    const windowCount = Math.min(60, Math.max(1, parseInt(req.query.windows, 10) || 14));
    try {
        const deptsRes = await pool.query('SELECT dept_id, name FROM departments ORDER BY name');
        const depts = deptsRes.rows;

        const windows = [];
        let cursor = getAuditWindowStart();
        for (let i = 0; i < windowCount; i++) {
            windows.unshift({ start: new Date(cursor), end: getAuditWindowEnd(cursor) });
            cursor = getPreviousAuditWindowStart(cursor);
        }

        const results = [];
        for (const w of windows) {
            const perDept = [];
            for (const dept of depts) {
                const countsRes = await pool.query(
                    `WITH auditable_boxes AS (
                        SELECT b.box_id FROM toolboxes b WHERE b.dept_id = $1
                          AND EXISTS (SELECT 1 FROM tools t JOIN drawers dr ON t.drawer_id = dr.drawer_id
                                      WHERE dr.box_id = b.box_id AND t.status NOT IN ('Retired','Pending Transfer','In Calibration'))
                     )
                     SELECT
                       (SELECT COUNT(*) FROM auditable_boxes) AS total,
                       (SELECT COUNT(DISTINCT b.box_id) FROM audit_logs a
                          JOIN tools t ON a.tool_id = t.tool_id JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
                          WHERE a.action = 'AUDIT' AND a.timestamp >= $2::timestamptz AND a.timestamp < $3::timestamptz AND b.box_id IN (SELECT box_id FROM auditable_boxes)
                       ) AS audited`,
                    [dept.dept_id, w.start, w.end]
                );
                perDept.push({ dept_id: dept.dept_id, name: dept.name, total: parseInt(countsRes.rows[0].total, 10), audited: parseInt(countsRes.rows[0].audited, 10) });
            }
            const total = perDept.reduce((sum, d) => sum + d.total, 0);
            const audited = perDept.reduce((sum, d) => sum + d.audited, 0);
            results.push({
                window_start: w.start.toISOString(),
                is_morning: w.start.getHours() === AUDIT_MORNING_START_HOUR,
                total, audited,
                compliance_pct: total === 0 ? null : Math.round((audited / total) * 100),
                departments: perDept,
            });
        }

        res.json({ success: true, windows: results });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch audit compliance trend.' });
    }
});

// Generate an AUDIT or FLAGGED report, scoped to a department if the requester is a dept_admin.
// No explicit minimum role check (getRoleWeight is used only to derive queryDept), any authenticated user may call this.
app.post('/api/reports/generate', requireFetchHeader, requireRole(1), async (req, res) => {
    const { report_type, dept_id, start_date, end_date } = req.body;
    try {
        let queryDept = dept_id;
        if (req.authUser.weight === 3) {
            // A dept_admin may report on their home department or any department they've been
            // granted cross-department access to, but never the global 'ALL' view -- that
            // stays super_admin-only. Falls back to their home dept if the requested one isn't
            // actually in their accessible set (covers a stale/tampered dept_id as well as 'ALL').
            const requested = parseInt(dept_id, 10);
            queryDept = req.authUser.accessibleDeptIds.includes(requested) ? requested : req.authUser.dept_id;
        }

        let data = [];
        if (report_type === 'AUDIT') {
            // FIX: tools has no box_id column; tools relate to toolboxes only via drawer_id -> drawers.box_id.
            // Join through drawers first instead of joining toolboxes directly off tools.box_id.
            let query = `
                SELECT a.timestamp, u.full_name, u.badge_id, a.action, t.qr_code, t.name AS tool_name, d.name AS dept_name, a.notes
                FROM audit_logs a LEFT JOIN users u ON a.user_id = u.user_id LEFT JOIN tools t ON a.tool_id = t.tool_id
                LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id LEFT JOIN toolboxes b ON dr.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
                WHERE a.timestamp >= $1::timestamp AND a.timestamp <= $2::timestamp
            `;
            const params = [start_date + ' 00:00:00', end_date + ' 23:59:59'];
            if (queryDept !== 'ALL') { query += ` AND d.dept_id = $3`; params.push(queryDept); }
            query += ` ORDER BY a.timestamp DESC`;
            const result = await pool.query(query, params);
            data = result.rows;
        } else if (report_type === 'FLAGGED') {
            // FIX: tools has no box_id column; tools relate to toolboxes only via drawer_id -> drawers.box_id.
            // Join through drawers first instead of joining toolboxes directly off tools.box_id.
            let query = `
                SELECT t.qr_code, t.name AS tool_name, t.status, t.status_reason, d.name AS dept_name
                FROM tools t LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id LEFT JOIN toolboxes b ON dr.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
                WHERE t.status IN ('Broken', 'Missing', 'Worn')
            `;
            const params = [];
            if (queryDept !== 'ALL') { query += ` AND d.dept_id = $1`; params.push(queryDept); }
            const result = await pool.query(query, params);
            data = result.rows;
        }
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate report.' });
    }
});

// ==========================================
// 8.5 HARDWARE INTEGRATION & GRACE PERIOD
// ==========================================

// In-memory store for active unlocks. Format: { box_id: { user_id, badge_id, expires_at } }
const activeUnlocks = new Map();

// Housekeeping: Clean up expired locks from memory every 10 seconds
setInterval(() => {
    const now = Date.now();
    for (let [boxId, data] of activeUnlocks.entries()) {
        if (now > data.expires_at) {
            activeUnlocks.delete(boxId);
            console.log(`[Hardware] Grace period expired for Box: ${boxId}`);
        }
    }
}, 10000);

/**
 * ENDPOINT 1: The UI requests a physical unlock.
 * Triggered by the Kiosk when a user selects a box to open.
 */
// NOTE: still only requires a single badge (not the new dual-PIN scheme) since there's no physical hardware deployed yet -- needs the same sign-off treatment before this path goes live.
app.post('/api/hardware/unlock', async (req, res) => {
    const { badge_id, box_id } = req.body;

    try {
        // 1. Verify the user
        const userRes = await pool.query('SELECT user_id, full_name, role FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'Invalid Badge ID.' });
        const user = userRes.rows[0];

        // TODO (Future): Add cross-department permission checks here before unlocking.

        // 2. Start the 60-second Grace Period
        activeUnlocks.set(box_id, {
            user_id: user.user_id,
            badge_id: badge_id,
            expires_at: Date.now() + 60000 // 60 seconds from now
        });

        // 3. TODO (Future): Fire Webhook to Igloohome API or local Raspberry Pi GPIO pin here
        console.log(`[Hardware] UNLOCK COMMAND SENT to Box: ${box_id} by ${user.full_name}`);

        res.json({ success: true, message: 'Box unlocked. 60-second grace period started.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process unlock request.' });
    }
});

/**
 * ENDPOINT 2: The Physical Sensor detects a change.
 * Triggered by an RFID scanner, limit switch, or weight sensor inside the drawer.
 */
// NOTE: still only requires a single badge (not the new dual-PIN scheme) since there's no physical hardware deployed yet -- needs the same sign-off treatment before this path goes live.
app.post('/api/hardware/sensor', async (req, res) => {
    // Expected payload from the sensor hardware
    const { box_id, qr_code, action } = req.body; // action should be 'REMOVED' or 'RETURNED'
    
    try {
        const client = await pool.connect();
        await client.query('BEGIN');

        // Verify the tool exists
        const toolRes = await client.query('SELECT tool_id, name, status FROM tools WHERE qr_code = $1', [qr_code]);
        if (toolRes.rows.length === 0) throw new Error('Unregistered tool detected.');
        const tool = toolRes.rows[0];

        // Check if there is an active authorized user for this box
        const activeSession = activeUnlocks.get(box_id);

        if (action === 'REMOVED') {
            if (activeSession) {
                // AUTHORIZED CHECKOUT: A valid user opened the box within the last 60 seconds
                await client.query("UPDATE tools SET status = 'Out', status_reason = NULL WHERE tool_id = $1", [tool.tool_id]);
                await client.query(
                    "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'CHECKOUT_TOOL', $2, 'Auto-Checkout via Hardware Sensor')",
                    [activeSession.user_id, tool.tool_id]
                );
                console.log(`[Hardware] Auto-Checkout: ${tool.name} assigned to ${activeSession.badge_id}`);
            } else {
                // GHOST CHECKOUT: The box was forced, or the grace period expired
                await client.query("UPDATE tools SET status = 'Missing', status_reason = 'Ghost Checkout (Sensor)' WHERE tool_id = $1", [tool.tool_id]);
                await client.query(
                    "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES (NULL, 'FLAGGED_MISSING', $1, 'Hardware detected removal without active session')",
                    [tool.tool_id]
                );
                console.log(`[Hardware] 🚨 ALERT: Ghost Checkout detected for ${tool.name}!`);
            }
        } 
        else if (action === 'RETURNED') {
            // AUTHORIZED OR UNAUTHORIZED RETURN: If a tool is put back, we always accept it.
            let returnUserId = activeSession ? activeSession.user_id : null;
            let logNote = activeSession ? 'Auto-Return via Hardware Sensor' : 'Ghost Return via Hardware Sensor';

            await client.query("UPDATE tools SET status = 'In', status_reason = NULL WHERE tool_id = $1", [tool.tool_id]);
            await client.query(
                "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'CHECKIN_TOOL', $2, $3)",
                [returnUserId, tool.tool_id, logNote]
            );
            console.log(`[Hardware] Tool Returned: ${tool.name}`);
        }

        await client.query('COMMIT');
        client.release();
        res.json({ success: true });

    } catch (err) {
        console.error("[Hardware] Sensor processing error:", err.message);
        res.status(500).json({ error: 'Failed to process sensor data.' });
    }
});

// ==========================================
// 8.6 CALENDAR FEED (iCalendar / .ics)
// ==========================================
// Escapes a text value per RFC 5545 (backslash, semicolon, comma, embedded newline). Line
// folding for values over 75 octets is deliberately not implemented -- every field here is a
// short tool name/location, not free-form prose, so it isn't expected to matter in practice.
function icsEscapeText(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// A calibration due date is a whole day, not a specific moment -- VALUE=DATE wants a bare
// YYYYMMDD with no time/timezone component. `dateStr` may be a plain date or an ISO
// timestamp; only the leading 10 characters (YYYY-MM-DD) are used either way.
function formatIcsDate(dateStr) {
    return dateStr.slice(0, 10).replace(/-/g, '');
}

// Surfaces the feed token to the admin panel so a super_admin can copy the subscribe URL --
// gated one level above the everyday admin actions (requireRole(4)) since, unlike the feed
// endpoint itself, this one DOES carry a real session, and the token is the feed's only
// access control. Returns configured:false rather than an error when CALENDAR_FEED_TOKEN
// isn't set, so the admin UI can show setup instructions instead of a raw failure.
app.get('/api/settings/calendar-feed-token', requireRole(4), async (req, res) => {
    const token = process.env.CALENDAR_FEED_TOKEN;
    if (!token) return res.json({ configured: false });
    res.json({ configured: true, token });
});

/**
 * Publishes a read-only iCalendar feed of every calibrated tool's due date, gated by a
 * single shared token (CALENDAR_FEED_TOKEN in .env) instead of a login session -- a calendar
 * app auto-refreshing a subscribed URL has no way to do interactive auth, so the token IS
 * the entire access control, same reasoning CalTool's own calibration feed documents ("pulls
 * from CalTool -- no account, service account, or OAuth of any kind"). An unconfigured
 * token always rejects; it never falls back to open access.
 */
app.get('/api/calendar/calibration.ics', calendarFeedLimiter, async (req, res) => {
    const configuredToken = process.env.CALENDAR_FEED_TOKEN;
    if (!configuredToken || req.query.token !== configuredToken) {
        return res.status(403).send('Forbidden');
    }

    try {
        const result = await pool.query(
            `SELECT t.tool_id, t.qr_code, t.name, t.cal_due_date::text AS cal_due_date, d.name AS dept_name, b.name AS box_name
             FROM tools t
             LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
             LEFT JOIN toolboxes b ON dr.box_id = b.box_id
             LEFT JOIN departments d ON b.dept_id = d.dept_id
             WHERE t.is_calibrated = true AND t.cal_due_date IS NOT NULL AND t.status != 'Retired'
             ORDER BY t.cal_due_date ASC`
        );

        const dtstamp = `${formatIcsDate(new Date().toISOString())}T000000Z`;
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//ToolTracker//Calibration Due Dates//EN',
            'CALSCALE:GREGORIAN',
            'X-WR-CALNAME:ToolTracker Calibration Due Dates',
        ];

        for (const tool of result.rows) {
            const location = [tool.dept_name, tool.box_name].filter(Boolean).join(' / ');
            lines.push(
                'BEGIN:VEVENT',
                `UID:cal-${tool.tool_id}@tooltracker`,
                `DTSTAMP:${dtstamp}`,
                `DTSTART;VALUE=DATE:${formatIcsDate(tool.cal_due_date)}`,
                `SUMMARY:${icsEscapeText(`Calibration Due: ${tool.name} (${tool.qr_code})`)}`,
                ...(location ? [`LOCATION:${icsEscapeText(location)}`] : []),
                'END:VEVENT',
            );
        }
        lines.push('END:VCALENDAR');

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="tooltracker-calibration.ics"');
        res.send(lines.join('\r\n'));
    } catch (err) {
        console.error('Calendar Feed Error:', err);
        res.status(500).send('Failed to generate calendar feed.');
    }
});

// ==========================================
// 9. AUTOMATED BACKGROUND LOGGER
// ==========================================
const hourlyDir = path.join(LOG_DIR, 'hourly');
const dailyDir = path.join(LOG_DIR, 'daily');

if (!fs.existsSync(hourlyDir)) fs.mkdirSync(hourlyDir, { recursive: true });
if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true });

/**
 * Formats a single "who has it since when" line for a checked-out tool, e.g.:
 *   ABC123 "Torque Wrench" -> Jane Doe (ELE001) since 2026-07-01 08:15
 * @param {object} row - a row from the out-tools-for-department query
 * @returns {string}
 */
const formatOutToolLine = (row) => {
    const since = row.timestamp ? new Date(row.timestamp).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
    return `${row.qr_code} "${row.tool_name}" -> ${row.user_name || 'Unknown User'} (${row.badge_id || 'N/A'}) since ${since}`;
};

/**
 * Fetches the tools currently checked out of a single department, along with who has
 * them and since when. Reuses the same LATERAL-join pattern as GET /api/dashboard's
 * out_tools query, scoped down to one dept_id.
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {number} deptId
 * @returns {Promise<Array<{qr_code: string, tool_name: string, user_name: string, badge_id: string, timestamp: Date}>>}
 */
const getOutToolsForDept = async (client, deptId) => {
    const query = `
        SELECT t.qr_code, t.name AS tool_name, u.full_name AS user_name, u.badge_id, al.timestamp
        FROM tools t
        JOIN drawers dr ON t.drawer_id = dr.drawer_id
        JOIN toolboxes b ON dr.box_id = b.box_id
        LEFT JOIN LATERAL (SELECT user_id, timestamp FROM audit_logs WHERE tool_id = t.tool_id AND action = 'CHECKOUT_TOOL' ORDER BY timestamp DESC LIMIT 1) al ON true
        LEFT JOIN users u ON al.user_id = u.user_id
        WHERE t.status = 'Out' AND b.dept_id = $1
        ORDER BY t.qr_code ASC;
    `;
    const result = await client.query(query, [deptId]);
    return result.rows;
};

/**
 * Writes a per-department snapshot of how many tools are currently checked out (and to
 * whom) to an hourly log file under logs/hourly/<dept_prefix>/<date>_hourly.log.
 * Driven from the departments table with a LEFT JOIN into a per-department aggregate, so
 * every department gets exactly one line every run, even when it has zero tools out.
 * Invoked on the hour by the setInterval loop below.
 */
async function generateHourlyLog() {
    try {
        const query = `
            SELECT d.prefix_code AS dept_prefix, d.dept_id, COALESCE(out_counts.tools_out, 0) AS tools_out
            FROM departments d
            LEFT JOIN (
                SELECT b.dept_id, COUNT(t.tool_id) AS tools_out
                FROM tools t JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
                WHERE t.status = 'Out' GROUP BY b.dept_id
            ) out_counts ON out_counts.dept_id = d.dept_id
            ORDER BY d.prefix_code;
        `;
        const result = await pool.query(query);
        const now = new Date();
        const dateString = now.toISOString().split('T')[0];
        const timeString = now.toLocaleTimeString();

        for (const row of result.rows) {
            const prefix = row.dept_prefix;
            const toolsOut = parseInt(row.tools_out, 10) || 0;
            const deptDir = path.join(hourlyDir, prefix);
            if (!fs.existsSync(deptDir)) fs.mkdirSync(deptDir, { recursive: true });
            const filePath = path.join(deptDir, `${dateString}_hourly.log`);

            let line;
            if (toolsOut === 0) {
                line = `[${timeString}] DEPT=${prefix} | OUT=0 | All tools checked in.\n`;
            } else {
                const outRows = await getOutToolsForDept(pool, row.dept_id);
                const detail = outRows.map(formatOutToolLine).join(' | ');
                line = `[${timeString}] DEPT=${prefix} | OUT=${toolsOut} | ${detail}\n`;
            }
            fs.appendFileSync(filePath, line);
        }
        console.log(`[Logger] Hourly metrics successfully routed to department folders.`);
    } catch (err) {
        console.error("Hourly log failed:", err);
    }
}

/**
 * Writes a per-department daily snapshot to a monthly log file under
 * logs/daily/<dept_prefix>/<month>_daily.log. Driven from the departments table so every
 * department gets a snapshot every day, even an all-zero one, plus richer detail sections
 * for out tools, flagged tools, upcoming/overdue calibrations, and today's audit status.
 * Invoked once per calendar day by the setInterval loop below.
 */
async function generateDailyLog() {
    try {
        const deptsResult = await pool.query('SELECT dept_id, prefix_code FROM departments ORDER BY prefix_code ASC');
        const now = new Date();
        const dateString = now.toISOString().split('T')[0];
        const monthString = dateString.substring(0, 7);

        for (const dept of deptsResult.rows) {
            const prefix = dept.prefix_code;
            const deptId = dept.dept_id;

            // Status-count summary (always emitted, even all-zero)
            const statusCountsRes = await pool.query(
                `SELECT t.status, COUNT(t.tool_id) AS status_count
                 FROM tools t JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
                 WHERE b.dept_id = $1 GROUP BY t.status`,
                [deptId]
            );
            const totalAssetsRes = await pool.query(
                `SELECT COUNT(t.tool_id) AS total
                 FROM tools t JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
                 WHERE b.dept_id = $1 AND t.status != 'Retired'`,
                [deptId]
            );
            const totalAssets = parseInt(totalAssetsRes.rows[0].total, 10) || 0;

            let inCount = 0, outCount = 0, flaggedCount = 0;
            statusCountsRes.rows.forEach(row => {
                const count = parseInt(row.status_count, 10) || 0;
                if (row.status === 'In') inCount = count;
                else if (row.status === 'Out') outCount = count;
                else if (['Missing', 'Broken', 'Worn'].includes(row.status)) flaggedCount += count;
            });

            // OUT detail
            const outRows = await getOutToolsForDept(pool, deptId);

            // FLAGGED detail
            const flaggedRes = await pool.query(
                `SELECT t.qr_code, t.name AS tool_name, t.status, t.status_reason,
                        latest.timestamp AS reported_at, u.full_name AS user_name, u.badge_id
                 FROM tools t
                 JOIN drawers dr ON t.drawer_id = dr.drawer_id
                 JOIN toolboxes b ON dr.box_id = b.box_id
                 LEFT JOIN LATERAL (
                     SELECT user_id, timestamp FROM audit_logs
                     WHERE tool_id = t.tool_id AND action IN ('ISSUE_REPORT', 'AUDIT')
                     ORDER BY timestamp DESC LIMIT 1
                 ) latest ON true
                 LEFT JOIN users u ON latest.user_id = u.user_id
                 WHERE b.dept_id = $1 AND t.status IN ('Missing', 'Broken', 'Worn')
                 ORDER BY t.qr_code ASC`,
                [deptId]
            );

            // CALIBRATION DUE/OVERDUE (within 30 days, or already overdue)
            const calRes = await pool.query(
                `SELECT t.qr_code, t.name AS tool_name, t.cal_due_date
                 FROM tools t
                 JOIN drawers dr ON t.drawer_id = dr.drawer_id
                 JOIN toolboxes b ON dr.box_id = b.box_id
                 WHERE b.dept_id = $1 AND t.is_calibrated = true AND t.status != 'Retired'
                   AND t.cal_due_date IS NOT NULL AND t.cal_due_date <= (CURRENT_DATE + INTERVAL '30 days')
                 ORDER BY t.cal_due_date ASC`,
                [deptId]
            );

            // AUDIT STATUS -- report BOTH mandatory windows for the day being logged (morning
            // 04:00-14:00, afternoon 14:00-04:00 overnight), not just whichever is active right
            // now. Built from `now`'s own local date components (not the UTC-derived dateString
            // string above) so this lines up exactly with getAuditWindowStart()'s local-time math.
            // Note: since this job runs at midnight, the afternoon window (which continues until
            // 04:00 the next day) is only partially elapsed at that point -- its status here is
            // an honest snapshot of "as of midnight", not a final verdict on the whole window.
            const morningWindowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), AUDIT_MORNING_START_HOUR, 0, 0, 0);
            const afternoonWindowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), AUDIT_AFTERNOON_START_HOUR, 0, 0, 0);
            const [morningStatus, afternoonStatus] = await Promise.all([
                describeAuditWindowStatus(deptId, morningWindowStart),
                describeAuditWindowStatus(deptId, afternoonWindowStart),
            ]);
            const auditStatusLine = `Morning (04:00-14:00): ${morningStatus} | Afternoon (14:00-04:00): ${afternoonStatus}`;

            // Build the log block
            let block = `\n[DAILY SNAPSHOT] ${dateString} -- DEPT=${prefix}\n`;
            block += `  Total Assets: ${totalAssets} | In: ${inCount} | Out: ${outCount} | Flagged: ${flaggedCount}\n`;

            block += `  OUT (${outRows.length}): `;
            block += outRows.length === 0 ? `- All tools checked in.\n` : `\n` + outRows.map(r => `    - ${formatOutToolLine(r)}`).join('\n') + '\n';

            block += `  FLAGGED (${flaggedRes.rows.length}): `;
            if (flaggedRes.rows.length === 0) {
                block += `- No issues reported.\n`;
            } else {
                block += `\n` + flaggedRes.rows.map(r => {
                    const reportedDate = r.reported_at ? new Date(r.reported_at).toISOString().slice(0, 10) : 'unknown date';
                    const reporter = r.user_name ? `${r.user_name} (${r.badge_id})` : 'Unknown User';
                    return `    - ${r.qr_code} "${r.tool_name}" [${r.status}] reported by ${reporter} on ${reportedDate} -- "${r.status_reason || ''}"`;
                }).join('\n') + '\n';
            }

            block += `  CALIBRATION DUE/OVERDUE (${calRes.rows.length}): `;
            if (calRes.rows.length === 0) {
                block += `- None due within 30 days.\n`;
            } else {
                block += `\n` + calRes.rows.map(r => {
                    const dueDate = new Date(r.cal_due_date);
                    const dueDateStr = dueDate.toISOString().slice(0, 10);
                    const daysDiff = Math.round((dueDate - new Date(dateString)) / (1000 * 60 * 60 * 24));
                    return `    - ${r.qr_code} "${r.tool_name}" due ${dueDateStr} (${daysDiff}days)`;
                }).join('\n') + '\n';
            }

            block += `  AUDIT STATUS: ${auditStatusLine}\n`;
            block += `----------------------------------------------------------------------\n`;

            const deptDir = path.join(dailyDir, prefix);
            if (!fs.existsSync(deptDir)) fs.mkdirSync(deptDir, { recursive: true });
            const filePath = path.join(deptDir, `${monthString}_daily.log`);
            fs.appendFileSync(filePath, block);
        }
        console.log(`[Logger] Daily snapshots successfully routed to department folders.`);
    } catch (err) {
        console.error("Daily log failed:", err);
    }
}

let lastHourlyLog = new Date().getHours();
let lastDailyLog = new Date().getDate();

setInterval(() => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDate = now.getDate();

    if (currentHour !== lastHourlyLog) {
        generateHourlyLog();
        lastHourlyLog = currentHour; 
    }
    if (currentDate !== lastDailyLog) {
        generateDailyLog();
        lastDailyLog = currentDate; 
    }
}, 60000);

// ==========================================
// SERVER STARTUP
// ==========================================
// Plain HTTP on 3000 -- fine for same-machine access (http://localhost:3000, where camera
// access still works since browsers special-case "localhost" as a secure context) and for
// Caddy (see Caddyfile) to reverse-proxy from. Real HTTPS for every other device (phones,
// etc. -- required for camera access anywhere other than localhost) is handled by Caddy in
// front of this app, using a genuinely trusted Let's Encrypt certificate via DNS-01 against
// a DuckDNS name, rather than a self-signed dev certificate that would need installing on
// every device by hand. Run Caddy alongside this process: ./caddy.exe run
app.listen(3000, '0.0.0.0', () => {
    console.log(`Backend API running on port 3000 (HTTP).`);
});