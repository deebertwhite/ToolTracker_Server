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

// Raw /api/storage rows, stashed here by fetchStorageTree() so the Shadow Board Map's
// Department -> Toolbox -> Drawer selects can cascade without a second fetch.
let globalStorageDepts = [];
let globalStorageBoxes = [];
let globalStorageDrawers = [];

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

        globalStorageDepts = data.departments || [];
        globalStorageBoxes = data.toolboxes || [];
        globalStorageDrawers = data.drawers || [];

        let html = '';
        data.departments.forEach(dept => {
            html += `<div class="nav-item nav-dept" onclick="loadLocationView('dept', '${dept.dept_id}', '${dept.name}', '${dept.prefix_code}')">${icon('building-2')} ${dept.name}</div>`;

            const boxes = data.toolboxes.filter(b => b.dept_id === dept.dept_id);
            boxes.forEach(box => {
                html += `<div class="nav-item nav-box" onclick="loadLocationView('box', '${box.name}', '${box.name}', 'Toolbox')">${icon('toolbox')} ${box.name}</div>`;
            });
        });
        document.getElementById('tree-container').innerHTML = html;
    } catch (e) {
        document.getElementById('tree-container').innerHTML = `<div style="color:var(--red); padding:20px;">Failed to load tree.</div>`;
    }
}

// ==========================================
// 3.5 SHADOW BOARD MAP VIEW
// ==========================================
/**
 * Switches to the Shadow Board Map view (department -> toolbox -> drawer picker + the
 * selected drawer's photo/markers) and populates the Department select from the same
 * globalStorageDepts data fetchStorageTree() already fetched for the sidebar -- no second
 * request needed just to show this view.
 */
function showDrawerMapView() {
    document.getElementById('view-global').style.display = 'none';
    document.getElementById('view-location').style.display = 'none';
    document.getElementById('view-cal-cockpit').style.display = 'none';
    document.getElementById('view-drawer-map').style.display = 'block';

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-drawer-map').classList.add('active');

    const deptSelect = document.getElementById('map-select-dept');
    deptSelect.innerHTML = `<option value="">Select...</option>` +
        globalStorageDepts.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
}

/** Department changed -- repopulate the Toolbox select, scoped to that department, and reset Drawer. */
function onDrawerMapDeptChange() {
    const deptId = document.getElementById('map-select-dept').value;
    const boxSelect = document.getElementById('map-select-box');
    const drawerSelect = document.getElementById('map-select-drawer');

    drawerSelect.innerHTML = `<option value="">Select toolbox first...</option>`;
    drawerSelect.disabled = true;
    hideDrawerMapDisplay();

    if (!deptId) { boxSelect.innerHTML = `<option value="">Select department first...</option>`; boxSelect.disabled = true; return; }

    const boxes = globalStorageBoxes.filter(b => b.dept_id == deptId);
    boxSelect.innerHTML = `<option value="">Select...</option>` + boxes.map(b => `<option value="${b.box_id}">${b.name}</option>`).join('');
    boxSelect.disabled = false;
}

/** Toolbox changed -- repopulate the Drawer select, scoped to that toolbox. */
function onDrawerMapBoxChange() {
    const boxId = document.getElementById('map-select-box').value;
    const drawerSelect = document.getElementById('map-select-drawer');
    hideDrawerMapDisplay();

    if (!boxId) { drawerSelect.innerHTML = `<option value="">Select toolbox first...</option>`; drawerSelect.disabled = true; return; }

    const drawers = globalStorageDrawers.filter(d => d.box_id == boxId);
    drawerSelect.innerHTML = `<option value="">Select...</option>` + drawers.map(d => `<option value="${d.drawer_id}">${d.name}</option>`).join('');
    drawerSelect.disabled = false;
}

/** Drawer changed -- render its map, or fall back to the empty-state card if none selected. */
function onDrawerMapDrawerChange() {
    const drawerId = document.getElementById('map-select-drawer').value;
    if (!drawerId) { hideDrawerMapDisplay(); return; }
    renderDrawerMap(drawerId);
}

