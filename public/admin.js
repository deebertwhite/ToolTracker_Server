// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
let currentAdminBadge = null; 
let html5QrAdminInstance = null;
let uploadTarget = { type: null, id: null }; // Tracks entity type and ID for photo uploads

// ==========================================
// 2. UTILITIES & VIEW TOGGLES
// ==========================================
function getRoleWeight(role) {
    const weights = { 'super_admin': 4, 'dept_admin': 3, 'tool_rep': 2, 'technician': 1 };
    return weights[role] || 0;
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
    document.getElementById('subhub-personnel').style.display = 'block';
    document.getElementById('subhub-infra').style.display = 'block';
    document.getElementById('subhub-assets').style.display = 'block';
}

function openSubPanel(panelId) {
    document.getElementById('subhub-personnel').style.display = 'none';
    document.getElementById('subhub-infra').style.display = 'none';
    document.getElementById('subhub-assets').style.display = 'none';
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    document.getElementById(panelId).style.display = 'block';
}

function closeSubPanel(workspaceId, subhubId) {
    document.querySelectorAll('.sub-panel').forEach(p => p.style.display = 'none');
    document.getElementById(subhubId).style.display = 'block';
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
        const weight = getRoleWeight(data.user.role);

        document.getElementById('auth-wall').style.display = 'none'; 
        document.getElementById('admin-app').style.display = 'block'; 
        document.getElementById('admin-name').textContent = `Logged in as: ${data.user.full_name} (${data.user.role.toUpperCase()})`;
        
        // Hide UI elements based on hierarchy
        if (weight < 2) {
            document.getElementById('hub-assets').style.display = 'none';
            document.getElementById('hub-reports').style.display = 'none';
        }
        if (weight < 4) {
            document.getElementById('card-manage-depts').style.display = 'none';
        }
        if (weight < 3) {
            document.getElementById('card-manage-boxes').style.display = 'none';
            document.getElementById('card-manage-users').style.display = 'none';
        }

        // Initialize Data
        if (weight >= 3) {
            loadUsers(); 
        }
        await syncStorageHierarchyDropdowns(); 
        
        if (weight >= 2) { 
            fetchNextToolId(); 
        } 
        
    } catch (err) { 
        alert('Server connection failure.'); 
    }
}

async function updateMyAccount() {
    const payload = { 
        requester: currentAdminBadge, 
        new_username: document.getElementById('my-new-username').value, 
        new_pin: document.getElementById('my-new-pin').value 
    };
    const res = await fetch('/api/users/me/update', { 
        method: 'PUT', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
    });
    if (res.ok) { 
        alert('✅ Account updated successfully.'); 
        document.getElementById('my-new-username').value = ''; 
        document.getElementById('my-new-pin').value = ''; 
    } else { 
        const err = await res.json(); 
        alert('❌ ' + err.error); 
    }
}

// ==========================================
// 4. PHOTO UPLOAD LOGIC
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
        const res = await fetch('/api/upload', {
            method: 'POST',
            body: formData 
        });

        const data = await res.json();
        if (res.ok) {
            alert('✅ Photo uploaded successfully!');
            // Refresh the appropriate table to render the new image
            if (uploadTarget.type === 'user') {
                loadUsers();
                loadRosterDirectory();
            } else if (uploadTarget.type === 'tool') {
                loadRemovableTools();
                loadInventoryDirectory();
            } else if (uploadTarget.type === 'toolbox' || uploadTarget.type === 'drawer') {
                loadInfraManagementTables();
            }
        } else {
            alert('❌ ' + (data.error || 'Upload failed.'));
        }
    } catch (err) {
        alert('❌ Network error during upload.');
    } finally {
        event.target.value = ''; 
    }
}

