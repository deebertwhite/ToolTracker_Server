// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
let activeUser = null;
let pendingMode = null; // 'OUT', 'IN', 'REPORT', 'AUDIT', or 'TRANSFERS'
let batchQueue = [];
let html5QrScannerInstance = null;

// Specific Audit State Variables
let auditTools = []; // tools currently 'In' this box -- what the attestation actually confirms
let auditExcludedCount = 0; // tools in this box left out of auditTools (Out, or already Missing/Broken/Worn) -- shown as an informational note, never touched
let auditBoxName = '';
// Set by jumpToAuditFromGate() when the audit workflow was entered via the
// AUDIT_REQUIRED gate (mid-checkout); checked/cleared at the end of
// submitAudit()'s success path so the tech is returned to their
// still-populated checkout batch instead of the idle screen.
let auditGateReturnPending = false;

// ==========================================
// 2. WORKFLOW NAVIGATION
// ==========================================
/**
 * Entry point for each of the 5 idle-screen action buttons.
 * Stores the chosen mode ('OUT' | 'IN' | 'REPORT' | 'AUDIT' | 'TRANSFERS') in
 * pendingMode, updates the auth screen's icon/title to match, and
 * transitions from #screen-idle to #screen-auth.
 */
function startWorkflow(mode) {
    pendingMode = mode;
    const authIcon = document.getElementById('auth-header-icon');
    const authTitle = document.getElementById('auth-header-title');

    if (mode === 'OUT') {
        authIcon.innerHTML = icon('upload');
        authTitle.textContent = 'Check Out';
    } else if (mode === 'IN') {
        authIcon.innerHTML = icon('download');
        authTitle.textContent = 'Check In';
    } else if (mode === 'REPORT') {
        authIcon.innerHTML = icon('triangle-alert', 'icon-warning');
        authTitle.textContent = 'Issue Report';
    } else if (mode === 'AUDIT') {
        authIcon.innerHTML = icon('clipboard-list');
        authTitle.textContent = 'Toolbox Audit';
    } else if (mode === 'TRANSFERS') {
        authIcon.innerHTML = icon('repeat');
        authTitle.textContent = 'Transfers';
    }

    document.getElementById('screen-idle').style.display = 'none';
    document.getElementById('screen-auth').style.display = 'flex';
    document.getElementById('auth-badge-input').focus();
}

/**
 * Tears down any in-progress workflow (stops the camera, clears
 * user/mode/queue/audit state) and returns the UI to #screen-idle.
 * Used by both the "Cancel" buttons and post-submit success paths.
 */
function resetToIdle() {
    killActiveCamera();
    activeUser = null;
    pendingMode = null;
    batchQueue = [];
    auditTools = [];
    auditExcludedCount = 0;
    auditGateReturnPending = false;

    document.getElementById('auth-badge-input').value = '';
    document.getElementById('auth-pin-input').value = '';
    document.getElementById('screen-action').style.display = 'none';
    document.getElementById('screen-auth').style.display = 'none';
    document.getElementById('screen-idle').style.display = 'flex';
    document.getElementById('kiosk-audit-banner').style.display = 'none';
    loadIdleAuditStatus(); // catches an audit just completed during the session that's ending
}

// ==========================================
// 3. AUTHENTICATION LOGIC
// ==========================================
/**
 * Validates the badge/username and PIN typed or scanned into
 * #auth-badge-input / #auth-pin-input against POST /api/kiosk-auth. On
 * success, populates activeUser (including the entered pin, so later
 * actions in this same kiosk session can resubmit it without
 * re-prompting) and the topbar avatar/name, then swaps #screen-auth for
 * #screen-action and calls setupActionScreen().
 */
async function authenticateUser() {
    const loginId = document.getElementById('auth-badge-input').value.trim();
    const pin = document.getElementById('auth-pin-input').value.trim();

    if (!loginId) {
        return showToast(`${icon('triangle-alert', 'icon-warning')} Identifier is required.`);
    }
    if (!pin) {
        return showToast(`${icon('triangle-alert', 'icon-warning')} PIN is required.`);
    }

    try {
        const response = await fetch('/api/kiosk-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login_id: loginId, pin: pin })
        });
        const data = await response.json();

        if (!response.ok) {
            return showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Identity not recognized.'));
        }

        activeUser = {
            badgeId: data.user.badge_id,
            name: data.user.full_name,
            initials: data.user.full_name.split(' ').map(n => n[0]).join(''),
            pin: pin,
            deptId: data.user.dept_id,
            role: data.user.role,
            grantedDeptIds: data.user.granted_dept_ids || []
        };

        if (data.user.photo_url) {
            document.getElementById('user-avatar').innerHTML = `<img src="${data.user.photo_url}" />`;
        } else {
            document.getElementById('user-avatar').textContent = activeUser.initials;
        }

        document.getElementById('user-name').textContent = activeUser.name;
        document.getElementById('auth-badge-input').value = '';
        document.getElementById('auth-pin-input').value = '';

        document.getElementById('screen-auth').style.display = 'none';
        document.getElementById('screen-action').style.display = 'flex';

        setupActionScreen();
        loadKioskAuditStatus();
    } catch (err) {
        showToast(`${icon('circle-x', 'icon-danger')} Server error.`);
    }
}

/**
 * Populates #kiosk-audit-banner with the current shift's audit-gate status for the
 * logged-in tech's own home department (activeUser.deptId), fetched from the same
 * GET /api/audits/today-status endpoint the admin panel already uses. This is a
 * heads-up shown right after login, before any scanning starts -- the actual
 * enforcement is unchanged and still happens server-side at checkout (AUDIT_REQUIRED).
 * Hidden entirely for a badge with no resolvable department (e.g. an admin account).
 */
async function loadKioskAuditStatus() {
    const banner = document.getElementById('kiosk-audit-banner');
    if (!activeUser.deptId) { banner.style.display = 'none'; return; }

    try {
        const res = await fetch('/api/audits/today-status');
        const data = await res.json();
        const dept = data.departments && data.departments.find(d => d.dept_id === activeUser.deptId);
        if (!dept) { banner.style.display = 'none'; return; }

        banner.style.display = 'block';
        if (dept.audit_completed) {
            banner.style.color = 'var(--green)';
            banner.innerHTML = `${icon('circle-check')} ${dept.name} audited this shift`;
        } else {
            banner.style.color = 'var(--red)';
            banner.innerHTML = `${icon('triangle-alert')} ${dept.name} audit pending this shift`;
        }
    } catch (err) {
        banner.style.display = 'none';
    }
}

