// ==========================================
// DASHBOARD LOGIC
// ==========================================

// ==========================================
// 1. STATE VARIABLES
// ==========================================
let globalTools = [];
let globalOutTools = [];
let globalFlaggedTools = [];
let globalCalTools = [];

// ==========================================
// 2. BOOT SEQUENCE
// ==========================================
/**
 * Kicks off the dashboard page: loads the storage tree sidebar, then the
 * global dashboard view, then the shift audit status widget (which keeps itself
 * live afterward -- see loadAuditStatusWidget()). Called once on window load
 * (see bottom of file).
 */
async function bootDashboard() {
    await fetchStorageTree();
    await loadGlobalDashboard();
    await loadAuditStatusWidget();
}

// ==========================================
// 2.5 SHIFT AUDIT STATUS WIDGET
// ==========================================
// Window end, cached from the last fetch so the on-screen countdown can tick every 30s
// without re-fetching the department list each time -- only a fresh fetch (every 5 min, or
// immediately once the cached window has actually elapsed) can learn about a newly
// completed audit or a window changeover.
let auditWidgetWindowEnd = null;

/**
 * Fetches GET /api/audits/today-status and renders the dashboard's "Shift Audit Status"
 * card: the current window's end time (#audit-widget-window) and one chip per department
 * (#audit-widget-chips), matching the same visual language as the equivalent admin.js/
 * kiosk.js widgets. Caches window_end into auditWidgetWindowEnd for
 * updateAuditWindowCountdown() to tick between fetches.
 */
async function loadAuditStatusWidget() {
    const chipsEl = document.getElementById('audit-widget-chips');
    const windowEl = document.getElementById('audit-widget-window');
    if (!chipsEl || !windowEl) return;

    try {
        const res = await fetch('/api/audits/today-status');
        const data = await res.json();
        if (!data.success) throw new Error('Failed to load audit status.');

        auditWidgetWindowEnd = new Date(data.window_end);
        updateAuditWindowCountdown();

        // Same chip convention as loadAuditStatus() in admin.js -- flat background, only the
        // text color and label change between the completed/pending states.
        chipsEl.innerHTML = data.departments.map(d => {
            if (d.audit_completed) {
                return `<span style="font-size:11px; font-weight:bold; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,0.05); color: var(--muted);">${d.name}</span>`;
            }
            return `<span style="font-size:11px; font-weight:bold; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,0.05); color: var(--red);">${d.name} -- Audit Pending</span>`;
        }).join('');
    } catch (e) {
        windowEl.textContent = 'Unavailable';
        chipsEl.innerHTML = `<span style="color: var(--red); font-size: 12px;">Failed to load audit status.</span>`;
    }
}

/**
 * Ticks #audit-widget-window's "time remaining" text from the cached
 * auditWidgetWindowEnd, without a network call. If the cached window has actually
 * elapsed (should be rare -- the 5-minute refresh in bootDashboard's setInterval normally
 * catches the changeover first), triggers an immediate re-fetch instead of showing a
 * negative/stale countdown.
 */
function updateAuditWindowCountdown() {
    const windowEl = document.getElementById('audit-widget-window');
    if (!windowEl || !auditWidgetWindowEnd) return;

    const msRemaining = auditWidgetWindowEnd - new Date();
    if (msRemaining <= 0) { loadAuditStatusWidget(); return; }

    const hours = Math.floor(msRemaining / 3600000);
    const minutes = Math.floor((msRemaining % 3600000) / 60000);
    const endLabel = auditWidgetWindowEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    windowEl.textContent = `Window ends ${endLabel} (${hours}h ${minutes}m remaining)`;
}

// ==========================================
// 3. STORAGE TREE SIDEBAR RENDERING
// ==========================================
/**
 * Fetches departments/toolboxes from /api/storage and renders the clickable
 * nav tree in the sidebar. Called by bootDashboard() on page load.
 */
