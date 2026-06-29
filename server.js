const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    user: 'tooladmin', host: 'localhost', database: 'tooltracker', password: 'SuperSecretPassword123', port: 5432,
});

// --- HELPER FUNCTIONS ---
// Hierarchy Logic: SA=4, DA=3, TR=2, Tech=1
const getRoleWeight = (role) => ({ 'super_admin': 4, 'dept_admin': 3, 'tool_rep': 2, 'technician': 1 }[role] || 0);
const generatePin = () => Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit PIN
const simulateEmail = (email, subject, body) => {
    console.log(`\n=================================================`);
    console.log(`📧 EMAIL SENT TO: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${body}`);
    console.log(`=================================================\n`);
};

// ==========================================
// 1. SYSTEM & INVENTORY FETCHING
// ==========================================
app.get('/api/status', async (req, res) => {
    try { const result = await pool.query('SELECT NOW()'); res.json({ message: 'Online', db_time: result.rows[0].now }); } 
    catch (err) { res.status(500).json({ error: 'DB failed' }); }
});

app.get('/api/tools', async (req, res) => {
    try {
        const query = `SELECT t.*, b.name AS toolbox_name, dr.name AS drawer_name, d.name AS department_name FROM tools t LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id LEFT JOIN toolboxes b ON t.box_id = b.box_id LEFT JOIN departments d ON b.dept_id = d.dept_id ORDER BY t.name ASC;`;
        const result = await pool.query(query); res.json({ success: true, tools: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch tools.' }); }
});

app.get('/api/tools/next-id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT MAX(CAST(SUBSTRING(qr_code FROM '[0-9]+') AS INTEGER)) + 1 AS next_number FROM tools WHERE qr_code LIKE '%-%';`);
        res.json({ success: true, next_sequence: result.rows[0].next_number || 10001 });
    } catch (err) { res.status(500).json({ error: 'Failed to calculate ID.' }); }
});

// ==========================================
// 2. AUTHENTICATION (Supports Username or Badge)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { login_id, pin } = req.body; 
    try {
        // ILIKE ensures case-insensitive matching (so 'admin' matches 'ADMIN')
        const result = await pool.query(
            'SELECT user_id, badge_id, full_name, username, role, is_active FROM users WHERE (badge_id ILIKE $1 OR username ILIKE $1) AND pin = $2', 
            [login_id, pin]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid Credentials.' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Server error during login.' }); }
});

app.post('/api/kiosk-auth', async (req, res) => {
    const { login_id } = req.body; 
    try {
        // ILIKE ensures case-insensitive matching here as well
        const result = await pool.query(
            'SELECT user_id, badge_id, full_name, role, is_active FROM users WHERE badge_id ILIKE $1 OR username ILIKE $1', 
            [login_id]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Unrecognized ID.' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Server error.' }); }
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

        // Can only view users with a strictly lower weight than themselves
        const result = await pool.query(`SELECT u.user_id, u.badge_id, u.username, u.email, u.full_name, u.role, d.name AS department_name FROM users u LEFT JOIN departments d ON u.dept_id = d.dept_id WHERE u.is_active = true ORDER BY u.full_name ASC`);
        
        const filteredUsers = result.rows.filter(u => getRoleWeight(u.role) < reqWeight);
        res.json({ success: true, users: filteredUsers });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch users.' }); }
});