/**
 * Populates #idle-audit-status on the idle screen (#screen-idle) with the current shift
 * audit window and one pass/fail chip per department -- visible to anyone walking up to
 * the kiosk, before logging in, unlike #kiosk-audit-banner above (which only shows the
 * logged-in tech's own department, after auth). Called once on page load and re-run
 * periodically (see the setInterval near the bottom of this file) since the idle screen
 * is often left on-screen unattended for a long time.
 */
async function loadIdleAuditStatus() {
    const windowEl = document.getElementById('idle-audit-window');
    const chipsEl = document.getElementById('idle-audit-chips');
    if (!windowEl || !chipsEl) return;

    try {
        const res = await fetch('/api/audits/today-status');
        const data = await res.json();
        if (!data.success) throw new Error('failed');

        const windowStart = new Date(data.window_start);
        const isMorning = windowStart.getHours() === 4;
        windowEl.textContent = `${isMorning ? 'Morning' : 'Afternoon'} audit window (since ${windowStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;

        // Same flat-background chip convention as loadAuditStatus() in admin.js, plus an
        // icon since this is meant to be glanceable from a few steps away on the kiosk.
        chipsEl.innerHTML = data.departments.map(d => {
            const color = d.audit_completed ? 'var(--muted)' : 'var(--red)';
            const label = d.audit_completed ? `${icon('circle-check')} ${d.name}` : `${icon('triangle-alert')} ${d.name}`;
            return `<span style="font-size:12px; font-weight:bold; padding:5px 12px; border-radius:14px; background: rgba(255,255,255,0.05); color: ${color};">${label}</span>`;
        }).join('');
    } catch (err) {
        windowEl.textContent = '';
        chipsEl.innerHTML = '';
    }
}

/**
 * Resets per-session batch/audit state and shows the correct
 * sub-panel (#panel-scanner, #panel-report, #panel-audit, or
 * #panel-transfers) for the current pendingMode, wiring up
 * mode-specific labels and kicking off dropdown loading when needed.
 */
function setupActionScreen() {
    batchQueue = [];
    auditTools = [];
    auditExcludedCount = 0;
    renderQueue();

    document.getElementById('panel-scanner').style.display = 'none';
    document.getElementById('panel-report').style.display = 'none';
    document.getElementById('panel-audit').style.display = 'none';
    document.getElementById('panel-transfers').style.display = 'none';

    if (pendingMode === 'REPORT') {
        document.getElementById('panel-report').style.display = 'block';
        document.getElementById('report-qr').focus();
        toggleReportQaDeptVisibility();
        loadReportQaDeptDropdown();
    } else if (pendingMode === 'AUDIT') {
        document.getElementById('panel-audit').style.display = 'block';
        document.getElementById('audit-step-1').style.display = 'block';
        document.getElementById('audit-step-2').style.display = 'none';
        loadAuditDropdown();
    } else if (pendingMode === 'TRANSFERS') {
        document.getElementById('panel-transfers').style.display = 'block';
        loadTransferQueue();
    } else {
        document.getElementById('panel-scanner').style.display = 'block';
        document.getElementById('action-title').innerHTML = pendingMode === 'OUT' ? `${icon('upload')} Scan Tools for Checkout` : `${icon('download')} Scan Tools for Check-in`;
        document.getElementById('btn-submit-action').textContent = pendingMode === 'OUT' ? '✓ Complete Checkout' : '✓ Complete Check-in';
        document.getElementById('kiosk-work-order-group').style.display = pendingMode === 'OUT' ? 'block' : 'none';
        document.getElementById('kiosk-work-order').value = '';
        focusScanInput('kiosk-scan-input');
    }
}

// ==========================================
// 4. SCANNING (IN/OUT)
// ==========================================
/** True while #override-modal or #audit-gate-modal is open on top of #screen-action. */
function isAnyKioskModalOpen() {
    const overrideModal = document.getElementById('override-modal');
    const auditGateModal = document.getElementById('audit-gate-modal');
    const calCompleteModal = document.getElementById('cal-complete-modal');
    return (overrideModal && overrideModal.style.display === 'flex') ||
           (auditGateModal && auditGateModal.style.display === 'flex') ||
           (calCompleteModal && calCompleteModal.style.display === 'flex');
}

/**
 * Focuses the given scan input, but only while #screen-action is actually visible (guards
 * against stealing focus after navigating away) and no modal is currently open on top of it
 * -- without that second check, the auto-refocus blur listener below would yank focus back
 * to the scan input the instant an operator clicked into the Buddy Sign-Off PIN field (its
 * own focus blurs the scan input, which re-triggers this function 200ms later), making the
 * PIN field appear to "immediately unclick" itself. Used both directly (scan-box click) and
 * by the auto-refocus blur listener set up on DOMContentLoaded.
 */
function focusScanInput(inputId) {
    const input = document.getElementById(inputId);
    if (input && document.getElementById('screen-action').style.display === 'flex' && !isAnyKioskModalOpen()) {
        input.focus();
    }
}

/**
 * Reads #kiosk-scan-input, normalizes it, and (if not already
 * queued) appends it to batchQueue for the checkout/check-in batch
 * being built, then re-renders the queue list.
 */
function handleToolScan() {
    const input = document.getElementById('kiosk-scan-input');
    const qr = input.value.trim().toUpperCase();
    
    if (!qr) return;
    
    if (batchQueue.includes(qr)) { 
        showToast(`${icon('triangle-alert', 'icon-warning')} Already in queue.`); 
        input.value = ''; 
        return; 
    }
    
    batchQueue.push(qr); 
    renderQueue(); 
    input.value = ''; 
    showToast(`${icon('plus')} Added: ${qr}`);
}

/**
 * Redraws the #queue-count and #queue-list UI from the current
 * batchQueue array, including each item's remove (x icon) control.
 * Also updates #queue-count-live, the same count shown on the
 * "Done Scanning" button while a continuous scan session is open.
 */
function renderQueue() {
    document.getElementById('queue-count').textContent = batchQueue.length;
    const liveCount = document.getElementById('queue-count-live');
    if (liveCount) liveCount.textContent = batchQueue.length;
    document.getElementById('queue-list').innerHTML = batchQueue.map((qr, index) => `
        <div class="batch-item">
            <div>${icon('wrench')} <strong>${qr}</strong></div>
            <div style="color:var(--red);cursor:pointer;font-weight:bold;font-size:16px;padding:0 10px;" onclick="removeItem(${index})">${icon('x')}</div>
        </div>
    `).join('');
}

/**
 * Removes a single tool from batchQueue by index (invoked from the
 * per-row remove (x icon) control rendered in renderQueue()) and re-renders.
 */
function removeItem(index) {
    batchQueue.splice(index, 1); 
    renderQueue(); 
}

// ==========================================
// 5. AUDIT WORKFLOW
// ==========================================
/**
 * The logged-in activeUser's home department plus any explicitly granted ones (see
 * migrations/005) -- same shape/meaning as accessibleDeptIds server-side, and same
 * convention: does NOT treat super_admin as unrestricted here, since a super_admin has no
 * real "home" department scoping to apply in the first place. Callers check
 * activeUser.role === 'super_admin' themselves wherever unrestricted access should apply
 * (see loadAuditDropdown() below), matching how server.js's own accessibleDeptIds is used.
 */
function getAccessibleDeptIds() {
    if (!activeUser) return [];
    return [...new Set([activeUser.deptId, ...(activeUser.grantedDeptIds || [])].filter(id => id !== null && id !== undefined))];
}

/**
 * Populates the #audit-box-select dropdown (audit-step-1) from GET /api/storage so the user
 * can pick which toolbox to inventory. Grouped into one <optgroup> per department (sorted by
 * department name, toolboxes sorted within each), and restricted to departments the logged-in
 * activeUser can access -- their home department plus any explicitly granted ones, or every
 * department for a super_admin. This is a convenience filter, not the real enforcement: the
 * server independently checks the same access on submit (see getUserAccess() in server.js),
 * so this can't be bypassed by editing the DOM or calling the API directly.
 */
async function loadAuditDropdown() {
    try {
        const res = await fetch('/api/storage');
        const data = await res.json();

        const accessibleDeptIds = getAccessibleDeptIds();
        const visibleDepts = (activeUser && activeUser.role === 'super_admin')
            ? data.departments
            : data.departments.filter(d => accessibleDeptIds.includes(d.dept_id));

        const html = visibleDepts
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(dept => {
                const boxes = data.toolboxes
                    .filter(b => b.dept_id === dept.dept_id)
                    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                if (boxes.length === 0) return '';
                const options = boxes.map(b => `<option value="${b.name}">${b.name}</option>`).join('');
                return `<optgroup label="${dept.name}">${options}</optgroup>`;
            })
            .join('');

        document.getElementById('audit-box-select').innerHTML = '<option value="">-- Select a Toolbox --</option>' + html;
    } catch (e) {
        showToast(`${icon('circle-x', 'icon-danger')} Failed to load storage infrastructure.`);
    }
}

/**
 * Begins the physical audit for the toolbox selected in #audit-box-select: fetches the full
 * tool manifest via GET /api/tools and splits it into auditTools (tools currently 'In' --
 * expected to be sitting in this box, and what physically confirming the box means checking
 * against) and auditExcludedCount (tools currently 'Out', 'Missing', 'Broken', or 'Worn' --
 * not expected to be physically present, or already a tracked issue via the separate Report
 * Issue workflow, so they're shown as an informational count only and never touched by this
 * audit). Retired/Pending Transfer/In Calibration tools are dropped entirely, matching
 * getAuditGatePendingToolboxes()'s own exclusion set in server.js. Advances the UI from
 * audit-step-1 to audit-step-2.
 */
async function startAudit() {
    const select = document.getElementById('audit-box-select');
    if (!select.value) {
        return showToast(`${icon('triangle-alert', 'icon-warning')} Select a toolbox.`);
    }

    auditBoxName = select.value;
    document.getElementById('audit-box-title').textContent = auditBoxName;

    try {
        const res = await fetch('/api/tools');
        const data = await res.json();

        const inBox = data.tools.filter(t => t.toolbox_name === auditBoxName && !['Retired', 'Pending Transfer', 'In Calibration'].includes(t.status));

        if (inBox.length === 0) {
            return showToast(`${icon('triangle-alert', 'icon-warning')} No tools assigned to this box.`);
        }

        auditTools = inBox.filter(t => t.status === 'In');
        auditExcludedCount = inBox.length - auditTools.length;

        document.getElementById('audit-step-1').style.display = 'none';
        document.getElementById('audit-step-2').style.display = 'block';
        document.getElementById('audit-attest-checkbox').checked = false;
        document.getElementById('btn-submit-audit').disabled = true;

        renderAuditList();
    } catch (err) {
        showToast(`${icon('circle-x', 'icon-danger')} Failed to pull manifest.`);
    }
}

/**
 * Redraws #audit-tool-list (read-only: ID + description, no per-row controls -- see
 * submitAudit() for why) from the current auditTools array, plus #audit-excluded-note
 * summarizing how many other tools in this box were left out (currently checked out, or
 * already flagged Missing/Broken/Worn) and therefore aren't part of this attestation.
 */
function renderAuditList() {
    document.getElementById('audit-tool-list').innerHTML = auditTools.map(t => `
        <tr>
            <td style="font-family: monospace;">${t.qr_code}</td>
            <td>
                <strong>${t.name}</strong><br>
                <span style="font-size:11px;color:var(--muted);">${t.drawer_name || '--'}</span>
            </td>
        </tr>
    `).join('');

    document.getElementById('audit-excluded-note').textContent = auditExcludedCount > 0
        ? `${auditExcludedCount} other tool(s) in this box are currently checked out or already flagged, and aren't part of this checklist.`
        : '';
}

/**
 * Finalizes the audit and POSTs the results to /api/audits/submit: every tool in auditTools
 * (everything currently 'In' this box -- see startAudit()) is submitted as 'Present', since
 * reaching this point already required checking #audit-attest-checkbox, i.e. an affirmative
 * statement that the operator physically opened the box and confirmed all of them. There's
 * no per-tool ambiguity to resolve here by design (see the comment above #audit-step-2 in
 * kiosk.html for why) -- an actual problem with a specific tool goes through the separate
 * Report Issue workflow instead. On success, shows a toast and either returns to
 * #panel-scanner with the original batchQueue still intact (if this audit was reached via
 * the AUDIT_REQUIRED gate mid-checkout, auditGateReturnPending) so the tech can finalize the
 * checkout that triggered the gate, or otherwise back to audit-step-1 (toolbox selection) --
 * NOT the idle screen -- so several boxes can be audited in one visit without
 * re-authenticating for each one. The operator stays signed in until they explicitly hit
 * "Cancel & Log Out".
 */
async function submitAudit() {
    try {
        const res = await fetch('/api/audits/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                badge_id: activeUser.badgeId,
                results: auditTools.map(t => ({ tool_id: t.tool_id, audit_status: 'Present', audit_notes: '' }))
            })
        });

        if (!res.ok) {
            return showToast(`${icon('circle-x', 'icon-danger')} Failed to log audit.`);
        }

        if (auditGateReturnPending) {
            auditGateReturnPending = false;
            pendingMode = 'OUT';
            auditTools = [];
            auditExcludedCount = 0;
            document.getElementById('panel-audit').style.display = 'none';
            document.getElementById('panel-scanner').style.display = 'block';
            document.getElementById('action-title').innerHTML = `${icon('upload')} Scan Tools for Checkout`;
            document.getElementById('btn-submit-action').textContent = '✓ Complete Checkout';
            renderQueue();
            showToast(`${icon('circle-check', 'icon-success')} Audit logged — you can now finalize your checkout.`);
            return;
        }

        showToast(`${icon('circle-check', 'icon-success')} Audit complete and verified.`);
        // Return to toolbox selection rather than logging out -- auditing several boxes in
        // one visit used to mean re-scanning a badge and re-entering a PIN for every single
        // one. The operator stays signed in until they explicitly hit "Cancel & Log Out".
        auditTools = [];
        auditExcludedCount = 0;
        auditBoxName = '';
        document.getElementById('audit-step-2').style.display = 'none';
        document.getElementById('audit-step-1').style.display = 'block';
        loadAuditDropdown();
    } catch (e) {
        showToast(`${icon('circle-x', 'icon-danger')} Connection error.`);
    }
}

