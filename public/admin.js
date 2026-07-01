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

function toggleModalEditMode(isEditing) {
    document.getElementById('em-read-fields').style.display = isEditing ? 'none' : 'block';
    document.getElementById('em-edit-fields').style.display = isEditing ? 'block' : 'none';
    
    const editBtn = document.getElementById('em-btn-edit');
    const saveBtn = document.getElementById('em-btn-save');
    if (editBtn) editBtn.style.display = isEditing ? 'none' : 'inline-flex';
    if (saveBtn) saveBtn.style.display = isEditing ? 'inline-flex' : 'none';
}

function getRoleWeight(role) {
    const weights = { 'super_admin': 4, 'dept_admin': 3, 'tool_rep': 2, 'technician': 1 };
    return weights[role] || 0;
}

function safeSetDisplay(id, displayState) {
    const el = document.getElementById(id);
    if (el) el.style.display = displayState;
}

function openWorkspace(id) {
    document.getElementById('hub-view').style.display = 'none';
    document.getElementById('workspace-view').style.display = 'block';
    document.querySelectorAll('.workspace-panel').forEach(p => p.style.display = 'none');
    document.getElementById(id).style.display = 'block';
}

function showMainHub() {
    document.getElementById('workspace-view').style.display = 'none';
    document.getElementById('hub-view').style.display = 'grid';
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    
    safeSetDisplay('subhub-personnel', 'block');
    safeSetDisplay('subhub-inventory', 'block');
}

function openSubPanel(panelId) {
    safeSetDisplay('subhub-personnel', 'none');
    safeSetDisplay('subhub-inventory', 'none');
    
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    document.getElementById(panelId).style.display = 'block';
}

function closeSubPanel(workspaceId, subhubId) {
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    safeSetDisplay(subhubId, 'block');
}

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
        
        currentAdminBadge = data.user.badge_id; 
        currentAdminWeight = getRoleWeight(data.user.role);

        document.getElementById('auth-wall').style.display = 'none'; 
        document.getElementById('admin-app').style.display = 'block'; 
        document.getElementById('admin-name').textContent = `Logged in as: ${data.user.full_name} (${data.user.role.toUpperCase()})`;
        
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
        await syncStorageHierarchyDropdowns(); 
        if (currentAdminWeight >= 2) { fetchNextToolId(); } 
        
    } catch (err) { 
        alert('Server connection failure.'); 
    }
}

