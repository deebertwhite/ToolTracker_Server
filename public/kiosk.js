// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
let activeUser = null; 
let pendingMode = null; // 'OUT', 'IN', 'REPORT', or 'AUDIT'
let batchQueue = []; 
let html5QrScannerInstance = null;

// Specific Audit State Variables
let auditTools = [];
let auditBoxName = '';

// ==========================================
// 2. WORKFLOW NAVIGATION
// ==========================================
function startWorkflow(mode) {
    pendingMode = mode;
    const authIcon = document.getElementById('auth-header-icon'); 
    const authTitle = document.getElementById('auth-header-title');
    
    if (mode === 'OUT') { 
        authIcon.textContent = '📤'; 
        authTitle.textContent = 'Check Out'; 
    } else if (mode === 'IN') { 
        authIcon.textContent = '📥'; 
        authTitle.textContent = 'Check In'; 
    } else if (mode === 'REPORT') { 
        authIcon.textContent = '⚠️'; 
        authTitle.textContent = 'Issue Report'; 
    } else if (mode === 'AUDIT') { 
        authIcon.textContent = '📋'; 
        authTitle.textContent = 'Toolbox Audit'; 
    }
    
    document.getElementById('screen-idle').style.display = 'none'; 
    document.getElementById('screen-auth').style.display = 'flex'; 
    document.getElementById('auth-badge-input').focus();
}

function resetToIdle() { 
    killActiveCamera(); 
    activeUser = null; 
    pendingMode = null; 
    batchQueue = []; 
    auditTools = []; 
    
    document.getElementById('auth-badge-input').value = ''; 
    document.getElementById('screen-action').style.display = 'none'; 
    document.getElementById('screen-auth').style.display = 'none'; 
    document.getElementById('screen-idle').style.display = 'flex'; 
}

// ==========================================
// 3. AUTHENTICATION LOGIC
// ==========================================
async function authenticateUser() {
    const loginId = document.getElementById('auth-badge-input').value.trim();
    
    if (!loginId) {
        return showToast('⚠️ Identifier is required.');
    }
    
    try {
        const response = await fetch('/api/kiosk-auth', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ login_id: loginId }) 
        });
        const data = await response.json();
        
        if (!response.ok) {
            return showToast('❌ ' + (data.error || 'Identity not recognized.'));
        }

        activeUser = { 
            badgeId: data.user.badge_id, 
            name: data.user.full_name, 
            initials: data.user.full_name.split(' ').map(n => n[0]).join('') 
        };
        
        if (data.user.photo_url) {
            document.getElementById('user-avatar').innerHTML = `<img src="${data.user.photo_url}" />`;
        } else {
            document.getElementById('user-avatar').textContent = activeUser.initials; 
        }

        document.getElementById('user-name').textContent = activeUser.name;
        document.getElementById('auth-badge-input').value = '';
        
        document.getElementById('screen-auth').style.display = 'none'; 
        document.getElementById('screen-action').style.display = 'flex';
        
        setupActionScreen();
    } catch (err) { 
        showToast('❌ Server error.'); 
    }
}

function setupActionScreen() {
    batchQueue = []; 
    auditTools = []; 
    renderQueue();
    
    document.getElementById('panel-scanner').style.display = 'none';
    document.getElementById('panel-report').style.display = 'none';
    document.getElementById('panel-audit').style.display = 'none';

    if (pendingMode === 'REPORT') { 
        document.getElementById('panel-report').style.display = 'block'; 
        document.getElementById('report-qr').focus(); 
    } else if (pendingMode === 'AUDIT') {
        document.getElementById('panel-audit').style.display = 'block';
        document.getElementById('audit-step-1').style.display = 'block';
        document.getElementById('audit-step-2').style.display = 'none';
        loadAuditDropdown();
    } else {
        document.getElementById('panel-scanner').style.display = 'block'; 
        document.getElementById('action-title').textContent = pendingMode === 'OUT' ? '📤 Scan Tools for Checkout' : '📥 Scan Tools for Check-in';
        document.getElementById('btn-submit-action').textContent = pendingMode === 'OUT' ? '✓ Complete Checkout' : '✓ Complete Check-in';
        focusScanInput('kiosk-scan-input');
    }
}