/**
 * Audit-gate entry point: invoked from #audit-gate-modal's
 * per-toolbox "Audit <name> Now" buttons when a checkout was rejected
 * with AUDIT_REQUIRED. Hides the gate modal, switches the visible
 * panel from #panel-scanner to #panel-audit (leaving pendingMode and
 * batchQueue untouched so the checkout can resume after), loads the
 * toolbox dropdown, pre-selects boxName, and immediately calls
 * startAudit() — skipping the manual dropdown-pick-and-click-Begin
 * step. Sets auditGateReturnPending so submitAudit() knows to return
 * to the scanner panel (with batchQueue intact) instead of resetting
 * to idle once this audit is logged.
 */
async function jumpToAuditFromGate(boxName) {
    document.getElementById('audit-gate-modal').style.display = 'none';
    auditGateReturnPending = true;

    document.getElementById('panel-scanner').style.display = 'none';
    document.getElementById('panel-audit').style.display = 'block';
    document.getElementById('audit-step-1').style.display = 'block';
    document.getElementById('audit-step-2').style.display = 'none';

    await loadAuditDropdown();
    const select = document.getElementById('audit-box-select');
    select.value = boxName;
    startAudit();
}

// ==========================================
// 6. CAMERA HARDWARE CONTROLS
// ==========================================
/**
 * Camera lifecycle: safely stops the shared html5QrScannerInstance
 * if it is currently scanning, then hides every possible camera
 * preview element (#reader, #auth-reader, #report-reader)
 * regardless of which one was active. Called
 * whenever a workflow is abandoned (e.g. resetToIdle()) to make sure
 * no camera is left running in the background.
 */