// ==========================================
// 5. USER MANAGEMENT
// ==========================================
async function loadUsers() {
    try {
        const response = await fetch(`/api/users?requester=${currentAdminBadge}`); 
        const data = await response.json();
        
        document.getElementById('user-manage-body').innerHTML = data.users.map(u => {
            const avatar = u.photo_url 
                ? `<img src="${u.photo_url}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0;">` 
                : `<div style="width: 40px; height: 40px; border-radius: 50%; background: var(--surface2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0;">👤</div>`;

            return `
                <tr>
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            ${avatar}
                            <div>
                                <strong>${u.full_name}</strong><br>
                                <span style="font-size:11px;color:var(--muted);">${u.email || 'No email'}</span>
                            </div>
                        </div>
                    </td>
                    <td style="font-family: monospace; font-size:12px;">Badge: ${u.badge_id}<br>User: ${u.username || '---'}</td>
                    <td>${u.role.toUpperCase()}</td>
                    <td>
                        <button onclick="triggerPhotoUpload('user', '${u.badge_id}')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-weight:bold;margin-right:10px;">📸 Upload</button>
                        <button onclick="resetUserPin('${u.badge_id}')" style="background:none;border:none;color:var(--blue);cursor:pointer;font-weight:bold;margin-right:10px;">↺ PIN</button>
                        <button onclick="deactivateUser('${u.badge_id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:bold;">✕ Remove</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
    }
}

async function loadRosterDirectory() {
    try {
        const res = await fetch(`/api/roster`); 
        const data = await res.json();
        
        document.getElementById('user-roster-body').innerHTML = data.roster.map(u => {
            const avatar = u.photo_url 
                ? `<img src="${u.photo_url}" style="width: 30px; height: 30px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0;">` 
                : `<div style="width: 30px; height: 30px; border-radius: 50%; background: var(--surface2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">👤</div>`;

            return `
                <tr class="roster-row">
                    <td>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            ${avatar}
                            <strong>${u.full_name}</strong>
                        </div>
                    </td>
                    <td>${u.department_name || '--'}</td>
                    <td>${u.role.toUpperCase()}</td>
                    <td style="font-family: monospace;">${u.badge_id}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
    }
}

function filterRoster() {
    const input = document.getElementById('roster-search').value.toUpperCase();
    const rows = document.querySelectorAll('.roster-row');
    rows.forEach(row => { 
        row.style.display = row.innerText.toUpperCase().includes(input) ? '' : 'none'; 
    });
}

async function addUser() { 
    const payload = { 
        requester: currentAdminBadge, 
        full_name: document.getElementById('new-name').value, 
        email: document.getElementById('new-email').value, 
        dept_id: document.getElementById('new-user-dept').value, 
        role: document.getElementById('new-role').value 
    }; 
    
    if (!payload.full_name || !payload.email) {
        return alert('Name and Email are required.');
    }
    
    const res = await fetch('/api/users', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
    }); 
    
    if (res.ok) { 
        alert('✅ User created. Credentials dispatched via email.'); 
        document.getElementById('new-name').value = ''; 
        document.getElementById('new-email').value = ''; 
        loadUsers(); 
        loadRosterDirectory(); 
    } else { 
        const err = await res.json(); 
        alert('❌ ' + err.error); 
    }
}

async function resetUserPin(id) { 
    if(!confirm(`Generate and email a new PIN for ${id}?`)) return; 
    const res = await fetch(`/api/users/${id}/reset-pin`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ requester: currentAdminBadge }) 
    }); 
    if (res.ok) {
        alert('✅ New PIN dispatched.'); 
    } else {
        alert('❌ Failed to reset PIN.');
    }
}

async function deactivateUser(id) { 
    if(!confirm(`Deactivate ${id}?`)) return; 
    await fetch(`/api/users/${id}/deactivate`, { 
        method: 'PUT', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ requester: currentAdminBadge }) 
    }); 
    loadUsers(); 
    loadRosterDirectory(); 
}

// ==========================================
// 6. INFRASTRUCTURE & STORAGE
// ==========================================
async function renderInfraDirectory() {
    document.getElementById('infra-tree-container').innerHTML = `<div style="text-align: center; color: var(--muted); padding: 20px;">Fetching structural data...</div>`;
    try {
        const [storageRes, toolsRes] = await Promise.all([fetch('/api/storage'), fetch('/api/tools')]);
        const storage = await storageRes.json(); 
        const tools = await toolsRes.json();
        
        let html = '';
        storage.departments.forEach(dept => {
            html += `<div class="card" style="border-left: 4px solid var(--accent); margin-bottom: 15px;">
                        <h4 style="margin-bottom: 10px;">🏢 ${dept.name} <span style="font-weight:normal; color:var(--muted); font-size:13px;">(${dept.prefix_code})</span></h4>`;
            
            const deptBoxes = storage.toolboxes.filter(b => b.dept_id === dept.dept_id);
            if(deptBoxes.length === 0) {
                html += `<div class="tree-item">No storage installed.</div>`;
            }
            
            deptBoxes.forEach(box => {
                const boxTools = tools.tools.filter(t => t.toolbox_name === box.name);
                html += `<div class="tree-node">
                            <strong>🧰 ${box.name}</strong> 
                            <span style="font-size:12px; color:var(--muted); float:right;">${boxTools.length} Total Assets</span>`;
                
                const boxDrawers = storage.drawers.filter(d => d.box_id === box.box_id);
                if(boxDrawers.length > 0) {
                    boxDrawers.forEach(dr => {
                        const drTools = tools.tools.filter(t => t.drawer_name === dr.name && t.toolbox_name === box.name).length;
                        html += `<div class="tree-child">📂 ${dr.name} <span style="font-size:12px; color:var(--muted); float:right;">${drTools} items</span></div>`;
                    });
                }
                html += `</div>`;
            });
            html += `</div>`;
        });
        document.getElementById('infra-tree-container').innerHTML = html;
    } catch (e) { 
        document.getElementById('infra-tree-container').innerHTML = `<div style="color: var(--red); padding: 20px;">Error rendering map.</div>`; 
    }
}

