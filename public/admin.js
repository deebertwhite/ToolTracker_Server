// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
let currentAdminBadge = null; 
let currentAdminWeight = 0; 
let html5QrAdminInstance = null;
let uploadTarget = { type: null, id: null };

// Global caches for the Universal Modal
let globalBoxesCache = [];
let globalDrawersCache = [];
let globalToolsCache = [];

// ==========================================
// 2. UTILITIES & VIEW TOGGLES
// ==========================================

/**
 * Toggles the universal entity modal (#entity-modal-overlay) between its read-only view
 * and its edit view. isEditing=false (the default when the modal opens) shows #em-read-fields
 * and the "Edit Details" button; isEditing=true shows #em-edit-fields and the "Save Changes"
 * button. Does not itself gate on role weight -- callers only wire up the edit button when
 * the current user's permission level allows it (see openEntityModal).
 */
function toggleModalEditMode(isEditing) {
    document.getElementById('em-read-fields').style.display = isEditing ? 'none' : 'block';
    document.getElementById('em-edit-fields').style.display = isEditing ? 'block' : 'none';
    
    const editBtn = document.getElementById('em-btn-edit');
    const saveBtn = document.getElementById('em-btn-save');
    if (editBtn) editBtn.style.display = isEditing ? 'none' : 'inline-flex';
    if (saveBtn) saveBtn.style.display = isEditing ? 'inline-flex' : 'none';
}

/**
 * Maps a role string to its numeric weight for the role-hierarchy gating pattern used
 * throughout this file: super_admin=4, dept_admin=3, tool_rep=2, technician=1 (unknown/
 * missing role = 0). The resulting weight is cached in currentAdminWeight at login and
 * compared with thresholds elsewhere (>=2 unlocks tool_rep-level actions, >=3 unlocks
 * dept_admin-level actions, >=4 is reserved for super_admin-only actions).
 */
function getRoleWeight(role) {
    const weights = { 'super_admin': 4, 'dept_admin': 3, 'tool_rep': 2, 'technician': 1 };
    return weights[role] || 0;
}

/** Sets element.style.display for the given element id, silently no-oping if the element isn't present in the DOM. */
function safeSetDisplay(id, displayState) {
    const el = document.getElementById(id);
    if (el) el.style.display = displayState;
}

/**
 * Hub -> workspace transition (part of the hub/subhub/sub-panel state machine). Hides the
 * top-level #hub-view grid, shows #workspace-view, hides every .workspace-panel, then shows
 * only the one matching `id` (e.g. 'ws-account', 'ws-personnel', 'ws-inventory', 'ws-reports').
 */
function openWorkspace(id) {
    document.getElementById('hub-view').style.display = 'none';
    document.getElementById('workspace-view').style.display = 'block';
    document.querySelectorAll('.workspace-panel').forEach(p => p.style.display = 'none');
    document.getElementById(id).style.display = 'block';
}

/**
 * Workspace -> hub transition (part of the hub/subhub/sub-panel state machine). Reverses
 * openWorkspace(): hides #workspace-view, shows #hub-view, hides every .sub-panel, and
 * restores both subhub landing screens (#subhub-personnel, #subhub-inventory) so that
 * re-entering either workspace lands back on its subhub menu instead of a leftover sub-panel.
 */
function showMainHub() {
    document.getElementById('workspace-view').style.display = 'none';
    document.getElementById('hub-view').style.display = 'grid';
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    
    safeSetDisplay('subhub-personnel', 'block');
    safeSetDisplay('subhub-inventory', 'block');
}

/**
 * Subhub -> sub-panel transition (part of the hub/subhub/sub-panel state machine). Hides
 * both subhub landing screens and every .sub-panel, then shows only the requested panelId
 * (e.g. 'panel-manage-users', 'panel-view-roster', 'panel-inv-tree', 'panel-inv-build').
 */
function openSubPanel(panelId) {
    safeSetDisplay('subhub-personnel', 'none');
    safeSetDisplay('subhub-inventory', 'none');
    
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    document.getElementById(panelId).style.display = 'block';
}

/**
 * Sub-panel -> subhub transition (part of the hub/subhub/sub-panel state machine). Hides
 * every .sub-panel and re-shows the given subhubId, returning the user to that workspace's
 * menu screen. (workspaceId is accepted for symmetry with the "Back" button call sites but
 * is not itself used here since the workspace panel is already visible.)
 */
function closeSubPanel(workspaceId, subhubId) {
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    safeSetDisplay(subhubId, 'block');
}

/**
 * Expands/collapses one node (department, toolbox, or drawer) of the infrastructure tree
 * rendered by renderEditableInfraTree(). Flips the referenced containerId between
 * display:block/none and flips its sibling .toggle-icon glyph between ▼ (expanded) and ▶
 * (collapsed).
 */
function toggleTreeVisibility(containerId, headerElement) {
    const container = document.getElementById(containerId);
    const icon = headerElement.querySelector('.toggle-icon');
    if (!container) return;
    
    if (container.style.display === 'none') {
        container.style.display = 'block';
        if (icon) icon.textContent = '▼';
    } else {
        container.style.display = 'none';
        if (icon) icon.textContent = '▶';
    }
}

// ==========================================
// 3. AUTHENTICATION
// ==========================================
/**
 * Shared post-authentication bootstrap, called after either a fresh /api/login or a
 * restored /api/session on page load (see restoreAdminSession()). Stores
 * currentAdminBadge/currentAdminWeight (display-only caches now -- the server derives
 * authorization from the session cookie, not from anything sent by this client), swaps
 * #auth-wall for #admin-app, and applies the role-weight hierarchy gating pattern to hide
 * UI the current role isn't entitled to:
 *   - weight < 2 (below tool_rep): hides #hub-inventory and #hub-reports hub cards.
 *   - weight < 3 (below dept_admin): hides #card-manage-boxes and #card-manage-users.
 *   - weight < 4 (below super_admin): hides #card-manage-depts.
 * Finally preloads data appropriate to the role (user list for dept_admin+, storage
 * dropdowns for everyone, next tool id for tool_rep+).
 */
function bootstrapAdminUI(user) {
    currentAdminBadge = user.badge_id;
    currentAdminWeight = getRoleWeight(user.role);

    document.getElementById('auth-wall').style.display = 'none';
    document.getElementById('admin-app').style.display = 'block';
    document.getElementById('admin-name').textContent = `Logged in as: ${user.full_name} (${user.role.toUpperCase()})`;

    // Hide UI elements based on hierarchy
    if (currentAdminWeight < 2) {
        safeSetDisplay('hub-inventory', 'none');
        safeSetDisplay('hub-reports', 'none');
    }
    if (currentAdminWeight < 4) {
        safeSetDisplay('card-manage-depts', 'none');
    }
    if (currentAdminWeight < 3) {
        safeSetDisplay('card-manage-boxes', 'none');
        safeSetDisplay('card-manage-users', 'none');
    }

    if (currentAdminWeight >= 3) { loadUsers(); }
    syncStorageHierarchyDropdowns();
    if (currentAdminWeight >= 2) { fetchNextToolId(); }
}