function killActiveCamera() {
    if (html5QrScannerInstance && html5QrScannerInstance.isScanning) {
        html5QrScannerInstance.stop().then(() => {
            document.getElementById('reader').style.display = 'none';
            document.getElementById('auth-reader').style.display = 'none';
            document.getElementById('report-reader').style.display = 'none';
        }).catch(e => { console.error("Error stopping camera", e); });
    }
    // Always resync the continuous-scan button pair, not just when isScanning was true --
    // callers like resetToIdle() should never leave a stray "Done Scanning" button visible.
    setContinuousScanUI('reader', false);
}

// Maps each reader element that supports continuous (batch) scanning to its Open/Done
// button pair, so the UI can toggle which one is visible without threading extra
// parameters through every call site. Readers not listed here (auth-reader,
// report-reader) are single-shot only and have no Done button to manage.
const CONTINUOUS_SCAN_BUTTONS = {
    'reader': { openBtn: 'btn-open-scanner', doneBtn: 'btn-done-scanner' },
};

/** Shows the "Done Scanning" control and hides "Open Camera Scanner" (or vice versa) for a given reader, if it has a registered button pair in CONTINUOUS_SCAN_BUTTONS. */
function setContinuousScanUI(readerId, isScanning) {
    const buttons = CONTINUOUS_SCAN_BUTTONS[readerId];
    if (!buttons) return;
    const openBtn = document.getElementById(buttons.openBtn);
    const doneBtn = document.getElementById(buttons.doneBtn);
    if (openBtn) openBtn.style.display = isScanning ? 'none' : '';
    if (doneBtn) doneBtn.style.display = isScanning ? '' : 'none';
}

/** Stops a continuous batch-scanning session (the "Done Scanning" button's handler) and restores the Open Camera Scanner button. */
function stopContinuousScanner(readerId) {
    killActiveCamera();
    setContinuousScanUI(readerId, false);
}

/**
 * Audio + haptic confirmation that a barcode was just successfully captured -- a single
 * synthesized beep via the Web Audio API (no audio file asset needed, and no risk of a
 * browser autoplay block since this only ever runs from inside a user-gesture call stack:
 * a button click or an Enter keydown) plus a short vibration where the platform supports
 * it. Vibration is Android-only in practice -- iOS Safari has never implemented the
 * Vibration API, even installed as a PWA, so `navigator.vibrate` is simply undefined there;
 * this silently ends up audio-only on iPhone/iPad/desktop rather than erroring.
 * One AudioContext is created lazily and reused (rather than one per scan) since browsers
 * cap how many can exist at once and there's no reason to pay that cost repeatedly.
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

/**
 * Camera lifecycle: shared low-level driver behind all camera scan
 * buttons. Reveals the given preview element, (re)creates the
 * html5QrScannerInstance against it, and starts scanning using the
 * rear-facing camera specifically (`facingMode: "environment"`,
 * requested directly rather than enumerating devices and guessing
 * which index is the rear camera -- that order is unpredictable
 * across phones/browsers, and iOS in particular often lists the
 * front camera first, which is what was happening before this).
 * If no rear camera exists (e.g. a laptop webcam), the browser
 * falls back to whatever camera is available rather than failing.
 *
 * By default (continuous=false) a successful decode stops the
 * camera, hides the preview, and invokes successCallback once --
 * used for one-off scans (badge login, a single report/asset code).
 * With continuous=true the camera keeps running after each decode
 * so several tools can be scanned back-to-back without reopening
 * it, debounced so the same code lingering in frame doesn't
 * re-fire; setContinuousScanUI() reveals that reader's "Done
 * Scanning" button so the operator has a way to close it explicitly.
 * Surfaces toasts for no-camera and permission-denied failure paths.
 */