// ==========================================
// 4. SCANNING (IN/OUT)
// ==========================================
function focusScanInput(inputId) {
    const input = document.getElementById(inputId);
    if(input && document.getElementById('screen-action').style.display === 'flex') {
        input.focus(); 
    }
}

function handleToolScan() {
    const input = document.getElementById('kiosk-scan-input');
    const qr = input.value.trim().toUpperCase();
    
    if (!qr) return;
    
    if (batchQueue.includes(qr)) { 
        showToast('⚠️ Already in queue.'); 
        input.value = ''; 
        return; 
    }
    
    batchQueue.push(qr); 
    renderQueue(); 
    input.value = ''; 
    showToast(`➕ Added: ${qr}`);
}

function renderQueue() {
    document.getElementById('queue-count').textContent = batchQueue.length;
    document.getElementById('queue-list').innerHTML = batchQueue.map((qr, index) => `
        <div class="batch-item">
            <div>🔧 <strong>${qr}</strong></div>
            <div style="color:var(--red);cursor:pointer;font-weight:bold;font-size:16px;padding:0 10px;" onclick="removeItem(${index})">✕</div>
        </div>
    `).join('');
}

function removeItem(index) { 
    batchQueue.splice(index, 1); 
    renderQueue(); 
}

// ==========================================
// 5. AUDIT WORKFLOW
// ==========================================
async function loadAuditDropdown() {
    try {
        const res = await fetch('/api/storage');
        const data = await res.json();
        document.getElementById('audit-box-select').innerHTML = '<option value="">-- Select a Toolbox --</option>' + data.toolboxes.map(b => `<option value="${b.name}">${b.name}</option>`).join('');
    } catch (e) { 
        showToast("❌ Failed to load storage infrastructure."); 
    }
}

async function startAudit() {
    const select = document.getElementById('audit-box-select');
    if (!select.value) {
        return showToast("⚠️ Select a toolbox.");
    }
    
    auditBoxName = select.value;
    document.getElementById('audit-box-title').textContent = auditBoxName;

    try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        
        const filtered = data.tools.filter(t => t.toolbox_name === auditBoxName && t.status !== 'Retired');
        
        if (filtered.length === 0) {
            return showToast("⚠️ No tools assigned to this box.");
        }

        auditTools = filtered.map(t => ({ 
            ...t, 
            audit_status: 'Pending', 
            audit_notes: '' 
        }));
        
        document.getElementById('audit-step-1').style.display = 'none';
        document.getElementById('audit-step-2').style.display = 'block';
        
        renderAuditList();
        focusScanInput('audit-scan-input');
    } catch (err) { 
        showToast("❌ Failed to pull manifest."); 
    }
}