async function submitStructureDept() { 
    await fetch('/api/departments', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ 
            name: document.getElementById('str-dept-name').value, 
            prefix_code: document.getElementById('str-dept-prefix').value, 
            requester: currentAdminBadge 
        }) 
    }); 
    syncStorageHierarchyDropdowns(); 
    alert('✅ Department Established.'); 
    document.getElementById('str-dept-name').value = ''; 
    document.getElementById('str-dept-prefix').value = '';
}

async function submitStructureBox() { 
    await fetch('/api/toolboxes', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ 
            name: document.getElementById('str-box-name').value, 
            dept_id: document.getElementById('str-box-dept-select').value, 
            requester: currentAdminBadge 
        }) 
    }); 
    syncStorageHierarchyDropdowns(); 
    alert('✅ Storage Unit Installed.'); 
    document.getElementById('str-box-name').value = '';
}

async function submitStructureDrawer() { 
    await fetch('/api/drawers', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ 
            name: document.getElementById('str-drawer-name').value, 
            box_id: document.getElementById('str-drawer-box-select').value, 
            requester: currentAdminBadge 
        }) 
    }); 
    syncStorageHierarchyDropdowns(); 
    alert('✅ Drawer Assigned.'); 
    document.getElementById('str-drawer-name').value = '';
}

async function syncStorageHierarchyDropdowns() {
    try {
        const res = await fetch('/api/storage'); 
        const data = await res.json(); 
        if(!data.success) return;
        
        document.getElementById('add-tool-prefix').innerHTML = data.departments.map(d => `<option value="${d.prefix_code}-">${d.prefix_code}</option>`).join('');
        document.getElementById('add-tool-drawer').innerHTML = data.drawers.map(dr => `<option value="${dr.drawer_id}">${dr.name}</option>`).join('');
        document.getElementById('replace-tool-drawer').innerHTML = data.drawers.map(dr => `<option value="${dr.drawer_id}">${dr.name}</option>`).join('');
        document.getElementById('str-box-dept-select').innerHTML = data.departments.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
        document.getElementById('str-drawer-box-select').innerHTML = data.toolboxes.map(b => `<option value="${b.box_id}">${b.name}</option>`).join('');
        document.getElementById('new-user-dept').innerHTML = data.departments.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
        document.getElementById('rep-dept').innerHTML = '<option value="ALL">Global (All Departments)</option>' + data.departments.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
    } catch(e) {
        console.error(e);
    }
}