async function fetchStorageTree() {
    try {
        const res = await fetch('/api/storage');
        const data = await res.json();
        
        let html = '';
        data.departments.forEach(dept => {
            html += `<div class="nav-item nav-dept" onclick="loadLocationView('dept', '${dept.dept_id}', '${dept.name}', '${dept.prefix_code}')">🏢 ${dept.name}</div>`;
            
            const boxes = data.toolboxes.filter(b => b.dept_id === dept.dept_id);
            boxes.forEach(box => {
                html += `<div class="nav-item nav-box" onclick="loadLocationView('box', '${box.name}', '${box.name}', 'Toolbox')">🧰 ${box.name}</div>`;
            });
        });
        document.getElementById('tree-container').innerHTML = html;
    } catch (e) {
        document.getElementById('tree-container').innerHTML = `<div style="color:var(--red); padding:20px;">Failed to load tree.</div>`;
    }
}

// ==========================================
// 4. GLOBAL DASHBOARD VIEW RENDERING
// ==========================================
/**
 * Renders the main (all-locations) dashboard view: KPI cards, out-tools,
 * flagged/maintenance, and upcoming-calibration tables. Called by
 * bootDashboard() on page load, and again whenever the user navigates back
 * to the global view (e.g. clicking the global nav item).
 */