function renderAuditList() {
    const scannedCount = auditTools.filter(t => t.audit_status === 'Present').length;
    const progressEl = document.getElementById('audit-progress');
    
    progressEl.textContent = `${scannedCount} / ${auditTools.length} Scanned`;
    
    if (scannedCount === auditTools.length) {
        progressEl.style.background = 'rgba(34, 197, 94, 0.2)';
        progressEl.style.color = 'var(--green)';
    } else {
        progressEl.style.background = 'rgba(203, 96, 21, 0.1)';
        progressEl.style.color = 'var(--accent)';
    }

    document.getElementById('audit-tool-list').innerHTML = auditTools.map((t, index) => {
        let borderCol = 'transparent';
        if (t.audit_status === 'Present') borderCol = 'var(--green)';
        if (t.audit_status === 'Missing') borderCol = 'var(--red)';
        if (t.audit_status === 'Broken') borderCol = 'var(--orange)';

        return `
        <tr style="border-left: 3px solid ${borderCol}; background: ${t.audit_status !== 'Pending' ? 'rgba(255,255,255,0.02)' : 'transparent'};">
            <td style="font-family: monospace;">${t.qr_code}</td>
            <td>
                <strong>${t.name}</strong><br>
                <span style="font-size:11px;color:var(--muted);">${t.drawer_name || '--'}</span>
            </td>
            <td>
                <select onchange="updateAuditItem('${t.qr_code}', 'audit_status', this.value)" class="form-select" style="padding: 6px; font-size: 13px;">
                    <option value="Pending" ${t.audit_status === 'Pending' ? 'selected' : ''}>Pending</option>
                    <option value="Present" ${t.audit_status === 'Present' ? 'selected' : ''}>Present</option>
                    <option value="Missing" ${t.audit_status === 'Missing' ? 'selected' : ''}>Missing</option>
                    <option value="Broken" ${t.audit_status === 'Broken' ? 'selected' : ''}>Broken</option>
                </select>
            </td>
            <td>
                <input class="form-input" style="padding: 6px; font-size: 13px;" placeholder="Notes..." value="${t.audit_notes}" onchange="updateAuditItem('${t.qr_code}', 'audit_notes', this.value)">
            </td>
        </tr>
        `;
    }).join('');
}

function handleAuditScan() {
    const input = document.getElementById('audit-scan-input');
    const qr = input.value.trim().toUpperCase();
    
    if (!qr) return;

    const toolIndex = auditTools.findIndex(t => t.qr_code === qr);
    
    if (toolIndex === -1) {
        showToast("⚠️ Tool doesn't belong in this box.");
    } else {
        auditTools[toolIndex].audit_status = 'Present';
        renderAuditList();
        showToast(`✅ Checked off: ${qr}`);
    }
    
    input.value = '';
}

function updateAuditItem(qr, field, value) {
    const idx = auditTools.findIndex(t => t.qr_code === qr);
    if (idx !== -1) {
        auditTools[idx][field] = value;
        renderAuditList();
    }
}

async function submitAudit() {
    const pendingCount = auditTools.filter(t => t.audit_status === 'Pending').length;
    
    if (pendingCount > 0) {
        const confirmMissing = confirm(`You have ${pendingCount} tools still pending. Auto-mark them as Missing?`);
        if (!confirmMissing) return; 
        
        auditTools.forEach(t => { 
            if (t.audit_status === 'Pending') t.audit_status = 'Missing'; 
        });
    }

    try {
        const res = await fetch('/api/audits/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                badge_id: activeUser.badgeId,
                box_id: auditBoxName,
                results: auditTools
            })
        });

        if (!res.ok) {
            return showToast("❌ Failed to log audit.");
        }
        
        showToast("✅ Audit complete and verified.");
        setTimeout(resetToIdle, 1500);
    } catch (e) {
        showToast("❌ Connection error.");
    }
}

// ==========================================
// 6. CAMERA HARDWARE CONTROLS
// ==========================================
function killActiveCamera() {
    if (html5QrScannerInstance && html5QrScannerInstance.isScanning) {
        html5QrScannerInstance.stop().then(() => { 
            document.getElementById('reader').style.display = 'none'; 
            document.getElementById('auth-reader').style.display = 'none'; 
            document.getElementById('report-reader').style.display = 'none'; 
            document.getElementById('audit-reader').style.display = 'none'; 
        }).catch(e => { console.error("Error stopping camera", e); });
    }
}