function hideDrawerMapDisplay() {
    document.getElementById('map-display-card').style.display = 'none';
    document.getElementById('map-empty-card').style.display = 'block';
    document.getElementById('map-empty-message').textContent = 'Select a department, toolbox, and drawer above.';
}

/**
 * Renders the selected drawer's photo with a colored marker for every tool that has a saved
 * position (green/accent/red -- same convention as everywhere else in this app), read-only
 * (no click-to-place here; markers are set from the drawer's entity modal in the admin
 * panel). Re-fetches /api/tools fresh rather than trusting globalTools' page-load snapshot,
 * since this view is meant to be left open on a shared screen for a while.
 */
async function renderDrawerMap(drawerId) {
    const drawer = globalStorageDrawers.find(d => d.drawer_id == drawerId);
    const emptyCard = document.getElementById('map-empty-card');
    const displayCard = document.getElementById('map-display-card');

    if (!drawer || !drawer.photo_url) {
        displayCard.style.display = 'none';
        emptyCard.style.display = 'block';
        document.getElementById('map-empty-message').textContent = drawer
            ? 'This drawer has no photo yet -- add one from its entity card in the admin panel.'
            : 'Drawer not found.';
        return;
    }

    let tools;
    try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        tools = (data.tools || []).filter(t => t.drawer_id == drawerId);
    } catch (e) {
        emptyCard.style.display = 'block';
        displayCard.style.display = 'none';
        document.getElementById('map-empty-message').textContent = 'Failed to load tool data.';
        return;
    }

    emptyCard.style.display = 'none';
    displayCard.style.display = 'block';
    document.getElementById('map-drawer-title').textContent = drawer.name;
    document.getElementById('map-drawer-img').src = drawer.photo_url;

    const placed = tools.filter(t => t.position_x !== null && t.position_y !== null);
    const unplacedCount = tools.length - placed.length;
    const statusColor = (status) => status === 'In' ? 'var(--green)' : (status === 'Out' ? 'var(--accent)' : 'var(--red)');

    document.getElementById('map-drawer-markers').innerHTML = placed.map(t => `
        <div title="${t.name} (${t.status})"
             style="position:absolute; left:${t.position_x * 100}%; top:${t.position_y * 100}%; transform:translate(-50%,-50%);
                    width:16px; height:16px; border-radius:50%; background:${statusColor(t.status)}; border:2px solid #fff;
                    box-shadow:0 0 4px rgba(0,0,0,0.6);"></div>
    `).join('');

    document.getElementById('map-unplaced-note').textContent = unplacedCount > 0
        ? `${unplacedCount} tool(s) in this drawer don't have a marked position yet.`
        : (tools.length === 0 ? 'No tools assigned to this drawer.' : '');
}

// ==========================================
// 3.6 CALIBRATION COCKPIT VIEW
// ==========================================
// An isolated, read-only lens over the same calibrated-tool data already used elsewhere on
// this page (globalTools, from GET /api/tools) -- modeled on a colleague's separate
// calibration-tracking prototype's own "Overview" page: a stat-tile drilldown grid plus a
// solid-color day/lock status pill per tool, adapted to this app's existing dark theme rather
// than importing that prototype's own light "steel" palette. Nothing about how calibrated
// tools are actually tracked or checked out changes anywhere else in the app; this view only
// reads what's already there.
let cockpitFilter = null; // null (default: everything needing attention) | 'due-soon' | 'locked'

/** Switches to the Calibration Cockpit view, re-fetching /api/tools fresh (same reasoning as renderDrawerMap -- this view is meant to be left open on a shared screen for a while) before rendering. */
async function loadCalCockpit() {
    document.getElementById('view-global').style.display = 'none';
    document.getElementById('view-location').style.display = 'none';
    document.getElementById('view-drawer-map').style.display = 'none';
    document.getElementById('view-cal-cockpit').style.display = 'block';

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const nav = document.getElementById('nav-cal-cockpit');
    if (nav) nav.classList.add('active');

    try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        if (data.success) globalTools = data.tools || [];
    } catch (e) { /* render from whatever globalTools already has (e.g. boot's own fetch) */ }
    renderCockpitView();
}

