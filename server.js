require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// STORAGE PATH CONFIGURATION (PC vs RPI)
// ==========================================

// Option A: Windows PC (Development)
const BASE_STORAGE_PATH = __dirname;

// Option B: Raspberry Pi External Drive (Production)
// const BASE_STORAGE_PATH = '/mnt/external_drive/ToolTracker_Data';

const UPLOAD_DIR = path.join(BASE_STORAGE_PATH, 'public', 'uploads');
const LOG_DIR = path.join(BASE_STORAGE_PATH, 'logs');

// Serve uploaded photos dynamically
app.use('/uploads', express.static(UPLOAD_DIR));

// ==========================================
// EMAIL (SMTP) CONFIGURATION
// ==========================================
// Built once at startup from process.env.SMTP_* (see .env.example). If SMTP_HOST/SMTP_USER
// are not set, simulateEmail() below falls back to console-logging instead of using this.
const mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: (process.env.SMTP_USER && process.env.SMTP_PASS)
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
});

// ==========================================
// DATABASE CONFIGURATION
// ==========================================
// NOTE: 'dotenv' is already listed as a dependency in package.json but is never
// required or used anywhere in this file. Before deploying this app to the
// Raspberry Pi, these hardcoded credentials should be moved into a .env file
// (loaded here via require('dotenv').config()) and docker-compose.yml should be
// updated to match, rather than shipping plaintext credentials in source control.
const pool = new Pool({
    user: 'tooladmin',
    host: 'localhost',
    database: 'tooltracker',
    password: 'SuperSecretPassword123',
    port: 5432,
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
 * Generates a random 6-digit numeric PIN (as a string), used for login
 * and manager-override authentication.
 * @returns {string} a 6-digit PIN, e.g. "042817"
 */
const generatePin = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * AUDIT GATE: returns the list of toolboxes in the given department that still
 * need an AUDIT today. A toolbox only counts if it currently has at least one
 * non-retired, non-transferred tool in it. Empty array => department passes.
 * @param {import('pg').PoolClient|import('pg').Pool} client - DB client/pool to query with
 * @param {number} deptId - department to check
 * @returns {Promise<Array<{box_id: number, name: string}>>} pending toolboxes (empty = audited today)
 */
const getAuditGatePendingToolboxes = async (client, deptId) => {
    const query = `
        WITH auditable_boxes AS (
          SELECT b.box_id, b.name FROM toolboxes b WHERE b.dept_id = $1
            AND EXISTS (SELECT 1 FROM tools t JOIN drawers dr ON t.drawer_id = dr.drawer_id
                        WHERE dr.box_id = b.box_id AND t.status NOT IN ('Retired','Pending Transfer','In Calibration'))
        ), audited_today AS (
          SELECT DISTINCT b.box_id FROM audit_logs a
            JOIN tools t ON a.tool_id = t.tool_id JOIN drawers dr ON t.drawer_id = dr.drawer_id JOIN toolboxes b ON dr.box_id = b.box_id
            WHERE a.action='AUDIT' AND a.timestamp::date = CURRENT_DATE AND b.dept_id = $1
        )
        SELECT ab.box_id, ab.name FROM auditable_boxes ab LEFT JOIN audited_today at ON ab.box_id = at.box_id WHERE at.box_id IS NULL;
    `;
    const result = await client.query(query, [deptId]);
    return result.rows;
};

/**
 * TOOL STATUS STATE MACHINE: validates whether an admin-driven status change
 * (via PUT /api/tools/:id) is legal, without touching the DB.
 * - 'Out', 'Pending Transfer', and 'In Calibration' can never be *entered* here -- 'Out' only
 *   happens via a real kiosk checkout, the other two only via the transfer endpoints.
 * - While currently 'Out', 'Pending Transfer', or 'In Calibration', no change is allowed at all.
 * - Otherwise: 'In' <-> (Missing, Broken, Worn) freely, any of those -> Retired, Retired is terminal.
 * @param {string} currentStatus - the tool's status before the update
 * @param {string} requestedStatus - the status being requested
 * @returns {{ allowed: true } | { allowed: false, code: string }}
 */
const checkToolStatusTransition = (currentStatus, requestedStatus) => {
    if (requestedStatus === currentStatus) return { allowed: true };

    if (currentStatus === 'Out') return { allowed: false, code: 'TOOL_IS_OUT' };
    if (currentStatus === 'Pending Transfer' || currentStatus === 'In Calibration') return { allowed: false, code: 'TOOL_IN_TRANSFER' };

    if (requestedStatus === 'Out' || requestedStatus === 'Pending Transfer' || requestedStatus === 'In Calibration') {
        return { allowed: false, code: 'INVALID_STATUS_TRANSITION' };
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
 * Sends an outbound notification email (new-user welcome + PIN reset) via the SMTP
 * transport configured from process.env.SMTP_*. If SMTP_HOST or SMTP_USER is not set
 * (i.e. .env hasn't been configured yet), falls back to the original console-log-only
 * behavior instead of attempting to send. Never throws -- a down mail server or missing
 * config must never fail user-creation or PIN-reset.
 * @param {string} email - recipient address
 * @param {string} subject - email subject line
 * @param {string} body - email body text
 */
const simulateEmail = async (email, subject, body) => {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        console.log(`[Email] SMTP is not configured (see .env.example) -- logging instead of sending.`);
        console.log(`\n=================================================`);
        console.log(`📧 EMAIL SENT TO: ${email}`);
        console.log(`Subject: ${subject}`);
        console.log(`Body:\n${body}`);
        console.log(`=================================================\n`);
        return;
    }

    try {
        await mailTransport.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: subject,
            text: body,
        });
        console.log(`[Email] Sent "${subject}" to ${email}.`);
    } catch (err) {
        console.error(`[Email] Failed to send "${subject}" to ${email}:`, err.message);
    }
};

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
            SELECT t.*, b.name AS toolbox_name, dr.name AS drawer_name, d.name AS department_name 
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

// Compute the next sequential numeric suffix for a tool QR code with the given prefix.
app.get('/api/tools/next-id', async (req, res) => {
    const { prefix } = req.query;
    if (!prefix) return res.status(400).json({ error: 'Prefix required.' });

    try {
        const query = `
            SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(qr_code, '\\D', '', 'g'), '') AS INTEGER)), 0) + 1 AS next_number 
            FROM tools WHERE qr_code LIKE $1;
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
app.post('/api/login', async (req, res) => {
    const { login_id, pin } = req.body; 
    try {
        const query = `
            SELECT user_id, badge_id, full_name, username, role, is_active 
            FROM users WHERE (badge_id ILIKE $1 OR username ILIKE $1) AND pin = $2
        `;
        const result = await pool.query(query, [login_id, pin]);
        
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid Credentials.' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.' });
        
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: 'Server error during login.' }); 
    }
});

// Kiosk login: identify a user by badge_id/username + PIN for quick kiosk access.
app.post('/api/kiosk-auth', async (req, res) => {
    const { login_id, pin } = req.body;
    try {
        const query = `
            SELECT user_id, badge_id, full_name, role, is_active, dept_id
            FROM users WHERE (badge_id ILIKE $1 OR username ILIKE $1) AND pin = $2
        `;
        const result = await pool.query(query, [login_id, pin]);

        // Same message whether login_id is unknown or the pin is wrong, to avoid enumeration.
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid Credentials.', code: 'BAD_CREDENTIALS' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.', code: 'INACTIVE_USER' });

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// ==========================================
// 3. USER MANAGEMENT & SELF-SERVICE
// ==========================================
// List active users with a lower role weight than the requester (any authenticated requester).
app.get('/api/users', async (req, res) => {
    const requesterBadge = req.query.requester;
    if (!requesterBadge) return res.status(401).json({ error: 'Unauthorized.' });
    
    try {
        const reqUser = await pool.query('SELECT role, dept_id FROM users WHERE badge_id = $1 AND is_active = true', [requesterBadge]);
        if (reqUser.rows.length === 0) return res.status(403).json({ error: 'Invalid account.' });
        
        const requester = reqUser.rows[0];
        const reqWeight = getRoleWeight(requester.role);

        // Fetching photo_url for the UI
        const query = `
            SELECT u.user_id, u.badge_id, u.username, u.email, u.full_name, u.role, d.name AS department_name, u.photo_url 
            FROM users u LEFT JOIN departments d ON u.dept_id = d.dept_id 
            WHERE u.is_active = true ORDER BY u.full_name ASC
        `;
        const result = await pool.query(query);
        const filteredUsers = result.rows.filter(u => getRoleWeight(u.role) < reqWeight);
        
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

// Create a new user account. Requester must outrank the target role (getRoleWeight hierarchy check);
// generates badge_id/username/PIN and "sends" a welcome email.
app.post('/api/users', async (req, res) => {
    const { full_name, email, dept_id, role, requester } = req.body;
    const client = await pool.connect(); 
    
    try {
        await client.query('BEGIN');
        const auth = await client.query('SELECT role, dept_id FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0) throw new Error('Access Denied.');
        if (getRoleWeight(auth.rows[0].role) <= getRoleWeight(role)) throw new Error('Hierarchy Violation.');

        const finalDeptId = auth.rows[0].role === 'super_admin' ? dept_id : auth.rows[0].dept_id;
        if (!email || !email.includes('@')) throw new Error('Valid email address required.');
        const username = email.split('@')[0].toLowerCase();

        const deptRes = await client.query('SELECT prefix_code FROM departments WHERE dept_id = $1', [finalDeptId]);
        if (deptRes.rows.length === 0) throw new Error('Invalid Department selected.');
        const prefix = deptRes.rows[0].prefix_code; 

        const maxRes = await client.query(`SELECT MAX(CAST(NULLIF(regexp_replace(badge_id, '\\D', '', 'g'), '') AS INTEGER)) as max_num FROM users WHERE badge_id LIKE $1`, [`${prefix}%`]);
        const badge_id = prefix + String((maxRes.rows[0].max_num || 0) + 1).padStart(3, '0');

        const newPin = generatePin();
        const insertQuery = `INSERT INTO users (badge_id, full_name, email, username, dept_id, role, pin) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
        const result = await client.query(insertQuery, [badge_id, full_name, email, username, finalDeptId, role, newPin]);

        await client.query('COMMIT');
        simulateEmail(email, 'Welcome to LTA Tracker', `Username: ${username}\nBadge ID: ${badge_id}\nTemporary PIN: ${newPin}`);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message || 'Failed to create user.' });
    } finally {
        client.release();
    }
});