function executeCameraScan(elementId, successCallback, continuous = false) {
    document.getElementById(elementId).style.display = 'block';

    if (html5QrScannerInstance) { html5QrScannerInstance.clear(); }
    html5QrScannerInstance = new Html5Qrcode(elementId);

    // Tracks the last code seen by this scan session so the same barcode sitting in
    // frame for a couple of seconds doesn't fire successCallback dozens of times while
    // the operator is moving the phone to the next tool. Scoped to this call (rather
    // than module-level) since a fresh session always starts debounce state clean.
    let lastContinuousScanCode = null;
    let lastContinuousScanTime = 0;

    html5QrScannerInstance.start(
        { facingMode: "environment" },
        { fps: 14, qrbox: { width: 260, height: 260 }, aspectRatio: 1.0 }, // matches the .camera-reader CSS's fixed 1:1 box so the preview doesn't stretch/squish when the phone rotates
        (text) => {
            if (continuous) {
                const now = Date.now();
                if (text === lastContinuousScanCode && (now - lastContinuousScanTime) < 2000) return;
                lastContinuousScanCode = text;
                lastContinuousScanTime = now;
                playScanFeedback();
                successCallback(text);
            } else {
                playScanFeedback();
                html5QrScannerInstance.stop().then(() => {
                    document.getElementById(elementId).style.display = 'none';
                    successCallback(text);
                });
            }
        }
    ).then(() => {
        if (continuous) setContinuousScanUI(elementId, true);
    }).catch(err => {
        showToast(`${icon('circle-x', 'icon-danger')} Camera Error`);
        document.getElementById(elementId).style.display = 'none';
    });
}

/**
 * Camera lifecycle: opens the auth-screen camera (#auth-reader) via
 * executeCameraScan() and, once a badge is decoded, fills
 * #auth-badge-input with the scanned text and immediately calls
 * authenticateUser() to log the technician in.
 */
function startAuthCameraScanner() {
    executeCameraScan('auth-reader', (txt) => { 
        document.getElementById('auth-badge-input').value = txt; 
        authenticateUser(); 
    }); 
}

/**
 * Camera lifecycle: generic tool-scan camera opener reused by the
 * scanner and report panels (each passes its own reader
 * element id and text input id). Opens the given camera preview via
 * executeCameraScan(), fills the given input with the decoded text,
 * and optionally invokes triggerFunc() afterward (e.g.
 * handleToolScan) to process the scan immediately.
 * Pass continuous=true (checkout/check-in scanning does) to keep the
 * camera open across multiple scans instead of closing it after the
 * first one -- see executeCameraScan().
 */
function startToolCameraScanner(readerId, inputId, triggerFunc = null, continuous = false) {
    executeCameraScan(readerId, (txt) => {
        document.getElementById(inputId).value = txt;
        if (triggerFunc) triggerFunc();
    }, continuous);
}

// ==========================================
// 7. GENERAL API ACTIONS (Transactions & Errors)
// ==========================================
/**
 * Submits the current batchQueue as a checkout or check-in
 * transaction to POST /api/transactions (action derived from
 * pendingMode). Every checkout AND check-in now requires a universal
 * Buddy Sign-Off PIN (any other active user, no role restriction), so
 * when called with no managerPin this
 * ALWAYS shows #override-modal (clearing/focusing #override-pin-input)
 * and returns, rather than only doing so after a rejected attempt.
 * submitTransactionWithOverride() re-invokes this same function with
 * managerPin populated once the sign-off PIN has been entered.
 *
 * Error-handling branches inspected on a non-ok response (button is
 * restored first in every case):
 *   - BAD_TECH_PIN: the technician's own session PIN (activeUser.pin)
 *     is stale/wrong — re-entering the sign-off PIN can't fix this,
 *     so the kiosk is sent back to resetToIdle().
 *   - SIGNOFF_REQUIRED: shouldn't normally happen since the modal
 *     always collects the PIN first, but toast if the server disagrees.
 *   - BAD_PIN: the sign-off PIN doesn't match an authorized user;
 *     toast and keep the modal open for retry.
 *   - SIGNOFF_SAME_PERSON: the sign-off PIN resolved to the same user
 *     as the technician; toast and keep the modal open for retry.
 *   - CAL_EXPIRED / CAL_NO_DUE_DATE / CAL_NO_CERTIFICATE / CAL_INVESTIGATION_OPEN /
 *     TOOL_IN_TRANSFER: hard stops — toast the server's message, close
 *     the modal, and return to the scan panel (no retry can fix any of these).
 *   - AUDIT_REQUIRED: the tool's home department hasn't been audited
 *     today; close the sign-off modal and show #audit-gate-modal with
 *     one "Audit <name> Now" button per pending toolbox.
 *   - Any other error: shown as a generic toast.
 * On success, the override modal (if open) is hidden, a success
 * toast is shown, and the kiosk returns to the idle screen.
 */