/**
 * Computes a tool's status band -- the exact same thresholds the reference prototype's own
 * regime logic uses (>60 days green, 30-60 yellow, 0-29 red, missing due date/certificate or
 * overdue = locked), extended with this app's own has_open_investigation signal (a concept
 * the reference prototype doesn't have) folded into "locked": an investigation-blocked tool
 * genuinely can't be checked out right now (see the CAL_INVESTIGATION_OPEN hard-stop in
 * POST /api/transactions), so it belongs in the same band as any other lock reason rather
 * than being invisible here. Returns null for a non-calibrated tool (no band applies).
 *
 * Day count is calendar-day arithmetic anchored at LOCAL midnight today (matching the
 * existing calIsExpired convention in admin.js -- new Date(new Date().toDateString())),
 * not a raw millisecond diff against the current instant -- GET /api/tools now returns
 * cal_due_date as a plain 'YYYY-MM-DD' string (see server.js, cast to ::text) rather than the
 * ambiguous server-timezone-dependent Date serialization it used to, but even with a clean
 * date string, comparing against "right now" would still make the label tick down mid-day
 * and, worse, occasionally misclassify a tool by one day for hours around each boundary.
 */
function cockpitDteBand(tool) {
    if (!tool.is_calibrated) return null;
    const lockedReason = tool.has_open_investigation ? 'Investigation open'
        : !tool.cal_due_date ? 'No due date'
        : !tool.has_cal_record ? 'No certificate'
        : null;
    if (lockedReason) return { band: 'locked', label: 'LOCKED', reason: lockedReason };

    const todayMidnight = new Date(new Date().toDateString());
    const days = Math.round((new Date(tool.cal_due_date) - todayMidnight) / 86400000);
    if (days < 0) return { band: 'locked', label: 'LOCKED', reason: 'Cal expired' };
    if (days <= 29) return { band: 'red', label: `${days}d`, reason: null };
    if (days <= 60) return { band: 'yellow', label: `${days}d`, reason: null };
    return { band: 'green', label: `${days}d`, reason: null };
}

/** Renders one DTE status pill -- solid background, white text, small lock icon when locked. The `title` attribute carries the specific lock reason, same as a native tooltip. */
function cockpitDteBadge(bandInfo) {
    if (!bandInfo) return `<span style="color:var(--muted);">--</span>`;
    const colors = { green: 'var(--green)', yellow: 'var(--orange)', red: 'var(--red)', locked: '#4b5563' };
    const lockIcon = bandInfo.band === 'locked' ? `<span style="display:inline-flex; width:11px; height:11px;">${icon('lock')}</span>` : '';
    return `<span title="${bandInfo.reason || ''}" style="display:inline-flex; align-items:center; gap:4px; background:${colors[bandInfo.band]}; color:#fff; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700;">${lockIcon}${bandInfo.label}</span>`;
}

/** Toggles the attention table's filter -- clicking the already-active tile clears it back to the default (everything needing attention). Pure client-side re-render, no fetch. */
function setCockpitFilter(filter) {
    cockpitFilter = (cockpitFilter === filter) ? null : filter;
    renderCockpitView();
}

