const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Broadcast the "public" folder to the web
app.use(express.static(path.join(__dirname, 'public')));

// Connect to PostgreSQL Database
const pool = new Pool({
    user: 'tooladmin',
    host: 'localhost', 
    database: 'tooltracker',
    password: 'SuperSecretPassword123',
    port: 5432,
});

// ==========================================
// 1. SYSTEM STATUS
// ==========================================
app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ message: 'Central Server Online!', db_time: result.rows[0].now });
    } catch (err) { res.status(500).json({ error: 'Database connection failed' }); }
});

// ==========================================
// 2. FETCH INVENTORY & USERS (Secured Reads)
// ==========================================
app.get('/api/tools', async (req, res) => {
    try {
        const query = `
            SELECT t.tool_id, t.qr_code, t.name, t.status, t.status_reason, t.replaced_by_id,
                   b.name AS toolbox_name, dr.name AS drawer_name, d.name AS department_name
            FROM tools t
            LEFT JOIN drawers dr ON t.drawer_id = dr.drawer_id
            LEFT JOIN toolboxes b ON t.box_id = b.box_id
            LEFT JOIN departments d ON b.dept_id = d.dept_id
            ORDER BY t.name ASC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, tools: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch tools.' }); }
});

app.get('/api/users', async (req, res) => {
    const requesterBadge = req.query.requester;
    if (!requesterBadge) return res.status(401).json({ error: 'Unauthorized: Who is asking?' });

    try {
        const requesterRes = await pool.query('SELECT role, dept_id FROM users WHERE badge_id = $1 AND is_active = true', [requesterBadge]);
        if (requesterRes.rows.length === 0) return res.status(403).json({ error: 'Invalid or deactivated requester account.' });
        
        const requester = requesterRes.rows[0];
        let query = ''; let params = [];

        if (requester.role === 'super_admin') {
            query = `SELECT u.user_id, u.badge_id, u.full_name, u.role, d.name AS department_name FROM users u LEFT JOIN departments d ON u.dept_id = d.dept_id WHERE u.is_active = true ORDER BY u.full_name ASC`;
        } else if (requester.role === 'dept_admin') {
            query = `SELECT u.user_id, u.badge_id, u.full_name, u.role, d.name AS department_name FROM users u LEFT JOIN departments d ON u.dept_id = d.dept_id WHERE u.is_active = true AND u.dept_id = $1 ORDER BY u.full_name ASC`;
            params = [requester.dept_id];
        } else { return res.status(403).json({ error: 'Access Denied: Insufficient privileges.' }); }

        const result = await pool.query(query, params);
        res.json({ success: true, users: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch users.' }); }
});

// ==========================================
// 3. AUTHENTICATION
// ==========================================
app.post('/api/login', async (req, res) => {
    const { badge_id, pin } = req.body; 
    try {
        const result = await pool.query('SELECT user_id, full_name, role, is_active FROM users WHERE badge_id = $1 AND pin = $2', [badge_id, pin]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid Badge ID or PIN.' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.' });
        res.json({ success: true, user: { id: result.rows[0].user_id, name: result.rows[0].full_name, role: result.rows[0].role } });
    } catch (err) { res.status(500).json({ error: 'Server error during login.' }); }
});

app.post('/api/kiosk-auth', async (req, res) => {
    const { badge_id } = req.body; 
    try {
        const result = await pool.query('SELECT user_id, full_name, role, is_active FROM users WHERE badge_id = $1', [badge_id]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Unrecognized Badge.' });
        if (!result.rows[0].is_active) return res.status(403).json({ error: 'Profile deactivated.' });
        res.json({ success: true, user: { id: result.rows[0].user_id, name: result.rows[0].full_name, role: result.rows[0].role } });
    } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

// ==========================================
// 4. NEXT AVAILABLE TOOL ID
// ==========================================
app.get('/api/tools/next-id', async (req, res) => {
    try {
        const query = `SELECT MAX(CAST(SUBSTRING(qr_code FROM '[0-9]+') AS INTEGER)) + 1 AS next_number FROM tools WHERE qr_code LIKE '%-%';`;
        const result = await pool.query(query);
        res.json({ success: true, next_sequence: result.rows[0].next_number || 10001 });
    } catch (err) { res.status(500).json({ error: 'Failed to calculate ID.' }); }
});

// ==========================================
// 5. TRANSACTIONS, REPORTS & AUDIT LOGS
// ==========================================
app.get('/api/audit', async (req, res) => {
    const requesterBadge = req.query.requester;
    if (!requesterBadge) return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1 AND is_active = true', [requesterBadge]);
        if (auth.rows.length === 0 || auth.rows[0].role === 'tool_rep' || auth.rows[0].role === 'technician') return res.status(403).json({ error: 'Access Denied.' });

        const query = `
            SELECT a.log_id, a.action, a.timestamp, a.notes, u.full_name AS user_name, u.badge_id, t.qr_code, t.name AS tool_name
            FROM audit_logs a LEFT JOIN users u ON a.user_id = u.user_id LEFT JOIN tools t ON a.tool_id = t.tool_id
            ORDER BY a.timestamp DESC LIMIT 50;
        `;
        const result = await pool.query(query);
        res.json({ success: true, logs: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch logs.' }); }
});

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
        let processedTools = [];

        for (let qr of qr_codes) {
            const toolRes = await client.query('SELECT tool_id, name FROM tools WHERE qr_code = $1 AND status = $2', [qr, expectedStatus]);
            if (toolRes.rows.length === 0) throw new Error(`Tool ${qr} unavailable.`);
            const toolId = toolRes.rows[0].tool_id;
            await client.query('UPDATE tools SET status = $1 WHERE tool_id = $2', [targetStatus, toolId]);
            await client.query('INSERT INTO audit_logs (user_id, action, tool_id) VALUES ($1, $2, $3)', [userId, action, toolId]);
            processedTools.push(toolRes.rows[0].name);
        }
        await client.query('COMMIT');
        res.json({ success: true, tools: processedTools });
    } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); } finally { client.release(); }
});

app.post('/api/tools/report', async (req, res) => {
    const { badge_id, qr_code, issue_type, notes } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT user_id FROM users WHERE badge_id = $1 AND is_active = true', [badge_id]);
        if (userRes.rows.length === 0) throw new Error('Invalid badge.');
        const userId = userRes.rows[0].user_id;

        const toolRes = await client.query('SELECT tool_id FROM tools WHERE qr_code = $1', [qr_code]);
        if (toolRes.rows.length === 0) throw new Error('Tool not found.');
        const toolId = toolRes.rows[0].tool_id;

        await client.query('UPDATE tools SET status = $1, status_reason = $2 WHERE tool_id = $3', [issue_type, notes, toolId]);
        await client.query('INSERT INTO audit_logs (user_id, action, tool_id, notes) VALUES ($1, $2, $3, $4)', [userId, `REPORT_${issue_type.toUpperCase()}`, toolId, notes]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ error: err.message }); } finally { client.release(); }
});

// ==========================================
// 6. MANAGEMENT: ADD / DEACTIVATE USERS
// ==========================================
app.post('/api/users', async (req, res) => {
    const { badge_id, full_name, dept_id, role, pin, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role, dept_id FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0 || ['tool_rep', 'technician'].includes(auth.rows[0].role)) return res.status(403).json({ error: 'Access Denied.' });
        const finalDeptId = auth.rows[0].role === 'super_admin' ? dept_id : auth.rows[0].dept_id;
        const result = await pool.query('INSERT INTO users (badge_id, full_name, dept_id, role, pin) VALUES ($1, $2, $3, $4, $5) RETURNING *', [badge_id, full_name, finalDeptId, role || 'technician', pin || '1234']);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed to create user.' }); }
});

app.put('/api/users/:badge_id/deactivate', async (req, res) => {
    const { badge_id } = req.params; const { requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0 || ['tool_rep', 'technician'].includes(auth.rows[0].role)) return res.status(403).json({ error: 'Access Denied.' });
        const result = await pool.query('UPDATE users SET is_active = false WHERE badge_id = $1 RETURNING *', [badge_id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ==========================================
// 7. MANAGEMENT: ASSET LOGIC
// ==========================================
app.post('/api/tools', async (req, res) => {
    const { qr_code, name, drawer_id, replaced_tool_id, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0 || auth.rows[0].role === 'technician') return res.status(403).json({ error: 'Tool Rep clearance required.' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (replaced_tool_id) {
                await client.query("UPDATE tools SET qr_code = qr_code || '-RET-' || tool_id, status = 'Retired' WHERE tool_id = $1", [replaced_tool_id]);
            }
            const insertRes = await client.query('INSERT INTO tools (qr_code, name, drawer_id, status) VALUES ($1, $2, $3, $4) RETURNING tool_id', [qr_code, name, drawer_id || null, 'In']);
            const newToolId = insertRes.rows[0].tool_id;
            if (replaced_tool_id) {
                await client.query('UPDATE tools SET replaced_by_id = $1 WHERE tool_id = $2', [newToolId, replaced_tool_id]);
            }
            await client.query('COMMIT');
            res.json({ success: true, tool_id: newToolId });
        } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    } catch (err) { res.status(500).json({ error: 'Failed to add tool.' }); }
});

// ==========================================
// 8. STORAGE HIERARCHY MANAGEMENT
// ==========================================
app.get('/api/storage', async (req, res) => {
    try {
        const depts = await pool.query('SELECT * FROM departments ORDER BY name');
        const boxes = await pool.query('SELECT * FROM toolboxes ORDER BY name');
        const drawers = await pool.query('SELECT * FROM drawers ORDER BY name');
        res.json({ success: true, departments: depts.rows, toolboxes: boxes.rows, drawers: drawers.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch storage.' }); }
});

app.post('/api/departments', async (req, res) => {
    const { name, prefix_code, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0 || auth.rows[0].role !== 'super_admin') return res.status(403).json({ error: 'Super Admin clearance required.' });
        const result = await pool.query('INSERT INTO departments (name, prefix_code) VALUES ($1, $2) RETURNING *', [name, prefix_code.toUpperCase()]);
        res.json({ success: true, department: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/toolboxes', async (req, res) => {
    const { name, dept_id, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0 || ['tool_rep', 'technician'].includes(auth.rows[0].role)) return res.status(403).json({ error: 'Admin required.' });
        const result = await pool.query('INSERT INTO toolboxes (dept_id, name) VALUES ($1, $2) RETURNING *', [dept_id, name]);
        res.json({ success: true, toolbox: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/drawers', async (req, res) => {
    const { box_id, name, requester } = req.body;
    try {
        const auth = await pool.query('SELECT role FROM users WHERE badge_id = $1', [requester]);
        if (auth.rows.length === 0 || ['tool_rep', 'technician'].includes(auth.rows[0].role)) return res.status(403).json({ error: 'Admin required.' });
        const result = await pool.query('INSERT INTO drawers (box_id, name) VALUES ($1, $2) RETURNING *', [box_id, name]);
        res.json({ success: true, drawer: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// START SERVER (Listening on 0.0.0.0 to allow network connections like iPhones!)
app.listen(3000, '0.0.0.0', () => { 
    console.log(`Backend API running on port 3000. Ready for network connections.`); 
});