app.post('/api/users', async (req, res) => {
    const { full_name, email, dept_id, role, requester } = req.body;
    
    // Use a transaction pool so we lock the database while generating the ID
    const client = await pool.connect(); 
    try {
        await client.query('BEGIN');

        // 1. Verify Bouncer & Hierarchy
        const auth = await client.query('SELECT role, dept_id FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0) throw new Error('Access Denied.');
        if (getRoleWeight(auth.rows[0].role) <= getRoleWeight(role)) {
            throw new Error('Hierarchy Violation: Cannot create an account at or above your own rank.');
        }

        // 2. Determine correct Department (Super Admins can assign anywhere)
        const finalDeptId = auth.rows[0].role === 'super_admin' ? dept_id : auth.rows[0].dept_id;

        // 3. Auto-Generate Username (Extract everything before the @)
        if (!email || !email.includes('@')) throw new Error('Valid email address required.');
        const username = email.split('@')[0].toLowerCase();

        // 4. Auto-Generate Badge ID (e.g., AVI001)
        const deptRes = await client.query('SELECT prefix_code FROM departments WHERE dept_id = $1', [finalDeptId]);
        if (deptRes.rows.length === 0) throw new Error('Invalid Department selected.');
        const prefix = deptRes.rows[0].prefix_code; 

        // Find highest existing number for this specific prefix using regex to strip letters
        const maxRes = await client.query(`
            SELECT MAX(CAST(NULLIF(regexp_replace(badge_id, '\\D', '', 'g'), '') AS INTEGER)) as max_num 
            FROM users 
            WHERE badge_id LIKE $1
        `, [`${prefix}%`]);
        
        let nextNum = (maxRes.rows[0].max_num || 0) + 1;
        // Combine prefix and pad the number with leading zeros (e.g., AVI + 001)
        const badge_id = prefix + String(nextNum).padStart(3, '0');

        // 5. Generate PIN and Insert User
        const newPin = generatePin();
        const result = await client.query(
            'INSERT INTO users (badge_id, full_name, email, username, dept_id, role, pin) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', 
            [badge_id, full_name, email, username, finalDeptId, role, newPin]
        );

        await client.query('COMMIT');

        // 6. Dispatch the Welcome Email
        simulateEmail(email, 'Welcome to LTA Tracker', 
            `Hello ${full_name},\n\nYour account has been provisioned.\n\n` +
            `Username: ${username}\nBadge ID: ${badge_id}\nTemporary PIN: ${newPin}\n\n` +
            `Please log into the Admin portal to change your PIN.`
        );
        
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message || 'Failed to create user. Email may already exist.' });
    } finally {
        client.release();
    }
});