async function loadInfraManagementTables() {
    try {
        const res = await fetch('/api/storage');
        const data = await res.json();
        
        if (!data.success) return;

        document.getElementById('manage-dept-body').innerHTML = data.departments.map(dept => {
            return `
                <tr>
                    <td style="font-family: monospace; font-weight: bold;">${dept.prefix_code}</td>
                    <td>${dept.name}</td>
                    <td>
                        <button onclick="deleteInfraItem('departments', '${dept.dept_id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-weight:bold;">✕ Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

        document.getElementById('manage-box-body').innerHTML = data.toolboxes.map(box => {
            const parentDept = data.departments.find(d => d.dept_id === box.dept_id);
            const deptName = parentDept ? parentDept.name : 'Unknown';
            
            const thumb = box.photo_url 
                ? `<img src="${box.photo_url}" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0;">` 
                : `<div style="width: 40px; height: 40px; border-radius: 6px; background: var(--surface2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0;">🧰</div>`;
            
            return `
                <tr>
                    <td style="color: var(--muted);">${deptName}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            ${thumb}
                            <strong>${box.name}</strong>
                        </div>
                    </td>
                    <td>
                        <button onclick="triggerPhotoUpload('toolbox', '${box.box_id}')" style="background:none; border:none; color:var(--accent); cursor:pointer; font-weight:bold; margin-right:10px;">📸 Upload</button>
                        <button onclick="deleteInfraItem('toolboxes', '${box.box_id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-weight:bold;">✕ Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

        document.getElementById('manage-drawer-body').innerHTML = data.drawers.map(drawer => {
            const parentBox = data.toolboxes.find(b => b.box_id === drawer.box_id);
            const boxName = parentBox ? parentBox.name : 'Unknown';
            
            const thumb = drawer.photo_url 
                ? `<img src="${drawer.photo_url}" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0;">` 
                : `<div style="width: 40px; height: 40px; border-radius: 6px; background: var(--surface2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0;">📂</div>`;
            
            return `
                <tr>
                    <td style="color: var(--muted);">${boxName}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            ${thumb}
                            <strong>${drawer.name}</strong>
                        </div>
                    </td>
                    <td>
                        <button onclick="triggerPhotoUpload('drawer', '${drawer.drawer_id}')" style="background:none; border:none; color:var(--accent); cursor:pointer; font-weight:bold; margin-right:10px;">📸 Upload</button>
                        <button onclick="deleteInfraItem('drawers', '${drawer.drawer_id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-weight:bold;">✕ Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (err) {
        console.error('Failed to load infrastructure tables:', err);
    }
}

async function deleteInfraItem(type, id) {
    if (!confirm(`Are you sure you want to delete this structure? It will only succeed if it is completely empty.`)) return;

    try {
        const res = await fetch(`/api/${type}/${id}`, { method: 'DELETE' });
        const data = await res.json();

        if (res.ok) {
            alert('✅ Structure successfully deleted.');
            loadInfraManagementTables();
            syncStorageHierarchyDropdowns();
        } else {
            alert('❌ ' + (data.error || 'Failed to delete structure.'));
        }
    } catch (err) {
        alert('❌ Network error while attempting to delete.');
    }
}

// ==========================================
// 7. CAMERA HARDWARE
// ==========================================
function initCameraCore(elementId, callback) { 
    document.getElementById(elementId).style.display = 'block'; 
    if(html5QrAdminInstance) { html5QrAdminInstance.clear(); } 
    
    html5QrAdminInstance = new Html5Qrcode(elementId); 
    Html5Qrcode.getCameras().then(devices => { 
        if (devices && devices.length) { 
            html5QrAdminInstance.start(devices[0].id, { fps: 12, qrbox: 250 }, (txt) => { 
                html5QrAdminInstance.stop().then(() => { 
                    document.getElementById(elementId).style.display = 'none'; 
                    callback(txt); 
                }); 
            }).catch((err) => { 
                alert("Camera Error: " + err); 
                document.getElementById(elementId).style.display = 'none'; 
            }); 
        } else { 
            alert("No cameras found."); 
            document.getElementById(elementId).style.display = 'none'; 
        } 
    }).catch(err => { 
        alert("Permission denied."); 
        document.getElementById(elementId).style.display = 'none'; 
    }); 
}

function startAdminLoginCamera() { 
    initCameraCore('admin-auth-reader', (txt) => { 
        document.getElementById('admin-badge').value = txt; 
    }); 
}

function startAdminAssetCamera(readerId, inputId) { 
    initCameraCore(readerId, (txt) => { 
        document.getElementById('add-tool-prefix').style.display = 'none'; 
        document.getElementById(inputId).value = txt; 
    }); 
}

// ==========================================
// 8. ASSETS & TOOLS
// ==========================================
async function fetchNextToolId() { 
    const prefixDropdown = document.getElementById('add-tool-prefix');
    if (!prefixDropdown || prefixDropdown.style.display === 'none' || !prefixDropdown.value) return;
    
    document.getElementById('add-tool-id').value = 'Generating...';
    try { 
        const res = await fetch(`/api/tools/next-id?prefix=${prefixDropdown.value}`); 
        const data = await res.json(); 
        document.getElementById('add-tool-id').value = data.success ? data.next_sequence : 'Error'; 
    } catch (err) { 
        document.getElementById('add-tool-id').value = 'Error'; 
    } 
}

async function loadRemovableTools() {
    try {
        const res = await fetch('/api/tools'); 
        const data = await res.json();
        
        document.getElementById('tools-removable-body').innerHTML = data.tools.filter(t => t.status === 'In' || t.status === 'Out').map(t => `
            <tr>
                <td style="font-family: monospace;">${t.qr_code}</td>
                <td><strong>${t.name}</strong></td>
                <td>${t.toolbox_name || '--'} / ${t.drawer_name || '--'}</td>
                <td>${t.status}</td>
                <td>
                    <button onclick="triggerPhotoUpload('tool', '${t.qr_code}')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-weight:bold;margin-right:10px;">📸 Upload</button>
                    <button onclick="removeToolPermanent('${t.tool_id}', '${t.qr_code}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:bold;">✕ Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error(err);
    }
}

async function removeToolPermanent(tool_id, qr_code) {
    if(!confirm(`WARNING: Permanently delete ${qr_code}? This will erase its history and free the ID for immediate reuse.`)) return;
    const res = await fetch(`/api/tools/${tool_id}`, { 
        method: 'DELETE', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ requester: currentAdminBadge }) 
    });
    if (res.ok) { 
        alert('✅ Tool removed and ID freed.'); 
        loadRemovableTools(); 
        fetchNextToolId(); 
        loadInventoryDirectory(); 
    } else {
        alert('❌ Failed to delete tool.');
    }
}