/** Fills the Calibration Cockpit's stat tiles and attention table from the already-fetched globalTools -- pure client-side render, called on view entry and again by every tile click / "show all" checkbox toggle, never re-fetching on its own. */
function renderCockpitView() {
    const calTools = globalTools.filter(t => t.is_calibrated);
    const banded = calTools.map(t => ({ tool: t, band: cockpitDteBand(t) }));
    const dueSoon = banded.filter(b => b.band.band === 'yellow' || b.band.band === 'red');
    const locked = banded.filter(b => b.band.band === 'locked');

    document.getElementById('cockpit-kpi-all').textContent = calTools.length;
    document.getElementById('cockpit-kpi-in').textContent = calTools.filter(t => t.status === 'In').length;
    document.getElementById('cockpit-kpi-out').textContent = calTools.filter(t => t.status === 'Out').length;
    document.getElementById('cockpit-kpi-transfer').textContent = calTools.filter(t => t.status === 'Pending Transfer' || t.status === 'In Calibration').length;
    document.getElementById('cockpit-kpi-due-soon').textContent = dueSoon.length;
    document.getElementById('cockpit-kpi-locked').textContent = locked.length;

    // Highlight whichever tile matches the active filter -- the closest equivalent here to the
    // reference prototype's tile hover/active treatment.
    document.getElementById('cockpit-tile-due-soon').style.boxShadow = cockpitFilter === 'due-soon' ? '0 0 0 2px var(--orange)' : 'none';
    document.getElementById('cockpit-tile-locked').style.boxShadow = cockpitFilter === 'locked' ? '0 0 0 2px var(--red)' : 'none';
    document.getElementById('cockpit-filter-clear').style.display = cockpitFilter ? 'inline' : 'none';

    const showAll = document.getElementById('cockpit-show-all').checked;
    let rows, title;
    if (showAll) { rows = banded; title = 'All Calibrated Tools'; }
    else if (cockpitFilter === 'due-soon') { rows = dueSoon; title = 'Due Soon'; }
    else if (cockpitFilter === 'locked') { rows = locked; title = 'Locked'; }
    else { rows = banded.filter(b => b.band.band !== 'green'); title = 'Needs Attention'; }
    document.getElementById('cockpit-table-title').textContent = title;

    // Urgency-first: locked, then red, then yellow, then green -- then soonest due date first.
    const order = { locked: 0, red: 1, yellow: 2, green: 3 };
    rows = rows.slice().sort((a, b) => {
        const bandDiff = order[a.band.band] - order[b.band.band];
        if (bandDiff !== 0) return bandDiff;
        const aTime = a.tool.cal_due_date ? new Date(a.tool.cal_due_date).getTime() : -Infinity;
        const bTime = b.tool.cal_due_date ? new Date(b.tool.cal_due_date).getTime() : -Infinity;
        return aTime - bTime;
    });

    const body = document.getElementById('cockpit-attention-body');
    if (rows.length === 0) {
        body.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">Nothing here -- every calibrated tool is in good standing.</td></tr>`;
        return;
    }
    body.innerHTML = rows.map(({ tool, band }) => {
        const deptLabel = tool.department_name || '--';
        const boxLabel = tool.toolbox_name || '--';
        const locationLine = tool.drawer_name ? `${deptLabel} / ${boxLabel} / ${tool.drawer_name}` : `${deptLabel} / ${boxLabel}`;
        return `<tr style="cursor:pointer;" onclick="openToolDetailModal('${tool.qr_code}')">
            <td style="font-family: monospace;">${tool.qr_code}</td>
            <td><strong>${tool.name}</strong></td>
            <td>${cockpitDteBadge(band)}</td>
            <td>${tool.status}</td>
            <td>${locationLine}</td>
        </tr>`;
    }).join('');
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
    document.getElementById('view-drawer-map').style.display = 'none';
    document.getElementById('view-cal-cockpit').style.display = 'none';

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

        // 4.5 Render charts (see section 4.5 below) from the same globalTools this view
        // already fetched -- no extra round trip for these two; the activity trend is a
        // separate fetch since it's not part of either payload above.
        renderStatusBreakdownChart();
        renderCalComplianceChart();
        loadActivityTrendChart();
        loadAuditComplianceTrendChart();

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
                    <td style="color: var(--accent); font-weight:bold;">${icon('user')} ${t.user_name || 'Unknown'}</td>
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
// 4.5 CHARTS (hand-rolled SVG -- no charting library)
// ==========================================
// Deliberately not a charting library: matches this app's existing preference for vendoring
// small, self-contained pieces (see icons.js) over adding a runtime dependency, and every
// chart here is simple enough (a donut, a grouped bar chart) that hand-rolling the SVG is
// less code than wiring up a library would be. Colors are hardcoded hex (not var(--x)) since
// these strings get parsed as literal SVG attribute values, not CSS -- no cascade to resolve
// a custom property against.
const CHART_COLORS = {
    in: '#22c55e', out: '#CB6015', missing: '#ef4444', broken: '#f59e0b',
    worn: '#eab308', retired: '#6b7280', transfer: '#3b82f6',
    compliant: '#22c55e', dueSoon: '#f59e0b', overdue: '#ef4444',
    checkout: '#CB6015', checkin: '#3b82f6',
};

/**
 * Renders a donut chart into containerId from segments (array of {label, value, color}),
 * plus a text legend with counts. Segments with value 0 are dropped from the ring but still
 * listed in the legend (at 0) so a category's absence is visible, not just missing.
 */
function renderDonutChart(containerId, segments, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    if (total === 0) {
        container.innerHTML = `<div style="text-align:center; color:var(--muted); padding:30px 0; font-size:13px;">No data yet.</div>`;
        return;
    }

    const size = options.size || 150;
    const strokeWidth = options.strokeWidth || 24;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;

    let offset = 0;
    const rings = segments.filter(s => s.value > 0).map(s => {
        const dash = (s.value / total) * circumference;
        const circle = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${s.color}" stroke-width="${strokeWidth}" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${s.label}: ${s.value}</title></circle>`;
        offset += dash;
        return circle;
    }).join('');

    const legend = segments.map(s => `
        <div style="display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:5px;">
            <span style="width:10px; height:10px; border-radius:2px; background:${s.color}; flex-shrink:0;"></span>
            <span style="color:var(--muted);">${s.label}</span>
            <strong style="margin-left:auto;">${s.value}</strong>
        </div>
    `).join('');

    container.innerHTML = `
        <div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap;">
            <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0;">
                ${rings}
                <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" style="fill:var(--text); font-size:22px; font-weight:700;">${total}</text>
            </svg>
            <div style="flex:1; min-width:130px;">${legend}</div>
        </div>
    `;
}

/**
 * Renders a two-series grouped bar chart into containerId from points (array of
 * {label, a, b}) -- used for the checkout/check-in activity trend. Only every few x-axis
 * labels are drawn (spaced out by labelEvery) since 30 individual day labels would overlap
 * at any reasonable chart width.
 */
function renderBarChart(containerId, points, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!points.length) {
        container.innerHTML = `<div style="text-align:center; color:var(--muted); padding:30px 0; font-size:13px;">No activity in this window yet.</div>`;
        return;
    }

    const width = options.width || 760;
    const height = options.height || 160;
    const paddingBottom = 22;
    const plotHeight = height - paddingBottom;
    const maxVal = Math.max(1, ...points.map(p => Math.max(p.a, p.b)));
    const groupWidth = width / points.length;
    const barWidth = Math.max(2, Math.min(14, groupWidth / 2.5));
    const labelEvery = Math.max(1, Math.ceil(points.length / 10));

    const bars = points.map((p, i) => {
        const groupCenter = i * groupWidth + groupWidth / 2;
        const aHeight = (p.a / maxVal) * plotHeight;
        const bHeight = (p.b / maxVal) * plotHeight;
        const label = i % labelEvery === 0
            ? `<text x="${groupCenter}" y="${height - 6}" text-anchor="middle" style="fill:var(--muted); font-size:9px;">${p.label}</text>`
            : '';
        return `
            <rect x="${groupCenter - barWidth - 1}" y="${plotHeight - aHeight}" width="${barWidth}" height="${Math.max(0, aHeight)}" fill="${CHART_COLORS.checkout}" rx="1.5"><title>${p.label} checkout: ${p.a}</title></rect>
            <rect x="${groupCenter + 1}" y="${plotHeight - bHeight}" width="${barWidth}" height="${Math.max(0, bHeight)}" fill="${CHART_COLORS.checkin}" rx="1.5"><title>${p.label} check-in: ${p.b}</title></rect>
            ${label}
        `;
    }).join('');

    container.innerHTML = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

/** Builds the Tool Status Breakdown donut from the already-fetched globalTools -- no extra request. Retired tools are included (unlike most KPIs on this page, which exclude them) since this chart's whole point is showing the full inventory's status mix. */
function renderStatusBreakdownChart() {
    const counts = { In: 0, Out: 0, Missing: 0, Broken: 0, Worn: 0, Retired: 0, 'Pending Transfer': 0, 'In Calibration': 0 };
    globalTools.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
    renderDonutChart('chart-status-breakdown', [
        { label: 'In', value: counts.In, color: CHART_COLORS.in },
        { label: 'Out', value: counts.Out, color: CHART_COLORS.out },
        { label: 'Missing', value: counts.Missing, color: CHART_COLORS.missing },
        { label: 'Broken', value: counts.Broken, color: CHART_COLORS.broken },
        { label: 'Worn', value: counts.Worn, color: CHART_COLORS.worn },
        { label: 'In Transfer/Cal', value: counts['Pending Transfer'] + counts['In Calibration'], color: CHART_COLORS.transfer },
        { label: 'Retired', value: counts.Retired, color: CHART_COLORS.retired },
    ]);
}

/** Builds the Calibration Compliance donut (Compliant / Due within 30 days / Overdue) from the already-fetched globalTools, mirroring the same 30-day window the "Cal Due" KPI card already uses. Only tools flagged is_calibrated count -- tools that don't require it aren't part of this picture at all. */
function renderCalComplianceChart() {
    const today = new Date();
    const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    let compliant = 0, dueSoon = 0, overdue = 0;
    globalTools.forEach(t => {
        if (!t.is_calibrated || !t.cal_due_date) return;
        const due = new Date(t.cal_due_date);
        if (due < today) overdue++;
        else if (due <= thirtyDaysFromNow) dueSoon++;
        else compliant++;
    });
    renderDonutChart('chart-cal-compliance', [
        { label: 'Compliant (30+ days)', value: compliant, color: CHART_COLORS.compliant },
        { label: 'Due Within 30 Days', value: dueSoon, color: CHART_COLORS.dueSoon },
        { label: 'Overdue', value: overdue, color: CHART_COLORS.overdue },
    ]);
}

/**
 * Renders a single-series bar chart into containerId from points (array of {label, pct}),
 * one bar per shift window, colored by compliance level (green = fully audited, amber =
 * partially, red = not at all, gray = no auditable toolboxes that window at all -- N/A, not
 * a failure). Structurally similar to renderBarChart() but one bar per point instead of a
 * pair, since compliance is a single percentage, not two comparable series.
 */
function renderComplianceTrendChart(containerId, points) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!points.length) {
        container.innerHTML = `<div style="text-align:center; color:var(--muted); padding:30px 0; font-size:13px;">No shift windows yet.</div>`;
        return;
    }

    const width = 760, height = 160, paddingBottom = 30, plotHeight = height - paddingBottom;
    const groupWidth = width / points.length;
    const barWidth = Math.max(4, Math.min(28, groupWidth * 0.6));

    const bars = points.map((p, i) => {
        const center = i * groupWidth + groupWidth / 2;
        const pct = p.pct === null ? 0 : p.pct;
        const barHeight = (pct / 100) * plotHeight;
        const color = p.pct === null ? '#6b7280' : (p.pct >= 100 ? CHART_COLORS.compliant : (p.pct > 0 ? CHART_COLORS.dueSoon : CHART_COLORS.overdue));
        const title = p.pct === null ? `${p.label}: no auditable toolboxes` : `${p.label}: ${p.pct}% audited`;
        return `
            <rect x="${center - barWidth / 2}" y="${plotHeight - barHeight}" width="${barWidth}" height="${Math.max(1, barHeight)}" fill="${color}" rx="2"><title>${title}</title></rect>
            <text x="${center}" y="${height - 6}" text-anchor="middle" style="fill:var(--muted); font-size:9px;">${p.label}</text>
        `;
    }).join('');

    container.innerHTML = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

