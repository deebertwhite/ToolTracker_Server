// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
let currentAdminBadge = null; 
let currentAdminWeight = 0; 
let html5QrAdminInstance = null;
let uploadTarget = { type: null, id: null };

// Global caches for the Universal Modal
let globalDeptsCache = [];
let globalBoxesCache = [];
let globalDrawersCache = [];
let globalToolsCache = [];
let globalUsersCache = [];

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
 * display:block/none and flips its sibling .toggle-icon between a chevron-down (expanded)
 * and chevron-right (collapsed).
 */
function toggleTreeVisibility(containerId, headerElement) {
    const container = document.getElementById(containerId);
    const toggleIcon = headerElement.querySelector('.toggle-icon');
    if (!container) return;

    if (container.style.display === 'none') {
        container.style.display = 'block';
        if (toggleIcon) toggleIcon.innerHTML = ICONS['chevron-down'];
    } else {
        container.style.display = 'none';
        if (toggleIcon) toggleIcon.innerHTML = ICONS['chevron-right'];
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
 *   - weight < 3 (below dept_admin): hides #card-manage-boxes, #card-manage-drawers,
 *     #card-manage-users, and #card-inventory-import (bulk CSV import).
 *   - weight < 4 (below super_admin): hides #card-manage-depts.
 * Populates the Provision New User form's role dropdown with options capped at the viewer's
 * own weight (inclusive) -- matches POST /api/users, which now allows creating a peer, e.g. a
 * super_admin creating another super_admin directly. Finally preloads data appropriate to the
 * role (user list for dept_admin+, storage dropdowns for everyone, next tool id for tool_rep+).
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
        safeSetDisplay('card-manage-drawers', 'none');
        safeSetDisplay('card-manage-users', 'none');
        safeSetDisplay('card-inventory-import', 'none');
    }

    // Options capped at the viewer's own weight (inclusive) -- matches the server's
    // POST /api/users hierarchy check, which now allows creating a peer, e.g. a super_admin
    // creating another super_admin, not just strictly-subordinate roles.
    const newRoleEl = document.getElementById('new-role');
    if (newRoleEl) newRoleEl.innerHTML = roleOptionsUpTo(currentAdminWeight, 'technician');

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
/** Records which entity (type + id) a photo upload is destined for, then opens the hidden #global-photo-upload file picker shared by every "Photo" button. */
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
/** Display labels for each role value, used by the personnel entity modal's role dropdown. */
const ROLE_LABELS = { technician: 'Technician', tool_rep: 'Tool Rep', dept_admin: 'Department Admin', super_admin: 'Super Admin' };

/** Builds <option> tags for every role whose weight is <= maxWeight, selecting selectedRole. Used so the role dropdown never offers a promotion beyond the acting admin's own level. */
function roleOptionsUpTo(maxWeight, selectedRole) {
    return Object.keys(ROLE_LABELS)
        .filter(role => getRoleWeight(role) <= maxWeight)
        .map(role => `<option value="${role}" ${role === selectedRole ? 'selected' : ''}>${ROLE_LABELS[role]}</option>`)
        .join('');
}

/**
 * Fetches the requester's manageable subordinate roster from GET /api/users, caches it in
 * globalUsersCache (consumed by openEntityModal), and renders #user-manage-body (the "Manage
 * Accounts" table) as click-to-view rows -- mirroring renderEditableInfraTree()'s pattern for
 * departments/toolboxes/drawers/tools. There are no inline Upload/PIN/Role/Remove actions here
 * any more; clicking a row opens openEntityModal('user', badge_id), which is the only place
 * those actions live now. Only reachable when currentAdminWeight >= 3 (dept_admin+), matching
 * the card-manage-users visibility gate applied at login.
 */
async function loadUsers() {
    try {
        const response = await fetch('/api/users'); const data = await response.json();
        globalUsersCache = data.users;
        document.getElementById('user-manage-body').innerHTML = data.users.map(u => {
            const avatar = u.photo_url ? `<img src="${u.photo_url}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 40px; height: 40px; border-radius: 50%; background: var(--surface2); display: flex; align-items: center; justify-content: center;">${icon('user')}</div>`;
            return `<tr style="cursor: pointer;" onclick="openEntityModal('user', '${u.badge_id}')">
                        <td><div style="display: flex; align-items: center; gap: 12px;">${avatar} <div><strong>${u.full_name}</strong><br><span style="font-size:11px;color:var(--muted);">${u.email || 'No email'}</span></div></div></td>
                        <td style="font-family: monospace; font-size:12px;">Badge: ${u.badge_id}<br>User: ${u.username || '---'}</td>
                        <td>${ROLE_LABELS[u.role] || u.role.toUpperCase()}</td>
                    </tr>`;
        }).join('');
    } catch (err) { console.error(err); }
}

/** Fetches the company-wide directory from GET /api/roster and renders #user-roster-body (the read-only "Company Roster" table), tagging each row .roster-row for filterRoster() to search over. */
async function loadRosterDirectory() {
    try {
        const res = await fetch(`/api/roster`); const data = await res.json();
        document.getElementById('user-roster-body').innerHTML = data.roster.map(u => {
            const avatar = u.photo_url ? `<img src="${u.photo_url}" style="width: 30px; height: 30px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 30px; height: 30px; border-radius: 50%; background: var(--surface2); display: flex; align-items: center; justify-content: center;">${icon('user')}</div>`;
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

/** Confirms with the operator, then deactivates the given badge id via PUT /api/users/:id/deactivate, closes the entity modal (a no-op if it wasn't open), and refreshes both personnel tables. */
async function deactivateUser(id) {
    if(!confirm(`Deactivate ${id}?`)) return;
    await fetch(`/api/users/${id}/deactivate`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' } });
    closeEntityModal();
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
    btn.innerHTML = `${icon('hourglass')} Building...`; btn.disabled = true;
    const res = await fetch('/api/toolboxes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) { document.getElementById('str-box-name').value = ''; document.getElementById('str-box-drawers').value = ''; await syncStorageHierarchyDropdowns(); await fetchNextBoxId(); renderEditableInfraTree(); btn.innerHTML = `${icon('circle-check', 'icon-success')} Success!`; }
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Database error')); }
    setTimeout(() => { btn.innerHTML = `${icon('hammer')} Build Storage Structure`; btn.disabled = false; }, 2000);
}

/** Cascade handler for the Add Drawer form's Department select: repopulates the Toolbox select filtered to that department (populateBoxSelect). */
function onNewDrawerDeptChange() {
    populateBoxSelect(document.getElementById('new-drawer-box'), document.getElementById('new-drawer-dept').value);
}

/** Validates and submits the "Add Drawer to Existing Toolbox" form to POST /api/drawers -- for adding a single drawer to an already-provisioned toolbox, as opposed to Smart Box Builder which only creates drawers alongside a brand-new toolbox. Gated to currentAdminWeight >= 3 (dept_admin+) by the hidden #card-manage-drawers card, matching the server's requireRole(3) on this endpoint. */
async function submitNewDrawer() {
    const box_id = document.getElementById('new-drawer-box').value;
    const name = document.getElementById('new-drawer-name').value.trim();
    if (!box_id || !name) return alert('⚠️ Select a toolbox and enter a drawer name.');

    const res = await fetch('/api/drawers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({ box_id, name }) });
    if (res.ok) {
        document.getElementById('new-drawer-name').value = '';
        await syncStorageHierarchyDropdowns();
        renderEditableInfraTree();
        alert('✅ Drawer added.');
    } else {
        const data = await res.json();
        alert('❌ ' + (data.error || 'Failed to add drawer.'));
    }
}

/**
 * Filters globalBoxesCache to the given department id and (re)populates a toolbox <select>
 * with it. Shared by the Ingest New Asset cascade and the Add Drawer cascade so both stay
 * in sync with a single implementation. Shows an explicit disabled option when the chosen
 * department has no toolboxes yet, rather than silently leaving the select empty.
 */
function populateBoxSelect(selectEl, deptId) {
    if (!selectEl) return;
    if (!deptId) { selectEl.innerHTML = '<option value="">-- Select a department first --</option>'; return; }
    const boxes = globalBoxesCache.filter(b => b.dept_id == deptId);
    selectEl.innerHTML = boxes.length
        ? '<option value="">-- Select Toolbox --</option>' + boxes.map(b => `<option value="${b.box_id}">${b.name}</option>`).join('')
        : '<option value="">No toolboxes in this department</option>';
}

/** Filters globalDrawersCache to the given toolbox id and (re)populates a drawer <select>. Shows an explicit message when the chosen toolbox has no drawers yet. */
function populateDrawerSelect(selectEl, boxId) {
    if (!selectEl) return;
    if (!boxId) { selectEl.innerHTML = '<option value="">-- Select a toolbox first --</option>'; return; }
    const drawers = globalDrawersCache.filter(d => d.box_id == boxId);
    selectEl.innerHTML = drawers.length
        ? '<option value="">-- Select Drawer --</option>' + drawers.map(d => `<option value="${d.drawer_id}">${d.name}</option>`).join('')
        : '<option value="">No drawers in this toolbox</option>';
}

/**
 * Fetches GET /api/storage, caches the result in globalDeptsCache/globalBoxesCache/
 * globalDrawersCache (shared with renderEditableInfraTree/openEntityModal), and
 * re-populates every dependent <select> across the app: #str-box-dept-select,
 * #add-tool-dept, #new-drawer-dept, #new-user-dept, and #rep-dept. Also opportunistically
 * primes #str-box-id via fetchNextBoxId() the first time a department list is loaded.
 * The toolbox/drawer cascades (Ingest New Asset, Add Drawer) are populated on demand by
 * their own onchange handlers (onAddToolDeptChange, onNewDrawerDeptChange, etc.), not here.
 */
async function syncStorageHierarchyDropdowns() {
    try {
        const res = await fetch('/api/storage'); const data = await res.json(); if(!data.success) return;

        globalDeptsCache = data.departments;
        globalBoxesCache = data.toolboxes;
        globalDrawersCache = data.drawers;

        const deptOptions = data.departments.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
        const boxDeptSelect = document.getElementById('str-box-dept-select');
        if(boxDeptSelect) {
            boxDeptSelect.innerHTML = deptOptions;
            if(boxDeptSelect.options.length > 0 && !document.getElementById('str-box-id').value) fetchNextBoxId();
        }

        // Carries data-prefix so fetchNextToolId() can derive the barcode prefix straight
        // from whichever department is selected -- the prefix and the drawer assignment can
        // no longer disagree with each other (previously two independent dropdowns, which
        // is exactly how tools ended up filed under the wrong department's boxes).
        const deptOptionsWithPrefix = '<option value="">-- Select Department --</option>' +
            data.departments.map(d => `<option value="${d.dept_id}" data-prefix="${d.prefix_code}">${d.name}</option>`).join('');
        const addToolDeptEl = document.getElementById('add-tool-dept');
        if (addToolDeptEl) addToolDeptEl.innerHTML = deptOptionsWithPrefix;
        const newDrawerDeptEl = document.getElementById('new-drawer-dept');
        if (newDrawerDeptEl) newDrawerDeptEl.innerHTML = '<option value="">-- Select Department --</option>' + deptOptions;

        // The blank option matters specifically for a super_admin creating another
        // super_admin: only for that requester/role combination does this field's value
        // reach the server at all (POST /api/users forces every other role to the
        // requester's own department regardless of what's selected here), and a super_admin
        // isn't required to belong to one -- matching the existing department-less
        // super_admin account already in the system.
        const newDeptEl = document.getElementById('new-user-dept');
        if (newDeptEl) newDeptEl.innerHTML = '<option value="">-- No Department (Global Admin only) --</option>' + deptOptions;
        const repDeptEl = document.getElementById('rep-dept');
        if (repDeptEl) repDeptEl.innerHTML = '<option value="ALL">Global (All Departments)</option>' + deptOptions;
    } catch(e) { console.error(e); }
}

// Unified Editable Tree replacing the 3 old tables
/**
 * Recursively renders the full department -> toolbox -> drawer -> tool hierarchy into
 * #editable-infra-tree-container. Fetches GET /api/storage and GET /api/tools in parallel,
 * caches the results in globalDeptsCache/globalBoxesCache/globalDrawersCache/globalToolsCache
 * (consumed later by openEntityModal), then builds nested HTML level by level:
 *   - one collapsible card per department, filtering storage.toolboxes by dept_id;
 *   - one collapsible .tree-node per toolbox within that department, filtering
 *     storage.drawers by box_id (and tools by cross-referencing each tool's drawer_id back
 *     to its drawer's box_id) to compute the asset count shown in the header;
 *   - one collapsible .tree-child per drawer within that toolbox, filtering tools.tools by
 *     drawer_id, sorted numerically by name;
 *   - one row per tool within that drawer, with a status-colored badge.
 * This tree itself is click-to-view only -- there are no inline Edit/Photo/Delete buttons at
 * any level. Clicking a department/toolbox/drawer/tool's name opens openEntityModal(), which
 * is the only place those actions live now (gated there by role weight, same thresholds as
 * before: canEditDepts >= 4, canEditInfra >= 3, canEditTools >= 2). Departments/toolboxes/
 * drawers additionally have a small toggle-icon (separate click target) for expand/collapse,
 * driven by toggleTreeVisibility() via the generated dept-content-/box-content-/
 * drawer-content- element ids; tools are leaves, so their whole row just opens the modal.
 */
async function renderEditableInfraTree() {
    const container = document.getElementById('editable-infra-tree-container');
    if(!container) return;
    container.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 20px;">Fetching structural data...</div>`;
    
    try {
        const [storageRes, toolsRes] = await Promise.all([fetch('/api/storage'), fetch('/api/tools')]);
        const storage = await storageRes.json(); const tools = await toolsRes.json();

        globalDeptsCache = storage.departments;
        globalBoxesCache = storage.toolboxes;
        globalDrawersCache = storage.drawers;
        globalToolsCache = tools.tools;

        let html = '';
        storage.departments.forEach(dept => {
            const deptContentId = `dept-content-${dept.dept_id}`;

            // Clicking the toggle-icon expands/collapses; clicking the name opens the entity
            // modal (view details, or edit/delete if permitted) -- see openEntityModal().
            html += `<div class="card" style="border-left: 4px solid var(--accent); margin-bottom: 15px; padding: 15px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; user-select: none;">
                            <span class="icon toggle-icon" style="color: var(--muted); cursor: pointer;" onclick="toggleTreeVisibility('${deptContentId}', this.parentElement)">${ICONS['chevron-down']}</span>
                            <h4 style="margin: 0; cursor: pointer;" onclick="openEntityModal('department', '${dept.dept_id}')">
                                ${icon('building-2')} ${dept.name} <span style="font-weight:normal; color:var(--muted); font-size:13px;">(${dept.prefix_code})</span>
                            </h4>
                        </div>
                        <div id="${deptContentId}">`;

            const deptBoxes = storage.toolboxes.filter(b => b.dept_id === dept.dept_id);
            if(deptBoxes.length === 0) html += `<div class="tree-item" style="color:var(--muted);">No storage installed.</div>`;

            deptBoxes.forEach(box => {
                const boxTools = tools.tools.filter(t => { const dr = storage.drawers.find(d => d.drawer_id === t.drawer_id); return dr && dr.box_id === box.box_id; });
                const thumb = box.photo_url ? `<img src="${box.photo_url}" onclick="openImageModal('${box.photo_url}')" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover; cursor: zoom-in;">` : icon('toolbox');
                const boxContentId = `box-content-${box.box_id}`;

                html += `<div class="tree-node" style="padding: 10px;">
                            <div style="display: flex; align-items: center; gap: 10px; user-select: none;">
                                ${thumb}
                                <span class="icon toggle-icon" style="font-size: 12px; color: var(--muted); cursor: pointer;" onclick="toggleTreeVisibility('${boxContentId}', this.parentElement)">${ICONS['chevron-down']}</span>
                                <span onclick="openEntityModal('toolbox', '${box.box_id}')" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                                    <strong>${box.name}</strong>
                                    <span style="background: var(--surface); padding: 2px 6px; border-radius: 4px; font-size: 10px; color: var(--accent); font-family: monospace;">${box.qr_code || 'NO-ID'}</span>
                                    <span style="font-size:12px; color:var(--muted);">(${boxTools.length} Assets)</span>
                                </span>
                            </div>
                            <div id="${boxContentId}" style="margin-top: 10px;">`;

                const boxDrawers = storage.drawers.filter(d => d.box_id === box.box_id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

                if(boxDrawers.length > 0) {
                    boxDrawers.forEach(dr => {
                        const drToolsList = tools.tools.filter(t => t.drawer_id === dr.drawer_id);
                        const drThumb = dr.photo_url ? `<img src="${dr.photo_url}" onclick="openImageModal('${dr.photo_url}')" style="width: 20px; height: 20px; border-radius: 4px; object-fit: cover; cursor: zoom-in;">` : icon('folder');
                        const drawerContentId = `drawer-content-${dr.drawer_id}`;

                        html += `<div class="tree-child" style="padding: 6px 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                                    <div style="display: flex; align-items: center; gap: 8px; user-select: none;">
                                        ${drThumb}
                                        <span class="icon toggle-icon" style="font-size: 10px; color: var(--muted); cursor: pointer;" onclick="toggleTreeVisibility('${drawerContentId}', this.parentElement)">${ICONS['chevron-down']}</span>
                                        <span onclick="openEntityModal('drawer', '${dr.drawer_id}')" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                                            <span style="font-weight: bold;">${dr.name}</span>
                                            <span style="font-size:11px; color:var(--muted); margin-left: 5px;">(${drToolsList.length} tools)</span>
                                        </span>
                                    </div>
                                    <div id="${drawerContentId}" style="margin-top: 8px; padding-left: 20px; border-left: 1px dashed var(--border);">`;

                        if (drToolsList.length === 0) {
                            html += `<div style="font-size: 12px; color: var(--muted); padding: 4px 0;">Drawer is empty.</div>`;
                        } else {
                            drToolsList.forEach(tool => {
                                const statusColor = tool.status === 'In' ? 'var(--green)' : (tool.status === 'Out' ? 'var(--accent)' : 'var(--red)');
                                const serialDisplay = tool.serial_number
                                    ? `<span style="font-size: 11px; color: var(--text);">S/N: <span style="font-family: monospace;">${tool.serial_number}</span></span>`
                                    : `<span style="font-size: 11px; color: var(--muted); font-style: italic;">No serial set</span>`;
                                const calDueDisplay = tool.is_calibrated
                                    ? `<span style="font-size: 11px; color: ${tool.cal_due_date ? 'var(--text)' : 'var(--muted)'};">Cal Due: ${tool.cal_due_date ? tool.cal_due_date.split('T')[0] : 'Unknown'}</span>`
                                    : `<span style="font-size: 11px; color: var(--muted); font-style: italic;">Not calibrated</span>`;

                                // Whole row opens the entity modal -- there's nothing to expand/collapse
                                // at this level (tools are leaves), so no separate toggle icon is needed.
                                html += `
                                    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.02); cursor: pointer;" onclick="openEntityModal('tool', '${tool.qr_code}')">
                                        <span style="font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); color: ${statusColor};">${tool.status}</span>
                                        <span style="font-size: 13px; font-weight:bold;">${tool.name}</span>
                                        <span style="font-family: monospace; font-size: 10px; color: var(--muted);">${tool.qr_code}</span>
                                        ${serialDisplay}
                                        ${calDueDisplay}
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
/**
 * Cascade handler for the Ingest New Asset form's Department select: repopulates the
 * Toolbox select filtered to that department (populateBoxSelect), resets the Drawer select
 * to its empty "select a toolbox first" state, and requests a fresh barcode id via
 * fetchNextToolId() (which reads this same department's prefix).
 */
function onAddToolDeptChange() {
    populateBoxSelect(document.getElementById('add-tool-box'), document.getElementById('add-tool-dept').value);
    document.getElementById('add-tool-drawer').innerHTML = '<option value="">-- Select a toolbox first --</option>';
    fetchNextToolId();
}

/** Cascade handler for the Ingest New Asset form's Toolbox select: repopulates the Drawer select filtered to that toolbox (populateDrawerSelect). */
function onAddToolBoxChange() {
    populateDrawerSelect(document.getElementById('add-tool-drawer'), document.getElementById('add-tool-box').value);
}

/** Cascade handler for the tool edit modal's Location department select (see openEntityModal, type 'tool') -- lets an existing tool be moved to a different toolbox/drawer, including across departments. */
function onMoveToolDeptChange() {
    populateBoxSelect(document.getElementById('em-input-move-box'), document.getElementById('em-input-move-dept').value);
    document.getElementById('em-input-move-drawer').innerHTML = '<option value="">-- Select a toolbox first --</option>';
}

/** Cascade handler for the tool edit modal's Location toolbox select: repopulates the Drawer select filtered to that toolbox. */
function onMoveToolBoxChange() {
    populateDrawerSelect(document.getElementById('em-input-move-drawer'), document.getElementById('em-input-move-box').value);
}

/**
 * Requests the next sequential tool barcode from GET /api/tools/next-id, using the prefix
 * carried on the selected #add-tool-dept option's data-prefix attribute (see
 * syncStorageHierarchyDropdowns), and writes the FULL id (prefix + sequence) into the
 * read-only #add-tool-id field. Deriving the prefix from the department selection directly
 * -- rather than a second, independent prefix dropdown -- is what guarantees the barcode id
 * and the drawer assignment always agree on department; that mismatch was the root cause of
 * tools ending up filed under the wrong department's boxes.
 */
async function fetchNextToolId() {
    const deptSelect = document.getElementById('add-tool-dept');
    const idField = document.getElementById('add-tool-id');
    const prefix = deptSelect.selectedOptions[0]?.dataset.prefix;
    if (!prefix) { idField.value = ''; idField.placeholder = 'Select a department first...'; return; }

    idField.value = 'Generating...';
    try {
        const res = await fetch(`/api/tools/next-id?prefix=${prefix}-`); const data = await res.json();
        idField.value = data.success ? `${prefix}-${data.next_sequence}` : 'Error';
    } catch (err) { idField.value = 'Error'; }
}

/**
 * Validates and submits the "Ingest New Asset" form to POST /api/tools. Department, toolbox,
 * and drawer are all required now (previously drawer alone was optional and unscoped, which
 * is how tools ended up filed under the wrong department -- see fetchNextToolId). The
 * barcode id in #add-tool-id is used as-is, whether auto-generated or overwritten by a
 * camera scan (see startAdminAssetCamera). On success, resets the form and refreshes the
 * infrastructure tree.
 */
async function addNewTool() {
    const payload = {
        name: document.getElementById('add-tool-name').value,
        description: document.getElementById('add-tool-desc').value,
        serial_number: document.getElementById('add-tool-serial').value || null,
        part_number: document.getElementById('add-tool-partnum').value || null,
        replacement_url: document.getElementById('add-tool-url').value,
        qr_code: document.getElementById('add-tool-id').value,
        drawer_id: document.getElementById('add-tool-drawer').value
    };
    if (!payload.name || !payload.qr_code) return alert('⚠️ Name and Barcode ID are required.');
    if (!document.getElementById('add-tool-dept').value || !document.getElementById('add-tool-box').value || !payload.drawer_id) {
        return alert('⚠️ Select a department, toolbox, and drawer for this asset.');
    }

    const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) {
        alert(`✅ Asset saved: ${payload.qr_code}`);
        document.getElementById('add-tool-name').value = '';
        document.getElementById('add-tool-desc').value = '';
        document.getElementById('add-tool-serial').value = '';
        document.getElementById('add-tool-partnum').value = '';
        document.getElementById('add-tool-url').value = '';
        document.getElementById('add-tool-dept').value = '';
        document.getElementById('add-tool-box').innerHTML = '<option value="">-- Select a department first --</option>';
        document.getElementById('add-tool-drawer').innerHTML = '<option value="">-- Select a toolbox first --</option>';
        document.getElementById('add-tool-id').value = '';
        renderEditableInfraTree();
    } else {
        const data = await res.json();
        alert('❌ ' + (data.error || 'Failed to save asset.'));
    }
}

/**
 * Uploads the file selected in #import-csv-file to POST /api/tools/import (multipart field
 * `csv`) and renders the returned per-row report into #import-results-container: a summary
 * line (created/updated/error counts) plus a row-by-row table. This is a best-effort bulk
 * operation server-side -- one bad row doesn't block the rest of the file -- so the report
 * is the only way to know what actually happened; there's no single pass/fail result.
 * Refreshes the infrastructure tree afterward so any created/updated tools show up
 * immediately. Gated to currentAdminWeight >= 3 (dept_admin+) by the hidden
 * #card-inventory-import card, matching the server's requireRole(3) on this endpoint.
 */
async function submitInventoryImport() {
    const fileInput = document.getElementById('import-csv-file');
    const file = fileInput.files[0];
    if (!file) return alert('⚠️ Choose a CSV file first.');

    const formData = new FormData();
    formData.append('csv', file);

    const btn = document.getElementById('btn-import-csv');
    btn.innerHTML = `${icon('hourglass')} Importing...`; btn.disabled = true;

    try {
        const res = await fetch('/api/tools/import', { method: 'POST', headers: { 'X-Requested-With': 'ToolTracker' }, body: formData });
        const data = await res.json();
        if (!res.ok) { alert('❌ ' + (data.error || 'Import failed.')); return; }

        const { results, summary } = data;
        document.getElementById('import-results-container').style.display = 'block';
        document.getElementById('import-summary').textContent = `${summary.created} created, ${summary.updated} updated, ${summary.errors} error(s).`;
        document.getElementById('import-results-body').innerHTML = results.map(r => {
            const color = r.result === 'error' ? 'var(--red)' : (r.result === 'created' ? 'var(--green)' : 'var(--accent)');
            const resultIcon = r.result === 'error' ? icon('circle-x') : icon('circle-check');
            return `<tr><td>${r.row}</td><td style="font-family: monospace;">${r.barcode}</td><td style="color: ${color}; font-weight: bold;">${resultIcon} ${r.result}</td><td>${r.message}</td></tr>`;
        }).join('');

        fileInput.value = '';
        renderEditableInfraTree();
    } catch (err) {
        alert('❌ Network error during import.');
    } finally {
        btn.innerHTML = `${icon('upload')} Import`; btn.disabled = false;
    }
}

/**
 * Audio + haptic confirmation that a barcode was just successfully captured -- see the
 * identical helper in kiosk.js for the full reasoning (synthesized Web Audio beep, no
 * asset file; vibration is Android-only since iOS Safari has never implemented the
 * Vibration API). Kept as its own copy here rather than a shared file since admin.js and
 * kiosk.js are already independently self-contained per page (see initCameraCore below vs.
 * kiosk.js's executeCameraScan -- same pattern, not shared either).
 */
let scanFeedbackAudioCtx = null;
function playScanFeedback() {
    try {
        if (!scanFeedbackAudioCtx) scanFeedbackAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = scanFeedbackAudioCtx;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 1400;
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.12);
    } catch (e) { /* Web Audio unavailable/blocked -- scanning itself still works fine without the beep */ }

    if (navigator.vibrate) navigator.vibrate(60);
}

/** Shared html5-qrcode bootstrap: reveals the given reader element, tears down any previous scanner instance, and starts scanning using the rear-facing camera specifically (`facingMode: "environment"`, requested directly rather than enumerating devices and guessing which index is the rear camera -- that order is unpredictable across phones/browsers, and iOS in particular often lists the front camera first). Falls back to whatever camera is available if no rear camera exists (e.g. a laptop webcam). Invokes callback(decodedText) once a code is read (stopping the scanner and hiding the reader first). Alerts the operator if the scanner fails to start (no camera, permission denied, etc). */
function initCameraCore(elementId, callback) {
    document.getElementById(elementId).style.display = 'block';
    if (html5QrAdminInstance) { html5QrAdminInstance.clear(); }
    html5QrAdminInstance = new Html5Qrcode(elementId);
    html5QrAdminInstance.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: 250, aspectRatio: 1.0 }, // matches the .camera-reader CSS's fixed 1:1 box so the preview doesn't stretch/squish when the phone rotates
        (txt) => { playScanFeedback(); html5QrAdminInstance.stop().then(() => { document.getElementById(elementId).style.display = 'none'; callback(txt); }); }
    ).catch((err) => { alert("Camera Error"); document.getElementById(elementId).style.display = 'none'; });
}
/** Opens the login-screen scanner and writes the decoded badge id into #admin-badge. */
function startAdminLoginCamera() { initCameraCore('admin-auth-reader', (txt) => { document.getElementById('admin-badge').value = txt; }); }
/** Opens the asset-ingest scanner and writes the decoded value into the given input, overwriting whatever auto-generated barcode was there -- the department/toolbox/drawer selection is unaffected either way. */
function startAdminAssetCamera(readerId, inputId) { initCameraCore(readerId, (txt) => { document.getElementById(inputId).value = txt; }); }

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
 * department, toolbox, drawer, tool, or user record, dispatching on `type`. This is the only
 * way to reach Edit/Photo/Delete (or, for a user, Edit Role/Photo/PIN-reset/Remove) --
 * both the infrastructure tree (renderEditableInfraTree) and the personnel table (loadUsers)
 * are click-to-view only, with a separate toggle-icon for expand/collapse where applicable.
 *   - 'department': looks up globalDeptsCache by dept_id, shows a name-only edit field
 *     (prefix_code is immutable -- it's baked into existing barcode IDs) plus Delete.
 *   - 'toolbox' / 'drawer': looks up globalBoxesCache/globalDrawersCache, shows a
 *     name-only edit field plus Photo/Delete.
 *   - 'tool': looks up globalToolsCache by qr_code, builds a richer read view (description,
 *     status, calibration due date, replacement link) plus a fuller edit view (name,
 *     description, replacement URL, status select, calibration checkbox + dates) and
 *     Photo/Delete.
 *   - 'user': looks up globalUsersCache by badge_id, shows username/email/department/role in
 *     the read view and a role-only dropdown (roleOptionsUpTo) in the edit view, plus
 *     Photo/Reset PIN/Remove. Unlike the other types there's no per-type weight gate here --
 *     the Manage Accounts panel that's the only entry point to this type is already hidden
 *     below weight 3, and GET /api/users only ever returns people below the requester's own
 *     weight, so anyone who can open this modal already qualifies for all its actions.
 * For the infrastructure types, action buttons are only rendered when the caller's role
 * weight clears that type's threshold (canEditDepts = currentAdminWeight >= 4 for department,
 * canEditInfra = currentAdminWeight >= 3 for toolbox/drawer, canEditTools = currentAdminWeight
 * >= 2 for tool -- matching each type's requireRole() minimum server-side) -- if the
 * threshold isn't met, #em-actions is left empty and the modal is effectively read-only. The
 * modal always opens via toggleModalEditMode(false), i.e. read view first, even when edit is
 * permitted.
 */
function openEntityModal(type, id) {
    const canEditDepts = currentAdminWeight >= 4; // matches requireRole(4) on the department PUT/DELETE endpoints
    const canEditInfra = currentAdminWeight >= 3;
    const canEditTools = currentAdminWeight >= 2;
    let entity = null; let titleHtml = ''; let fieldsHtml = ''; let readHtml = ''; let actionsHtml = '';

    document.getElementById('em-target-type').value = type;
    document.getElementById('em-target-id').value = id;

    if (type === 'department') {
        entity = globalDeptsCache.find(d => d.dept_id == id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `DEPARTMENT [ID: ${entity.dept_id}]`;
        document.getElementById('em-thumb').innerHTML = icon('building-2');

        titleHtml = `<h3 style="margin:0;">${entity.name}</h3>`;
        readHtml = `<div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Prefix Code</div><div style="font-size:14px;margin-top:4px;font-family:monospace;">${entity.prefix_code}</div></div>`;
        fieldsHtml = `
            <div class="form-group"><label class="form-label">Department Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>
            <div class="form-group">
                <label class="form-label">Prefix Code</label>
                <div style="padding:8px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size:13px; font-family:monospace; color:var(--muted);">${entity.prefix_code}</div>
                <div style="font-size:11px; color: var(--muted); margin-top:4px;">Can't be changed after creation -- it's embedded in every existing barcode ID under this department.</div>
            </div>
        `;

        if (canEditDepts) {
            actionsHtml = `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">${icon('pencil')} Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">${icon('save')} Save Changes</button>
                <button class="btn btn-secondary" onclick="deleteInfraItem('departments', '${entity.dept_id}')" style="width:auto; color: var(--red); border-color: var(--red);">${icon('x')} Delete</button>
            `;
        }

    } else if (type === 'toolbox') {
        entity = globalBoxesCache.find(b => b.box_id == id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `STORAGE UNIT [ID: ${entity.box_id}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:8px;object-fit:cover;cursor:zoom-in;">` : icon('toolbox');

        titleHtml = `<h3 style="margin:0;">${entity.name}</h3>`;
        fieldsHtml = `<div class="form-group"><label class="form-label">Unit Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>`;

        if (canEditInfra) {
            actionsHtml = `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">${icon('pencil')} Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">${icon('save')} Save Changes</button>
                <button class="btn btn-secondary" onclick="triggerPhotoUpload('toolbox', '${entity.box_id}')" style="width:auto;">${icon('camera')} Photo</button>
                <button class="btn btn-secondary" onclick="deleteInfraItem('toolboxes', '${entity.box_id}')" style="width:auto; color: var(--red); border-color: var(--red);">${icon('x')} Delete</button>
            `;
        }

    } else if (type === 'drawer') {
        entity = globalDrawersCache.find(d => d.drawer_id == id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `STORAGE DRAWER [ID: ${entity.drawer_id}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:8px;object-fit:cover;cursor:zoom-in;">` : icon('folder');

        titleHtml = `<h3 style="margin:0;">${entity.name}</h3>`;
        fieldsHtml = `<div class="form-group"><label class="form-label">Drawer Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>`;

        // Shadow-board map: only meaningful once the drawer has a photo to place markers on
        // (see triggerPhotoUpload('drawer', ...) below) -- #em-position-map-list is filled in
        // asynchronously by renderPositionMap() once the modal is actually open, same pattern
        // as loadCalibrationHistory()/loadIncidentHistory() for tools.
        readHtml = entity.photo_url ? `
            <div id="em-position-map-section" style="margin-top:15px;">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">Tool Positions (Shadow Board Map)</div>
                <div id="em-position-map-wrap" style="position:relative;display:inline-block;max-width:100%;border-radius:8px;overflow:hidden;border:1px solid var(--border);line-height:0;">
                    <img id="em-position-map-img" src="${entity.photo_url}" style="display:block;max-width:100%;">
                    <div id="em-position-map-markers" style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>
                </div>
                <div id="em-position-map-controls" style="margin-top:10px;"></div>
            </div>
        ` : '';

        if (canEditInfra) {
            actionsHtml = `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">${icon('pencil')} Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">${icon('save')} Save Changes</button>
                <button class="btn btn-secondary" onclick="triggerPhotoUpload('drawer', '${entity.drawer_id}')" style="width:auto;">${icon('camera')} Photo</button>
                <button class="btn btn-secondary" onclick="deleteInfraItem('drawers', '${entity.drawer_id}')" style="width:auto; color: var(--red); border-color: var(--red);">${icon('x')} Delete</button>
            `;
        }

    } else if (type === 'tool') {
        entity = globalToolsCache.find(t => t.qr_code === id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `ASSET [${entity.qr_code}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:8px;object-fit:cover;cursor:zoom-in;">` : icon('wrench');
        
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
            <div style="display: flex; align-items: center; gap: 14px; margin-bottom:10px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div style="flex:1;">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Data Matrix Label</div>
                    <div style="font-size:12px;margin-top:4px;color:var(--muted);">${entity.barcode_image_url ? 'Auto-generated -- click to view/print.' : 'Not generated yet.'}</div>
                </div>
                ${entity.barcode_image_url
                    ? `<img src="${entity.barcode_image_url}" onclick="openImageModal('${entity.barcode_image_url}')" style="width:50px;height:50px;object-fit:contain;background:#fff;border-radius:4px;cursor:zoom-in;flex-shrink:0;">`
                    : ''}
            </div>
            <div style="display: flex; align-items: center; gap: 14px; margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div style="flex:1;">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Code 128 Label</div>
                    <div style="font-size:12px;margin-top:4px;color:var(--muted);">${entity.linear_barcode_image_url ? 'For 1D-only barcode scanners -- click to view/print.' : 'Not generated yet.'}</div>
                </div>
                ${entity.linear_barcode_image_url
                    ? `<img src="${entity.linear_barcode_image_url}" onclick="openImageModal('${entity.linear_barcode_image_url}')" style="width:70px;height:35px;object-fit:contain;background:#fff;border-radius:4px;cursor:zoom-in;flex-shrink:0;">`
                    : ''}
            </div>
            ${!entity.photo_url ? `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-bottom:10px;">No photo on file.</div>` : ''}
        `;
        if(entity.replacement_url) readHtml += `<div><a href="${entity.replacement_url}" target="_blank" style="color:var(--blue); font-size: 13px; text-decoration: none;">${icon('shopping-cart')} Open Replacement Link →</a></div>`;
        // #em-cal-history-list is populated asynchronously by loadCalibrationHistory() below
        // -- every completed calibration cycle (see calibration_records / migrations/006), not
        // just the current due date, so an auditor can see who calibrated it and under what
        // certificate. Shown for every tool, not just ones already flagged is_calibrated --
        // "+ Log Calibration" is also how an existing tool (whose last_cal_date/cal_due_date
        // were set by the ingest form, a direct edit, or CSV import, with no traceable record
        // at all) gets its history backfilled, and logging one sets is_calibrated
        // automatically -- see submitCalLogForm().
        readHtml += `
            <div id="em-cal-history-container" style="margin-top:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Calibration History</div>
                    <button type="button" class="btn-icon" style="width:auto; padding:4px 10px; font-size:11px;" onclick="toggleCalLogForm(true)">${icon('plus')} Log Calibration</button>
                </div>
                <div id="em-cal-history-list" style="font-size:12px;color:var(--muted);margin-top:4px;">Loading...</div>

                <div id="em-cal-log-form" style="display:none; margin-top:10px; background: rgba(255,255,255,0.02); padding:12px; border-radius:8px; border:1px solid var(--border);">
                    <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom:10px;">
                        <div class="form-group" style="margin:0;"><label class="form-label">Calibration Date</label><input type="date" class="form-input" id="em-cal-date"></div>
                        <div class="form-group" style="margin:0;"><label class="form-label">Due Date</label><input type="date" class="form-input" id="em-cal-due"></div>
                    </div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Provider / Lab</label><input class="form-input" id="em-cal-provider" placeholder="e.g. Snap-on Calibration Services"></div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Certificate / Reference #</label><input class="form-input" id="em-cal-cert" placeholder="e.g. CERT-2026-04231"></div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Standard Used <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="em-cal-standard" placeholder="e.g. NIST-traceable"></div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Notes <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="em-cal-notes"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-secondary" style="width:auto;" onclick="toggleCalLogForm(false)">Cancel</button>
                        <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitCalLogForm('${entity.tool_id}', '${entity.qr_code}')">Save Record</button>
                    </div>
                </div>
            </div>
        `;
        // #em-incident-history-list is populated asynchronously by loadIncidentHistory()
        // below -- every reported Missing/Broken/Worn cycle (see tool_incidents /
        // migrations/007), not just the tool's current status, and -- critically -- how/
        // when/by whom each one was RESOLVED, which previously left no trace at all (a
        // status edit alone wrote no audit_logs row). #em-incident-resolve-form only shows
        // once an open incident is known to exist -- see loadIncidentHistory().
        readHtml += `
            <div id="em-incident-history-container" style="margin-top:15px;">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Incident History</div>
                <div id="em-incident-history-list" style="font-size:12px;color:var(--muted);margin-top:4px;">Loading...</div>

                <div id="em-incident-resolve-form" style="display:none; margin-top:10px; background: rgba(239,68,68,0.08); padding:12px; border-radius:8px; border:1px solid var(--red);">
                    <div style="font-size:13px; font-weight:bold; color:var(--red); margin-bottom:8px;">Resolve Open Incident</div>
                    <div class="form-group" style="margin-bottom:10px;">
                        <label class="form-label">Resolution</label>
                        <select class="form-select" id="em-incident-resolution">
                            <option value="RESOLVED">Found / Repaired -- Return to Service</option>
                            <option value="WRITTEN_OFF">Write Off -- Retire Permanently</option>
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Resolution Notes</label><input class="form-input" id="em-incident-notes" placeholder="e.g. Found in Drawer 3, mislabeled during last audit"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitIncidentResolve('${entity.tool_id}', '${entity.qr_code}')">Submit Resolution</button>
                    </div>
                </div>
            </div>
        `;

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

        // Location cascade (Department -> Toolbox -> Drawer), defaulted to the tool's current
        // drawer -- lets a tool be moved to a different drawer/toolbox, including across
        // departments, straight from the edit modal instead of only via direct DB access or a
        // CSV round-trip. Mirrors the Ingest New Asset cascade (populateBoxSelect/
        // populateDrawerSelect), just wired to onMoveToolDeptChange/onMoveToolBoxChange instead.
        const currentDrawer = globalDrawersCache.find(d => d.drawer_id == entity.drawer_id);
        const currentBox = currentDrawer ? globalBoxesCache.find(b => b.box_id == currentDrawer.box_id) : null;
        const currentMoveDeptId = currentBox ? currentBox.dept_id : '';
        const moveDeptOptions = globalDeptsCache.map(d => `<option value="${d.dept_id}" ${d.dept_id == currentMoveDeptId ? 'selected' : ''}>${d.name}</option>`).join('');
        const boxesInDept = globalBoxesCache.filter(b => b.dept_id == currentMoveDeptId);
        const moveBoxOptions = boxesInDept.length
            ? '<option value="">-- Select Toolbox --</option>' + boxesInDept.map(b => `<option value="${b.box_id}" ${currentBox && b.box_id == currentBox.box_id ? 'selected' : ''}>${b.name}</option>`).join('')
            : '<option value="">No toolboxes in this department</option>';
        const drawersInBox = currentBox ? globalDrawersCache.filter(d => d.box_id == currentBox.box_id) : [];
        const moveDrawerOptions = drawersInBox.length
            ? '<option value="">-- Select Drawer --</option>' + drawersInBox.map(d => `<option value="${d.drawer_id}" ${d.drawer_id == entity.drawer_id ? 'selected' : ''}>${d.name}</option>`).join('')
            : '<option value="">No drawers in this toolbox</option>';

        fieldsHtml = `
            <div class="form-group"><label class="form-label">Asset Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>
            <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="em-input-desc" rows="2">${entity.description || ''}</textarea></div>
            <div class="form-group">
                <label class="form-label">Location</label>
                <div class="flex-grid-3" style="margin-bottom: 0;">
                    <select class="form-select" id="em-input-move-dept" onchange="onMoveToolDeptChange()">${moveDeptOptions}</select>
                    <select class="form-select" id="em-input-move-box" onchange="onMoveToolBoxChange()">${moveBoxOptions}</select>
                    <select class="form-select" id="em-input-move-drawer">${moveDrawerOptions}</select>
                </div>
            </div>
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
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">${icon('pencil')} Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">${icon('save')} Save Changes</button>
                <button class="btn btn-secondary" onclick="triggerPhotoUpload('tool', '${entity.qr_code}')" style="width:auto;">${icon('camera')} Photo</button>
                <button class="btn btn-secondary" onclick="removeToolPermanent('${entity.tool_id}', '${entity.qr_code}')" style="width:auto; color: var(--red); border-color: var(--red);">${icon('x')} Delete</button>
            `;
        }

    } else if (type === 'user') {
        // Every user reachable here already comes from GET /api/users, which only returns
        // people whose role weight is strictly below the requester's own -- the Manage
        // Accounts panel itself is hidden below weight 3 (see bootstrapAdminUI) -- so unlike
        // toolbox/drawer/tool (visible to a wider tool_rep+ audience via the Master Directory),
        // every viewer who can even open this modal already qualifies for all its actions.
        entity = globalUsersCache.find(u => u.badge_id === id);
        if(!entity) return;
        document.getElementById('em-type-badge').textContent = `PERSONNEL [${entity.badge_id}]`;
        document.getElementById('em-thumb').innerHTML = entity.photo_url
            ? `<img src="${entity.photo_url}" onclick="openImageModal('${entity.photo_url}')" style="width:100%;height:100%;border-radius:50%;object-fit:cover;cursor:zoom-in;">`
            : icon('user');

        const grantedNames = (entity.granted_dept_ids || []).map(gid => (globalDeptsCache.find(d => d.dept_id == gid) || {}).name).filter(Boolean);
        titleHtml = `<h3 style="margin:0;">${entity.full_name}</h3>`;
        readHtml = `
            <div style="display: flex; gap: 30px; margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Username</div><div style="font-size:14px;margin-top:4px;font-family:monospace;">${entity.username || '--'}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Email</div><div style="font-size:14px;margin-top:4px;">${entity.email || '--'}</div></div>
            </div>
            <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Department</div><div style="font-size:14px;margin-top:4px;">${entity.department_name || '--'}</div></div>
            <div style="margin-top:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">System Role</div><div style="font-size:14px;margin-top:4px;font-weight:bold;color:var(--accent);">${ROLE_LABELS[entity.role] || entity.role}</div></div>
            ${grantedNames.length > 0 ? `<div style="margin-top:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Also Manages</div><div style="font-size:14px;margin-top:4px;">${grantedNames.join(', ')}</div></div>` : ''}
        `;
        fieldsHtml = `
            <div class="form-group">
                <label class="form-label">System Role</label>
                <select class="form-select" id="em-input-role" ${currentAdminWeight >= 4 ? `onchange="document.getElementById('em-dept-access-section').style.display = this.value === 'dept_admin' ? 'block' : 'none'"` : ''}>${roleOptionsUpTo(currentAdminWeight, entity.role)}</select>
                <div style="font-size:11px; color: var(--muted); margin-top:4px;">You can only assign roles up to your own level.</div>
            </div>
            ${currentAdminWeight >= 4 ? `
                <div class="form-group" id="em-dept-access-section" style="display: ${entity.role === 'dept_admin' ? 'block' : 'none'};">
                    <label class="form-label">Granted Department Access</label>
                    <div style="font-size:11px; color: var(--muted); margin-bottom:6px;">Full manager access to these departments, in addition to their home department (${entity.department_name || '--'}).</div>
                    <div style="display:flex; flex-direction:column; gap:6px; max-height:160px; overflow-y:auto; padding:8px; background: rgba(255,255,255,0.02); border-radius:6px; border:1px solid var(--border);">
                        ${globalDeptsCache.filter(d => d.dept_id != entity.dept_id).map(d => `
                            <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
                                <input type="checkbox" class="em-input-granted-dept" value="${d.dept_id}" ${(entity.granted_dept_ids || []).includes(d.dept_id) ? 'checked' : ''}>
                                ${d.name}
                            </label>
                        `).join('') || `<div style="font-size:12px; color: var(--muted);">No other departments exist yet.</div>`}
                    </div>
                </div>
            ` : ''}
        `;

        actionsHtml = `
            <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">${icon('pencil')} Edit Role</button>
            <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">${icon('save')} Save Changes</button>
            <button class="btn btn-secondary" onclick="triggerPhotoUpload('user', '${entity.badge_id}')" style="width:auto;">${icon('camera')} Photo</button>
            <button class="btn btn-secondary" onclick="resetUserPin('${entity.badge_id}')" style="width:auto;">${icon('key-round')} Reset PIN</button>
            <button class="btn btn-secondary" onclick="deactivateUser('${entity.badge_id}')" style="width:auto; color: var(--red); border-color: var(--red);">${icon('x')} Remove</button>
        `;
    }

    document.getElementById('em-title-container').innerHTML = titleHtml;
    document.getElementById('em-read-fields').innerHTML = readHtml;
    document.getElementById('em-edit-fields').innerHTML = fieldsHtml;
    document.getElementById('em-actions').innerHTML = actionsHtml;

    // ALWAYS open in Read-Only mode first!
    toggleModalEditMode(false);
    document.getElementById('entity-modal-overlay').style.display = 'flex';

    if (type === 'tool') { loadCalibrationHistory(entity.tool_id); loadIncidentHistory(entity.tool_id); }
    if (type === 'drawer' && entity.photo_url) { renderPositionMap(entity); }
}

/**
 * Renders the shadow-board map inside an open drawer modal (see the `readHtml` built for
 * type === 'drawer' in openEntityModal) -- a colored marker for every tool in this drawer
 * that already has a saved position (green/accent/red, same convention as the inventory
 * tree's status coloring), plus, for anyone who can edit tools, a "click the photo to place"
 * control listing whatever tools in this drawer don't have one yet. Re-called after every
 * place/unplace so the map updates immediately without reopening the modal.
 * @param {object} drawer - a drawer entity from globalDrawersCache (needs drawer_id)
 */
function renderPositionMap(drawer) {
    const canEditTools = currentAdminWeight >= 2; // matches requireRole(2) on PUT /api/tools/:id/position
    const markersEl = document.getElementById('em-position-map-markers');
    const controlsEl = document.getElementById('em-position-map-controls');
    if (!markersEl || !controlsEl) return; // modal was closed/switched before this ran

    const drawerTools = globalToolsCache.filter(t => t.drawer_id === drawer.drawer_id);
    const placed = drawerTools.filter(t => t.position_x !== null && t.position_y !== null);
    const unplaced = drawerTools.filter(t => t.position_x === null || t.position_y === null);
    const statusColor = (status) => status === 'In' ? 'var(--green)' : (status === 'Out' ? 'var(--accent)' : 'var(--red)');

    markersEl.innerHTML = placed.map(t => `
        <div title="${t.name} (${t.status})" onclick="event.stopPropagation();${canEditTools ? ` unplaceToolPosition('${t.qr_code}')` : ''}"
             style="position:absolute; left:${t.position_x * 100}%; top:${t.position_y * 100}%; transform:translate(-50%,-50%);
                    width:16px; height:16px; border-radius:50%; background:${statusColor(t.status)}; border:2px solid #fff;
                    box-shadow:0 0 4px rgba(0,0,0,0.6);${canEditTools ? ' cursor:pointer;' : ''}"></div>
    `).join('');

    const img = document.getElementById('em-position-map-img');

    if (!canEditTools || unplaced.length === 0) {
        img.onclick = null;
        controlsEl.innerHTML = drawerTools.length === 0
            ? `<div style="font-size:12px;color:var(--muted);">No tools assigned to this drawer yet.</div>`
            : (canEditTools ? `<div style="font-size:12px;color:var(--muted);">Every tool in this drawer is placed. Click a marker to remove it.</div>` : '');
        return;
    }

    controlsEl.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <label class="form-label" style="margin:0;white-space:nowrap;">Click the photo to place:</label>
            <select class="form-select" id="em-position-tool-select" style="width:auto;flex:1;min-width:160px;">
                ${unplaced.map(t => `<option value="${t.qr_code}">${t.name} (${t.qr_code})</option>`).join('')}
            </select>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px;">Click an existing marker to remove its position.</div>
    `;

    img.onclick = (event) => {
        const select = document.getElementById('em-position-tool-select');
        if (!select || !select.value) return;
        const rect = event.target.getBoundingClientRect();
        placeToolPosition(select.value, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    };
}

/**
 * Saves a tool's shadow-board position (fractional 0-1 within its drawer's photo) via
 * PUT /api/tools/:id/position, updates the local cache, and re-renders the map in place --
 * see renderPositionMap().
 */
async function placeToolPosition(qrCode, x, y) {
    try {
        const res = await fetch(`/api/tools/${encodeURIComponent(qrCode)}/position`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ position_x: x, position_y: y }),
        });
        if (!res.ok) { const data = await res.json().catch(() => ({})); alert('❌ ' + (data.error || 'Failed to place tool.')); return; }
        const tool = globalToolsCache.find(t => t.qr_code === qrCode);
        if (tool) { tool.position_x = x; tool.position_y = y; }
        const drawer = globalDrawersCache.find(d => d.drawer_id == document.getElementById('em-target-id').value);
        if (drawer) renderPositionMap(drawer);
    } catch (err) {
        alert('❌ Network error while placing tool.');
    }
}

/**
 * Clears a tool's shadow-board position -- confirms first, since a click on a small marker
 * is easy to fat-finger and there's no undo besides re-placing it -- then re-renders the map.
 */
async function unplaceToolPosition(qrCode) {
    const tool = globalToolsCache.find(t => t.qr_code === qrCode);
    if (!tool || !confirm(`Remove the shadow-board marker for "${tool.name}"?`)) return;
    try {
        const res = await fetch(`/api/tools/${encodeURIComponent(qrCode)}/position`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ position_x: null, position_y: null }),
        });
        if (!res.ok) { const data = await res.json().catch(() => ({})); alert('❌ ' + (data.error || 'Failed to remove marker.')); return; }
        tool.position_x = null; tool.position_y = null;
        const drawer = globalDrawersCache.find(d => d.drawer_id == document.getElementById('em-target-id').value);
        if (drawer) renderPositionMap(drawer);
    } catch (err) {
        alert('❌ Network error while removing marker.');
    }
}

/**
 * Fills in #em-cal-history-list (inside the #em-cal-history-container block rendered by
 * openEntityModal for every tool) from GET /api/tools/:id/calibration-history -- every
 * completed calibration cycle, newest first, not just the tool's current due date. Called
 * with the tool's real numeric tool_id (not qr_code, unlike most of this file's tool
 * lookups) since that's what the endpoint expects. Leaves the header/"+ Log Calibration"
 * button/form alone -- only the list itself is replaced, so re-calling this after
 * submitCalLogForm() doesn't need to re-render the whole container.
 */
async function loadCalibrationHistory(toolId) {
    const listEl = document.getElementById('em-cal-history-list');
    if (!listEl) return;
    try {
        const res = await fetch(`/api/tools/${toolId}/calibration-history`);
        const data = await res.json();
        if (!res.ok || !data.records.length) {
            listEl.innerHTML = `No completed calibration cycles on record yet.`;
            return;
        }
        listEl.innerHTML = data.records.map(r => `
            <div style="padding:8px 0; border-bottom:1px solid var(--border);">
                <div style="display:flex; justify-content:space-between; font-size:13px;"><strong style="color:var(--text);">${r.cal_date.split('T')[0]}</strong><span>Due: ${r.due_date.split('T')[0]}</span></div>
                <div style="font-size:12px; color:var(--text); margin-top:2px;">${r.provider} &mdash; Cert# <span style="font-family:monospace;">${r.certificate_number}</span></div>
                ${r.standard_used ? `<div style="font-size:11px;">Standard: ${r.standard_used}</div>` : ''}
                ${r.notes ? `<div style="font-size:11px;">${r.notes}</div>` : ''}
                <div style="font-size:10px; margin-top:2px;">Recorded by ${r.recorded_by_name || 'Unknown'}</div>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = `<span style="color:var(--red);">Failed to load.</span>`;
    }
}

/** Shows/hides the "+ Log Calibration" inline form (#em-cal-log-form) in the tool modal, resetting its fields to blank (calibration date defaulted to today) each time it's opened. */
function toggleCalLogForm(show) {
    document.getElementById('em-cal-log-form').style.display = show ? 'block' : 'none';
    if (show) {
        document.getElementById('em-cal-date').value = new Date().toISOString().slice(0, 10);
        document.getElementById('em-cal-due').value = '';
        document.getElementById('em-cal-provider').value = '';
        document.getElementById('em-cal-cert').value = '';
        document.getElementById('em-cal-standard').value = '';
        document.getElementById('em-cal-notes').value = '';
    }
}

/**
 * Submits the "+ Log Calibration" form to POST /api/tools/:id/calibration-history --
 * directly logging (or backfilling) a calibration record outside the kiosk's QA transfer
 * flow, e.g. for a tool that already had calibration dates set some other way and has no
 * traceable history yet. On success, refreshes the infrastructure tree (so
 * globalToolsCache's is_calibrated/cal_due_date reflect the now-most-recent record) and
 * reopens this same tool's modal fresh, which re-triggers loadCalibrationHistory().
 */
async function submitCalLogForm(toolId, qrCode) {
    const calDate = document.getElementById('em-cal-date').value;
    const dueDate = document.getElementById('em-cal-due').value;
    const provider = document.getElementById('em-cal-provider').value.trim();
    const certificateNumber = document.getElementById('em-cal-cert').value.trim();
    const standardUsed = document.getElementById('em-cal-standard').value.trim();
    const notes = document.getElementById('em-cal-notes').value.trim();

    if (!calDate || !dueDate) return alert('⚠️ Calibration date and due date are both required.');
    if (!provider || !certificateNumber) return alert('⚠️ Calibration provider and certificate/reference number are both required.');

    try {
        const res = await fetch(`/api/tools/${toolId}/calibration-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ cal_date: calDate, due_date: dueDate, provider, certificate_number: certificateNumber, standard_used: standardUsed || null, notes: notes || null })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to log calibration record.')); }
        await renderEditableInfraTree();
        openEntityModal('tool', qrCode);
    } catch (e) {
        alert('Network Error.');
    }
}

/**
 * Fills in #em-incident-history-list from GET /api/tools/:id/incidents -- every reported
 * Missing/Broken/Worn cycle, newest first, including how/when/by whom it was resolved. If
 * the most recent incident is still OPEN, also reveals #em-incident-resolve-form (hidden
 * the rest of the time) so resolving it is the obvious next action, not a hunt for a button.
 */
async function loadIncidentHistory(toolId) {
    const listEl = document.getElementById('em-incident-history-list');
    const resolveForm = document.getElementById('em-incident-resolve-form');
    if (!listEl) return;
    try {
        const res = await fetch(`/api/tools/${toolId}/incidents`);
        const data = await res.json();
        if (!res.ok || !data.incidents.length) {
            listEl.innerHTML = `No incidents on record.`;
            if (resolveForm) resolveForm.style.display = 'none';
            return;
        }

        listEl.innerHTML = data.incidents.map(inc => {
            const statusColor = inc.status === 'OPEN' ? 'var(--red)' : (inc.status === 'WRITTEN_OFF' ? 'var(--muted)' : 'var(--green)');
            const statusLabel = inc.status === 'OPEN' ? 'OPEN' : (inc.status === 'WRITTEN_OFF' ? 'Written Off' : 'Resolved');
            return `
            <div style="padding:8px 0; border-bottom:1px solid var(--border);">
                <div style="display:flex; justify-content:space-between; font-size:13px;">
                    <strong style="color:var(--text);">${inc.incident_type}</strong>
                    <span style="color:${statusColor}; font-weight:bold;">${statusLabel}</span>
                </div>
                <div style="font-size:11px;">Reported ${new Date(inc.reported_at).toLocaleString()} by ${inc.reported_by_name || 'Unknown'}${inc.last_known_location ? ' -- last known at ' + inc.last_known_location : ''}</div>
                ${inc.description ? `<div style="font-size:12px; color:var(--text); margin-top:2px;">${inc.description}</div>` : ''}
                ${inc.status !== 'OPEN' ? `<div style="font-size:11px; margin-top:2px;">Resolved ${new Date(inc.resolved_at).toLocaleString()} by ${inc.resolved_by_name || 'Unknown'}${inc.resolution_notes ? ' -- ' + inc.resolution_notes : ''}</div>` : ''}
            </div>
        `;
        }).join('');

        if (resolveForm) {
            const hasOpenIncident = data.incidents.some(inc => inc.status === 'OPEN');
            resolveForm.style.display = hasOpenIncident ? 'block' : 'none';
            if (hasOpenIncident) resolveForm.dataset.incidentId = data.incidents.find(inc => inc.status === 'OPEN').incident_id;
        }
    } catch (e) {
        listEl.innerHTML = `<span style="color:var(--red);">Failed to load.</span>`;
    }
}

/**
 * Submits #em-incident-resolve-form to POST /api/tools/:id/incidents/:incident_id/resolve --
 * the recommended way to resolve an open incident (over just changing the tool's status via
 * the general edit form) since it collects resolution notes and doesn't require switching to
 * edit mode. On success, refreshes the infrastructure tree and reopens this tool's modal
 * fresh, same pattern as submitCalLogForm().
 */
async function submitIncidentResolve(toolId, qrCode) {
    const incidentId = document.getElementById('em-incident-resolve-form').dataset.incidentId;
    const resolution = document.getElementById('em-incident-resolution').value;
    const notes = document.getElementById('em-incident-notes').value.trim();

    try {
        const res = await fetch(`/api/tools/${toolId}/incidents/${incidentId}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ resolution, resolution_notes: notes || null })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to resolve incident.')); }
        await renderEditableInfraTree();
        openEntityModal('tool', qrCode);
    } catch (e) {
        alert('Network Error.');
    }
}

/** Hides the universal entity modal without saving. */
function closeEntityModal() { document.getElementById('entity-modal-overlay').style.display = 'none'; }

/**
 * Reads the entity type/id stashed in the modal's hidden #em-target-type/#em-target-id
 * fields and dispatches the save to the matching REST endpoint: PUT /api/toolboxes/:id,
 * PUT /api/drawers/:id, PUT /api/tools/:id, or PUT /api/users/:badge_id/role. Every
 * infrastructure type submits the shared `name` field; 'tool' additionally submits
 * description, drawer_id (the Location cascade -- lets a tool be moved to a different
 * drawer/toolbox/department here), replacement_url, status, and calibration fields; 'user'
 * submits only `role` (name/email/username aren't editable from here). For 'user', if the super_admin-only
 * granted-department checkboxes are present in the DOM, also submits their checked state
 * to PUT /api/users/:badge_id/department-access as a second request. Closes the modal and
 * refreshes the infrastructure tree (or the personnel tables, for 'user') on success.
 */
async function saveEntityUpdates() {
    const type = document.getElementById('em-target-type').value;
    const id = document.getElementById('em-target-id').value;

    let payload = {};
    let endpoint = '';

    if (type === 'user') {
        endpoint = `/api/users/${id}/role`;
        payload.role = document.getElementById('em-input-role').value;
    } else {
        payload.name = document.getElementById('em-input-name').value;
        if (type === 'department') { endpoint = `/api/departments/${id}`; }
        else if (type === 'toolbox') { endpoint = `/api/toolboxes/${id}`; }
        else if (type === 'drawer') { endpoint = `/api/drawers/${id}`; }
        else if (type === 'tool') {
            endpoint = `/api/tools/${id}`;
            payload.description = document.getElementById('em-input-desc').value;
            payload.drawer_id = document.getElementById('em-input-move-drawer').value || null;
            payload.serial_number = document.getElementById('em-input-serial').value || null;
            payload.part_number = document.getElementById('em-input-partnum').value || null;
            payload.replacement_url = document.getElementById('em-input-url').value;
            payload.status = document.getElementById('em-input-status').value;
            payload.is_calibrated = document.getElementById('em-input-is-cal').checked;
            payload.last_cal_date = document.getElementById('em-input-last-cal').value || null;
            payload.cal_due_date = document.getElementById('em-input-cal-due').value || null;
            if (!payload.drawer_id) return alert('⚠️ Select a Department, Toolbox, and Drawer for this asset.');
        }
    }

    try {
        const res = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
        if(!res.ok) { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to save.')); return; }

        // The department-access checkboxes (super_admin viewers only, see openEntityModal)
        // are a second, independent form on the same modal -- submitted as its own request
        // to PUT /api/users/:badge_id/department-access rather than folded into the role
        // payload above, since it's a full-replace of a separate table, not a users column.
        const grantedDeptEls = document.querySelectorAll('.em-input-granted-dept');
        if (type === 'user' && grantedDeptEls.length > 0) {
            const dept_ids = Array.from(grantedDeptEls).filter(el => el.checked).map(el => el.value);
            const grantRes = await fetch(`/api/users/${id}/department-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({ dept_ids }) });
            if (!grantRes.ok) { const data = await grantRes.json(); alert('❌ Role saved, but department access failed: ' + (data.error || 'Unknown error.')); }
        }

        closeEntityModal();
        if (type === 'user') { loadUsers(); loadRosterDirectory(); } else { renderEditableInfraTree(); }
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
            () => { const btn = document.getElementById('cred-modal-copy-btn'); if (btn) { const original = btn.innerHTML; btn.innerHTML = `${icon('circle-check', 'icon-success')} Copied!`; setTimeout(() => { btn.innerHTML = original; }, 1500); } },
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