// Reset a user's PIN. Requester must outrank the target user (getRoleWeight hierarchy check).
app.post('/api/users/:badge_id/reset-pin', async (req, res) => {
    const { badge_id } = req.params; 
    const { requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        const target = await pool.query('SELECT role, email, full_name FROM users WHERE badge_id = $1', [badge_id]);
        
        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        if (getRoleWeight(auth.rows[0].role) <= getRoleWeight(target.rows[0].role)) return res.status(403).json({ error: 'Hierarchy Violation.' });

        const newPin = generatePin();
        await pool.query('UPDATE users SET pin = $1 WHERE badge_id = $2', [newPin, badge_id]);
        simulateEmail(target.rows[0].email, 'PIN Reset', `New temporary PIN: ${newPin}`);
        // Return the new PIN so the admin panel can display it directly -- email delivery
        // isn't configured yet, so this is currently the only way an admin can relay it.
        res.json({ success: true, new_pin: newPin });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset PIN.' });
    }
});

// Deactivate a user account. Requester must outrank the target user (getRoleWeight hierarchy check).
app.put('/api/users/:badge_id/deactivate', async (req, res) => {
    const { badge_id } = req.params; 
    const { requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        const target = await pool.query('SELECT role FROM users WHERE badge_id = $1', [badge_id]);
        
        if (getRoleWeight(auth.rows[0].role) <= getRoleWeight(target.rows[0].role)) return res.status(403).json({ error: 'Hierarchy Violation.' });

        await pool.query('UPDATE users SET is_active = false WHERE badge_id = $1', [badge_id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed.' }); 
    }
});

// Self-service: let the requester update their own username and/or PIN (no role check).
app.put('/api/users/me/update', async (req, res) => {
    const { requester, new_username, new_pin } = req.body;
    try {
        if (new_username) await pool.query('UPDATE users SET username = $1 WHERE badge_id = $2', [new_username, requester]);
        if (new_pin) await pool.query('UPDATE users SET pin = $1 WHERE badge_id = $2', [new_pin, requester]);
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
app.post('/api/departments', async (req, res) => {
    const { name, prefix_code, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 4) return res.status(403).json({ error: 'Super Admin clearance required.' });
        
        const result = await pool.query('INSERT INTO departments (name, prefix_code) VALUES ($1, $2) RETURNING *', [name, prefix_code.toUpperCase()]);
        res.json({ success: true, department: result.rows[0] });
    } catch (err) { 
        console.error("Department POST Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Auto-generate a Barcode ID for Toolboxes (e.g. AVI-BOX-001). No role check.
app.get('/api/toolboxes/next-id', async (req, res) => {
    const { prefix } = req.query;
    if (!prefix) return res.status(400).json({ error: 'Prefix required.' });

    try {
        const query = `
            SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(qr_code, '\\D', '', 'g'), '') AS INTEGER)), 0) + 1 AS next_number 
            FROM toolboxes WHERE qr_code LIKE $1;
        `;
        const result = await pool.query(query, [`${prefix}BOX-%`]);
        const nextSequence = String(result.rows[0].next_number).padStart(3, '0');
        res.json({ success: true, next_sequence: `${prefix}BOX-${nextSequence}` });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to calculate Box ID.' }); 
    }
});

// Smart Builder: Create Box AND its Drawers in one transaction. Requires dept_admin+ (getRoleWeight >= 3).
app.post('/api/toolboxes', async (req, res) => {
    const { name, dept_id, qr_code, drawer_count, requester } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        const auth = await client.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) throw new Error('Admin required.');
        
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
app.post('/api/drawers', async (req, res) => {
    const { box_id, name, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        
        const result = await pool.query('INSERT INTO drawers (box_id, name) VALUES ($1, $2) RETURNING *', [box_id, name]);
        res.json({ success: true, drawer: result.rows[0] });
    } catch (err) { 
        console.error("Drawer POST Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Delete a department, but only if it has no toolboxes assigned to it. No role check.
app.delete('/api/departments/:id', async (req, res) => {
    try {
        const check = await pool.query('SELECT COUNT(*) FROM toolboxes WHERE dept_id = $1', [req.params.id]);
        if (parseInt(check.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        await pool.query('DELETE FROM departments WHERE dept_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to delete Department.' }); 
    }
});

// Delete a toolbox, but only if it has no drawers and no tools assigned to it. No role check.
app.delete('/api/toolboxes/:id', async (req, res) => {
    try {
        const checkDrawers = await pool.query('SELECT COUNT(*) FROM drawers WHERE box_id = $1', [req.params.id]);
        // FIX: tools has no box_id column; tools relate to toolboxes only via drawer_id -> drawers.box_id.
        // Count tools whose drawer belongs to this toolbox instead of filtering tools.box_id directly.
        const checkTools = await pool.query('SELECT COUNT(*) FROM tools t LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id WHERE dr.box_id = $1', [req.params.id]);
        if (parseInt(checkDrawers.rows[0].count) > 0 || parseInt(checkTools.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        await pool.query('DELETE FROM toolboxes WHERE box_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to delete Toolbox.' }); 
    }
});

// Delete a drawer, but only if it has no tools assigned to it. No role check.
app.delete('/api/drawers/:id', async (req, res) => {
    try {
        const checkTools = await pool.query('SELECT COUNT(*) FROM tools WHERE drawer_id = $1', [req.params.id]);
        if (parseInt(checkTools.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        await pool.query('DELETE FROM drawers WHERE drawer_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to delete Drawer.' }); 
    }
});

// ==========================================
// 5. ASSET CREATION & DELETION
// ==========================================
// Create a new tool, optionally retiring/replacing an existing tool_id. Requires tool_rep+ (getRoleWeight >= 2).
app.post('/api/tools', async (req, res) => {
    const { qr_code, name, description, replacement_url, drawer_id, replaced_tool_id, requester, is_calibrated, last_cal_date, cal_due_date, serial_number, part_number } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 2) return res.status(403).json({ error: 'Tool Rep clearance required.' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (replaced_tool_id) {
                await client.query("UPDATE tools SET qr_code = qr_code || '-RET-' || tool_id, status = 'Retired' WHERE tool_id = $1", [replaced_tool_id]);
            }

            // Updated to include description, replacement_url, serial_number, and part_number
            const insertQuery = `INSERT INTO tools (qr_code, name, description, replacement_url, drawer_id, status, is_calibrated, last_cal_date, cal_due_date, serial_number, part_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING tool_id`;
            const insertRes = await client.query(insertQuery, [qr_code, name, description || null, replacement_url || null, drawer_id || null, 'In', is_calibrated || false, last_cal_date || null, cal_due_date || null, serial_number || null, part_number || null]);

            if (replaced_tool_id) {
                await client.query('UPDATE tools SET replaced_by_id = $1 WHERE tool_id = $2', [insertRes.rows[0].tool_id, replaced_tool_id]);
            }
            await client.query('COMMIT'); 
            res.json({ success: true });
        } catch (err) { 
            await client.query('ROLLBACK'); throw err; 
        } finally { 
            client.release(); 
        }
    } catch (err) { 
        res.status(500).json({ error: 'Failed to add tool.' }); 
    }
});

// Delete a tool and its audit log history. Requires tool_rep+ (getRoleWeight >= 2).
app.delete('/api/tools/:tool_id', async (req, res) => {
    const { tool_id } = req.params;
    const { requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 2) return res.status(403).json({ error: 'Tool Rep clearance required.' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM audit_logs WHERE tool_id = $1', [tool_id]);
            await client.query('DELETE FROM tools WHERE tool_id = $1', [tool_id]);
            await client.query('COMMIT');
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
app.put('/api/toolboxes/:id', async (req, res) => {
    const { name, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        await pool.query('UPDATE toolboxes SET name = $1 WHERE box_id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update toolbox.' }); }
});

// Update a Drawer. Requires dept_admin+ (getRoleWeight >= 3).
app.put('/api/drawers/:id', async (req, res) => {
    const { name, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        await pool.query('UPDATE drawers SET name = $1 WHERE drawer_id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update drawer.' }); }
});

// Update a Tool (name, description, status, calibration info). Requires tool_rep+ (getRoleWeight >= 2).
app.put('/api/tools/:id', async (req, res) => {
    const { name, description, replacement_url, status, is_calibrated, last_cal_date, cal_due_date, requester, serial_number, part_number } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 2) return res.status(403).json({ error: 'Tool Rep required.' });

        // If they checked the box but didn't provide a due date, throw an error
        if (is_calibrated && !cal_due_date) {
            return res.status(400).json({ error: 'Calibration Due Date is required.' });
        }

        const currentRes = await pool.query('SELECT status FROM tools WHERE tool_id = $1', [req.params.id]);
        if (currentRes.rows.length === 0) return res.status(404).json({ error: 'Tool not found.' });

        const transition = checkToolStatusTransition(currentRes.rows[0].status, status);
        if (!transition.allowed) {
            return res.status(409).json({ error: 'That status change is not allowed.', code: transition.code });
        }

        await pool.query(
            `UPDATE tools
             SET name = $1, description = $2, replacement_url = $3, status = $4,
                 is_calibrated = $5, last_cal_date = $6, cal_due_date = $7,
                 serial_number = $8, part_number = $9
             WHERE tool_id = $10`,
            [name, description || null, replacement_url || null, status,
             is_calibrated || false, last_cal_date || null, cal_due_date || null,
             serial_number || null, part_number || null, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Tool Update Error:", err);
        res.status(500).json({ error: 'Failed to update tool.' });
    }
});

// ==========================================
// 6. PHOTO UPLOAD ENDPOINT
// ==========================================
// Upload a photo and attach it to a user/tool/toolbox/drawer record. Requires tool_rep+ (getRoleWeight >= 2)
// for tool photos, and dept_admin+ (getRoleWeight >= 3) for user/toolbox/drawer photos.
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    const { requester, entity_type, entity_id } = req.body;
    
    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
    if (!requester || !entity_type || !entity_id) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0) throw new Error('Unauthorized.');
        
        const weight = getRoleWeight(auth.rows[0].role);
        
        if (weight < 2) throw new Error('Insufficient permissions to upload images.');
        if (weight < 3 && (entity_type === 'user' || entity_type === 'toolbox' || entity_type === 'drawer')) {
            throw new Error('You only have permission to upload tool assets.');
        }

        let table = '';
        let idColumn = '';
        if (entity_type === 'user') { table = 'users'; idColumn = 'badge_id'; }
        else if (entity_type === 'tool') { table = 'tools'; idColumn = 'qr_code'; }
        else if (entity_type === 'toolbox') { table = 'toolboxes'; idColumn = 'box_id'; }
        else if (entity_type === 'drawer') { table = 'drawers'; idColumn = 'drawer_id'; }
        else throw new Error('Invalid entity type.');

        const photoUrl = `/uploads/${req.file.filename}`;
        const query = `UPDATE ${table} SET photo_url = $1 WHERE ${idColumn} = $2 RETURNING *`;
        const result = await pool.query(query, [photoUrl, entity_id]);

        if (result.rows.length === 0) throw new Error(`Record not found in ${table}.`);

        res.json({ success: true, photo_url: photoUrl, message: 'Upload successful.' });
    } catch (err) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(403).json({ error: err.message || 'Upload failed.' });
    }
});

// ==========================================
// 7. KIOSK TRANSACTIONS & AUDITS
// ==========================================
// Process Tool Check-in / Check-out. Requires dual-PIN sign-off for every transaction (technician
// badge+pin, PLUS a manager/tool_rep+ sign-off PIN belonging to a different person) and, for
// checkouts, a same-day AUDIT of the tool's home department (see getAuditGatePendingToolboxes).
app.post('/api/transactions', async (req, res) => {
    const { badge_id, pin, action, qr_codes, manager_pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Authenticate the Technician (badge_id + pin)
        const userRes = await client.query('SELECT user_id, dept_id, role, full_name, badge_id FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

        // 2. Manager/sign-off PIN is now always required, for both checkout and check-in.
        if (!manager_pin) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Manager sign-off PIN is required.', code: 'SIGNOFF_REQUIRED' });
        }

        const mgrRes = await client.query("SELECT user_id, full_name, badge_id, role FROM users WHERE pin = $1 AND role IN ('super_admin', 'dept_admin', 'tool_rep') AND is_active = true", [manager_pin]);
        if (mgrRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Invalid Manager PIN or insufficient permissions.', code: 'BAD_PIN' });
        }
        const signoff = mgrRes.rows[0];

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
                SELECT t.tool_id, t.name, t.status, t.is_calibrated, t.cal_due_date, b.dept_id AS tool_dept_id
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
                // A. CALIBRATION HARD-STOP
                if (tool.is_calibrated && tool.cal_due_date) {
                    const today = new Date();
                    const dueDate = new Date(tool.cal_due_date);
                    if (dueDate <= today) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({ error: `Checkout Blocked: ${tool.name} calibration is expired!`, code: 'CAL_EXPIRED' });
                    }
                }

                // B. TRANSFER LOCK
                if (tool.status === 'Pending Transfer' || tool.status === 'In Calibration') {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: `Checkout Blocked: ${tool.name} is currently in a QA transfer.`, code: 'TOOL_IN_TRANSFER' });
                }

                // C. AUDIT GATE (skip if the tool has no resolvable home department)
                if (tool.tool_dept_id != null) {
                    if (!(tool.tool_dept_id in auditGateCache)) {
                        auditGateCache[tool.tool_dept_id] = await getAuditGatePendingToolboxes(client, tool.tool_dept_id);
                    }
                    const pendingToolboxes = auditGateCache[tool.tool_dept_id];
                    if (pendingToolboxes.length > 0) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({ error: `Checkout Blocked: department has not completed today's audit.`, code: 'AUDIT_REQUIRED', pending_toolboxes: pendingToolboxes });
                    }
                }

                // Execute Checkout
                await client.query("UPDATE tools SET status = 'Out' WHERE tool_id = $1", [tool.tool_id]);
                await client.query("INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)", [user.user_id, 'CHECKOUT_TOOL', tool.tool_id, logNotes]);

            } else if (action === 'CHECKIN_TOOL') {
                await client.query("UPDATE tools SET status = 'In', status_reason = NULL WHERE tool_id = $1", [tool.tool_id]);
                await client.query("INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)", [user.user_id, 'CHECKIN_TOOL', tool.tool_id, logNotes]);
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
app.get('/api/audit', async (req, res) => {
    const requesterBadge = req.query.requester;
    if (!requesterBadge) return res.status(401).json({ error: 'Unauthorized.' });
    
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1 AND is_active = true', [requesterBadge]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Access Denied.' });
        
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

// Process a full Toolbox Audit from the Kiosk. No role check beyond a valid active badge.
app.post('/api/audits/submit', async (req, res) => {
    const { badge_id, box_id, results } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) throw new Error('Invalid badge.');
        const userId = userRes.rows[0].user_id;

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

// Admin-panel-facing: today's audit-gate status for every department, reusing the same
// AUDIT GATE helper the checkout flow relies on (empty pending-toolbox list => audited today).
app.get('/api/audits/today-status', async (req, res) => {
    try {
        const depts = await pool.query('SELECT dept_id, name FROM departments ORDER BY name ASC');

        const departments = await Promise.all(depts.rows.map(async (dept) => {
            const pending = await getAuditGatePendingToolboxes(pool, dept.dept_id);
            const audit_completed = pending.length === 0;

            let completed_at = null;
            if (audit_completed) {
                const completedRes = await pool.query(
                    `SELECT MAX(a.timestamp) AS completed_at
                     FROM audit_logs a
                     JOIN tools t ON a.tool_id = t.tool_id
                     JOIN drawers dr ON t.drawer_id = dr.drawer_id
                     JOIN toolboxes b ON dr.box_id = b.box_id
                     WHERE a.action = 'AUDIT' AND a.timestamp::date = CURRENT_DATE AND b.dept_id = $1`,
                    [dept.dept_id]
                );
                completed_at = completedRes.rows[0].completed_at;
            }

            return { dept_id: dept.dept_id, name: dept.name, audit_completed, completed_at };
        }));

        res.json({ success: true, departments });
    } catch (err) {
        console.error("Audit Today-Status Error:", err);
        res.status(500).json({ error: 'Failed to fetch audit status.' });
    }
});

// ==========================================
// 7.5 QA TRANSFERS (CALIBRATION HAND-OFF)
// ==========================================
// Lifecycle: AWAITING_QA_ACCEPT -> IN_CALIBRATION -> AWAITING_HOME_ACCEPT -> COMPLETE (or CANCELLED
// while still AWAITING_QA_ACCEPT). tools.drawer_id is never modified during this cycle -- only
// tools.status reflects the tool being temporarily away for calibration.

// Report a tool issue from the kiosk (Broken/Missing/Worn). Requires a valid technician badge+pin;
// tool must currently be 'In'.
app.post('/api/kiosk/report-issue', async (req, res) => {
    const { badge_id, pin, qr_code, issue_type, notes } = req.body;

    if (!['Broken', 'Missing', 'Worn'].includes(issue_type)) {
        return res.status(400).json({ error: 'Invalid issue_type. Must be one of: Broken, Missing, Worn.', code: 'INVALID_ISSUE_TYPE' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

        const toolRes = await client.query('SELECT tool_id, status FROM tools WHERE qr_code = $1', [qr_code]);
        if (toolRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Tool not found.', code: 'TOOL_NOT_FOUND' });
        }
        const tool = toolRes.rows[0];

        if (tool.status !== 'In') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Tool must be checked in to report an issue.', code: 'TOOL_NOT_IN' });
        }

        await client.query('UPDATE tools SET status = $1, status_reason = $2 WHERE tool_id = $3', [issue_type, notes || null, tool.tool_id]);
        await client.query('INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)', [user.user_id, 'ISSUE_REPORT', tool.tool_id, notes || null]);

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
app.post('/api/transfers/initiate', async (req, res) => {
    const { badge_id, pin, qr_code, qa_dept_id, notes } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

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
app.post('/api/transfers/:transfer_id/qa-accept', async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT user_id, dept_id, role FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

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
app.post('/api/transfers/:transfer_id/complete-cal', async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin, last_cal_date, cal_due_date } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT user_id, dept_id, role FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

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

        if (!cal_due_date) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Calibration Due Date is required.', code: 'CAL_DUE_DATE_REQUIRED' });
        }

        const toolRes = await client.query(
            `UPDATE tools SET last_cal_date = $1, cal_due_date = $2, is_calibrated = true, status = 'Pending Transfer'
             WHERE tool_id = $3 RETURNING tool_id, last_cal_date, cal_due_date`,
            [last_cal_date || null, cal_due_date, transfer.tool_id]
        );
        const transferUpdRes = await client.query(
            `UPDATE tool_transfers SET status = 'AWAITING_HOME_ACCEPT', cal_completed_by_user_id = $1, cal_completed_at = NOW(), updated_at = NOW()
             WHERE transfer_id = $2 RETURNING transfer_id, tool_id, home_dept_id, qa_dept_id, status, initiated_at`,
            [user.user_id, transfer_id]
        );
        await client.query(
            "INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, 'CAL_COMPLETE', $2, 'Calibration completed; awaiting home department acceptance')",
            [user.user_id, transfer.tool_id]
        );

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
app.post('/api/transfers/:transfer_id/home-accept', async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT user_id, dept_id, role FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

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
app.post('/api/transfers/:transfer_id/cancel', async (req, res) => {
    const { transfer_id } = req.params;
    const { badge_id, pin, reason } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT user_id, role FROM users WHERE badge_id = $1 AND pin = $2 AND is_active = true', [badge_id, pin]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid Technician Badge or PIN.', code: 'BAD_TECH_PIN' });
        }
        const user = userRes.rows[0];

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

// Generate an AUDIT or FLAGGED report, scoped to a department if the requester is a dept_admin.
// No explicit minimum role check (getRoleWeight is used only to derive queryDept), any authenticated user may call this.
app.post('/api/reports/generate', async (req, res) => {
    const { requester, report_type, dept_id, start_date, end_date } = req.body;
    try {
        const auth = await pool.query('SELECT role, dept_id FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0) return res.status(403).json({ error: 'Unauthorized.' });
        
        const user = auth.rows[0];
        const weight = getRoleWeight(user.role);
        let queryDept = dept_id;
        if (weight === 3) queryDept = user.dept_id;

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

            // AUDIT STATUS (reuse the audit-gate helper from stage 1)
            const pendingToolboxes = await getAuditGatePendingToolboxes(pool, deptId);
            let auditStatusLine;
            if (pendingToolboxes.length === 0) {
                const completedRes = await pool.query(
                    `SELECT a.timestamp, u.full_name, u.badge_id
                     FROM audit_logs a
                     JOIN users u ON a.user_id = u.user_id
                     JOIN tools t ON a.tool_id = t.tool_id
                     JOIN drawers dr ON t.drawer_id = dr.drawer_id
                     JOIN toolboxes b ON dr.box_id = b.box_id
                     WHERE a.action = 'AUDIT' AND a.timestamp::date = CURRENT_DATE AND b.dept_id = $1
                     ORDER BY a.timestamp DESC LIMIT 1`,
                    [deptId]
                );
                if (completedRes.rows.length > 0) {
                    const completion = completedRes.rows[0];
                    const completedTime = new Date(completion.timestamp).toTimeString().slice(0, 5);
                    auditStatusLine = `Completed today at ${completedTime} by ${completion.full_name} (${completion.badge_id})`;
                } else {
                    // No auditable toolboxes in this department at all -> gate trivially passes.
                    auditStatusLine = `Completed today at N/A (no auditable toolboxes)`;
                }
            } else {
                auditStatusLine = `NOT audited today`;
            }

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
app.listen(3000, '0.0.0.0', () => { 
    console.log(`Backend API running on port 3000.`); 
});