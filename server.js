const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

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
// DATABASE CONFIGURATION
// ==========================================
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
const getRoleWeight = (role) => {
    const weights = { 'super_admin': 4, 'dept_admin': 3, 'tool_rep': 2, 'technician': 1 };
    return weights[role] || 0;
};

const generatePin = () => Math.floor(100000 + Math.random() * 900000).toString();

const simulateEmail = (email, subject, body) => {
    console.log(`\n=================================================`);
    console.log(`📧 EMAIL SENT TO: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${body}`);
    console.log(`=================================================\n`);
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
app.get('/api/status', async (req, res) => {
    try { 
        const result = await pool.query('SELECT NOW()'); 
        res.json({ message: 'Online', db_time: result.rows[0].now }); 
    } catch (err) { 
        res.status(500).json({ error: 'DB connection failed' }); 
    }
});

app.get('/api/tools', async (req, res) => {
    try {
        const query = `
            SELECT t.*, b.name AS toolbox_name, dr.name AS drawer_name, d.name AS department_name 
            FROM tools t 
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id 
            LEFT JOIN toolboxes b ON t.box_id = b.box_id 
            LEFT JOIN departments d ON b.dept_id = d.dept_id 
            ORDER BY t.name ASC;
        `;
        const result = await pool.query(query); 
        res.json({ success: true, tools: result.rows });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to fetch tools.' }); 
    }
});

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

app.post('/api/kiosk-auth', async (req, res) => {
    const { login_id } = req.body; 
    try {
        const query = `
            SELECT user_id, badge_id, full_name, role, is_active 
            FROM users WHERE badge_id ILIKE $1 OR username ILIKE $1
        `;
        const result = await pool.query(query, [login_id]);
        
        if (result.rows.length === 0) return res.status(401).json({ error: 'Unrecognized ID.' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.' });
        
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: 'Server error.' }); 
    }
});

// ==========================================
// 3. USER MANAGEMENT & SELF-SERVICE
// ==========================================
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
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to reset PIN.' }); 
    }
});

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
app.get('/api/storage', async (req, res) => {
    try {
        const depts = await pool.query('SELECT * FROM departments ORDER BY name');
        const boxes = await pool.query('SELECT * FROM toolboxes ORDER BY name');
        const drawers = await pool.query('SELECT * FROM drawers ORDER BY name');
        res.json({ success: true, departments: depts.rows, toolboxes: boxes.rows, drawers: drawers.rows });
    } catch (err) { 
        res.status(500).json({ error: 'Failed.' }); 
    }
});

app.post('/api/departments', async (req, res) => {
    const { name, prefix_code, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 4) return res.status(403).json({ error: 'Super Admin clearance required.' });
        
        const result = await pool.query('INSERT INTO departments (name, prefix_code) VALUES ($1, $2) RETURNING *', [name, prefix_code.toUpperCase()]);
        res.json({ success: true, department: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: 'Failed.' }); 
    }
});

app.post('/api/toolboxes', async (req, res) => {
    const { name, dept_id, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        
        const result = await pool.query('INSERT INTO toolboxes (dept_id, name) VALUES ($1, $2) RETURNING *', [dept_id, name]);
        res.json({ success: true, toolbox: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: 'Failed.' }); 
    }
});

app.post('/api/drawers', async (req, res) => {
    const { box_id, name, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        
        const result = await pool.query('INSERT INTO drawers (box_id, name) VALUES ($1, $2) RETURNING *', [box_id, name]);
        res.json({ success: true, drawer: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: 'Failed.' }); 
    }
});

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

app.delete('/api/toolboxes/:id', async (req, res) => {
    try {
        const checkDrawers = await pool.query('SELECT COUNT(*) FROM drawers WHERE box_id = $1', [req.params.id]);
        const checkTools = await pool.query('SELECT COUNT(*) FROM tools WHERE box_id = $1', [req.params.id]);
        if (parseInt(checkDrawers.rows[0].count) > 0 || parseInt(checkTools.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: Not empty.' });
        await pool.query('DELETE FROM toolboxes WHERE box_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to delete Toolbox.' }); 
    }
});

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
app.post('/api/tools', async (req, res) => {
    const { qr_code, name, drawer_id, replaced_tool_id, requester, is_calibrated, last_cal_date, cal_due_date } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 2) return res.status(403).json({ error: 'Tool Rep clearance required.' });
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (replaced_tool_id) {
                await client.query("UPDATE tools SET qr_code = qr_code || '-RET-' || tool_id, status = 'Retired' WHERE tool_id = $1", [replaced_tool_id]);
            }
            
            const insertQuery = `INSERT INTO tools (qr_code, name, drawer_id, status, is_calibrated, last_cal_date, cal_due_date) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING tool_id`;
            const insertRes = await client.query(insertQuery, [qr_code, name, drawer_id || null, 'In', is_calibrated || false, last_cal_date || null, cal_due_date || null]);
            
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

// ==========================================
// 6. PHOTO UPLOAD ENDPOINT
// ==========================================
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
app.post('/api/transactions', async (req, res) => {
    const { badge_id, action, qr_codes } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) throw new Error('Invalid badge.');
        const userId = userRes.rows[0].user_id;
        
        const targetStatus = action === 'CHECKOUT_TOOL' ? 'Out' : 'In'; 
        const expectedStatus = action === 'CHECKOUT_TOOL' ? 'In' : 'Out';
        
        for (let qr of qr_codes) {
            const toolRes = await client.query('SELECT tool_id FROM tools WHERE qr_code = $1 AND status = $2', [qr, expectedStatus]);
            if (toolRes.rows.length === 0) throw new Error(`Tool ${qr} unavailable.`);
            
            await client.query('UPDATE tools SET status = $1 WHERE tool_id = $2', [targetStatus, toolRes.rows[0].tool_id]);
            await client.query('INSERT INTO audit_logs (user_id, action, tool_id) VALUES ($1, $2, $3)', [userId, action, toolRes.rows[0].tool_id]);
        }
        await client.query('COMMIT'); res.json({ success: true });
    } catch (err) { 
        await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); 
    } finally { 
        client.release(); 
    }
});

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