async function submitTransaction(managerPin = null) {
    // Everything below is wrapped in one top-level try/catch -- previously only the
    // fetch itself was guarded, so any unexpected DOM/state error in the synchronous
    // setup above it (element lookups, button locking) would fail completely silently:
    // no toast, no modal change, the tap would just appear to do nothing. Whatever the
    // failure, the operator now always gets a visible message instead of a dead button.
    let submitBtn;
    try {
        if (batchQueue.length === 0) return showToast(`${icon('triangle-alert', 'icon-warning')} Queue empty.`);

        if (!managerPin) {
            // Universal gate: always require sign-off before finalizing, for BOTH OUT and IN.
            document.getElementById('override-pin-input').value = '';
            document.getElementById('override-modal').style.display = 'flex';
            document.getElementById('override-pin-input').focus();
            return;
        }

        // Lock the button to prevent double-clicks
        submitBtn = document.getElementById('btn-submit-action');
        if(submitBtn) { submitBtn.textContent = 'Processing...'; submitBtn.disabled = true; }

        const response = await fetch('/api/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                badge_id: activeUser.badgeId,
                pin: activeUser.pin,
                action: pendingMode === 'OUT' ? 'CHECKOUT_TOOL' : 'CHECKIN_TOOL',
                qr_codes: batchQueue,
                manager_pin: managerPin,
                work_order: pendingMode === 'OUT' ? document.getElementById('kiosk-work-order').value : undefined
            })
        });

        const data = await response.json();

        if (!response.ok) {
            // Restore button
            if(submitBtn) { submitBtn.textContent = pendingMode === 'OUT' ? '✓ Complete Checkout' : '✓ Complete Check-in'; submitBtn.disabled = false; }

            // Handle Custom Hard-Stops
            if (data.code === 'BAD_TECH_PIN') {
                document.getElementById('override-modal').style.display = 'none';
                showToast(`${icon('circle-x', 'icon-danger')} Your session PIN is invalid. Please sign in again.`);
                return resetToIdle();
            }
            else if (data.code === 'SIGNOFF_REQUIRED') {
                return showToast(icon('triangle-alert', 'icon-warning') + ' ' + (data.error || 'Sign-off PIN is required.'));
            }
            else if (data.code === 'BAD_PIN') {
                return showToast(`${icon('circle-x', 'icon-danger')} Invalid Buddy PIN.`);
            }
            else if (data.code === 'SIGNOFF_SAME_PERSON') {
                return showToast(`${icon('circle-x', 'icon-danger')} Sign-off must be from a different person.`);
            }
            else if (data.code === 'CAL_EXPIRED' || data.code === 'CAL_NO_DUE_DATE' || data.code === 'CAL_NO_CERTIFICATE' || data.code === 'CAL_INVESTIGATION_OPEN') {
                document.getElementById('override-modal').style.display = 'none';
                return showToast(icon('octagon', 'icon-danger') + ' ' + data.error);
            }
            else if (data.code === 'TOOL_IN_TRANSFER') {
                document.getElementById('override-modal').style.display = 'none';
                return showToast(icon('octagon', 'icon-danger') + ' ' + data.error);
            }
            else if (data.code === 'AUDIT_REQUIRED') {
                document.getElementById('override-modal').style.display = 'none';
                showAuditGateModal(data.pending_toolboxes || []);
                return;
            }
            return showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Transaction failed.'));
        }

        document.getElementById('override-modal').style.display = 'none';
        showToast(`${icon('circle-check', 'icon-success')} Successfully processed ${batchQueue.length} assets.`);
        setTimeout(resetToIdle, 1500);
    } catch (err) {
        if(submitBtn) { submitBtn.textContent = 'Error'; submitBtn.disabled = false; }
        showToast(icon('circle-x', 'icon-danger') + ' ' + (err && err.message ? err.message : 'Something went wrong. Please try again.'));
    }
}

/**
 * Buddy sign-off retry flow: reads the PIN entered in
 * #override-pin-input (shown unconditionally by submitTransaction())
 * and, if present, re-runs submitTransaction() with that PIN so the
 * exact same batch/action is resubmitted for authorization.
 */
function submitTransactionWithOverride() {
    try {
        const pin = document.getElementById('override-pin-input').value.trim();
        if (!pin) return showToast(`${icon('triangle-alert', 'icon-warning')} PIN is required.`);
        submitTransaction(pin); // Re-run the exact same transaction, but pass the PIN this time
    } catch (err) {
        showToast(icon('circle-x', 'icon-danger') + ' ' + (err && err.message ? err.message : 'Something went wrong. Please try again.'));
    }
}

/**
 * Audit-gate rejection UX: renders one "Audit <name> Now" button per
 * toolbox in pendingToolboxes into #audit-gate-box-list and shows
 * #audit-gate-modal. Each button calls jumpToAuditFromGate(name) so
 * the tech can log today's audit without losing the in-progress
 * checkout batch. The Cancel button (static markup in kiosk.html)
 * just hides the modal, leaving batchQueue untouched for a retry.
 */
function showAuditGateModal(pendingToolboxes) {
    document.getElementById('audit-gate-box-list').innerHTML = pendingToolboxes.map(box => `
        <button class="btn btn-primary" onclick="jumpToAuditFromGate('${(box.name || '').replace(/'/g, "\\'")}')">Audit ${box.name} Now</button>
    `).join('') || '<div style="color: var(--muted); font-size: 13px;">No specific toolboxes were listed.</div>';
    document.getElementById('audit-gate-modal').style.display = 'flex';
}

/**
 * Reads #report-qr / #report-type / #report-notes and routes to the
 * correct backend action. For 'Broken' | 'Missing' | 'Worn', POSTs to
 * POST /api/kiosk/report-issue. For 'NeedsCalibration', delegates to
 * submitCalibrationTransfer() instead (a distinct QA-transfer flow,
 * not a status flag). Locks the submit button and shows
 * "Submitting..." while the request is in flight.
 */
async function submitProblemReport() {
    const qr = document.getElementById('report-qr').value.trim().toUpperCase();
    const issueType = document.getElementById('report-type').value; // Broken | Missing | Worn | NeedsCalibration
    const notes = document.getElementById('report-notes').value.trim();

    if (!qr) return showToast(`${icon('triangle-alert', 'icon-warning')} Tool barcode is required.`);

    if (issueType === 'NeedsCalibration') {
        return submitCalibrationTransfer(qr, notes);
    }

    const btn = document.querySelector('#panel-report .btn-danger');
    if (btn) { btn.textContent = 'Submitting...'; btn.disabled = true; }

    try {
        const response = await fetch('/api/kiosk/report-issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                badge_id: activeUser.badgeId,
                pin: activeUser.pin,
                qr_code: qr,
                issue_type: issueType,
                notes: notes
            })
        });
        const data = await response.json();

        if (!response.ok) {
            if (btn) { btn.textContent = 'Submit Registry Log'; btn.disabled = false; }
            return showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Failed to log report.'));
        }

        showToast(`${icon('circle-check', 'icon-success')} Reported ${qr} as ${issueType}. ID reserved.`);
        setTimeout(resetToIdle, 1500);
    } catch (err) {
        if (btn) { btn.textContent = 'Submit Registry Log'; btn.disabled = false; }
        showToast(`${icon('circle-x', 'icon-danger')} Connection error.`);
    }
}

/**
 * Outbound leg of the QA calibration-transfer workflow, invoked by
 * submitProblemReport() when #report-type is 'NeedsCalibration'.
 * POSTs to POST /api/transfers/initiate with the QA department chosen
 * in #report-qa-dept. On success the tool flips to 'Pending Transfer'
 * server-side and awaits QA acceptance (see the Transfers workflow).
 */