/** Authenticates against POST /api/login with the badge/username + PIN entered on the #auth-wall. On success the server establishes a session cookie and bootstrapAdminUI() takes over from there. */
async function loginAdmin() {
    const loginId = document.getElementById('admin-badge').value.trim();
    const pin = document.getElementById('admin-pin').value.trim();

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login_id: loginId, pin: pin })
        });
        const data = await response.json();

        if (!response.ok) {
            return alert('❌ ' + (data.error || 'Login failed'));
        }

        bootstrapAdminUI(data.user);
    } catch (err) {
        alert('Server connection failure.');
    }
}

/**
 * Restores admin login state on page load via GET /api/session, so a reload doesn't force
 * re-entering the badge/PIN every time (the session cookie already proves who this is).
 * Silently leaves the login wall showing (the default state) if there's no active session
 * -- this is the normal case for a first visit or after logging out, not an error.
 */
async function restoreAdminSession() {
    try {
        const res = await fetch('/api/session');
        if (!res.ok) return;
        const data = await res.json();
        bootstrapAdminUI(data.user);
    } catch (err) { /* no-op -- login wall is already showing by default */ }
}

/** Ends the admin session (POST /api/logout) and reloads to show the login wall fresh. */
async function logoutAdmin() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } finally {
        window.location.reload();
    }
}

/** Submits the logged-in user's own username/PIN changes from the My Account panel to PUT /api/users/me/update, then clears the input fields on success. */
async function updateMyAccount() {
    const payload = { new_username: document.getElementById('my-new-username').value, new_pin: document.getElementById('my-new-pin').value };
    const res = await fetch('/api/users/me/update', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) { alert('✅ Account updated successfully.'); document.getElementById('my-new-username').value = ''; document.getElementById('my-new-pin').value = ''; }
    else { const err = await res.json(); alert('❌ ' + err.error); }
}

// ==========================================
// 4. PHOTO UPLOADS
// ==========================================
/** Records which entity (type + id) a photo upload is destined for, then opens the hidden #global-photo-upload file picker shared by every "📸 Photo/Upload" button. */
function triggerPhotoUpload(type, id) {
    uploadTarget = { type, id };
    document.getElementById('global-photo-upload').click();
}

/**
 * Change handler for #global-photo-upload. Packs the selected file plus the pending
 * uploadTarget (type/id set by triggerPhotoUpload) into FormData and POSTs to /api/upload.
 * Refreshes the personnel lists on a 'user' target, or the infrastructure tree for any
 * other entity type, then resets the file input.
 */
async function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('photo', file);
    formData.append('entity_type', uploadTarget.type);
    formData.append('entity_id', uploadTarget.id);

    try {
        const res = await fetch('/api/upload', { method: 'POST', headers: { 'X-Requested-With': 'ToolTracker' }, body: formData });
        const data = await res.json();
        if (res.ok) {
            alert('✅ Photo uploaded successfully!');
            if (uploadTarget.type === 'user') { loadUsers(); loadRosterDirectory(); } 
            else { renderEditableInfraTree(); }
        } else { alert('❌ ' + (data.error || 'Upload failed.')); }
    } catch (err) { alert('❌ Network error during upload.'); } 
    finally { event.target.value = ''; }
}

// ==========================================
// 5. PERSONNEL
// ==========================================
/**
 * Fetches the requester's manageable subordinate roster from GET /api/users and renders
 * #user-manage-body (the "Manage Accounts" table) with per-row Upload/PIN-reset/Remove
 * actions. Only reachable when currentAdminWeight >= 3 (dept_admin+), matching the
 * card-manage-users visibility gate applied at login.
 */
async function loadUsers() {
    try {
        const response = await fetch('/api/users'); const data = await response.json();
        document.getElementById('user-manage-body').innerHTML = data.users.map(u => {
            const avatar = u.photo_url ? `<img src="${u.photo_url}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 40px; height: 40px; border-radius: 50%; background: var(--surface2); display: flex; align-items: center; justify-content: center;">👤</div>`;
            return `<tr>
                        <td><div style="display: flex; align-items: center; gap: 12px;">${avatar} <div><strong>${u.full_name}</strong><br><span style="font-size:11px;color:var(--muted);">${u.email || 'No email'}</span></div></div></td>
                        <td style="font-family: monospace; font-size:12px;">Badge: ${u.badge_id}<br>User: ${u.username || '---'}</td>
                        <td>${u.role.toUpperCase()}</td>
                        <td>
                            <button onclick="triggerPhotoUpload('user', '${u.badge_id}')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-weight:bold;margin-right:10px;">📸 Upload</button>
                            <button onclick="resetUserPin('${u.badge_id}')" style="background:none;border:none;color:var(--blue);cursor:pointer;font-weight:bold;margin-right:10px;">↺ PIN</button>
                            <button onclick="deactivateUser('${u.badge_id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:bold;">✕ Remove</button>
                        </td>
                    </tr>`;
        }).join('');
    } catch (err) { console.error(err); }
}

/** Fetches the company-wide directory from GET /api/roster and renders #user-roster-body (the read-only "Company Roster" table), tagging each row .roster-row for filterRoster() to search over. */
async function loadRosterDirectory() {
    try {
        const res = await fetch(`/api/roster`); const data = await res.json();
        document.getElementById('user-roster-body').innerHTML = data.roster.map(u => {
            const avatar = u.photo_url ? `<img src="${u.photo_url}" style="width: 30px; height: 30px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 30px; height: 30px; border-radius: 50%; background: var(--surface2); display: flex; align-items: center; justify-content: center;">👤</div>`;
            return `<tr class="roster-row"><td><div style="display: flex; align-items: center; gap: 10px;">${avatar} <strong>${u.full_name}</strong></div></td><td>${u.department_name || '--'}</td><td>${u.role.toUpperCase()}</td><td style="font-family: monospace;">${u.badge_id}</td></tr>`;
        }).join('');
    } catch (err) { console.error(err); }
}

/** Live-filters the .roster-row rows in #roster-table by substring match (case-insensitive) against #roster-search's current value. */
function filterRoster() {
    const input = document.getElementById('roster-search').value.toUpperCase();
    document.querySelectorAll('.roster-row').forEach(row => { row.style.display = row.innerText.toUpperCase().includes(input) ? '' : 'none'; });
}