/**
 * Fetches GET /api/dashboard/audit-compliance-trend and builds the last-7-days shift-audit
 * compliance chart -- one bar per shift window (14 = 7 days x 2 windows/day), colored by
 * how much of that window's auditable inventory actually got audited. Ties the mandatory
 * shift-audit gate (see getAuditWindowStart in server.js) to a visible trend instead of only
 * ever showing the CURRENT window's pass/fail on the audit-status widget above.
 */
async function loadAuditComplianceTrendChart() {
    try {
        const res = await fetch('/api/dashboard/audit-compliance-trend?windows=14');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load');

        const points = data.windows.map(w => {
            const d = new Date(w.window_start);
            const label = `${d.getMonth() + 1}/${d.getDate()} ${w.is_morning ? 'AM' : 'PM'}`;
            return { label, pct: w.compliance_pct };
        });

        renderComplianceTrendChart('chart-audit-compliance-trend', points);
    } catch (e) {
        const container = document.getElementById('chart-audit-compliance-trend');
        if (container) container.innerHTML = `<div style="text-align:center; color:var(--red); padding:30px 0; font-size:13px;">Failed to load audit compliance trend.</div>`;
    }
}

/** Fetches GET /api/dashboard/activity-trend and builds the 30-day checkout/check-in grouped bar chart, zero-filling every day in the window (not just days with rows) so the x-axis stays evenly spaced and a quiet day reads as zero, not a gap. */
async function loadActivityTrendChart() {
    try {
        const res = await fetch('/api/dashboard/activity-trend?days=30');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load');

        const byDay = {};
        data.data.forEach(row => {
            if (!byDay[row.day]) byDay[row.day] = { a: 0, b: 0 };
            if (row.action === 'CHECKOUT_TOOL') byDay[row.day].a = parseInt(row.count, 10);
            if (row.action === 'CHECKIN_TOOL') byDay[row.day].b = parseInt(row.count, 10);
        });

        const points = [];
        for (let i = data.days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            const entry = byDay[key] || { a: 0, b: 0 };
            points.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, a: entry.a, b: entry.b });
        }

        renderBarChart('chart-activity-trend', points);
    } catch (e) {
        const container = document.getElementById('chart-activity-trend');
        if (container) container.innerHTML = `<div style="text-align:center; color:var(--red); padding:30px 0; font-size:13px;">Failed to load activity trend.</div>`;
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
    document.getElementById('view-drawer-map').style.display = 'none';
    document.getElementById('view-cal-cockpit').style.display = 'none';
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
                <td style="color: var(--accent); font-weight:bold;">${icon('user')} ${t.user_name || 'Unknown'}</td>
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
    document.getElementById('td-thumb').innerHTML = entity.photo_url ? `<img src="${entity.photo_url}" style="width:100%;height:100%;border-radius:8px;object-fit:cover;">` : icon('wrench');
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
            bodyHtml += `<div style="margin-bottom:15px; font-size:13px; color: var(--accent); font-weight:bold;">${icon('user')} Checked out to ${outEntry.user_name || 'Unknown'} since ${since}</div>`;
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
        bodyHtml += `<div><a href="${entity.replacement_url}" target="_blank" style="color:var(--blue); font-size: 13px; text-decoration: none;">${icon('shopping-cart')} Open Replacement Link →</a></div>`;
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