async function loadBrokenTools() {
    try {
        const res = await fetch('/api/tools'); 
        const data = await res.json(); 
        const dropdown = document.getElementById('replace-target-id'); 
        dropdown.innerHTML = '<option value="">-- Select a flagged tool --</option>';
        data.tools.forEach(t => { 
            if (['Broken','Missing','Worn'].includes(t.status)) {
                dropdown.innerHTML += `<option value="${t.tool_id}" data-qr="${t.qr_code}">[${t.qr_code}] ${t.name} - ${t.status}</option>`; 
            }
        });
    } catch (err) {
        console.error(err);
    }
}

function handleReplacementSelection() { 
    const opt = document.getElementById('replace-target-id').options[document.getElementById('replace-target-id').selectedIndex]; 
    document.getElementById('replace-tool-id').value = opt.value ? opt.dataset.qr : ''; 
}

async function addNewTool() {
    const payload = { 
        requester: currentAdminBadge, 
        name: document.getElementById('add-tool-name').value, 
        qr_code: document.getElementById('add-tool-prefix').style.display !== 'none' ? document.getElementById('add-tool-prefix').value + document.getElementById('add-tool-id').value : document.getElementById('add-tool-id').value, 
        drawer_id: document.getElementById('add-tool-drawer').value,
        is_calibrated: document.getElementById('add-tool-is-cal').checked,
        last_cal_date: document.getElementById('add-tool-last-cal').value || null,
        cal_due_date: document.getElementById('add-tool-cal-due').value || null
    };
    
    if (!payload.name || !payload.qr_code) {
        return alert('Description and ID required.');
    }
    if (payload.is_calibrated && !payload.cal_due_date) {
        return alert('Calibration Due Date is required for calibrated assets.');
    }
    
    const res = await fetch('/api/tools', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
    });
    
    if (res.ok) { 
        alert(`✅ Asset saved: ${payload.qr_code}`); 
        document.getElementById('add-tool-name').value = ''; 
        document.getElementById('add-tool-is-cal').checked = false;
        document.getElementById('add-tool-cal-fields').style.display = 'none';
        document.getElementById('add-tool-last-cal').value = '';
        document.getElementById('add-tool-cal-due').value = '';
        document.getElementById('add-tool-prefix').style.display = 'inline-block';
        fetchNextToolId(); 
        loadRemovableTools(); 
    }
}

async function replaceTool() {
    const targetDropdown = document.getElementById('replace-target-id');
    if (!targetDropdown.value) {
        return alert('Please select a tool to retire.');
    }
    
    const payload = { 
        requester: currentAdminBadge, 
        name: document.getElementById('replace-tool-name').value, 
        qr_code: document.getElementById('replace-tool-id').value, 
        drawer_id: document.getElementById('replace-tool-drawer').value, 
        replaced_tool_id: targetDropdown.value 
    };
    
    if (!payload.name) {
        return alert('Description required.');
    }
    const res = await fetch('/api/tools', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
    });
    
    if (res.ok) { 
        alert(`✅ Tool replaced. ID ${payload.qr_code} successfully reserved for the new item.`); 
        document.getElementById('replace-tool-name').value = ''; 
        loadBrokenTools(); 
    }
}