async function updateMyAccount() {
    const payload = { requester: currentAdminBadge, new_username: document.getElementById('my-new-username').value, new_pin: document.getElementById('my-new-pin').value };
    const res = await fetch('/api/users/me/update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) { alert('✅ Account updated successfully.'); document.getElementById('my-new-username').value = ''; document.getElementById('my-new-pin').value = ''; } 
    else { const err = await res.json(); alert('❌ ' + err.error); }
}

// ==========================================
// 4. PHOTO UPLOADS
// ==========================================
function triggerPhotoUpload(type, id) {
    uploadTarget = { type, id };
    document.getElementById('global-photo-upload').click();
}

async function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('photo', file);
    formData.append('requester', currentAdminBadge);
    formData.append('entity_type', uploadTarget.type);
    formData.append('entity_id', uploadTarget.id);

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
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
async function loadUsers() {
    try {
        const response = await fetch(`/api/users?requester=${currentAdminBadge}`); const data = await response.json();
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

async function loadRosterDirectory() {
    try {
        const res = await fetch(`/api/roster`); const data = await res.json();
        document.getElementById('user-roster-body').innerHTML = data.roster.map(u => {
            const avatar = u.photo_url ? `<img src="${u.photo_url}" style="width: 30px; height: 30px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 30px; height: 30px; border-radius: 50%; background: var(--surface2); display: flex; align-items: center; justify-content: center;">👤</div>`;
            return `<tr class="roster-row"><td><div style="display: flex; align-items: center; gap: 10px;">${avatar} <strong>${u.full_name}</strong></div></td><td>${u.department_name || '--'}</td><td>${u.role.toUpperCase()}</td><td style="font-family: monospace;">${u.badge_id}</td></tr>`;
        }).join('');
    } catch (err) { console.error(err); }
}

function filterRoster() {
    const input = document.getElementById('roster-search').value.toUpperCase();
    document.querySelectorAll('.roster-row').forEach(row => { row.style.display = row.innerText.toUpperCase().includes(input) ? '' : 'none'; });
}

async function addUser() { 
    const payload = { requester: currentAdminBadge, full_name: document.getElementById('new-name').value, email: document.getElementById('new-email').value, dept_id: document.getElementById('new-user-dept').value, role: document.getElementById('new-role').value }; 
    if (!payload.full_name || !payload.email) return alert('Name and Email are required.');
    const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); 
    if (res.ok) { alert('✅ User created.'); document.getElementById('new-name').value = ''; document.getElementById('new-email').value = ''; loadUsers(); loadRosterDirectory(); } else { const err = await res.json(); alert('❌ ' + err.error); }
}

async function resetUserPin(id) { 
    if(!confirm(`Reset PIN for ${id}?`)) return; 
    const res = await fetch(`/api/users/${id}/reset-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requester: currentAdminBadge }) }); 
    if (res.ok) alert('✅ PIN dispatched.'); else alert('❌ Failed.');
}

async function deactivateUser(id) { 
    if(!confirm(`Deactivate ${id}?`)) return; 
    await fetch(`/api/users/${id}/deactivate`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requester: currentAdminBadge }) }); 
    loadUsers(); loadRosterDirectory(); 
}

// ==========================================
// 6. INVENTORY & INFRASTRUCTURE
// ==========================================
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

async function submitStructureDept() { 
    const payload = { name: document.getElementById('str-dept-name').value, prefix_code: document.getElementById('str-dept-prefix').value, requester: currentAdminBadge };
    if (!payload.name || !payload.prefix_code) return alert("⚠️ Required fields missing.");
    const res = await fetch('/api/departments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); 
    if (res.ok) { alert('✅ Department Established.'); document.getElementById('str-dept-name').value = ''; document.getElementById('str-dept-prefix').value = ''; syncStorageHierarchyDropdowns(); renderEditableInfraTree(); } 
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Database error')); }
}

async function submitSmartBox() { 
    const payload = { name: document.getElementById('str-box-name').value, dept_id: document.getElementById('str-box-dept-select').value, qr_code: document.getElementById('str-box-id').value, drawer_count: document.getElementById('str-box-drawers').value, requester: currentAdminBadge };
    if (!payload.name || !payload.dept_id) return alert("⚠️ Required fields missing.");
    const btn = document.querySelector('button[onclick="submitSmartBox()"]');
    btn.textContent = "⏳ Building..."; btn.disabled = true;
    const res = await fetch('/api/toolboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); 
    if (res.ok) { document.getElementById('str-box-name').value = ''; document.getElementById('str-box-drawers').value = ''; await syncStorageHierarchyDropdowns(); await fetchNextBoxId(); renderEditableInfraTree(); btn.textContent = "✅ Success!"; } 
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Database error')); }
    setTimeout(() => { btn.textContent = "🔨 Build Storage Structure"; btn.disabled = false; }, 2000);
}

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

                                html += `
                                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.02);">
                                        <div style="display: flex; align-items: center; gap: 10px;">
                                            <span style="font-family: monospace; font-size: 11px; color: var(--muted);">${tool.qr_code}</span>
                                            <span style="font-size: 13px; font-weight:bold;">${tool.name}</span>
                                            <span style="font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); color: ${statusColor};">${tool.status}</span>
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

async function deleteInfraItem(type, id) {
    if (!confirm(`Are you sure you want to delete this structure? It will only succeed if it is empty.`)) return;
    try {
        const res = await fetch(`/api/${type}/${id}`, { method: 'DELETE' });
        if (res.ok) { renderEditableInfraTree(); syncStorageHierarchyDropdowns(); } 
        else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to delete.')); }
    } catch (err) { alert('❌ Network error.'); }
}

async function removeToolPermanent(tool_id, qr_code) {
    if(!confirm(`WARNING: Permanently delete ${qr_code}?`)) return;
    const res = await fetch(`/api/tools/${tool_id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requester: currentAdminBadge }) });
    if (res.ok) { alert('✅ Tool removed.'); renderEditableInfraTree(); } 
    else alert('❌ Failed to delete tool.');
}

// ==========================================
// 7. INGEST ASSETS (TOOLS) & CAMERAS
// ==========================================
async function fetchNextToolId() { 
    const prefixDropdown = document.getElementById('add-tool-prefix');
    if (!prefixDropdown || prefixDropdown.style.display === 'none' || !prefixDropdown.value) return;
    document.getElementById('add-tool-id').value = 'Generating...';
    try { 
        const res = await fetch(`/api/tools/next-id?prefix=${prefixDropdown.value}`); const data = await res.json(); 
        document.getElementById('add-tool-id').value = data.success ? data.next_sequence : 'Error'; 
    } catch (err) { document.getElementById('add-tool-id').value = 'Error'; } 
}

async function addNewTool() {
    const payload = { 
        requester: currentAdminBadge, 
        name: document.getElementById('add-tool-name').value, 
        description: document.getElementById('add-tool-desc').value, 
        replacement_url: document.getElementById('add-tool-url').value, 
        qr_code: document.getElementById('add-tool-prefix').style.display !== 'none' ? document.getElementById('add-tool-prefix').value + document.getElementById('add-tool-id').value : document.getElementById('add-tool-id').value, 
        drawer_id: document.getElementById('add-tool-drawer').value
    };
    if (!payload.name || !payload.qr_code) return alert('Name and ID required.');
    
    const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) { 
        alert(`✅ Asset saved: ${payload.qr_code}`); 
        document.getElementById('add-tool-name').value = ''; 
        document.getElementById('add-tool-desc').value = ''; 
        document.getElementById('add-tool-url').value = ''; 
        document.getElementById('add-tool-prefix').style.display = 'inline-block';
        fetchNextToolId(); renderEditableInfraTree();
    }
}

function initCameraCore(elementId, callback) { 
    document.getElementById(elementId).style.display = 'block'; 
    if(html5QrAdminInstance) { html5QrAdminInstance.clear(); } 
    html5QrAdminInstance = new Html5Qrcode(elementId); 
    Html5Qrcode.getCameras().then(devices => { 
        if (devices && devices.length) { 
            html5QrAdminInstance.start(devices[0].id, { fps: 12, qrbox: 250 }, (txt) => { html5QrAdminInstance.stop().then(() => { document.getElementById(elementId).style.display = 'none'; callback(txt); }); }).catch((err) => { alert("Camera Error"); document.getElementById(elementId).style.display = 'none'; }); 
        } else { alert("No cameras found."); document.getElementById(elementId).style.display = 'none'; } 
    }).catch(err => { document.getElementById(elementId).style.display = 'none'; }); 
}
function startAdminLoginCamera() { initCameraCore('admin-auth-reader', (txt) => { document.getElementById('admin-badge').value = txt; }); }
function startAdminAssetCamera(readerId, inputId) { initCameraCore(readerId, (txt) => { document.getElementById('add-tool-prefix').style.display = 'none'; document.getElementById(inputId).value = txt; }); }

// ==========================================
// 8. REPORTS
// ==========================================
async function generateCustomReport() {
    const payload = { requester: currentAdminBadge, report_type: document.getElementById('rep-type').value, dept_id: document.getElementById('rep-dept').value, start_date: document.getElementById('rep-start').value || new Date().toISOString().split('T')[0], end_date: document.getElementById('rep-end').value || new Date().toISOString().split('T')[0] };
    try {
        const res = await fetch('/api/reports/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const data = await res.json();
        if (!res.ok) return alert('❌ ' + data.error);
        const thead = document.getElementById('report-thead'); const tbody = document.getElementById('report-tbody');
        if (data.data.length === 0) { tbody.innerHTML = `<tr><td colspan="5" style="text-align: center;">No data found.</td></tr>`; return; }
        
        if (payload.report_type === 'AUDIT') {
            document.getElementById('report-display-title').textContent = `Transaction History (${payload.start_date} to ${payload.end_date})`;
            thead.innerHTML = `<tr><th>Timestamp</th><th>Technician</th><th>Action</th><th>Asset ID</th><th>Notes</th></tr>`;
            tbody.innerHTML = data.data.map(log => { const date = new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); return `<tr><td>${date}</td><td>${log.full_name} (${log.badge_id})</td><td>${log.action}</td><td style="font-family: monospace;">${log.qr_code}</td><td>${log.notes || '--'}</td></tr>`; }).join('');
        } else if (payload.report_type === 'FLAGGED') {
            document.getElementById('report-display-title').textContent = `Flagged Assets Report`;
            thead.innerHTML = `<tr><th>Barcode ID</th><th>Description</th><th>Department</th><th>Status</th><th>Reason</th></tr>`;
            tbody.innerHTML = data.data.map(t => { return `<tr><td style="font-family: monospace;">${t.qr_code}</td><td>${t.tool_name}</td><td>${t.dept_name || '--'}</td><td>${t.status}</td><td>${t.status_reason || '--'}</td></tr>`; }).join('');
        }
    } catch (err) { alert('Failed to pull report.'); }
}

function exportTableToCSV(filename) {
    const table = document.getElementById("generated-report-table"); let csv = [];
    for (let i = 0; i < table.rows.length; i++) { let row = [], cols = table.rows[i].querySelectorAll("td, th"); for (let j = 0; j < cols.length; j++) { row.push('"' + cols[j].innerText.replace(/"/g, '""') + '"'); } csv.push(row.join(",")); }
    const csvFile = new Blob([csv.join("\n")], {type: "text/csv"}); const downloadLink = document.createElement("a"); downloadLink.download = filename; downloadLink.href = window.URL.createObjectURL(csvFile); downloadLink.style.display = "none"; document.body.appendChild(downloadLink); downloadLink.click(); document.body.removeChild(downloadLink);
}

// ==========================================
// 9. UNIVERSAL ENTITY MODAL
// ==========================================
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
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Status</div><div style="font-size:14px;margin-top:4px;font-weight:bold;color:var(--accent);">${entity.status}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Calibration</div><div style="font-size:14px;margin-top:4px;font-weight:bold;">${calText}</div></div>
            </div>
        `;
        if(entity.replacement_url) readHtml += `<div><a href="${entity.replacement_url}" target="_blank" style="color:var(--blue); font-size: 13px; text-decoration: none;">🛒 Open Replacement Link →</a></div>`;

        // The "Edit" View (Hidden by default)
        fieldsHtml = `
            <div class="form-group"><label class="form-label">Asset Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>
            <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="em-input-desc" rows="2">${entity.description || ''}</textarea></div>
            <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
                <div class="form-group"><label class="form-label">Replacement URL</label><input class="form-input" id="em-input-url" value="${entity.replacement_url || ''}"></div>
                <div class="form-group"><label class="form-label">Physical Status</label>
                    <select class="form-select" id="em-input-status">
                        <option value="In" ${entity.status === 'In' ? 'selected' : ''}>In</option>
                        <option value="Out" ${entity.status === 'Out' ? 'selected' : ''}>Out</option>
                        <option value="Missing" ${entity.status === 'Missing' ? 'selected' : ''}>Missing</option>
                        <option value="Broken" ${entity.status === 'Broken' ? 'selected' : ''}>Broken</option>
                        <option value="Worn" ${entity.status === 'Worn' ? 'selected' : ''}>Worn</option>
                    </select>
                </div>
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

function closeEntityModal() { document.getElementById('entity-modal-overlay').style.display = 'none'; }

async function saveEntityUpdates() {
    const type = document.getElementById('em-target-type').value;
    const id = document.getElementById('em-target-id').value;
    const nameVal = document.getElementById('em-input-name').value;
    
    let payload = { requester: currentAdminBadge, name: nameVal };
    let endpoint = '';

    if (type === 'toolbox') { endpoint = `/api/toolboxes/${id}`; }
    else if (type === 'drawer') { endpoint = `/api/drawers/${id}`; }
    else if (type === 'tool') { 
        endpoint = `/api/tools/${id}`; 
        payload.description = document.getElementById('em-input-desc').value;
        payload.replacement_url = document.getElementById('em-input-url').value;
        payload.status = document.getElementById('em-input-status').value;
        payload.is_calibrated = document.getElementById('em-input-is-cal').checked;
        payload.last_cal_date = document.getElementById('em-input-last-cal').value || null;
        payload.cal_due_date = document.getElementById('em-input-cal-due').value || null;
    }

    try {
        const res = await fetch(endpoint, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        if(res.ok) { closeEntityModal(); renderEditableInfraTree(); } 
        else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to save.')); }
    } catch(e) { alert('Network Error.'); }
}

// ==========================================
// 10. IMAGE LIGHTBOX
// ==========================================
function openImageModal(url) {
    document.getElementById('image-modal-content').src = url;
    document.getElementById('image-modal-overlay').style.display = 'flex';
}

function closeImageModal() {
    document.getElementById('image-modal-overlay').style.display = 'none';
    document.getElementById('image-modal-content').src = '';
}