function executeCameraScan(elementId, successCallback) {
    document.getElementById(elementId).style.display = 'block';
    
    if(html5QrScannerInstance) { html5QrScannerInstance.clear(); }
    html5QrScannerInstance = new Html5Qrcode(elementId);
    
    Html5Qrcode.getCameras().then(devices => {
        if (devices && devices.length) {
            html5QrScannerInstance.start(devices[0].id, { fps: 14, qrbox: { width: 260, height: 260 } }, (text) => {
                html5QrScannerInstance.stop().then(() => { 
                    document.getElementById(elementId).style.display = 'none'; 
                    successCallback(text); 
                });
            }).catch(err => { 
                showToast('❌ Camera Error'); 
                document.getElementById(elementId).style.display = 'none'; 
            });
        } else { 
            showToast("⚠️ No cameras found."); 
            document.getElementById(elementId).style.display = 'none'; 
        }
    }).catch(err => { 
        showToast("❌ Camera permission denied."); 
        document.getElementById(elementId).style.display = 'none'; 
    });
}

function startAuthCameraScanner() { 
    executeCameraScan('auth-reader', (txt) => { 
        document.getElementById('auth-badge-input').value = txt; 
        authenticateUser(); 
    }); 
}

function startToolCameraScanner(readerId, inputId, triggerFunc = null) { 
    executeCameraScan(readerId, (txt) => { 
        document.getElementById(inputId).value = txt; 
        if (triggerFunc) triggerFunc(); 
    }); 
}

// ==========================================
// 7. GENERAL API ACTIONS (Transactions & Errors)
// ==========================================
async function submitTransaction(managerPin = null) {
    if (batchQueue.length === 0) return showToast('⚠️ Queue empty.');
    
    // Lock the button to prevent double-clicks
    const submitBtn = document.getElementById('btn-submit-action');
    if(submitBtn) { submitBtn.textContent = 'Processing...'; submitBtn.disabled = true; }
    
    try {
        const response = await fetch('/api/transactions', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                badge_id: activeUser.badgeId, 
                action: pendingMode === 'OUT' ? 'CHECKOUT_TOOL' : 'CHECKIN_TOOL', 
                qr_codes: batchQueue,
                manager_pin: managerPin
            }) 
        });
        
        const data = await response.json();

        if (!response.ok) {
            // Restore button
            if(submitBtn) { submitBtn.textContent = pendingMode === 'OUT' ? '✓ Complete Checkout' : '✓ Complete Check-in'; submitBtn.disabled = false; }
            
            // Handle Custom Hard-Stops
            if (data.code === 'CAL_EXPIRED') {
                return showToast('🛑 ' + data.error);
            } 
            else if (data.code === 'DEPT_RESTRICTED') {
                document.getElementById('override-pin-input').value = '';
                document.getElementById('override-modal').style.display = 'flex';
                document.getElementById('override-pin-input').focus();
                return;
            } 
            else if (data.code === 'BAD_PIN') {
                return showToast('❌ Invalid Manager PIN.');
            }
            return showToast('❌ ' + (data.error || 'Transaction failed.'));
        }
        
        document.getElementById('override-modal').style.display = 'none';
        showToast(`✅ Successfully processed ${batchQueue.length} assets.`); 
        setTimeout(resetToIdle, 1500);
    } catch (err) { 
        if(submitBtn) { submitBtn.textContent = 'Error'; submitBtn.disabled = false; }
        showToast('❌ Connection error.'); 
    }
}

function submitTransactionWithOverride() {
    const pin = document.getElementById('override-pin-input').value.trim();
    if (!pin) return showToast('⚠️ PIN is required.');
    submitTransaction(pin); // Re-run the exact same transaction, but pass the PIN this time
}

// ==========================================
// 8. UTILITIES
// ==========================================
function showToast(msg) { 
    const el = document.getElementById('kiosk-toast'); 
    el.textContent = msg; 
    el.style.display = 'block'; 
    setTimeout(() => { el.style.display = 'none'; }, 3500); 
}

// Auto-refocus logic
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('kiosk-scan-input').addEventListener('blur', () => { 
        setTimeout(() => focusScanInput('kiosk-scan-input'), 200); 
    });
    
    document.getElementById('audit-scan-input').addEventListener('blur', () => { 
        setTimeout(() => focusScanInput('audit-scan-input'), 200); 
    });
});