async function loadInventoryDirectory() {
    try {
        const res = await fetch('/api/tools'); 
        const data = await res.json();
        
        document.getElementById('inventory-directory-body').innerHTML = data.tools.map(t => {
            const thumb = t.photo_url 
                ? `<img src="${t.photo_url}" style="width: 40px; height: 40px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0;">` 
                : `<div style="width: 40px; height: 40px; border-radius: 6px; background: var(--surface2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0;">🔧</div>`;

            return `
                <tr class="inv-row">
                    <td style="font-family: monospace; vertical-align: middle;">${t.qr_code}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            ${thumb}
                            <strong>${t.name}</strong>
                        </div>
                    </td>
                    <td style="vertical-align: middle;">${t.toolbox_name || '--'} / ${t.drawer_name || '--'}</td>
                    <td style="color: ${t.status === 'In' ? 'var(--green)' : (t.status === 'Out' ? 'var(--accent)' : 'var(--red)')}; font-weight: bold; vertical-align: middle;">${t.status}</td>
                    <td style="font-size: 11px; color: var(--muted); vertical-align: middle;">${t.status_reason || '--'}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
    }
}

function filterInventory() {
    const input = document.getElementById('inventory-search').value.toUpperCase(); 
    const rows = document.querySelectorAll('.inv-row');
    rows.forEach(row => { 
        row.style.display = row.innerText.toUpperCase().includes(input) ? '' : 'none'; 
    });
}

// ==========================================
// 9. REPORTS
// ==========================================
async function generateCustomReport() {
    const payload = { 
        requester: currentAdminBadge, 
        report_type: document.getElementById('rep-type').value, 
        dept_id: document.getElementById('rep-dept').value, 
        start_date: document.getElementById('rep-start').value || new Date().toISOString().split('T')[0], 
        end_date: document.getElementById('rep-end').value || new Date().toISOString().split('T')[0] 
    };
    try {
        const res = await fetch('/api/reports/generate', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        }); 
        const data = await res.json();
        
        if (!res.ok) {
            return alert('❌ ' + data.error);
        }
        
        const thead = document.getElementById('report-thead'); 
        const tbody = document.getElementById('report-tbody');
        
        if (data.data.length === 0) { 
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center;">No data found for this query.</td></tr>`; 
            return; 
        }
        
        if (payload.report_type === 'AUDIT') {
            document.getElementById('report-display-title').textContent = `Transaction History (${payload.start_date} to ${payload.end_date})`;
            thead.innerHTML = `<tr><th>Timestamp</th><th>Technician</th><th>Action</th><th>Asset ID</th><th>Notes</th></tr>`;
            tbody.innerHTML = data.data.map(log => { 
                const date = new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); 
                return `<tr><td>${date}</td><td>${log.full_name} (${log.badge_id})</td><td>${log.action}</td><td style="font-family: monospace;">${log.qr_code}</td><td>${log.notes || '--'}</td></tr>`; 
            }).join('');
        } else if (payload.report_type === 'FLAGGED') {
            document.getElementById('report-display-title').textContent = `Flagged Assets Report`;
            thead.innerHTML = `<tr><th>Barcode ID</th><th>Description</th><th>Department</th><th>Status</th><th>Reason</th></tr>`;
            tbody.innerHTML = data.data.map(t => {
                return `<tr><td style="font-family: monospace;">${t.qr_code}</td><td>${t.tool_name}</td><td>${t.dept_name || '--'}</td><td>${t.status}</td><td>${t.status_reason || '--'}</td></tr>`;
            }).join('');
        }
    } catch (err) { 
        alert('Failed to pull report.'); 
    }
}

function exportTableToCSV(filename) {
    const table = document.getElementById("generated-report-table"); 
    let csv = [];
    for (let i = 0; i < table.rows.length; i++) { 
        let row = [], cols = table.rows[i].querySelectorAll("td, th"); 
        for (let j = 0; j < cols.length; j++) { 
            row.push('"' + cols[j].innerText.replace(/"/g, '""') + '"'); 
        } 
        csv.push(row.join(",")); 
    }
    const csvFile = new Blob([csv.join("\n")], {type: "text/csv"}); 
    const downloadLink = document.createElement("a"); 
    downloadLink.download = filename; 
    downloadLink.href = window.URL.createObjectURL(csvFile); 
    downloadLink.style.display = "none"; 
    document.body.appendChild(downloadLink); 
    downloadLink.click(); 
    document.body.removeChild(downloadLink);
}