/** Validates and submits the "Provision New User" form (name, email, department, role) to POST /api/users, then refreshes both the manage-users table and the roster directory. There is no email delivery in this system, so the generated credentials are shown directly via showCredentialsModal() instead. */
async function addUser() {
    const payload = { full_name: document.getElementById('new-name').value, email: document.getElementById('new-email').value, dept_id: document.getElementById('new-user-dept').value, role: document.getElementById('new-role').value };
    if (!payload.full_name || !payload.email) return alert('Name and Email are required.');
    const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) {
        const data = await res.json();
        document.getElementById('new-name').value = ''; document.getElementById('new-email').value = '';
        loadUsers(); loadRosterDirectory();
        showCredentialsModal({ title: 'New Account Created', fullName: data.user.full_name, username: data.user.username, badgeId: data.user.badge_id, pin: data.user.pin });
    } else { const err = await res.json(); alert('❌ ' + err.error); }
}

/** Confirms with the operator, then triggers a PIN reset for the given badge id via POST /api/users/:id/reset-pin. There is no email delivery in this system, so the new PIN is shown directly via showCredentialsModal() instead. */
async function resetUserPin(id) {
    if(!confirm(`Reset PIN for ${id}?`)) return;
    const res = await fetch(`/api/users/${id}/reset-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' } });
    if (res.ok) {
        const data = await res.json();
        showCredentialsModal({ title: 'PIN Reset', badgeId: id, pin: data.new_pin });
    } else { alert('❌ Failed.'); }
}

/** Confirms with the operator, then deactivates the given badge id via PUT /api/users/:id/deactivate and refreshes both personnel tables. */
async function deactivateUser(id) {
    if(!confirm(`Deactivate ${id}?`)) return; 
    await fetch(`/api/users/${id}/deactivate`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' } });
    loadUsers(); loadRosterDirectory(); 
}

// ==========================================
// 6. INVENTORY & INFRASTRUCTURE
// ==========================================
/** Looks up the selected department's prefix code and requests the next sequential box barcode from GET /api/toolboxes/next-id, writing it into the read-only #str-box-id field. */
async function fetchNextBoxId() {
    const deptSelect = document.getElementById('str-box-dept-select');
    if (!deptSelect || !deptSelect.value) return;
    const res = await fetch('/api/storage'); const data = await res.json();
    const dept = data.departments.find(d => d.dept_id == deptSelect.value);
    if(!dept) return;
    document.getElementById('str-box-id').value = 'Generating...';
    try { 
        const idRes = await fetch(`/api/toolboxes/next-id?prefix=${dept.prefix_code}-`); const idData = await idRes.json(); 
        document.getElementById('str-box-id').value = idData.success ? idData.next_sequence : 'Error'; 
    } catch (err) { document.getElementById('str-box-id').value = 'Error'; }
}

/** Validates and submits the "Establish New Department" form to POST /api/departments, then clears the inputs and refreshes the storage dropdowns and infrastructure tree. Gated to currentAdminWeight >= 4 (super_admin) by the hidden #card-manage-depts card. */
async function submitStructureDept() {
    const payload = { name: document.getElementById('str-dept-name').value, prefix_code: document.getElementById('str-dept-prefix').value };
    if (!payload.name || !payload.prefix_code) return alert("⚠️ Required fields missing.");
    const res = await fetch('/api/departments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) { alert('✅ Department Established.'); document.getElementById('str-dept-name').value = ''; document.getElementById('str-dept-prefix').value = ''; syncStorageHierarchyDropdowns(); renderEditableInfraTree(); } 
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Database error')); }
}

/** Validates and submits the "Smart Box Builder" form to POST /api/toolboxes (which also provisions the requested drawer_count), giving inline button feedback while the request is in flight. Gated to currentAdminWeight >= 3 (dept_admin+) by the hidden #card-manage-boxes card. */
async function submitSmartBox() {
    const payload = { name: document.getElementById('str-box-name').value, dept_id: document.getElementById('str-box-dept-select').value, qr_code: document.getElementById('str-box-id').value, drawer_count: document.getElementById('str-box-drawers').value };
    if (!payload.name || !payload.dept_id) return alert("⚠️ Required fields missing.");
    const btn = document.querySelector('button[onclick="submitSmartBox()"]');
    btn.textContent = "⏳ Building..."; btn.disabled = true;
    const res = await fetch('/api/toolboxes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) { document.getElementById('str-box-name').value = ''; document.getElementById('str-box-drawers').value = ''; await syncStorageHierarchyDropdowns(); await fetchNextBoxId(); renderEditableInfraTree(); btn.textContent = "✅ Success!"; } 
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Database error')); }
    setTimeout(() => { btn.textContent = "🔨 Build Storage Structure"; btn.disabled = false; }, 2000);
}

/**
 * Fetches GET /api/storage and re-populates every dependent <select> across the app that
 * lists departments, drawers, or department prefixes: #str-box-dept-select, #add-tool-prefix,
 * #add-tool-drawer, #new-user-dept, and #rep-dept. Also opportunistically primes
 * #str-box-id via fetchNextBoxId() the first time a department list is loaded.
 */
async function syncStorageHierarchyDropdowns() {
    try {
        const res = await fetch('/api/storage'); const data = await res.json(); if(!data.success) return;
        const deptOptions = data.departments.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
        const boxDeptSelect = document.getElementById('str-box-dept-select');
        if(boxDeptSelect) {
            boxDeptSelect.innerHTML = deptOptions;
            if(boxDeptSelect.options.length > 0 && !document.getElementById('str-box-id').value) fetchNextBoxId();
        }
        
        const prefixEl = document.getElementById('add-tool-prefix');
        if (prefixEl) prefixEl.innerHTML = data.departments.map(d => `<option value="${d.prefix_code}-">${d.prefix_code}</option>`).join('');
        const drawerEl = document.getElementById('add-tool-drawer');
        if (drawerEl) drawerEl.innerHTML = data.drawers.map(dr => `<option value="${dr.drawer_id}">${dr.name}</option>`).join('');
        
        const newDeptEl = document.getElementById('new-user-dept');
        if (newDeptEl) newDeptEl.innerHTML = deptOptions;
        const repDeptEl = document.getElementById('rep-dept');
        if (repDeptEl) repDeptEl.innerHTML = '<option value="ALL">Global (All Departments)</option>' + deptOptions;
    } catch(e) { console.error(e); }
}

// Unified Editable Tree replacing the 3 old tables
/**
 * Recursively renders the full department -> toolbox -> drawer -> tool hierarchy into
 * #editable-infra-tree-container. Fetches GET /api/storage and GET /api/tools in parallel,
 * caches the results in globalBoxesCache/globalDrawersCache/globalToolsCache (consumed later
 * by openEntityModal), then builds nested HTML level by level:
 *   - one collapsible card per department, filtering storage.toolboxes by dept_id;
 *   - one collapsible .tree-node per toolbox within that department, filtering
 *     storage.drawers by box_id (and tools by cross-referencing each tool's drawer_id back
 *     to its drawer's box_id) to compute the asset count shown in the header;
 *   - one collapsible .tree-child per drawer within that toolbox, filtering tools.tools by
 *     drawer_id, sorted numerically by name;
 *   - one row per tool within that drawer, with a status-colored badge.
 * Each level's action buttons (Edit/Photo/Delete) are only emitted when the role-weight
 * gate for that level is satisfied: canEditInfra = currentAdminWeight >= 3 for
 * departments/toolboxes/drawers, canEditTools = currentAdminWeight >= 2 for individual tools.
 * Collapse state per node is driven by toggleTreeVisibility() via the generated
 * dept-content-/box-content-/drawer-content- element ids.
 */
async function renderEditableInfraTree() {
    const container = document.getElementById('editable-infra-tree-container');
    if(!container) return;
    container.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 20px;">Fetching structural data...</div>`;
    
    const canEditInfra = currentAdminWeight >= 3;
    const canEditTools = currentAdminWeight >= 2;

    try {
        const [storageRes, toolsRes] = await Promise.all([fetch('/api/storage'), fetch('/api/tools')]);
        const storage = await storageRes.json(); const tools = await toolsRes.json();
        
        globalBoxesCache = storage.toolboxes;
        globalDrawersCache = storage.drawers;
        globalToolsCache = tools.tools;

        let html = '';
        storage.departments.forEach(dept => {
            const deptContentId = `dept-content-${dept.dept_id}`;
            const deptActions = canEditInfra ? `<button onclick="deleteInfraItem('departments', '${dept.dept_id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size: 12px; font-weight:bold;">✕ Delete Dept</button>` : '';

            html += `<div class="card" style="border-left: 4px solid var(--accent); margin-bottom: 15px; padding: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <h4 style="margin: 0; display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;" onclick="toggleTreeVisibility('${deptContentId}', this)">
                                <span class="toggle-icon" style="color: var(--muted);">▼</span> 
                                🏢 ${dept.name} <span style="font-weight:normal; color:var(--muted); font-size:13px;">(${dept.prefix_code})</span>
                            </h4>
                            ${deptActions}
                        </div>
                        <div id="${deptContentId}">`;
            
            const deptBoxes = storage.toolboxes.filter(b => b.dept_id === dept.dept_id);
            if(deptBoxes.length === 0) html += `<div class="tree-item" style="color:var(--muted);">No storage installed.</div>`;
            
            deptBoxes.forEach(box => {
                const boxTools = tools.tools.filter(t => { const dr = storage.drawers.find(d => d.drawer_id === t.drawer_id); return dr && dr.box_id === box.box_id; });
                const thumb = box.photo_url ? `<img src="${box.photo_url}" onclick="openImageModal('${box.photo_url}')" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover; cursor: zoom-in;">` : `🧰`;
                const boxContentId = `box-content-${box.box_id}`;
                
                const boxActions = canEditInfra ? `
                    <button onclick="openEntityModal('toolbox', '${box.box_id}')" style="background:none; border:none; color:var(--text); cursor:pointer; font-weight:bold; font-size: 12px; margin-right: 15px;">✏️ Edit</button>
                    <button onclick="triggerPhotoUpload('toolbox', '${box.box_id}')" style="background:none; border:none; color:var(--accent); cursor:pointer; font-weight:bold; font-size: 12px; margin-right: 15px;">📸 Photo</button>
                    <button onclick="deleteInfraItem('toolboxes', '${box.box_id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-weight:bold; font-size: 12px;">✕ Delete</button>` : '';

                html += `<div class="tree-node" style="padding: 10px;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div style="display: flex; align-items: center; gap: 10px; user-select: none;">
                                    ${thumb} 
                                    <span onclick="toggleTreeVisibility('${boxContentId}', this.parentElement)" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                                        <span class="toggle-icon" style="font-size: 12px; color: var(--muted);">▼</span>
                                        <strong>${box.name}</strong> 
                                        <span style="background: var(--surface); padding: 2px 6px; border-radius: 4px; font-size: 10px; color: var(--accent); font-family: monospace;">${box.qr_code || 'NO-ID'}</span>
                                        <span style="font-size:12px; color:var(--muted);">(${boxTools.length} Assets)</span>
                                    </span>
                                </div>
                                <div>${boxActions}</div>
                            </div>
                            <div id="${boxContentId}" style="margin-top: 10px;">`;
                
                const boxDrawers = storage.drawers.filter(d => d.box_id === box.box_id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

                if(boxDrawers.length > 0) {
                    boxDrawers.forEach(dr => {
                        const drToolsList = tools.tools.filter(t => t.drawer_id === dr.drawer_id);
                        const drThumb = dr.photo_url ? `<img src="${dr.photo_url}" onclick="openImageModal('${dr.photo_url}')" style="width: 20px; height: 20px; border-radius: 4px; object-fit: cover; cursor: zoom-in;">` : `📂`;
                        const drawerContentId = `drawer-content-${dr.drawer_id}`;
                        
                        const drActions = canEditInfra ? `
                            <button onclick="openEntityModal('drawer', '${dr.drawer_id}')" style="background:none; border:none; color:var(--text); cursor:pointer; font-weight:bold; font-size: 11px; margin-right: 15px;">✏️ Edit</button>
                            <button onclick="triggerPhotoUpload('drawer', '${dr.drawer_id}')" style="background:none; border:none; color:var(--accent); cursor:pointer; font-weight:bold; font-size: 11px; margin-right: 15px;">📸 Photo</button>
                            <button onclick="deleteInfraItem('drawers', '${dr.drawer_id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-weight:bold; font-size: 11px;">✕ Delete</button>` : '';

                        html += `<div class="tree-child" style="padding: 6px 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                                    <div style="display: flex; justify-content: space-between; align-items: center; user-select: none;">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${drThumb} 
                                            <span onclick="toggleTreeVisibility('${drawerContentId}', this.parentElement)" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                                                <span class="toggle-icon" style="font-size: 10px; color: var(--muted);">▼</span>
                                                <span style="font-weight: bold;">${dr.name}</span>
                                                <span style="font-size:11px; color:var(--muted); margin-left: 5px;">(${drToolsList.length} tools)</span>
                                            </span>
                                        </div>
                                        <div>${drActions}</div>
                                    </div>
                                    <div id="${drawerContentId}" style="margin-top: 8px; padding-left: 20px; border-left: 1px dashed var(--border);">`;
                        
                        if (drToolsList.length === 0) {
                            html += `<div style="font-size: 12px; color: var(--muted); padding: 4px 0;">Drawer is empty.</div>`;
                        } else {
                            drToolsList.forEach(tool => {
                                const toolActions = canEditTools ? `
                                    <button onclick="openEntityModal('tool', '${tool.qr_code}')" style="background:none; border:none; color:var(--text); cursor:pointer; font-size: 11px; margin-right:15px; font-weight:bold;">✏️ Edit</button>
                                    <button onclick="triggerPhotoUpload('tool', '${tool.qr_code}')" style="background:none; border:none; color:var(--accent); cursor:pointer; font-size: 11px; margin-right:15px; font-weight:bold;">📸 Photo</button>
                                    <button onclick="removeToolPermanent('${tool.tool_id}', '${tool.qr_code}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size: 11px; font-weight:bold;">✕ Delete</button>` : '';

                                const statusColor = tool.status === 'In' ? 'var(--green)' : (tool.status === 'Out' ? 'var(--accent)' : 'var(--red)');
                                const serialDisplay = tool.serial_number
                                    ? `<span style="font-size: 11px; color: var(--text);">S/N: <span style="font-family: monospace;">${tool.serial_number}</span></span>`
                                    : `<span style="font-size: 11px; color: var(--muted); font-style: italic;">No serial set</span>`;
                                const calDueDisplay = tool.is_calibrated
                                    ? `<span style="font-size: 11px; color: ${tool.cal_due_date ? 'var(--text)' : 'var(--muted)'};">Cal Due: ${tool.cal_due_date ? tool.cal_due_date.split('T')[0] : 'Unknown'}</span>`
                                    : `<span style="font-size: 11px; color: var(--muted); font-style: italic;">Not calibrated</span>`;

                                html += `
                                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.02);">
                                        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                            <span style="font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); color: ${statusColor};">${tool.status}</span>
                                            <span style="font-size: 13px; font-weight:bold;">${tool.name}</span>
                                            <span style="font-family: monospace; font-size: 10px; color: var(--muted);">${tool.qr_code}</span>
                                            ${serialDisplay}
                                            ${calDueDisplay}
                                        </div>
                                        <div>${toolActions}</div>
                                    </div>`;
                            });
                        }
                        
                        html += `   </div>
                                </div>`;
                    });
                }
                html += `   </div>
                          </div>`; 
            });
            html += `   </div>
                      </div>`; 
        });
        container.innerHTML = html;
    } catch (e) { container.innerHTML = `<div style="color: var(--red); padding: 20px;">Error rendering map.</div>`; }
}

/** Fetches GET /api/audits/today-status and renders one chip per department into #audit-status-body: muted styling when that department's mandatory audit for the CURRENT shift window (morning 04:00-14:00 or afternoon 14:00-04:00, see getAuditWindowStart in server.js) is already complete, or a red "-- Audit Pending" chip when it is not. Also shows which window is currently active in #audit-status-window. */
async function loadAuditStatus() {
    const container = document.getElementById('audit-status-body');
    if (!container) return;
    try {
        const res = await fetch('/api/audits/today-status');
        const data = await res.json();
        if (!data.success || !data.departments || data.departments.length === 0) {
            container.innerHTML = `<div style="color:var(--muted); font-size:12px;">No departments found.</div>`;
            return;
        }
        const windowLabel = document.getElementById('audit-status-window');
        if (windowLabel && data.departments[0] && data.departments[0].window_start) {
            const windowStart = new Date(data.departments[0].window_start);
            const isMorning = windowStart.getHours() === 4;
            windowLabel.textContent = `Current window: ${isMorning ? 'Morning (04:00-14:00)' : 'Afternoon (14:00-04:00)'}, since ${windowStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }
        container.innerHTML = data.departments.map(d => {
            if (d.audit_completed) {
                return `<span style="font-size:11px; font-weight:bold; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,0.05); color: var(--muted);">${d.name}</span>`;
            }
            return `<span style="font-size:11px; font-weight:bold; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,0.05); color: var(--red);">${d.name} -- Audit Pending</span>`;
        }).join('');
    } catch (e) {
        container.innerHTML = `<div style="color:var(--red); font-size:12px;">Failed to load audit status.</div>`;
    }
}

/** Confirms with the operator, then sends DELETE /api/{type}/{id} for a department/toolbox/drawer (type is the plural REST segment, e.g. 'departments', 'toolboxes', 'drawers'); the API rejects non-empty structures. Refreshes the tree and dropdowns on success. */
async function deleteInfraItem(type, id) {
    if (!confirm(`Are you sure you want to delete this structure? It will only succeed if it is empty.`)) return;
    try {
        const res = await fetch(`/api/${type}/${id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
        if (res.ok) { renderEditableInfraTree(); syncStorageHierarchyDropdowns(); } 
        else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to delete.')); }
    } catch (err) { alert('❌ Network error.'); }
}

/** Confirms with the operator, then permanently deletes a single tool via DELETE /api/tools/:tool_id and refreshes the infrastructure tree. */
async function removeToolPermanent(tool_id, qr_code) {
    if(!confirm(`WARNING: Permanently delete ${qr_code}?`)) return;
    const res = await fetch(`/api/tools/${tool_id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
    if (res.ok) { alert('✅ Tool removed.'); closeEntityModal(); renderEditableInfraTree(); }
    else alert('❌ Failed to delete tool.');
}

// ==========================================
// 7. INGEST ASSETS (TOOLS) & CAMERAS
// ==========================================
/** Requests the next sequential tool barcode for the currently selected department prefix from GET /api/tools/next-id, writing it into the read-only #add-tool-id field. No-ops if the prefix dropdown is hidden (i.e. a scanned barcode is being used instead). */
async function fetchNextToolId() {
    const prefixDropdown = document.getElementById('add-tool-prefix');
    if (!prefixDropdown || prefixDropdown.style.display === 'none' || !prefixDropdown.value) return;
    document.getElementById('add-tool-id').value = 'Generating...';
    try { 
        const res = await fetch(`/api/tools/next-id?prefix=${prefixDropdown.value}`); const data = await res.json(); 
        document.getElementById('add-tool-id').value = data.success ? data.next_sequence : 'Error'; 
    } catch (err) { document.getElementById('add-tool-id').value = 'Error'; } 
}

/**
 * Validates and submits the "Ingest New Asset" form to POST /api/tools. The barcode id is
 * assembled from the prefix dropdown + generated sequence unless a full code was scanned in
 * directly (prefix dropdown hidden), in which case the scanned value in #add-tool-id is used
 * as-is. On success, resets the name/description/url fields, re-arms the prefix dropdown,
 * and refreshes the next-id field and the infrastructure tree.
 */
async function addNewTool() {
    const payload = {
        name: document.getElementById('add-tool-name').value,
        description: document.getElementById('add-tool-desc').value,
        serial_number: document.getElementById('add-tool-serial').value || null,
        part_number: document.getElementById('add-tool-partnum').value || null,
        replacement_url: document.getElementById('add-tool-url').value,
        qr_code: document.getElementById('add-tool-prefix').style.display !== 'none' ? document.getElementById('add-tool-prefix').value + document.getElementById('add-tool-id').value : document.getElementById('add-tool-id').value,
        drawer_id: document.getElementById('add-tool-drawer').value
    };
    if (!payload.name || !payload.qr_code) return alert('Name and ID required.');

    const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) {
        alert(`✅ Asset saved: ${payload.qr_code}`);
        document.getElementById('add-tool-name').value = '';
        document.getElementById('add-tool-desc').value = '';
        document.getElementById('add-tool-serial').value = '';
        document.getElementById('add-tool-partnum').value = '';
        document.getElementById('add-tool-url').value = '';
        document.getElementById('add-tool-prefix').style.display = 'inline-block';
        fetchNextToolId(); renderEditableInfraTree();
    }
}

/** Shared html5-qrcode bootstrap: reveals the given reader element, tears down any previous scanner instance, and starts scanning using the rear-facing camera specifically (`facingMode: "environment"`, requested directly rather than enumerating devices and guessing which index is the rear camera -- that order is unpredictable across phones/browsers, and iOS in particular often lists the front camera first). Falls back to whatever camera is available if no rear camera exists (e.g. a laptop webcam). Invokes callback(decodedText) once a code is read (stopping the scanner and hiding the reader first). Alerts the operator if the scanner fails to start (no camera, permission denied, etc). */
function initCameraCore(elementId, callback) {
    document.getElementById(elementId).style.display = 'block';
    if (html5QrAdminInstance) { html5QrAdminInstance.clear(); }
    html5QrAdminInstance = new Html5Qrcode(elementId);
    html5QrAdminInstance.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: 250, aspectRatio: 1.0 }, // matches the .camera-reader CSS's fixed 1:1 box so the preview doesn't stretch/squish when the phone rotates
        (txt) => { html5QrAdminInstance.stop().then(() => { document.getElementById(elementId).style.display = 'none'; callback(txt); }); }
    ).catch((err) => { alert("Camera Error"); document.getElementById(elementId).style.display = 'none'; });
}
/** Opens the login-screen scanner and writes the decoded badge id into #admin-badge. */
function startAdminLoginCamera() { initCameraCore('admin-auth-reader', (txt) => { document.getElementById('admin-badge').value = txt; }); }
/** Opens the asset-ingest scanner, hides the prefix dropdown (a full scanned code replaces the generated prefix+sequence), and writes the decoded value into the given input. */
function startAdminAssetCamera(readerId, inputId) { initCameraCore(readerId, (txt) => { document.getElementById('add-tool-prefix').style.display = 'none'; document.getElementById(inputId).value = txt; }); }

// ==========================================
// 8. REPORTS
// ==========================================
/**
 * Submits the report builder criteria (type, department, date range) to POST
 * /api/reports/generate and renders the result into #generated-report-table. Builds
 * different header/row layouts depending on report_type: 'AUDIT' shows a transaction log
 * (timestamp/technician/action/asset/notes), 'FLAGGED' shows damaged/missing assets
 * (barcode/description/department/status/reason).
 */
async function generateCustomReport() {
    const payload = { report_type: document.getElementById('rep-type').value, dept_id: document.getElementById('rep-dept').value, start_date: document.getElementById('rep-start').value || new Date().toISOString().split('T')[0], end_date: document.getElementById('rep-end').value || new Date().toISOString().split('T')[0] };
    try {
        const res = await fetch('/api/reports/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) }); const data = await res.json();
        if (!res.ok) return alert('❌ ' + data.error);
        const thead = document.getElementById('report-thead'); const tbody = document.getElementById('report-tbody');
        if (data.data.length === 0) { tbody.innerHTML = `<tr><td colspan="6" style="text-align: center;">No data found.</td></tr>`; return; }

        if (payload.report_type === 'AUDIT') {
            document.getElementById('report-display-title').textContent = `Transaction History (${payload.start_date} to ${payload.end_date})`;
            thead.innerHTML = `<tr><th>Timestamp</th><th>Technician</th><th>Action</th><th>Asset ID</th><th>Department</th><th>Notes</th></tr>`;
            tbody.innerHTML = data.data.map(log => { const date = new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); return `<tr><td>${date}</td><td>${log.full_name} (${log.badge_id})</td><td>${log.action}</td><td style="font-family: monospace;">${log.qr_code}</td><td>${log.dept_name || '--'}</td><td>${log.notes || '--'}</td></tr>`; }).join('');
        } else if (payload.report_type === 'FLAGGED') {
            document.getElementById('report-display-title').textContent = `Flagged Assets Report`;
            thead.innerHTML = `<tr><th>Barcode ID</th><th>Description</th><th>Department</th><th>Status</th><th>Reason</th></tr>`;
            tbody.innerHTML = data.data.map(t => { return `<tr><td style="font-family: monospace;">${t.qr_code}</td><td>${t.tool_name}</td><td>${t.dept_name || '--'}</td><td>${t.status}</td><td>${t.status_reason || '--'}</td></tr>`; }).join('');
        }
    } catch (err) { alert('Failed to pull report.'); }
}

/** Serializes #generated-report-table's current rows (header + body) into CSV text and triggers a client-side download as the given filename. */
function exportTableToCSV(filename) {
    const table = document.getElementById("generated-report-table"); let csv = [];
    for (let i = 0; i < table.rows.length; i++) { let row = [], cols = table.rows[i].querySelectorAll("td, th"); for (let j = 0; j < cols.length; j++) { row.push('"' + cols[j].innerText.replace(/"/g, '""') + '"'); } csv.push(row.join(",")); }
    const csvFile = new Blob([csv.join("\n")], {type: "text/csv"}); const downloadLink = document.createElement("a"); downloadLink.download = filename; downloadLink.href = window.URL.createObjectURL(csvFile); downloadLink.style.display = "none"; document.body.appendChild(downloadLink); downloadLink.click(); document.body.removeChild(downloadLink);
}

// ==========================================
// 9. UNIVERSAL ENTITY MODAL
// ==========================================
/**
 * Populates and opens the universal entity modal (#entity-modal-overlay) for a single
 * toolbox, drawer, or tool record, dispatching on `type`:
 *   - 'toolbox': looks up globalBoxesCache by box_id, shows a name-only edit field.
 *   - 'drawer': looks up globalDrawersCache by drawer_id, shows a name-only edit field.
 *   - 'tool': looks up globalToolsCache by qr_code, builds a richer read view (description,
 *     status, calibration due date, replacement link) plus a fuller edit view (name,
 *     description, replacement URL, status select, calibration checkbox + dates).
 * For each type, the "Edit Details"/"Save Changes" action buttons are only rendered when
 * the caller's role weight clears that type's threshold (canEditInfra = currentAdminWeight
 * >= 3 for toolbox/drawer, canEditTools = currentAdminWeight >= 2 for tool) -- if the
 * threshold isn't met, #em-actions is left empty and the modal is effectively read-only.
 * The modal always opens via toggleModalEditMode(false), i.e. read view first, even when
 * edit is permitted.
 */
function openEntityModal(type, id) {
    const canEditInfra = currentAdminWeight >= 3;
    const canEditTools = currentAdminWeight >= 2;
    let entity = null; let titleHtml = ''; let fieldsHtml = ''; let readHtml = ''; let actionsHtml = '';

    document.getElementById('em-target-type').value = type;
    document.getElementById('em-target-id').value = id;

    if (type === 'toolbox') {
        entity = globalBoxesCache.find(b => b.box_id == id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `STORAGE UNIT [ID: ${entity.box_id}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:8px;object-fit:cover;cursor:zoom-in;">` : '🧰';
        
        titleHtml = `<h3 style="margin:0;">${entity.name}</h3>`;
        fieldsHtml = `<div class="form-group"><label class="form-label">Unit Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>`;
        
        if (canEditInfra) {
            actionsHtml = `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">✏️ Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">💾 Save Changes</button>
            `;
        }

    } else if (type === 'drawer') {
        entity = globalDrawersCache.find(d => d.drawer_id == id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `STORAGE DRAWER [ID: ${entity.drawer_id}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:8px;object-fit:cover;cursor:zoom-in;">` : '📂';
        
        titleHtml = `<h3 style="margin:0;">${entity.name}</h3>`;
        fieldsHtml = `<div class="form-group"><label class="form-label">Drawer Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>`;
        
        if (canEditInfra) {
            actionsHtml = `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">✏️ Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">💾 Save Changes</button>
            `;
        }

    } else if (type === 'tool') {
        entity = globalToolsCache.find(t => t.qr_code === id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `ASSET [${entity.qr_code}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:8px;object-fit:cover;cursor:zoom-in;">` : '🔧';
        
        const lastCal = entity.last_cal_date ? entity.last_cal_date.split('T')[0] : '';
        const dueCal = entity.cal_due_date ? entity.cal_due_date.split('T')[0] : '';
        const calText = entity.is_calibrated ? `Due: ${dueCal || 'Unknown'}` : 'Not Required';

        titleHtml = `<h3 style="margin:0;">${entity.name}</h3>`;
        
        // The Clean "Read" View
        readHtml = `
            <div style="margin-bottom:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Description</div><div style="font-size:14px;margin-top:4px;">${entity.description || '--'}</div></div>
            <div style="display: flex; gap: 30px; margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Serial Number</div><div style="font-size:14px;margin-top:4px;font-family:monospace;">${entity.serial_number || '--'}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Part Number</div><div style="font-size:14px;margin-top:4px;font-family:monospace;">${entity.part_number || '--'}</div></div>
            </div>
            <div style="display: flex; gap: 30px; margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Status</div><div style="font-size:14px;margin-top:4px;font-weight:bold;color:var(--accent);">${entity.status}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Calibration</div><div style="font-size:14px;margin-top:4px;font-weight:bold;">${calText}</div></div>
            </div>
            ${!entity.photo_url ? `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-bottom:10px;">No photo on file.</div>` : ''}
        `;
        if(entity.replacement_url) readHtml += `<div><a href="${entity.replacement_url}" target="_blank" style="color:var(--blue); font-size: 13px; text-decoration: none;">🛒 Open Replacement Link →</a></div>`;

        // The "Edit" View (Hidden by default)
        const isOut = entity.status === 'Out';
        let statusFieldHtml;
        if (isOut) {
            statusFieldHtml = `
                <div class="form-group">
                    <label class="form-label">Physical Status</label>
                    <div style="padding:8px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size:13px; font-weight:bold; color: var(--accent);">Out</div>
                    <div style="font-size:11px; color: var(--muted); margin-top:4px;">Checked out -- status changes require a kiosk check-in.</div>
                    <input type="hidden" id="em-input-status" value="Out">
                </div>`;
        } else if (entity.status === 'Retired') {
            statusFieldHtml = `
                <div class="form-group">
                    <label class="form-label">Physical Status</label>
                    <div style="padding:8px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size:13px; font-weight:bold; color: var(--red);">Retired</div>
                    <div style="font-size:11px; color: var(--muted); margin-top:4px;">Retired is permanent -- this asset can no longer change status.</div>
                    <input type="hidden" id="em-input-status" value="Retired">
                </div>`;
        } else if (entity.status === 'In') {
            statusFieldHtml = `
                <div class="form-group"><label class="form-label">Physical Status</label>
                    <select class="form-select" id="em-input-status">
                        <option value="In" selected>In</option>
                        <option value="Missing">Missing</option>
                        <option value="Broken">Broken</option>
                        <option value="Worn">Worn</option>
                        <option value="Retired">Retired (Permanent)</option>
                    </select>
                </div>`;
        } else { // Missing / Broken / Worn -- the server's status state machine only allows
                 // staying the same, resolving back to In, or retiring from these states, so
                 // the other two flag values must NOT be offered as selectable targets here.
            statusFieldHtml = `
                <div class="form-group"><label class="form-label">Physical Status</label>
                    <select class="form-select" id="em-input-status">
                        <option value="${entity.status}" selected>${entity.status} (No Change)</option>
                        <option value="In">In (Resolved)</option>
                        <option value="Retired">Retired (Permanent)</option>
                    </select>
                </div>`;
        }

        fieldsHtml = `
            <div class="form-group"><label class="form-label">Asset Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>
            <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="em-input-desc" rows="2">${entity.description || ''}</textarea></div>
            <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
                <div class="form-group"><label class="form-label">Serial Number</label><input class="form-input" id="em-input-serial" value="${entity.serial_number || ''}" placeholder="Optional"></div>
                <div class="form-group"><label class="form-label">Part Number (for reordering)</label><input class="form-input" id="em-input-partnum" value="${entity.part_number || ''}" placeholder="Optional"></div>
            </div>
            <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
                <div class="form-group"><label class="form-label">Replacement URL</label><input class="form-input" id="em-input-url" value="${entity.replacement_url || ''}"></div>
                ${statusFieldHtml}
            </div>
            <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 8px; border: 1px solid var(--border);">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; margin-bottom: 10px;">
                    <input type="checkbox" id="em-input-is-cal" ${entity.is_calibrated ? 'checked' : ''} onchange="document.getElementById('em-cal-dates').style.display = this.checked ? 'flex' : 'none'">
                    <strong>Requires Calibration</strong>
                </label>
                <div id="em-cal-dates" style="display: ${entity.is_calibrated ? 'flex' : 'none'}; gap: 10px;">
                    <div class="form-group" style="margin: 0;"><label class="form-label">Last Cal</label><input type="date" class="form-input" id="em-input-last-cal" value="${lastCal}"></div>
                    <div class="form-group" style="margin: 0;"><label class="form-label">Cal Due</label><input type="date" class="form-input" id="em-input-cal-due" value="${dueCal}"></div>
                </div>
            </div>
        `;

        if (canEditTools) {
            actionsHtml = `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">✏️ Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">💾 Save Changes</button>
                <button class="btn btn-secondary" onclick="triggerPhotoUpload('tool', '${entity.qr_code}')" style="width:auto;">📸 Photo</button>
                <button class="btn btn-secondary" onclick="removeToolPermanent('${entity.tool_id}', '${entity.qr_code}')" style="width:auto; color: var(--red); border-color: var(--red);">✕ Delete</button>
            `;
        }
    }

    document.getElementById('em-title-container').innerHTML = titleHtml;
    document.getElementById('em-read-fields').innerHTML = readHtml;
    document.getElementById('em-edit-fields').innerHTML = fieldsHtml;
    document.getElementById('em-actions').innerHTML = actionsHtml;

    // ALWAYS open in Read-Only mode first!
    toggleModalEditMode(false);
    document.getElementById('entity-modal-overlay').style.display = 'flex';
}

/** Hides the universal entity modal without saving. */
function closeEntityModal() { document.getElementById('entity-modal-overlay').style.display = 'none'; }

/**
 * Reads the entity type/id stashed in the modal's hidden #em-target-type/#em-target-id
 * fields and dispatches the save to the matching REST endpoint: PUT /api/toolboxes/:id,
 * PUT /api/drawers/:id, or PUT /api/tools/:id. Every type submits the shared `name` field;
 * 'tool' additionally submits description, replacement_url, status, and calibration
 * fields. Closes the modal and refreshes the infrastructure tree on success.
 */
async function saveEntityUpdates() {
    const type = document.getElementById('em-target-type').value;
    const id = document.getElementById('em-target-id').value;
    const nameVal = document.getElementById('em-input-name').value;
    
    let payload = { name: nameVal };
    let endpoint = '';

    if (type === 'toolbox') { endpoint = `/api/toolboxes/${id}`; }
    else if (type === 'drawer') { endpoint = `/api/drawers/${id}`; }
    else if (type === 'tool') {
        endpoint = `/api/tools/${id}`;
        payload.description = document.getElementById('em-input-desc').value;
        payload.serial_number = document.getElementById('em-input-serial').value || null;
        payload.part_number = document.getElementById('em-input-partnum').value || null;
        payload.replacement_url = document.getElementById('em-input-url').value;
        payload.status = document.getElementById('em-input-status').value;
        payload.is_calibrated = document.getElementById('em-input-is-cal').checked;
        payload.last_cal_date = document.getElementById('em-input-last-cal').value || null;
        payload.cal_due_date = document.getElementById('em-input-cal-due').value || null;
    }

    try {
        const res = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
        if(res.ok) { closeEntityModal(); renderEditableInfraTree(); }
        else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to save.')); }
    } catch(e) { alert('Network Error.'); }
}

// ==========================================
// 10. IMAGE LIGHTBOX
// ==========================================
/** Opens the full-screen image lightbox (#image-modal-overlay) showing the given photo URL. */
function openImageModal(url) {
    document.getElementById('image-modal-content').src = url;
    document.getElementById('image-modal-overlay').style.display = 'flex';
}

/** Hides the image lightbox and clears its <img> src so the last-viewed photo isn't retained in the DOM. */
function closeImageModal() {
    document.getElementById('image-modal-overlay').style.display = 'none';
    document.getElementById('image-modal-content').src = '';
}

// ==========================================
// 11. CREDENTIALS HANDOUT MODAL
// ==========================================
/**
 * Shows the badge id / username / PIN for a just-created or just-reset account so the
 * operator can relay it to the person directly -- this system has no email delivery.
 * Accepts { title, fullName?, username?, badgeId, pin }; fullName/username are optional
 * since a PIN reset only has a badge id on hand client-side.
 */
function showCredentialsModal({ title, fullName, username, badgeId, pin }) {
    document.getElementById('cred-modal-title').textContent = title;
    const rows = [];
    if (fullName) rows.push(['Full Name', fullName]);
    if (username) rows.push(['Username', username]);
    rows.push(['Badge ID', badgeId]);
    rows.push(['Temporary PIN', pin]);

    document.getElementById('cred-modal-body').innerHTML = rows.map(([label, value]) => `
        <div class="form-group" style="margin-bottom: 10px;">
            <label class="form-label">${label}</label>
            <input class="form-input" style="font-family: monospace; font-weight: bold; color: var(--accent);" value="${value}" readonly onclick="this.select()">
        </div>
    `).join('');

    document.getElementById('cred-modal-overlay').style.display = 'flex';
}

/** Copies all fields currently shown in the credentials modal to the clipboard as plain text, with a manual-select fallback since the Clipboard API can silently fail outside a secure context (e.g. plain http:// on the LAN). */
function copyCredentialsToClipboard() {
    const lines = Array.from(document.querySelectorAll('#cred-modal-body input')).map(input => {
        const label = input.closest('.form-group').querySelector('.form-label').textContent;
        return `${label}: ${input.value}`;
    });
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
            () => { const btn = document.getElementById('cred-modal-copy-btn'); if (btn) { const original = btn.textContent; btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = original; }, 1500); } },
            () => alert('Could not copy automatically -- click into each field above to select and copy it manually.')
        );
    } else {
        alert('Could not copy automatically -- click into each field above to select and copy it manually.');
    }
}

function closeCredentialsModal() {
    document.getElementById('cred-modal-overlay').style.display = 'none';
    document.getElementById('cred-modal-body').innerHTML = '';
}

// Restore an existing admin session on page load, if there is one (see restoreAdminSession()).
restoreAdminSession();