async function loadGlobalDashboard() {
    document.getElementById('view-global').style.display = 'block';
    document.getElementById('view-location').style.display = 'none';
    
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navGlobal = document.getElementById('nav-global');
    if (navGlobal) navGlobal.classList.add('active');

    try {
        // Fetch dashboard summary and full tools list simultaneously
        const [dashRes, toolsRes] = await Promise.all([fetch('/api/dashboard'), fetch('/api/tools')]);
        const data = await dashRes.json();
        const toolsData = await toolsRes.json();

        // 1. Explicitly catch backend SQL errors
        if (data.error) throw new Error("Backend SQL Error: " + data.error);
        if (toolsData.error) throw new Error("Backend Tools Error: " + toolsData.error);

        // 2. Safe Fallbacks
        globalTools = toolsData.tools || [];
        globalOutTools = data.out_tools || [];
        globalFlaggedTools = data.flagged_tools || [];
        globalCalTools = data.cal_tools || [];
        const outTools = globalOutTools;
        const flaggedTools = globalFlaggedTools;
        const calTools = globalCalTools;
        const stats = data.stats || { total_tools: 0, total_out: 0, total_flagged: 0 };

        // 3. Calculate upcoming calibrations
        let calAlertCount = 0;
        const today = new Date();
        const thirtyDaysFromNow = new Date(today.getTime() + (30 * 24 * 60 * 60 * 1000));
        
        globalTools.forEach(t => {
            if (t.is_calibrated && t.cal_due_date) {
                const due = new Date(t.cal_due_date);
                if (due <= thirtyDaysFromNow) calAlertCount++;
            }
        });

        // 4. Populate KPI Cards
        document.getElementById('kpi-out').textContent = stats.total_out;
        document.getElementById('kpi-flagged').textContent = stats.total_flagged;
        document.getElementById('kpi-total').textContent = stats.total_tools;
        const kpiCal = document.getElementById('kpi-cal');
        if (kpiCal) kpiCal.textContent = calAlertCount;

        // 5. Render 'Out' Tools Table
        const outBody = document.getElementById('dash-out-body');
        if (outTools.length === 0) { 
            outBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">All tools are secured.</td></tr>`; 
        } else {
            outBody.innerHTML = outTools.map(t => {
                const time = t.timestamp ? new Date(t.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--';
                return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${t.qr_code}')">
                    <td style="font-family: monospace;">${t.qr_code}</td>
                    <td><strong>${t.tool_name}</strong></td>
                    <td style="color: var(--accent); font-weight:bold;">👤 ${t.user_name || 'Unknown'}</td>
                    <td style="font-size:12px; color:var(--muted);">${time}</td>
                    <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
                </tr>`;
            }).join('');
        }

        // 6. Render 'Maintenance' Tools Table
        const flagBody = document.getElementById('dash-flagged-body');
        if (flaggedTools.length === 0) { 
            flagBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">No maintenance items flagged.</td></tr>`; 
        } else {
            flagBody.innerHTML = flaggedTools.map(t => {
                let badgeColor = t.status === 'Missing' ? 'var(--red)' : 'var(--orange)';
                return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${t.qr_code}')">
                    <td style="font-family: monospace;">${t.qr_code}</td>
                    <td><strong>${t.tool_name}</strong></td>
                    <td><span style="background: ${badgeColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;">${t.status}</span></td>
                    <td style="font-size:12px; color:var(--muted);">${t.status_reason || 'No notes provided.'}</td>
                    <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
                </tr>`;
            }).join('');
        }

        // 7. Filter & Render 'Calibration' Table
        const calBody = document.getElementById('dash-cal-body');
        if (!calBody) return; 
        
        const expiringCals = calTools.filter(t => {
            if (!t.cal_due_date) return false;
            return new Date(t.cal_due_date) <= thirtyDaysFromNow;
        });

        if (expiringCals.length === 0) { 
            calBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">All calibrations are up to date.</td></tr>`; 
        } else {
            calBody.innerHTML = expiringCals.map(t => {
                const due = new Date(t.cal_due_date);
                let badgeColor = due <= today ? 'var(--red)' : 'var(--orange)';
                let displayStatus = due <= today ? 'OVERDUE' : 'DUE SOON';
                let formattedDate = due.toISOString().split('T')[0];

                return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${t.qr_code}')">
                    <td style="font-family: monospace;">${t.qr_code}</td>
                    <td><strong>${t.tool_name}</strong></td>
                    <td><span style="background: ${badgeColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${displayStatus}</span></td>
                    <td style="font-size:12px; font-weight:bold; color:${badgeColor};">${formattedDate}</td>
                    <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
                </tr>`;
            }).join('');
        }

    } catch (e) { 
        console.error("Dashboard Render Error:", e);
        const errorMsg = e.message || "Unknown rendering error.";
        
        document.getElementById('dash-out-body').innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--red);">Crash: ${errorMsg}</td></tr>`;
        document.getElementById('dash-flagged-body').innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--red);">Crash: ${errorMsg}</td></tr>`;
        
        const calBody = document.getElementById('dash-cal-body');
        if (calBody) calBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--red);">Crash: ${errorMsg}</td></tr>`;
    }
}

// ==========================================
// 5. PER-LOCATION DETAIL VIEW
// ==========================================
/**
 * Renders the detail view for a single department or toolbox. Mirrors
 * loadGlobalDashboard()'s structure exactly (4 KPI cards + 3 tables), but
 * scopes each of the module-level caches (globalOutTools, globalFlaggedTools,
 * globalCalTools, globalTools) to the selected location instead of re-fetching
 * from the server. Called via onclick from the nav items rendered in
 * fetchStorageTree() (or any static nav item wired to it).
 */
function loadLocationView(type, filterValue, title, subtitle) {
    document.getElementById('view-global').style.display = 'none';
    document.getElementById('view-location').style.display = 'block';
    document.getElementById('loc-title').textContent = title;
    document.getElementById('loc-subtitle').textContent = type === 'dept' ? `Department Code: ${subtitle}` : subtitle;

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    // 1. Scope the shared caches to this location
    let scopedOut = [], scopedFlagged = [], scopedCal = [], scopedTotal = [];
    if (type === 'dept') {
        scopedOut = globalOutTools.filter(t => t.dept_name === title);
        scopedFlagged = globalFlaggedTools.filter(t => t.dept_name === title);
        scopedCal = globalCalTools.filter(t => t.dept_name === title);
        scopedTotal = globalTools.filter(t => t.department_name === title && t.status !== 'Retired');
    } else if (type === 'box') {
        scopedOut = globalOutTools.filter(t => t.box_name === title);
        scopedFlagged = globalFlaggedTools.filter(t => t.box_name === title);
        scopedCal = globalCalTools.filter(t => t.box_name === title);
        scopedTotal = globalTools.filter(t => t.toolbox_name === title && t.status !== 'Retired');
    }

    // 2. Calculate upcoming calibrations (same due<=+30d rule as loadGlobalDashboard())
    const today = new Date();
    const thirtyDaysFromNow = new Date(today.getTime() + (30 * 24 * 60 * 60 * 1000));
    const expiringCals = scopedCal.filter(t => {
        if (!t.cal_due_date) return false;
        return new Date(t.cal_due_date) <= thirtyDaysFromNow;
    });

    // 3. Populate scoped KPI cards
    document.getElementById('loc-kpi-out').textContent = scopedOut.length;
    document.getElementById('loc-kpi-flagged').textContent = scopedFlagged.length;
    document.getElementById('loc-kpi-cal').textContent = expiringCals.length;
    document.getElementById('loc-kpi-total').textContent = scopedTotal.length;

    // 4. Render 'Out' Tools Table
    const outBody = document.getElementById('loc-out-body');
    if (scopedOut.length === 0) {
        outBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">All tools are secured.</td></tr>`;
    } else {
        outBody.innerHTML = scopedOut.map(t => {
            const time = t.timestamp ? new Date(t.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--';
            return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${t.qr_code}')">
                <td style="font-family: monospace;">${t.qr_code}</td>
                <td><strong>${t.tool_name}</strong></td>
                <td style="color: var(--accent); font-weight:bold;">👤 ${t.user_name || 'Unknown'}</td>
                <td style="font-size:12px; color:var(--muted);">${time}</td>
                <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
            </tr>`;
        }).join('');
    }

    // 5. Render 'Maintenance' Tools Table
    const flagBody = document.getElementById('loc-flagged-body');
    if (scopedFlagged.length === 0) {
        flagBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">No maintenance items flagged.</td></tr>`;
    } else {
        flagBody.innerHTML = scopedFlagged.map(t => {
            let badgeColor = t.status === 'Missing' ? 'var(--red)' : 'var(--orange)';
            return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${t.qr_code}')">
                <td style="font-family: monospace;">${t.qr_code}</td>
                <td><strong>${t.tool_name}</strong></td>
                <td><span style="background: ${badgeColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;">${t.status}</span></td>
                <td style="font-size:12px; color:var(--muted);">${t.status_reason || 'No notes provided.'}</td>
                <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
            </tr>`;
        }).join('');
    }

    // 6. Render 'Calibration' Table
    const calBody = document.getElementById('loc-cal-body');
    if (expiringCals.length === 0) {
        calBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">All calibrations are up to date.</td></tr>`;
    } else {
        calBody.innerHTML = expiringCals.map(t => {
            const due = new Date(t.cal_due_date);
            let badgeColor = due <= today ? 'var(--red)' : 'var(--orange)';
            let displayStatus = due <= today ? 'OVERDUE' : 'DUE SOON';
            let formattedDate = due.toISOString().split('T')[0];

            return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${t.qr_code}')">
                <td style="font-family: monospace;">${t.qr_code}</td>
                <td><strong>${t.tool_name}</strong></td>
                <td><span style="background: ${badgeColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${displayStatus}</span></td>
                <td style="font-size:12px; font-weight:bold; color:${badgeColor};">${formattedDate}</td>
                <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
            </tr>`;
        }).join('');
    }
}

// ==========================================
// 6. READ-ONLY TOOL DETAIL MODAL
// ==========================================
/**
 * Populates and opens the read-only tool detail modal (#tool-detail-overlay) for a
 * single tool, looked up by qr_code in the already-fetched globalTools cache (from
 * GET /api/tools). The "checked out to X since Y" custody line additionally consults
 * globalOutTools (from GET /api/dashboard's out_tools, populated in loadGlobalDashboard())
 * -- if the tool isn't found there (e.g. its status changed between fetches), that line
 * is simply omitted. This modal is permanently view-only: no edit or delete controls are
 * ever rendered here.
 */
function openToolDetailModal(qrCode) {
    const entity = globalTools.find(t => t.qr_code === qrCode);
    if (!entity) return;

    document.getElementById('td-type-badge').textContent = `ASSET [${entity.qr_code}]`;
    document.getElementById('td-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" style="width:100%;height:100%;border-radius:8px;object-fit:cover;">` : '🔧';
    document.getElementById('td-title').textContent = entity.name;

    // Status badge coloring: In=green, Out=accent, Missing/Broken/Worn=red/orange
    let statusColor = entity.status === 'In' ? 'var(--green)' : (entity.status === 'Out' ? 'var(--accent)' : (entity.status === 'Missing' ? 'var(--red)' : 'var(--orange)'));

    let bodyHtml = `
        <div style="margin-bottom:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Description</div><div style="font-size:14px;margin-top:4px;">${entity.description || '--'}</div></div>
        <div style="margin-bottom:15px;"><span style="background: ${statusColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;">${entity.status}</span></div>
    `;

    // Custody line -- only when status is Out, and only if found in globalOutTools
    if (entity.status === 'Out') {
        const outEntry = globalOutTools.find(o => o.qr_code === qrCode);
        if (outEntry) {
            const since = outEntry.timestamp ? new Date(outEntry.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';
            bodyHtml += `<div style="margin-bottom:15px; font-size:13px; color: var(--accent); font-weight:bold;">👤 Checked out to ${outEntry.user_name || 'Unknown'} since ${since}</div>`;
        }
    }

    // Location -- prefer /api/tools shape (toolbox_name/drawer_name/department_name), fall back to dept_name/box_name if present
    const deptLabel = entity.department_name || entity.dept_name || '--';
    const boxLabel = entity.toolbox_name || entity.box_name || '--';
    const locationLine = entity.drawer_name ? `${deptLabel} / ${boxLabel} / ${entity.drawer_name}` : `${deptLabel} / ${boxLabel}`;
    bodyHtml += `<div style="margin-bottom:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Location</div><div style="font-size:14px;margin-top:4px;">${locationLine}</div></div>`;

    // Calibration block -- only if is_calibrated
    if (entity.is_calibrated) {
        const lastCal = entity.last_cal_date ? entity.last_cal_date.split('T')[0] : '--';
        const dueCal = entity.cal_due_date ? entity.cal_due_date.split('T')[0] : null;

        let calBadge = '';
        if (dueCal) {
            const due = new Date(entity.cal_due_date);
            const today = new Date();
            const thirtyDaysFromNow = new Date(today.getTime() + (30 * 24 * 60 * 60 * 1000));
            if (due <= today) {
                calBadge = `<span style="background: var(--red); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">OVERDUE</span>`;
            } else if (due <= thirtyDaysFromNow) {
                calBadge = `<span style="background: var(--orange); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">DUE SOON</span>`;
            } else {
                calBadge = `<span style="background: var(--green); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">CURRENT</span>`;
            }
        }

        bodyHtml += `
            <div style="margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase; margin-bottom:6px;">Calibration</div>
                <div style="display:flex; gap:20px; align-items:center;">
                    <div><div style="font-size:11px;color:var(--muted);">Last Cal</div><div style="font-size:13px;font-weight:bold;">${lastCal}</div></div>
                    <div><div style="font-size:11px;color:var(--muted);">Due</div><div style="font-size:13px;font-weight:bold;">${dueCal || 'Unknown'}</div></div>
                    ${calBadge}
                </div>
            </div>
        `;
    }

    // Status reason / notes -- only when present
    if (entity.status_reason) {
        bodyHtml += `<div style="margin-bottom:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Notes</div><div style="font-size:13px;margin-top:4px; color:var(--muted);">${entity.status_reason}</div></div>`;
    }

    // Replacement link -- only if present
    if (entity.replacement_url) {
        bodyHtml += `<div><a href="${entity.replacement_url}" target="_blank" style="color:var(--blue); font-size: 13px; text-decoration: none;">🛒 Open Replacement Link →</a></div>`;
    }

    document.getElementById('td-body').innerHTML = bodyHtml;
    document.getElementById('tool-detail-overlay').style.display = 'flex';
}

/** Hides the read-only tool detail modal. */
function closeToolDetailModal() { document.getElementById('tool-detail-overlay').style.display = 'none'; }

// ==========================================
// 7. PAGE INITIALIZATION TRIGGER
// ==========================================
// Initialize on load
window.onload = bootDashboard;

// Keeps the Shift Audit Status widget live on an unattended/all-day display: the
// countdown ticks every 30s from cached data (no network call), and a full re-fetch every
// 5 minutes picks up a newly-completed audit or a window changeover without needing a
// manual page reload.
setInterval(updateAuditWindowCountdown, 30 * 1000);
setInterval(loadAuditStatusWidget, 5 * 60 * 1000);