// Process a full Toolbox Audit from the Kiosk
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

// ==========================================
// 8. DASHBOARD & REPORTS
// ==========================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const outTools = await pool.query(`
            SELECT t.qr_code, t.name AS tool_name, u.full_name AS user_name, a.timestamp, d.name AS dept_name, b.name AS box_name
            FROM tools t
            LEFT JOIN audit_logs a ON a.log_id = (SELECT MAX(log_id) FROM audit_logs WHERE tool_id = t.tool_id)
            LEFT JOIN users u ON a.user_id = u.user_id
            LEFT JOIN toolboxes b ON t.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            WHERE t.status = 'Out' ORDER BY a.timestamp DESC
        `);

        const flaggedTools = await pool.query(`
            SELECT t.qr_code, t.name AS tool_name, t.status, t.status_reason, d.name AS dept_name, b.name AS box_name
            FROM tools t LEFT JOIN toolboxes b ON t.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
            WHERE t.status IN ('Broken', 'Missing', 'Worn') ORDER BY t.status ASC
        `);

        const stats = await pool.query(`
            SELECT (SELECT COUNT(*) FROM tools) AS total_tools,
                   (SELECT COUNT(*) FROM tools WHERE status = 'Out') AS total_out,
                   (SELECT COUNT(*) FROM tools WHERE status IN ('Broken', 'Missing', 'Worn')) AS total_flagged
        `);

        res.json({ success: true, out_tools: outTools.rows, flagged_tools: flaggedTools.rows, stats: stats.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch dashboard data.' });
    }
});

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
            let query = `
                SELECT a.timestamp, u.full_name, u.badge_id, a.action, t.qr_code, t.name AS tool_name, d.name AS dept_name, a.notes
                FROM audit_logs a LEFT JOIN users u ON a.user_id = u.user_id LEFT JOIN tools t ON a.tool_id = t.tool_id
                LEFT JOIN toolboxes b ON t.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
                WHERE a.timestamp >= $1::timestamp AND a.timestamp <= $2::timestamp
            `;
            const params = [start_date + ' 00:00:00', end_date + ' 23:59:59'];
            if (queryDept !== 'ALL') { query += ` AND d.dept_id = $3`; params.push(queryDept); }
            query += ` ORDER BY a.timestamp DESC`;
            const result = await pool.query(query, params);
            data = result.rows;
        } else if (report_type === 'FLAGGED') {
            let query = `
                SELECT t.qr_code, t.name AS tool_name, t.status, t.status_reason, d.name AS dept_name
                FROM tools t LEFT JOIN toolboxes b ON t.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
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

async function generateHourlyLog() {
    try {
        const query = `
            SELECT COALESCE(d.prefix_code, 'GLOBAL') AS dept_prefix, COUNT(t.tool_id) AS tools_out
            FROM tools t LEFT JOIN toolboxes b ON t.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
            WHERE t.status = 'Out' GROUP BY d.prefix_code;
        `;
        const result = await pool.query(query);
        const now = new Date();
        const dateString = now.toISOString().split('T')[0]; 
        const timeString = now.toLocaleTimeString();

        result.rows.forEach(row => {
            const prefix = row.dept_prefix;
            const deptDir = path.join(hourlyDir, prefix);
            if (!fs.existsSync(deptDir)) fs.mkdirSync(deptDir, { recursive: true });
            const filePath = path.join(deptDir, `${dateString}_hourly.log`);
            fs.appendFileSync(filePath, `[${timeString}] Tools currently checked out: ${row.tools_out}\n`);
        });
        console.log(`[Logger] Hourly metrics successfully routed to department folders.`);
    } catch (err) {
        console.error("Hourly log failed:", err);
    }
}

async function generateDailyLog() {
    try {
        const query = `
            SELECT COALESCE(d.prefix_code, 'GLOBAL') AS dept_prefix, t.status, COUNT(t.tool_id) AS status_count
            FROM tools t LEFT JOIN toolboxes b ON t.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id
            GROUP BY d.prefix_code, t.status;
        `;
        const result = await pool.query(query);
        const now = new Date();
        const dateString = now.toISOString().split('T')[0]; 
        const monthString = dateString.substring(0, 7); 
        
        const deptData = {};
        result.rows.forEach(row => {
            if (!deptData[row.dept_prefix]) deptData[row.dept_prefix] = [];
            deptData[row.dept_prefix].push({ status: row.status, count: row.status_count });
        });

        for (const [prefix, statsArray] of Object.entries(deptData)) {
            const deptDir = path.join(dailyDir, prefix);
            if (!fs.existsSync(deptDir)) fs.mkdirSync(deptDir, { recursive: true });

            let stats = `\n[DAILY SNAPSHOT] ${dateString}\n`;
            statsArray.forEach(stat => { stats += `  - ${stat.status}: ${stat.count}\n`; });
            stats += `----------------------------------------\n`;
            
            const filePath = path.join(deptDir, `${monthString}_daily.log`);
            fs.appendFileSync(filePath, stats);
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