async function submitCalibrationTransfer(qr, notes) {
    const qaDeptId = document.getElementById('report-qa-dept').value;
    if (!qaDeptId) return showToast(`${icon('triangle-alert', 'icon-warning')} Select a QA department.`);

    const btn = document.querySelector('#panel-report .btn-danger');
    if (btn) { btn.textContent = 'Submitting...'; btn.disabled = true; }

    try {
        const response = await fetch('/api/transfers/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                badge_id: activeUser.badgeId,
                pin: activeUser.pin,
                qr_code: qr,
                qa_dept_id: qaDeptId,
                notes: notes
            })
        });
        const data = await response.json();

        if (!response.ok) {
            if (btn) { btn.textContent = 'Submit Registry Log'; btn.disabled = false; }
            return showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Failed to initiate transfer.'));
        }

        showToast(`${icon('circle-check', 'icon-success')} ${qr} queued for QA pickup. Awaiting QA acceptance.`);
        setTimeout(resetToIdle, 1500);
    } catch (err) {
        if (btn) { btn.textContent = 'Submit Registry Log'; btn.disabled = false; }
        showToast(`${icon('circle-x', 'icon-danger')} Connection error.`);
    }
}

/**
 * Shows/hides #report-qa-dept-group depending on whether
 * #report-type is currently set to 'NeedsCalibration'. Wired to
 * #report-type's onchange and also called once when the Report panel
 * is opened so the group starts in the correct state.
 */
function toggleReportQaDeptVisibility() {
    const isCalTransfer = document.getElementById('report-type').value === 'NeedsCalibration';
    document.getElementById('report-qa-dept-group').style.display = isCalTransfer ? 'block' : 'none';
}

/**
 * Populates #report-qa-dept from GET /api/storage's departments array
 * (same data source syncStorageHierarchyDropdowns() in admin.js uses),
 * so the tech can pick which QA department a calibration transfer
 * should be routed to.
 */
async function loadReportQaDeptDropdown() {
    try {
        const res = await fetch('/api/storage');
        const data = await res.json();
        const select = document.getElementById('report-qa-dept');
        if (select) {
            select.innerHTML = '<option value="">-- Select QA Department --</option>' + data.departments.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
        }
    } catch (e) {
        showToast(`${icon('circle-x', 'icon-danger')} Failed to load departments.`);
    }
}

// ==========================================
// 7B. TRANSFERS WORKFLOW (QA queue)
// ==========================================
/**
 * Fetches both GET /api/transfers?...&direction=incoming and
 * ...&direction=outgoing for the current activeUser and renders all
 * three queue sections: #transfer-list-incoming (transfers awaiting
 * this dept's QA acceptance), #transfer-list-inqa (transfers this
 * dept's QA already accepted and can now complete/return, from the
 * incoming-direction response's in_progress array), and
 * #transfer-list-returning (transfers awaiting this (home) dept's
 * acceptance of a completed return). Each section renders an explicit
 * "Nothing pending." row when empty rather than being left blank.
 */
async function loadTransferQueue() {
    const incomingEl = document.getElementById('transfer-list-incoming');
    const inqaEl = document.getElementById('transfer-list-inqa');
    const returningEl = document.getElementById('transfer-list-returning');

    try {
        const [incomingRes, outgoingRes] = await Promise.all([
            fetch(`/api/transfers?badge_id=${encodeURIComponent(activeUser.badgeId)}&direction=incoming`),
            fetch(`/api/transfers?badge_id=${encodeURIComponent(activeUser.badgeId)}&direction=outgoing`)
        ]);
        const incomingData = await incomingRes.json();
        const outgoingData = await outgoingRes.json();

        if (!incomingRes.ok || !outgoingRes.ok) {
            showToast(`${icon('circle-x', 'icon-danger')} Failed to load transfer queue.`);
            return;
        }

        const incoming = incomingData.incoming || [];
        const inProgress = incomingData.in_progress || [];
        const outgoing = outgoingData.outgoing || [];

        incomingEl.innerHTML = incoming.length ? incoming.map(t => `
            <div class="batch-item" style="flex-direction: column; align-items: stretch; gap: 6px;">
                <div><strong>${t.tool_name}</strong> <span style="color: var(--muted); font-family: monospace;">(${t.qr_code})</span></div>
                <div style="font-size: 12px; color: var(--muted);">From: ${t.home_dept_name}${t.notes ? ' — ' + t.notes : ''}</div>
                <button class="btn btn-primary" style="width: auto; align-self: flex-start;" onclick="acceptIncomingTransfer(${t.transfer_id})">Accept Incoming</button>
            </div>
        `).join('') : '<div style="color: var(--muted); font-size: 13px; padding: 10px 0;">Nothing pending.</div>';

        inqaEl.innerHTML = inProgress.length ? inProgress.map(t => `
            <div class="batch-item" style="flex-direction: column; align-items: stretch; gap: 6px;">
                <div><strong>${t.tool_name}</strong> <span style="color: var(--muted); font-family: monospace;">(${t.qr_code})</span></div>
                <div style="font-size: 12px; color: var(--muted);">Home Dept: ${t.home_dept_name}${t.notes ? ' — ' + t.notes : ''}</div>
                <button class="btn btn-success" style="width: auto; align-self: flex-start;" onclick="openCalCompleteModal(${t.transfer_id})">Mark Calibration Complete & Return</button>
            </div>
        `).join('') : '<div style="color: var(--muted); font-size: 13px; padding: 10px 0;">Nothing pending.</div>';

        returningEl.innerHTML = outgoing.length ? outgoing.map(t => `
            <div class="batch-item" style="flex-direction: column; align-items: stretch; gap: 6px;">
                <div><strong>${t.tool_name}</strong> <span style="color: var(--muted); font-family: monospace;">(${t.qr_code})</span></div>
                <div style="font-size: 12px; color: var(--muted);">Status: ${t.status}${t.notes ? ' — ' + t.notes : ''}</div>
                ${t.status === 'AWAITING_HOME_ACCEPT' ? `<button class="btn btn-primary" style="width: auto; align-self: flex-start;" onclick="acceptReturnedTransfer(${t.transfer_id})">Accept Returned Tool</button>` : '<div style="font-size: 12px; color: var(--muted); font-style: italic;">Still at QA.</div>'}
            </div>
        `).join('') : '<div style="color: var(--muted); font-size: 13px; padding: 10px 0;">Nothing pending.</div>';
    } catch (err) {
        showToast(`${icon('circle-x', 'icon-danger')} Connection error loading transfers.`);
    }
}

/**
 * QA-side action: accepts physical receipt of an incoming transfer
 * (POST /api/transfers/:id/qa-accept), then toasts and refreshes all
 * three queue sections in place — the panel stays open so a tech can
 * process several transfers in one session.
 */