app.post('/api/users/:badge_id/reset-pin', async (req, res) => {
    const { badge_id } = req.params; const { requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        const target = await pool.query('SELECT role, email, full_name FROM users WHERE badge_id = $1', [badge_id]);
        
        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        if (getRoleWeight(auth.rows[0].role) <= getRoleWeight(target.rows[0].role)) {
            return res.status(403).json({ error: 'Hierarchy Violation: Cannot reset PIN for your rank or higher.' });
        }

        const newPin = generatePin();
        await pool.query('UPDATE users SET pin = $1 WHERE badge_id = $2', [newPin, badge_id]);
        
        simulateEmail(target.rows[0].email, 'PIN Reset', `Hello ${target.rows[0].full_name},\nYour admin has reset your PIN. Your new temporary PIN is: ${newPin}`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to reset PIN.' }); }
});

app.put('/api/users/:badge_id/deactivate', async (req, res) => {
    const { badge_id } = req.params; const { requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        const target = await pool.query('SELECT role FROM users WHERE badge_id = $1', [badge_id]);
        
        if (getRoleWeight(auth.rows[0].role) <= getRoleWeight(target.rows[0].role)) {
            return res.status(403).json({ error: 'Hierarchy Violation: Cannot deactivate a user at or above your rank.' });
        }

        await pool.query('UPDATE users SET is_active = false WHERE badge_id = $1', [badge_id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// SELF-SERVICE: Update Own Account
app.put('/api/users/me/update', async (req, res) => {
    const { requester, new_username, new_pin } = req.body;
    try {
        if (new_username) await pool.query('UPDATE users SET username = $1 WHERE badge_id = $2', [new_username, requester]);
        if (new_pin) await pool.query('UPDATE users SET pin = $1 WHERE badge_id = $2', [new_pin, requester]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update account. Username may be taken.' }); }
});

// ==========================================
// 4. ASSETS, STORAGE & AUDIT ENDPOINTS (Retained exactly as they were)
// ==========================================
app.get('/api/storage', async (req, res) => {
    try {
        const depts = await pool.query('SELECT * FROM departments ORDER BY name');
        const boxes = await pool.query('SELECT * FROM toolboxes ORDER BY name');
        const drawers = await pool.query('SELECT * FROM drawers ORDER BY name');
        res.json({ success: true, departments: depts.rows, toolboxes: boxes.rows, drawers: drawers.rows });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});
app.post('/api/departments', async (req, res) => {
    const { name, prefix_code, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 4) return res.status(403).json({ error: 'Super Admin clearance required.' });
        const result = await pool.query('INSERT INTO departments (name, prefix_code) VALUES ($1, $2) RETURNING *', [name, prefix_code.toUpperCase()]);
        res.json({ success: true, department: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});
app.post('/api/toolboxes', async (req, res) => {
    const { name, dept_id, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        const result = await pool.query('INSERT INTO toolboxes (dept_id, name) VALUES ($1, $2) RETURNING *', [dept_id, name]);
        res.json({ success: true, toolbox: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});
app.post('/api/drawers', async (req, res) => {
    const { box_id, name, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Admin required.' });
        const result = await pool.query('INSERT INTO drawers (box_id, name) VALUES ($1, $2) RETURNING *', [box_id, name]);
        res.json({ success: true, drawer: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});
app.post('/api/tools', async (req, res) => {
    const { qr_code, name, drawer_id, replaced_tool_id, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (getRoleWeight(auth.rows[0].role) < 2) return res.status(403).json({ error: 'Tool Rep clearance required.' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (replaced_tool_id) await client.query("UPDATE tools SET qr_code = qr_code || '-RET-' || tool_id, status = 'Retired' WHERE tool_id = $1", [replaced_tool_id]);
            const insertRes = await client.query('INSERT INTO tools (qr_code, name, drawer_id, status) VALUES ($1, $2, $3, $4) RETURNING tool_id', [qr_code, name, drawer_id || null, 'In']);
            if (replaced_tool_id) await client.query('UPDATE tools SET replaced_by_id = $1 WHERE tool_id = $2', [insertRes.rows[0].tool_id, replaced_tool_id]);
            await client.query('COMMIT'); res.json({ success: true });
        } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});
app.get('/api/audit', async (req, res) => {
    const requesterBadge = req.query.requester;
    if (!requesterBadge) return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1 AND is_active = true', [requesterBadge]);
        if (getRoleWeight(auth.rows[0].role) < 3) return res.status(403).json({ error: 'Access Denied.' });
        const query = `SELECT a.log_id, a.action, a.timestamp, a.notes, u.full_name AS user_name, u.badge_id, t.qr_code, t.name AS tool_name FROM audit_logs a LEFT JOIN users u ON a.user_id = u.user_id LEFT JOIN tools t ON a.tool_id = t.tool_id ORDER BY a.timestamp DESC LIMIT 50;`;
        const result = await pool.query(query); res.json({ success: true, logs: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});
app.post('/api/transactions', async (req, res) => {
    const { badge_id, action, qr_codes } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) throw new Error('Invalid badge.');
        const userId = userRes.rows[0].user_id;
        const targetStatus = action === 'CHECKOUT_TOOL' ? 'Out' : 'In'; const expectedStatus = action === 'CHECKOUT_TOOL' ? 'In' : 'Out';
        for (let qr of qr_codes) {
            const toolRes = await client.query('SELECT tool_id FROM tools WHERE qr_code = $1 AND status = $2', [qr, expectedStatus]);
            if (toolRes.rows.length === 0) throw new Error(`Tool ${qr} unavailable.`);
            await client.query('UPDATE tools SET status = $1 WHERE tool_id = $2', [targetStatus, toolRes.rows[0].tool_id]);
            await client.query('INSERT INTO audit_logs (user_id, action, tool_id) VALUES ($1, $2, $3)', [userId, action, toolRes.rows[0].tool_id]);
        }
        await client.query('COMMIT'); res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); } finally { client.release(); }
});
app.post('/api/tools/report', async (req, res) => {
    const { badge_id, qr_code, issue_type, notes } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) throw new Error('Invalid badge.');
        const toolRes = await client.query('SELECT tool_id FROM tools WHERE qr_code = $1', [qr_code]);
        if (toolRes.rows.length === 0) throw new Error('Tool not found.');
        await client.query('UPDATE tools SET status = $1, status_reason = $2 WHERE tool_id = $3', [issue_type, notes, toolRes.rows[0].tool_id]);
        await client.query('INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)', [userRes.rows[0].user_id, `REPORT_${issue_type.toUpperCase()}`, toolRes.rows[0].tool_id, notes]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); } finally { client.release(); }
});

// START SERVER
app.listen(3000, '0.0.0.0', () => { console.log(`Backend API running on port 3000.`); });