async function acceptIncomingTransfer(transferId) {
    try {
        const res = await fetch(`/api/transfers/${transferId}/qa-accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ badge_id: activeUser.badgeId, pin: activeUser.pin })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Failed to accept transfer.'));
        } else {
            showToast(`${icon('circle-check', 'icon-success')} Transfer accepted — tool is now in calibration.`);
        }
    } catch (err) {
        showToast(`${icon('circle-x', 'icon-danger')} Connection error.`);
    }
    loadTransferQueue();
}

/**
 * QA-side action: opens #cal-complete-modal for the given in-progress transfer, prefilling
 * today's date as the calibration date. submitCalibrationComplete() below does the actual
 * POST once the form -- including the calibration provider and certificate/reference number,
 * required for a traceable calibration_records row -- is filled in.
 */
function openCalCompleteModal(transferId) {
    document.getElementById('cal-complete-transfer-id').value = transferId;
    document.getElementById('cal-last-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('cal-due-date').value = '';
    document.getElementById('cal-provider').value = '';
    document.getElementById('cal-cert-number').value = '';
    document.getElementById('cal-standard').value = '';
    document.getElementById('cal-notes').value = '';
    document.getElementById('cal-result').value = 'Pass';
    document.getElementById('cal-complete-modal').style.display = 'flex';
}

/**
 * Finishes calibration on the transfer recorded in #cal-complete-modal: validates the
 * required fields client-side (POST /api/transfers/:id/complete-cal enforces the same
 * server-side, so this is just faster feedback, not the real check), then POSTs to log both
 * the tool's new due date and a permanent calibration_records entry. Toasts and refreshes
 * the queue in place regardless of outcome.
 */
async function submitCalibrationComplete() {
    const transferId = document.getElementById('cal-complete-transfer-id').value;
    const lastCalDate = document.getElementById('cal-last-date').value;
    const calDueDate = document.getElementById('cal-due-date').value;
    const provider = document.getElementById('cal-provider').value.trim();
    const certificateNumber = document.getElementById('cal-cert-number').value.trim();
    const standardUsed = document.getElementById('cal-standard').value.trim();
    const notes = document.getElementById('cal-notes').value.trim();
    const result = document.getElementById('cal-result').value;

    if (!lastCalDate || !calDueDate) return showToast(`${icon('triangle-alert', 'icon-warning')} Calibration date and due date are both required.`);
    if (!provider) return showToast(`${icon('triangle-alert', 'icon-warning')} Calibration provider/lab is required.`);
    if (!certificateNumber) return showToast(`${icon('triangle-alert', 'icon-warning')} Certificate/reference number is required.`);

    try {
        const res = await fetch(`/api/transfers/${transferId}/complete-cal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                badge_id: activeUser.badgeId,
                pin: activeUser.pin,
                last_cal_date: lastCalDate,
                cal_due_date: calDueDate,
                provider,
                certificate_number: certificateNumber,
                standard_used: standardUsed || null,
                notes: notes || null,
                result
            })
        });
        const data = await res.json();
        document.getElementById('cal-complete-modal').style.display = 'none';
        if (!res.ok) {
            showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Failed to complete calibration.'));
        } else if (result === 'Fail') {
            showToast(`${icon('triangle-alert', 'icon-warning')} Calibration FAILED — tool is blocked from checkout and a trace-back investigation was opened.`);
        } else {
            showToast(`${icon('circle-check', 'icon-success')} Calibration logged — tool is on its way back.`);
        }
    } catch (err) {
        document.getElementById('cal-complete-modal').style.display = 'none';
        showToast(`${icon('circle-x', 'icon-danger')} Connection error.`);
    }
    loadTransferQueue();
}

/**
 * Home-department action: accepts physical receipt of a tool
 * returning from QA (POST /api/transfers/:id/home-accept). Toasts and
 * refreshes the queue in place regardless of outcome.
 */
async function acceptReturnedTransfer(transferId) {
    try {
        const res = await fetch(`/api/transfers/${transferId}/home-accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ badge_id: activeUser.badgeId, pin: activeUser.pin })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(icon('circle-x', 'icon-danger') + ' ' + (data.error || 'Failed to accept returned tool.'));
        } else {
            showToast(`${icon('circle-check', 'icon-success')} Tool accepted back into service.`);
        }
    } catch (err) {
        showToast(`${icon('circle-x', 'icon-danger')} Connection error.`);
    }
    loadTransferQueue();
}

// ==========================================
// 8. UTILITIES
// ==========================================
/**
 * Displays a transient message in the #kiosk-toast element for 3.5
 * seconds. Used throughout the file for success/error/warning
 * feedback -- callers prefix msg with an icon() call (colored via the
 * icon-success/icon-danger/icon-warning modifier classes) rather than a leading emoji.
 */
function showToast(msg) {
    const el = document.getElementById('kiosk-toast');
    el.innerHTML = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// Last-resort safety net: this kiosk runs unattended for hours at a time, so a JS error
// nobody wrote a specific handler for must never fail completely silently -- a button
// that visibly does nothing when tapped looks identical to a hang, and the operator has
// no way to know whether to retry, wait, or call for help. Surfacing it as a toast at
// least tells them something broke, even if the message itself is just the raw error.
window.addEventListener('error', (event) => {
    showToast(`${icon('circle-x', 'icon-danger')} Unexpected error: ` + (event.message || 'unknown'));
});

// Auto-refocus logic
// On initial page load, wires up a blur listener on the persistent checkout/check-in scan
// input (#kiosk-scan-input) so that if it loses focus (e.g. after a hardware scanner "types"
// a value and the browser blurs it, or a stray tap elsewhere on the kiosk), focus is
// automatically restored shortly after via focusScanInput(). The short setTimeout lets any
// in-flight click/scan handling finish first. focusScanInput() itself only refocuses while
// #screen-action is visible, so this is a no-op once a workflow has ended. The audit
// workflow no longer has a scan input of its own (see #audit-step-2 in kiosk.html) so it
// needs no equivalent listener.
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('kiosk-scan-input').addEventListener('blur', () => {
        setTimeout(() => focusScanInput('kiosk-scan-input'), 200);
    });

    // Idle-screen audit status: load once now, then keep it fresh every 60s since this
    // screen is often left on-screen unattended for a long time (see loadIdleAuditStatus()).
    loadIdleAuditStatus();
    setInterval(loadIdleAuditStatus, 60 * 1000);
});