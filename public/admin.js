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
let globalToolGroupsCache = [];
let globalDeptGroupsCache = []; // cross-checkout department groups (migrations/020) -- {group_id, name}
// Sub-assemblies (migrations/018) of whichever tool's entity modal is currently open --
// populated by openEntityModal() from entity.sub_assemblies (already embedded on every
// GET /api/tools row), so openEditSubAssemblyForm()/deleteSubAssembly() can look a row up by
// sub_id without inlining its data into an onclick attribute.
let currentEntitySubAssemblies = [];
// Calibration history rows of whichever tool's history list was most recently loaded --
// populated by loadCalibrationHistory() so toggleCorrectionForm() can pre-fill a correction
// form from a record's current values by cal_id without inlining its data into an onclick
// attribute (same reasoning as currentEntitySubAssemblies above).
let currentCalHistoryRecords = [];

// Which dept-content-/box-content-/drawer-content- nodes of the Master Storage & Asset Tree
// are currently expanded, keyed by that content div's id -- see toggleTreeVisibility() and
// renderEditableInfraTree(). Anything not present here is treated as collapsed (the default
// for a node never touched this session), and any entry here survives a full tree rebuild
// (e.g. after saving an edit), so expanding down into one toolbox/drawer and then editing a
// tool no longer dumps the whole tree back open -- previously every render started every
// node expanded with nothing remembered at all.
let treeExpandState = {};

// Batch Move mode state for the Master Storage & Asset Tree -- see toggleBatchMoveMode() and
// PUT /api/tools/batch-move. selectedToolIds holds numeric tool_id, not qr_code (matching
// what the batch-move endpoint expects), unlike most of this file's tool lookups.
let batchMoveMode = false;
let selectedToolIds = new Set();

let adminIdleTimer = null;
// Separate from (and much shorter than) the session cookie's own 8-hour sliding expiry (see
// server.js) -- that protects the credential itself from living forever, this protects a
// shared/unattended admin terminal from being left logged in and walked away from. Five
// minutes of no mouse/keyboard/touch activity anywhere on the page logs out automatically.
const ADMIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Bumped at the start of every renderEditableInfraTree() call so an overlapping, slower-to-
// resolve call can detect it's no longer the latest and skip applying its (by then stale)
// results -- see the guard in that function.
let treeRenderToken = 0;

// ==========================================
// 2. UTILITIES & VIEW TOGGLES
// ==========================================

/** Live-uppercases a part/serial number field as the tech types -- shop-floor convention is that these are always read/written in caps off a physical stamp or label. Wired via oninput on every part-number/serial-number input; server.js normalizes the same way on every write path as a backstop (CSV import included), so the stored value is always uppercase regardless of entry path. */
function uppercaseInput(el) {
    el.value = el.value.toUpperCase();
}

/**
 * Returns the same calendar date one year later, as a `YYYY-MM-DD` string (the native
 * `<input type="date">` value format) -- used to default a "Calibration Due" field to one year
 * past whichever "Last Calibrated" date was just picked, the shop's usual interval, wired via
 * onchange on every "Last Calibrated" field throughout the app (ingest form, +Log Calibration,
 * sub-assembly, tool edit). Left freely editable afterward -- this only sets the initial default.
 * Deliberately built from local year/month/day integers (`new Date(y, m, d)`'s numeric-argument
 * form, never a parsed date STRING) rather than any UTC round-trip (e.g. `.toISOString()` on a
 * `new Date(dateStr)`), since this app has been bitten before by exactly that class of
 * timezone-dependent off-by-one-day bug on calibration dates (see GET /api/tools's
 * cal_due_date::text cast and GROUP_MEMBER_BLOCKED_SQL's CURRENT_DATE fix in server.js).
 */
function oneYearFromDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return '';
    const result = new Date(y + 1, m - 1, d);
    return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
}

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
 * and chevron-right (collapsed). Also records the new state in treeExpandState, keyed by
 * containerId, so a later full tree rebuild (renderEditableInfraTree() re-fetches and
 * rebuilds from scratch on every save) can restore exactly which nodes were open instead of
 * defaulting everything back to expanded.
 */
function toggleTreeVisibility(containerId, headerElement) {
    const container = document.getElementById(containerId);
    const toggleIcon = headerElement.querySelector('.toggle-icon');
    if (!container) return;

    const expanding = container.style.display === 'none';
    container.style.display = expanding ? 'block' : 'none';
    if (toggleIcon) toggleIcon.innerHTML = expanding ? ICONS['chevron-down'] : ICONS['chevron-right'];
    treeExpandState[containerId] = expanding;
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
 *   - weight < 2 (below tool_rep): hides #hub-inventory, #hub-reports, and #hub-departments hub cards.
 *   - weight < 3 (below dept_admin): hides #card-manage-boxes, #card-manage-drawers,
 *     #card-manage-users, #card-inventory-import (bulk CSV import), #card-trace-investigations,
 *     #card-tool-groups, #card-mpc-import, and #audit-schedule-card.
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
        safeSetDisplay('hub-departments', 'none');
    }
    if (currentAdminWeight < 4) {
        safeSetDisplay('card-manage-depts', 'none');
        safeSetDisplay('card-manage-dept-groups', 'none');
        safeSetDisplay('card-calendar-feed', 'none');
    }
    if (currentAdminWeight < 3) {
        safeSetDisplay('card-manage-boxes', 'none');
        safeSetDisplay('card-manage-drawers', 'none');
        safeSetDisplay('card-manage-users', 'none');
        safeSetDisplay('card-inventory-import', 'none');
        safeSetDisplay('card-trace-investigations', 'none');
        safeSetDisplay('card-tool-groups', 'none');
        safeSetDisplay('card-mpc-import', 'none');
        safeSetDisplay('audit-schedule-card', 'none');
    }

    // Options capped at the viewer's own weight (inclusive) -- matches the server's
    // POST /api/users hierarchy check, which now allows creating a peer, e.g. a super_admin
    // creating another super_admin, not just strictly-subordinate roles.
    const newRoleEl = document.getElementById('new-role');
    if (newRoleEl) newRoleEl.innerHTML = roleOptionsUpTo(currentAdminWeight, 'technician');

    if (currentAdminWeight >= 3) { loadUsers(); }
    syncStorageHierarchyDropdowns();
    if (currentAdminWeight >= 2) { fetchNextToolId(); }

    // Primed once here (not re-fetched on every renderEditableInfraTree() call, which would
    // otherwise re-run this aggregated roll-up query on every dept/box/drawer/tool
    // create/edit/delete) so the tool edit form's Group dropdown has data as soon as it's
    // needed. Groups change rarely, and loadToolGroups() (Reports card) keeps this cache fresh
    // whenever they're actually managed -- this bootstrap fetch just covers the case where a
    // tool is edited before Reports has ever been visited this session.
    fetch('/api/tool-groups').then(r => r.json()).then(data => { if (data.success) globalToolGroupsCache = data.groups; }).catch(() => {});

    // Cross-checkout department groups (migrations/020) -- same reasoning as the tool-groups
    // prefetch above: primed here so a department's edit view has its group dropdown ready
    // immediately, not just after this card has been visited. Also renders #dept-groups-list
    // directly (unlike tool groups, which only cache here and render on-demand elsewhere) since
    // this card has no separate "visit to load" entry point of its own.
    if (currentAdminWeight >= 4) loadDeptGroups();

    // Deep link from the dashboard's read-only tool card ("Open in Admin Portal", a new tab --
    // see openToolDetailModal() in dashboard.js) -- ?tool=<qr_code> jumps straight to that tool's
    // entity modal once logged in (or already logged in, via restoreAdminSession()'s own call
    // into this same function). No separate permission check needed here: openEntityModal()
    // already shows edit controls only up to the viewer's own weight, exactly as it does for
    // every other way of reaching this same modal. renderEditableInfraTree() is awaited first
    // since globalToolsCache (which openEntityModal('tool', ...) reads) isn't populated until
    // the Inventory tab has been visited at least once -- normally lazy, but this entry point
    // needs it immediately. The query param is then stripped so a later refresh doesn't reopen
    // the same tool.
    const deepLinkTool = new URLSearchParams(window.location.search).get('tool');
    if (deepLinkTool) {
        renderEditableInfraTree().then(() => {
            openEntityModal('tool', deepLinkTool);
            history.replaceState({}, '', window.location.pathname);
        });
    }

    resetAdminIdleTimer();
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

/**
 * Restarts the 5-minute idle-logout countdown (see ADMIN_IDLE_TIMEOUT_MS). Called on every
 * mousedown/mousemove/keydown/scroll/touchstart/click once a session is active, and once from
 * bootstrapAdminUI() to start the clock. No-ops while the login wall is showing so a stray
 * event listener firing before login (or after logout, until the next reload) can't do anything.
 */
function resetAdminIdleTimer() {
    if (adminIdleTimer) clearTimeout(adminIdleTimer);
    if (!currentAdminBadge) return;
    adminIdleTimer = setTimeout(() => {
        alert('⏱️ Logged out after 5 minutes of inactivity.');
        logoutAdmin();
    }, ADMIN_IDLE_TIMEOUT_MS);
}
['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach(evt => {
    document.addEventListener(evt, resetAdminIdleTimer, { passive: true });
});

/** Submits the logged-in user's own username/PIN changes from the My Account panel to PUT /api/users/me/update, then clears the input fields on success. */
async function updateMyAccount() {
    const payload = { new_username: document.getElementById('my-new-username').value, new_pin: document.getElementById('my-new-pin').value };
    const res = await fetch('/api/users/me/update', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) { alert('✅ Account updated successfully.'); document.getElementById('my-new-username').value = ''; document.getElementById('my-new-pin').value = ''; }
    else { const err = await res.json(); alert('❌ ' + err.error); }
}

/**
 * Loads the logged-in user's own login card into #my-login-card-preview, if one's been
 * generated -- self-service counterpart to the "Login Card" section on a subordinate's entity
 * card (see issueUserLoginCard()/printUserLoginCard()), which a super_admin can never reach for
 * their OWN account: GET /api/users only ever returns *subordinates* (strictly lower role
 * weight), so the single most senior account in the system never appears in its own Manage
 * Accounts list at all, let alone passes the hierarchy check that route's issue/view actions
 * require. Probes with a throwaway Image() rather than fetch() so a 404 (no card yet) shows a
 * plain "not generated" message instead of a broken-image icon.
 */
function loadMyLoginCard() {
    const preview = document.getElementById('my-login-card-preview');
    const printBtn = document.getElementById('btn-print-my-card');
    if (!preview) return;
    const probe = new Image();
    const src = `/api/users/me/login-card.png?t=${Date.now()}`; // cache-bust so a reissue is reflected immediately
    probe.onload = () => {
        preview.innerHTML = `<img src="${src}" style="width:120px;height:120px;object-fit:contain;background:#fff;border-radius:4px;">`;
        if (printBtn) printBtn.style.display = '';
    };
    probe.onerror = () => {
        preview.innerHTML = `<span style="color:var(--muted); font-size:12px;">No login card generated yet.</span>`;
        if (printBtn) printBtn.style.display = 'none';
    };
    probe.src = src;
}

/** Issues/reissues the logged-in user's own login card (POST /api/users/me/login-token), then reloads the preview. Reissuing invalidates whatever card they already had, same as the admin-issued version. */
async function issueMyLoginCard() {
    if (document.getElementById('my-login-card-preview').querySelector('img') && !confirm('Reissue your login card? Your current card (printed or digital) will stop working immediately.')) return;
    const res = await fetch('/api/users/me/login-token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' } });
    if (!res.ok) return alert('❌ Failed to generate login card.');
    loadMyLoginCard();
}

/** Prints the logged-in user's own login card -- same layout as printUserLoginCard(), just sourced from GET /api/session for full_name/badge_id (self) instead of globalUsersCache (subordinates only, see loadMyLoginCard()'s comment). */
async function printMyLoginCard() {
    const session = await (await fetch('/api/session')).json();
    if (!session.success) return;

    document.getElementById('toolbox-print-sheet-content').innerHTML = `
        <div style="display:flex; align-items:center; gap:20px; border:2px solid #000; border-radius:12px; padding:24px; max-width:400px;">
            <img src="/api/users/me/login-card.png" style="width:140px; height:140px; object-fit:contain;">
            <div>
                <div style="font-size:20px; font-weight:bold;">${session.user.full_name}</div>
                <div style="font-family:monospace; font-size:14px; color:#555; margin-top:4px;">${session.user.badge_id}</div>
                <div style="font-size:11px; color:#777; margin-top:10px;">Scan to sign in to the ToolTracker admin panel.</div>
            </div>
        </div>
    `;

    const area = document.getElementById('toolbox-print-sheet-area');
    area.style.display = 'block';
    await waitForImages(area);
    window.print();
}

// ==========================================
// 4. PHOTO UPLOADS
// ==========================================
/**
 * Records which entity (type + id) a photo upload is destined for, then opens the hidden
 * #global-photo-upload file picker shared by every "Photo" button. `toolId` is only used for
 * type 'calibration' (a calibration_records row has no tree/list of its own to refresh --
 * see handlePhotoUpload) and is ignored for every other type.
 */
function triggerPhotoUpload(type, id, toolId) {
    uploadTarget = { type, id, toolId };
    document.getElementById('global-photo-upload').click();
}

/**
 * Change handler for #global-photo-upload. Packs the selected file plus the pending
 * uploadTarget (type/id set by triggerPhotoUpload) into FormData and POSTs to /api/upload.
 * Refreshes the personnel lists on a 'user' target, this tool's calibration history on a
 * 'calibration' target, or the infrastructure tree for any other entity type, then resets the
 * file input.
 */
async function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('photo', file);
    formData.append('entity_type', uploadTarget.type);
    formData.append('entity_id', uploadTarget.id);

    let res;
    try {
        res = await fetch('/api/upload', { method: 'POST', headers: { 'X-Requested-With': 'ToolTracker' }, body: formData });
    } catch (err) {
        alert('❌ Network error during upload.');
        event.target.value = '';
        return;
    }

    // Parsed separately from the fetch itself -- a response that arrived but isn't valid JSON
    // (e.g. a proxy/server error page) is a server-side problem, not a "network error", and
    // deserves its own message rather than being lumped in with an actual dropped connection.
    let data;
    try {
        data = await res.json();
    } catch (err) {
        alert(`❌ Unexpected response from server (status ${res.status}). Try again, and let an admin know if it keeps happening.`);
        event.target.value = '';
        return;
    }

    if (res.ok) {
        alert('✅ Photo uploaded successfully!');
        if (uploadTarget.type === 'user') { loadUsers(); loadRosterDirectory(); }
        else if (uploadTarget.type === 'calibration') { loadCalibrationHistory(uploadTarget.toolId); }
        else {
            // Rebuild the tree first so globalDrawersCache/globalBoxesCache/globalToolsCache
            // reflect the new photo_url, THEN -- if this entity's own card is the one still
            // open (the only way to have reached the Photo button in the first place) --
            // re-open it fresh. Without this, the modal kept showing its OLD <img src>, which
            // the upload endpoint may have just deleted from disk (see deletePhotoFile() in
            // POST /api/upload), and for a drawer specifically its tool-position markers
            // (tools.position_x/position_y -- entirely separate columns, never touched by a
            // photo upload) stayed rendered against the stale image instead of the new one,
            // making already-placed tools look "lost" even though nothing was actually
            // deleted. Re-opening re-renders renderPositionMap() against the fresh photo with
            // that same unchanged position data.
            await renderEditableInfraTree();
            const modalOpen = document.getElementById('entity-modal-overlay').style.display === 'flex';
            if (modalOpen) openEntityModal(uploadTarget.type, uploadTarget.id);
        }
    } else {
        alert('❌ ' + (data.error || 'Upload failed.'));
    }
    event.target.value = '';
}

// ==========================================
// 4.5 TOOLBOX PRINT SHEET
// ==========================================
/**
 * Resolves once every <img> under container has finished loading (or errored -- a missing/
 * broken one shouldn't block printing the rest). Shared by openToolboxPrintSheet() and
 * printUserLoginCard() below: both build print content full of <img>s generated fresh per
 * request (scan-code.png / login-card.png) rather than pre-existing static files, so they load
 * measurably slower than a typical cached image -- window.print() firing before they're done
 * rasterizes blank boxes on a real printer (a screen preview taken even a moment later can
 * misleadingly look fine, which is how this shipped broken once already).
 */
async function waitForImages(container) {
    const images = Array.from(container.querySelectorAll('img'));
    await Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
    })));
}

/**
 * Shared "EMPTY" visual stamp for a drawer with zero tools assigned (Retired tools don't count --
 * every caller excludes them itself, matching the print sheet's own long-standing tools filter).
 * Just the word itself (no background badge/oval) at partial opacity, so it reads as a light
 * watermark over the photo rather than a solid sticker. Text stays black -- style.css's
 * `@media print` block forces `color: black !important` under .printable-area (see numberBadge()
 * below) anyway -- with a white halo (`text-shadow`, a separate property that override doesn't
 * touch) standing in for the removed background so it still reads against a dark patch of photo,
 * in print or on screen. `absolute` floats it centered over a photo (the caller's container must
 * already be position:relative); pass false for a page/section with no photo, where the caller
 * centers it itself (e.g. with a flex wrapper) alongside normal document flow.
 */
function emptyDrawerStamp(fontSizePx, absolute = true) {
    const position = absolute
        ? 'position:absolute; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-16deg);'
        : 'transform:rotate(-16deg);';
    const haloTight = Math.round(fontSizePx * 0.1);
    const haloWide = Math.round(fontSizePx * 0.2);
    return `<div style="${position} opacity:0.6; color:#000; font-size:${fontSizePx}px; font-weight:900;
                letter-spacing:${Math.round(fontSizePx * 0.12)}px; text-transform:uppercase; white-space:nowrap;
                text-shadow: 0 0 ${haloTight}px #fff, 0 0 ${haloTight}px #fff, 0 0 ${haloWide}px #fff, 0 0 ${haloWide}px #fff;
                pointer-events:none;">Empty</div>`;
}

/**
 * Builds and prints a reference sheet for one toolbox: every drawer in it gets a full tabloid
 * (11x17in landscape -- see the injected <style> right before window.print() below, which sets
 * this scoped to just this print job) "map" page, titled "<toolbox> -- <drawer>" so a page is
 * self-identifying without flipping back to the first one. A drawer with a photo gets a second
 * "Tool List" page right after its map, with full details (code, name, ID) for every tool in it.
 * An empty drawer (zero non-Retired tools) still gets both pages -- its photo (if any) and its
 * Tool List page both show the EMPTY stamp instead of being skipped, so the binder always has an
 * entry for every drawer, not just occupied ones.
 * Meant to be printed and kept in a binder near the physical box, so a tool can be signed out by
 * scanning straight from the page instead of needing a barcode label on the tool itself or in
 * its drawer slot.
 *
 * The drawer's photo fills essentially the whole map page, and every tool already pinpointed on
 * it (the shadow-board map, see renderPositionMap()) gets its own scan code floated directly over
 * its exact spot in the photo, tagged with a small numbered badge (1, 2, 3...) in reading order
 * (top-to-bottom, left-to-right) -- the SAME numbers label the matching rows on the Tool List
 * page right after it, so a glance at either page finds the other's entry for the same tool. The
 * code itself is still there to scan directly from the map; the badge is purely a human
 * cross-reference. An earlier version floated the full name+ID text directly on the photo instead
 * of a number, which a real print showed overlapping badly on drawers with several tools
 * positioned close together (an actual physical-crowding problem, not a layout one) -- a small
 * number avoids that while still answering "which tool is this" at a glance, with the full detail
 * living on the dedicated list page instead. The large tabloid page is still what makes floating
 * anything directly on the photo practical at all (an earlier letter-sized version used numbered
 * pins pointing to a separate legend instead, since even a bare code shrunk to fit inline on that
 * smaller photo would've been under a reliable scan size).
 *
 * Tools not yet pinpointed can't be floated on the photo at all (there's no position to use) --
 * they list instead in a narrow sidebar alongside the map (no number, since there's no map badge
 * to match) and again, unnumbered, at the end of the Tool List page. A drawer with no photo on
 * file at all falls back to a single dense full-page grid of every tool in it instead of a
 * map+list pair, since there's no map to pair a list with -- that grid already shows full details.
 *
 * A static catalog snapshot only -- deliberately NOT live status (In/Out/etc.) or anything
 * date-based (calibration due date). These pages are meant to be printed once and left in
 * the binder indefinitely, not reprinted on any schedule -- a due date frozen in ink the day
 * it was printed would just go wrong forever, which is worse than not showing one at all.
 * Retired tools are excluded (nothing to sign out). Each code comes from
 * GET /api/tools/:id/scan-code.png -- a text-free Data Matrix generated fresh for this purpose
 * (see that route in server.js for why), not the tool's own stored sticker-label image. Layout
 * is otherwise a pure client-side render from the same globalBoxesCache/globalDrawersCache/
 * globalToolsCache already kept in sync by renderEditableInfraTree().
 *
 * Follows the same .printable-area + window.print() pattern as the existing Custom Report
 * Builder's Print button (see style.css's @media print block) -- the browser's own print
 * rendering, no PDF library. #toolbox-print-sheet-area starts display:none (see admin.html)
 * so it doesn't clutter the screen; this function reveals it right before printing, and the
 * afterprint listener below hides it again afterward.
 */
async function openToolboxPrintSheet(boxId) {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

    const box = globalBoxesCache.find(b => b.box_id == boxId);
    if (!box) return;
    const drawers = globalDrawersCache.filter(d => d.box_id == boxId).sort(byName);

    // Explicit inches, not width:100%/height:100% -- #toolbox-print-sheet-area (.printable-area)
    // has no height of its own (just width:100%, see style.css), so a percentage height here
    // would have nothing definite to resolve against and collapse to the content's own natural
    // size instead of actually filling a page (confirmed via a live PDF-generation test: the
    // page div measured 0 height). Matches the 17x11in page / 0.5in margin injected into
    // #toolbox-sheet-page-size below -- keep both in sync if either ever changes.
    //
    // 0.5in, not the original 0.25in: James reported real printed photos looking cropped at the
    // edges. A CSS @page margin only controls the DOCUMENT's content box -- it has no say over
    // a real printer's own hardware "non-printable area" (nearly every printer, tabloid-size
    // ones especially, physically can't lay ink all the way to the paper edge), and since the
    // drawer photo is deliberately sized to fill essentially the whole page, anything inside
    // that unprintable band gets silently clipped right at the photo's own edge -- exactly the
    // reported symptom. 0.25in was too tight a margin to reliably clear that; 0.5in is a
    // conservative buffer that should clear it on most printers. If photos still look clipped
    // after this, the printer itself likely doesn't support true 17x11in (Tabloid/Ledger) paper
    // and is silently substituting/scaling onto a smaller sheet -- a printer/driver setting to
    // check, not something a page margin can fix.
    const PAGE_SIZE = 'width:16in; height:10in;';
    const pageDiv = (inner) => `<div style="break-before: page; ${PAGE_SIZE} box-sizing:border-box; display:flex; flex-direction:column;">${inner}</div>`;

    // Compact scan-code-plus-text card, used for the not-yet-pinpointed sidebar and the no-photo
    // grid fallback -- NOT the on-photo overlay, which floats just a numbered code (see
    // `overlays` below) to avoid text pushing neighboring tools' labels into each other on a busy
    // photo. Neither of these two layouts has that overlap risk (a sidebar list and an
    // auto-wrapping grid both just add rows as needed), so there's no reason to drop the name/ID
    // text here too.
    const toolCard = (t, codeSizePx) => `
        <div style="display:flex; align-items:center; gap:4px; white-space:nowrap;">
            <img src="/api/tools/${t.tool_id}/scan-code.png" style="width:${codeSizePx}px; height:${codeSizePx}px; object-fit:contain; flex-shrink:0;">
            <div style="line-height:1.15; min-width:0;">
                <div style="font-size:12px; font-weight:bold; white-space:${codeSizePx > 40 ? 'nowrap' : 'normal'};">${t.name}</div>
                <div style="font-size:11px; font-family:monospace;">${t.qr_code}</div>
            </div>
        </div>`;

    // Small circular number badge, shared by the map overlay and the Tool List row below so both
    // stay visually consistent. White background with black text, not the other way around --
    // style.css's `@media print` block forces `color: black !important` on everything under
    // .printable-area (this whole print sheet), which silently turned a white number on a black
    // circle invisible (caught via a live print render, not the diff review -- the DOM had the
    // right "1"/"2" text all along, it just rendered black-on-black). Matches the scan code
    // image's own established "opaque white, legible against anything" approach instead of
    // fighting that print rule. box-sizing:border-box plus no border means line-height can just
    // equal `size` to center the number -- no border-width math to get wrong.
    const numberBadge = (number, size) => `
        <div style="box-sizing:border-box; flex:0 0 auto; width:${size}px; height:${size}px; border-radius:50%; text-align:center;
                    line-height:${size}px; font-size:12px; font-weight:bold; color:#000;
                    background:${number != null ? '#fff' : 'transparent'};
                    ${number != null ? 'box-shadow:0 1px 3px rgba(0,0,0,0.6);' : ''}">${number != null ? number : ''}</div>`;

    // Tool List page row -- same code+name+ID as toolCard() above, plus a leading number badge
    // matching the one floated over this tool's position on the map page (null for an
    // unpositioned tool, which has no map badge to match).
    const detailRow = (t, number) => `
        <div style="display:flex; align-items:center; gap:8px; border:1px solid #ccc; border-radius:5px; padding:6px;">
            ${numberBadge(number, 22)}
            ${toolCard(t, 44)}
        </div>`;

    const pageTitle = (drawer, label) => `
        <div style="flex:0 0 auto; display:flex; justify-content:space-between; align-items:baseline; margin:0 0 8px; padding-bottom:6px; border-bottom:3px solid #000;">
            <h3 style="margin:0; font-size:24px;">${box.name} &mdash; ${drawer.name}${label ? ` <span style="font-size:16px; font-weight:normal; color:#555;">(${label})</span>` : ''}</h3>
            <span style="font-size:11px; color:#555;">printed ${new Date().toLocaleDateString()}</span>
        </div>`;

    const drawerPages = drawers.map(drawer => {
        const tools = globalToolsCache.filter(t => t.drawer_id == drawer.drawer_id && t.status !== 'Retired');

        if (!drawer.photo_url) {
            // No photo to float cards on -- fall back to a dense grid of every tool, same as
            // the sidebar card style just bigger, filling the whole page instead of a narrow
            // column. The large tabloid page means even this fallback fits far more per page
            // than the old letter-sized version did. Already shows full details, so there's no
            // separate Tool List page for this case.
            const grid = tools.length
                ? `<div style="flex:1 1 auto; min-height:0; overflow:hidden; display:grid; grid-auto-rows:min-content; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:10px; align-content:start;">
                        ${tools.sort(byName).map(t => `<div style="border:1px solid #ccc; border-radius:5px; padding:6px;">${toolCard(t, 50)}</div>`).join('')}
                   </div>`
                : `<div style="flex:1 1 auto; min-height:0; display:flex; align-items:center; justify-content:center;">${emptyDrawerStamp(64, false)}</div>`;
            return pageDiv(`${pageTitle(drawer)}${grid}`);
        }

        // Reading order top-to-bottom/left-to-right so a glance down the sidebar roughly
        // matches a glance down the photo, for whatever's left unpinpointed -- also the order
        // the 1, 2, 3... map badges and Tool List rows are numbered in.
        const positioned = tools.filter(t => t.position_x !== null && t.position_y !== null)
            .sort((a, b) => a.position_y - b.position_y || a.position_x - b.position_x);
        const unpositioned = tools.filter(t => t.position_x === null || t.position_y === null).sort(byName);

        // Code plus a small numbered badge, not the full name/ID text -- an early real print
        // showed text-plus-code cards overlapping on drawers with several tools positioned close
        // together (expected for a physically tight drawer; not something any page size fully
        // solves). The code is already a solid white square with black modules
        // (generatePngAtSize()'s backgroundColor:'FFFFFF', see server.js) -- legible on its own
        // against the photo with no extra card/border needed; the badge sits just outside its
        // corner so it doesn't cover any modules. Full name/ID lives on the Tool List page,
        // keyed by this same number.
        const overlays = positioned.map((t, idx) => `
            <div style="position:absolute; left:${t.position_x * 100}%; top:${t.position_y * 100}%; transform:translate(-50%,-50%); width:50px; height:50px;">
                <img src="/api/tools/${t.tool_id}/scan-code.png" style="width:50px; height:50px; object-fit:contain; display:block; box-shadow:0 1px 4px rgba(0,0,0,0.6);">
                <div style="position:absolute; top:-8px; left:-8px;">${numberBadge(idx + 1, 20)}</div>
            </div>
        `).join('') + (tools.length ? '' : emptyDrawerStamp(56));

        const sidebar = unpositioned.length ? `
            <div style="flex:0 0 2.5in; min-width:0; overflow-y:auto; border-left:1px solid #ccc; padding-left:10px;">
                <div style="font-size:12px; font-weight:bold; color:#333; margin-bottom:8px;">Not Yet Pinpointed</div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${unpositioned.map(t => `<div style="border:1px solid #ccc; border-radius:4px; padding:5px;">${toolCard(t, 36)}</div>`).join('')}
                </div>
            </div>` : '';

        // The wrapper used to be `display:inline-block` with no explicit size, relying on its
        // shrink-to-fit auto-height happening to come out matching the <img>'s own rendered box.
        // That auto height is CSS-spec "indefinite", though -- which made the <img>'s own
        // `max-height:100%` (referencing this wrapper as its containing block) fail to resolve
        // for a photo that's tall enough to be height-constrained rather than width-constrained
        // (any photo less panoramic than ~16:9 on this page shape). With no effective max-height,
        // the image sized itself from width alone, via its own aspect ratio, with NO regard for
        // whether that height actually fit the page -- confirmed live: a 1600x1200 (4:3) drawer
        // photo rendered 1152px tall inside a page whose body row only had ~911px of real height,
        // overflowing the page by roughly 240px (2.5in), silently clipped wherever the real page
        // boundary fell when printed. James reported this as photos looking "cut off around the
        // edges." Fixed by making the wrapper `width:100%; height:100%` of its own flex parent
        // instead -- a flex item's cross size IS definite per spec, so the <img>'s max-height:100%
        // now properly resolves against it, and object-fit:contain correctly shrinks the image (on
        // both axes) to actually fit, instead of only ever checking its width. This can
        // reintroduce letterboxing within the wrapper when the photo's aspect ratio doesn't match
        // the wrapper's -- but the marker overlay no longer depends on the two matching exactly
        // (see the `beforeprint` listener below, which already re-measures and repositions it
        // against the <img>'s own true rendered box for exactly this reason).
        const photoArea = `
            <div style="flex:1 1 auto; min-width:0; min-height:0; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                <div style="position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center;">
                    <img src="${drawer.photo_url}" style="display:block; max-width:100%; max-height:100%; object-fit:contain;">
                    <div data-photo-overlay style="position:absolute; top:0; left:0; width:100%; height:100%;">${overlays}</div>
                </div>
            </div>`;

        const body = `<div style="flex:1 1 auto; min-height:0; display:flex; gap:12px;">${photoArea}${sidebar}</div>`;
        const mapPage = pageDiv(`${pageTitle(drawer)}${body}`);

        const detailGrid = tools.length
            ? `<div style="flex:1 1 auto; min-height:0; overflow:hidden; display:grid; grid-auto-rows:min-content; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:8px; align-content:start;">
                    ${positioned.map((t, idx) => detailRow(t, idx + 1)).join('')}
                    ${unpositioned.map(t => detailRow(t, null)).join('')}
               </div>`
            : `<div style="flex:1 1 auto; min-height:0; display:flex; align-items:center; justify-content:center;">${emptyDrawerStamp(64, false)}</div>`;
        const detailPage = pageDiv(`${pageTitle(drawer, 'Tool List')}${detailGrid}`);

        return mapPage + detailPage;
    }).join('');

    document.getElementById('toolbox-print-sheet-content').innerHTML = drawerPages || `<p>This toolbox has no drawers yet.</p>`;

    const area = document.getElementById('toolbox-print-sheet-area');
    area.style.display = 'block';
    await waitForImages(area);

    // Scopes the tabloid/landscape page size to just this print job -- a CSS named page
    // (`@page toolbox-sheet { }` + `page: toolbox-sheet;`) looked like the right tool for this
    // (avoid affecting printUserLoginCard(), which reuses this same print area for an unrelated
    // small card) but a live PDF-generation test showed Chromium's print pipeline doesn't
    // actually honor a named @page's `size` -- confirmed it silently fell back to plain Letter.
    // An unnamed `@page { size: ... }` rule IS honored, so this injects one just for this print
    // call and the afterprint listener below removes it again right after.
    const pageSizeStyle = document.createElement('style');
    pageSizeStyle.id = 'toolbox-sheet-page-size';
    pageSizeStyle.textContent = '@page { size: 17in 11in; margin: 0.5in; }'; // 0.5in margin -- see PAGE_SIZE's comment above for why
    document.head.appendChild(pageSizeStyle);

    window.print();
}

/**
 * Builds and prints individual tool cards for every (non-Retired) tool currently in a toolbox --
 * a second, physical way to scan a tool in/out besides the binder print sheet above, small enough
 * to go on a keychain. One-sided (James's follow-up: "drop the backside, putting all info in
 * front" -- an earlier front/back version needed duplex alignment that was more friction than it
 * was worth): photo, this drawer's position number (same reading-order numbering the map
 * overlay/Tool List page above use, kept in lockstep with it deliberately), name, and the
 * scannable code + ID, all on one face.
 *
 * Laid out as 3.5x2in cards, 2 columns x 5 rows (10/page) -- matches widely-available
 * pre-perforated business-card sheets (so this can be cut with scissors on plain paper, or
 * printed onto perforated stock for a clean break with no cutting at all), same spirit as the
 * print sheet's own "use what's easy to produce" choices elsewhere.
 *
 * Every photo is preloaded first (getImageOrientation() below) to tell portrait from landscape
 * before the card layout is ever built. James reported the photo looking "too zoomed in" on a
 * real print -- the card's photo area is a wide rectangle, and object-fit:cover on a PORTRAIT
 * photo (common for a phone photo of a hand tool stood on end) crops away most of the top and
 * bottom to fill that wide shape, leaving a tight, zoomed-in sliver of the middle. Rotating a
 * portrait photo 90 degrees first (so it lies on its side) gives object-fit:cover a shape close
 * to the card's own before it ever has to crop, using the space far better than either that heavy
 * crop or the alternative (object-fit:contain, which would shrink the whole photo down small
 * enough to avoid cropping and letterbox it instead -- also not what was asked for). There's no
 * way to detect which way is "upright" for an arbitrary tool photo (that's real object recognition,
 * well beyond this), so every portrait photo rotates the same fixed direction (90deg clockwise) --
 * if that reads wrong on a real tool's photo, flipping the single ROTATE_DEGREES constant below
 * to -90 is the fix.
 *
 * Deliberately NOT live status or anything date-based, same reasoning as the print sheet above --
 * a card is meant to be cut out and carried indefinitely, not reprinted on a schedule.
 */
async function openToolCardsPrintSheet(boxId) {
    const box = globalBoxesCache.find(b => b.box_id == boxId);
    if (!box) return;
    const drawerIds = new Set(globalDrawersCache.filter(d => d.box_id == boxId).map(d => d.drawer_id));
    const tools = globalToolsCache
        .filter(t => drawerIds.has(t.drawer_id) && t.status !== 'Retired')
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!tools.length) return alert('This toolbox has no tools to make cards for.');

    // Position numbers: group by drawer and rank each drawer's own positioned tools in reading
    // order (top-to-bottom, left-to-right) -- the exact same sort openToolboxPrintSheet() above
    // uses for its map badges/Tool List numbering, so a card's number always matches that sheet.
    const itemNumberByToolId = {};
    const byDrawer = {};
    tools.forEach(t => {
        if (t.position_x === null || t.position_y === null) return;
        (byDrawer[t.drawer_id] = byDrawer[t.drawer_id] || []).push(t);
    });
    Object.values(byDrawer).forEach(drawerTools => {
        drawerTools.sort((a, b) => a.position_y - b.position_y || a.position_x - b.position_x);
        drawerTools.forEach((t, i) => { itemNumberByToolId[t.tool_id] = i + 1; });
    });

    // Preload every photo so its real pixel dimensions are known before building the card HTML --
    // see this function's own doc comment for why orientation (not just "loaded yet") matters.
    const orientationByToolId = {};
    await Promise.all(tools.filter(t => t.photo_url).map(t => new Promise(resolve => {
        const img = new Image();
        img.onload = () => { orientationByToolId[t.tool_id] = img.naturalHeight > img.naturalWidth ? 'portrait' : 'landscape'; resolve(); };
        img.onerror = () => { orientationByToolId[t.tool_id] = 'landscape'; resolve(); };
        img.src = t.photo_url;
    })));

    const CARD_W = 3.5, CARD_H = 2, COLS = 2, ROWS = 5, PER_PAGE = COLS * ROWS;
    const PHOTO_H = 1.25; // of the card's 2in -- the rest is the info strip below
    const ROTATE_DEGREES = 90; // see doc comment -- flip to -90 if portrait photos read backwards

    const cardHtml = (t) => {
        const itemNum = itemNumberByToolId[t.tool_id];
        let photoInner;
        if (!t.photo_url) {
            photoInner = `<span style="color:#999; font-size:11px;">No Photo</span>`;
        } else if (orientationByToolId[t.tool_id] === 'portrait') {
            // Width/height swapped on the <img> itself (so object-fit:cover fills a box shaped
            // like the ORIGINAL unrotated card area) then rotated -- the visual result after
            // rotation exactly fills the card-shaped container again. Centered via the
            // position:absolute + translate(-50%,-50%) pair; the container's overflow:hidden
            // clips it to the card's actual bounds.
            photoInner = `<img src="${t.photo_url}" style="position:absolute; top:50%; left:50%; width:${PHOTO_H}in; height:${CARD_W}in; object-fit:cover; transform:translate(-50%,-50%) rotate(${ROTATE_DEGREES}deg);">`;
        } else {
            photoInner = `<img src="${t.photo_url}" style="width:100%; height:100%; object-fit:cover;">`;
        }
        return `
        <div style="width:${CARD_W}in; height:${CARD_H}in; box-sizing:border-box; border:1px solid #ccc; overflow:hidden; display:flex; flex-direction:column;">
            <div style="flex:0 0 ${PHOTO_H}in; position:relative; overflow:hidden; background:#eee; display:flex; align-items:center; justify-content:center;">
                ${photoInner}
            </div>
            <div style="flex:1 1 auto; min-height:0; padding:4px 6px; display:flex; align-items:center; gap:6px; border-top:1px solid #ccc;">
                <img src="/api/tools/${t.tool_id}/scan-code.png" style="width:0.55in; height:0.55in; object-fit:contain; flex-shrink:0;">
                <div style="min-width:0; line-height:1.25;">
                    ${itemNum ? `<div style="font-size:11px; font-weight:bold;">Item #${itemNum}</div>` : ''}
                    <div style="font-size:13px; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.name}</div>
                    <div style="font-family:monospace; font-size:11px;">${t.qr_code}</div>
                </div>
            </div>
        </div>`;
    };
    const blankCard = `<div style="width:${CARD_W}in; height:${CARD_H}in;"></div>`;

    const gridPage = (chunk) => {
        const rowsHtml = [];
        for (let r = 0; r < ROWS; r++) {
            const row = chunk.slice(r * COLS, r * COLS + COLS);
            while (row.length < COLS) row.push(null);
            rowsHtml.push(`<div style="display:flex;">${row.map(t => t ? cardHtml(t) : blankCard).join('')}</div>`);
        }
        return `<div style="break-before:page;">${rowsHtml.join('')}</div>`;
    };

    let pagesHtml = '';
    for (let i = 0; i < tools.length; i += PER_PAGE) {
        pagesHtml += gridPage(tools.slice(i, i + PER_PAGE));
    }

    document.getElementById('toolbox-print-sheet-content').innerHTML = pagesHtml;
    const area = document.getElementById('toolbox-print-sheet-area');
    area.style.display = 'block';
    await waitForImages(area);

    // Plain Letter, not the toolbox sheet's tabloid override -- reuses the same injected-style id
    // (and the one afterprint cleanup below) since only one print job is ever active at a time.
    const pageSizeStyle = document.createElement('style');
    pageSizeStyle.id = 'toolbox-sheet-page-size';
    pageSizeStyle.textContent = '@page { size: 8.5in 11in; margin: 0.5in; }';
    document.head.appendChild(pageSizeStyle);

    window.print();
}

window.addEventListener('afterprint', () => {
    const area = document.getElementById('toolbox-print-sheet-area');
    if (area) area.style.display = 'none';
    document.getElementById('toolbox-sheet-page-size')?.remove();
});

// Fixes a real marker-drift bug: each map page's photo overlay (`[data-photo-overlay]`, holding
// the scan-code/number-badge markers) is sized to its wrapper div via plain percentages, on the
// assumption that the wrapper and the <img> it wraps always end up the same size. That's no
// longer guaranteed now that the wrapper fills its flex parent rather than shrink-wrapping the
// image (see photoArea's own comment above) -- a photo whose aspect ratio doesn't match the
// wrapper's legitimately letterboxes within it (object-fit:contain), leaving the wrapper BIGGER
// than the image's real visible box on one axis. (The original version of this bug ran the other
// way -- the wrapper came out SMALLER than the image, which was overflowing its page entirely;
// fixed separately, see photoArea's comment.) Either way, a percentage-sized overlay drifts from
// the photo's real on-screen position. `.printable-area`'s real print-only layout
// (position:absolute, full page width -- see style.css's `@media print` block) isn't active
// during on-screen preview, so the TRUE geometry can't be measured/fixed before `window.print()`
// is called -- `beforeprint` is the one reliable hook that fires once print media (and therefore
// the real layout) is actually active, letting this re-measure the image's real rendered box and
// force the overlay to match it exactly via explicit pixel values, regardless of which direction
// (or whether) the wrapper and image sizes actually differ.
window.addEventListener('beforeprint', () => {
    document.querySelectorAll('[data-photo-overlay]').forEach(overlay => {
        const wrapper = overlay.parentElement;
        const img = wrapper?.querySelector(':scope > img');
        if (!img) return;
        const imgRect = img.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        overlay.style.left = (imgRect.left - wrapperRect.left) + 'px';
        overlay.style.top = (imgRect.top - wrapperRect.top) + 'px';
        overlay.style.width = imgRect.width + 'px';
        overlay.style.height = imgRect.height + 'px';
    });
});

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

/**
 * Issues or reissues a login-card QR token via POST /api/users/:id/login-token, then re-opens
 * the entity modal so it picks up the fresh globalUsersCache state (has_login_card / the new
 * card image) immediately instead of needing the admin to close and reopen it by hand.
 * Reissuing confirms first since it invalidates whatever card the person already has in hand.
 */
async function issueUserLoginCard(id, isReissue) {
    if (isReissue && !confirm(`Reissue the login card for ${id}? Their current card (printed or digital) will stop working immediately.`)) return;
    const res = await fetch(`/api/users/${id}/login-token`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' } });
    if (!res.ok) return alert('❌ Failed to generate login card.');
    await loadUsers();
    openEntityModal('user', id);
}

/**
 * Prints a single login card: the QR (login-card.png) plus the person's name/badge as plain
 * text next to it -- not baked into the PNG itself (see generateQrPngAtSize() in
 * scripts/lib/datamatrix.js), so this stays simple HTML rather than needing server-side text
 * compositing the way the tool barcode labels do. Same .printable-area + window.print()
 * pattern as the toolbox print sheet; reuses that same printable area rather than adding a
 * second one, since only one is ever shown at a time.
 */
async function printUserLoginCard(badgeId) {
    const user = globalUsersCache.find(u => u.badge_id === badgeId);
    if (!user || !user.has_login_card) return;

    document.getElementById('toolbox-print-sheet-content').innerHTML = `
        <div style="display:flex; align-items:center; gap:20px; border:2px solid #000; border-radius:12px; padding:24px; max-width:400px;">
            <img src="/api/users/${badgeId}/login-card.png" style="width:140px; height:140px; object-fit:contain;">
            <div>
                <div style="font-size:20px; font-weight:bold;">${user.full_name}</div>
                <div style="font-family:monospace; font-size:14px; color:#555; margin-top:4px;">${badgeId}</div>
                <div style="font-size:11px; color:#777; margin-top:10px;">Scan to sign in to the ToolTracker admin panel.</div>
            </div>
        </div>
    `;

    const area = document.getElementById('toolbox-print-sheet-area');
    area.style.display = 'block';
    await waitForImages(area);
    window.print();
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

/** Validates and submits the "Establish New Department" form (now part of the Departments workspace) to POST /api/departments, then clears the inputs and refreshes the storage dropdowns/caches/roster. Gated to currentAdminWeight >= 4 (super_admin) by the hidden #card-manage-depts card. Uses the lightweight primeStorageCaches() rather than renderEditableInfraTree() -- the Master Storage & Asset Tree isn't visible from this workspace, so there's no reason to pay for building (and image-loading) its entire off-screen DOM just to refresh a cache. */
async function submitStructureDept() {
    const payload = { name: document.getElementById('str-dept-name').value, prefix_code: document.getElementById('str-dept-prefix').value };
    if (!payload.name || !payload.prefix_code) return alert("⚠️ Required fields missing.");
    const res = await fetch('/api/departments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
    if (res.ok) {
        alert('✅ Department Established.');
        document.getElementById('str-dept-name').value = '';
        document.getElementById('str-dept-prefix').value = '';
        syncStorageHierarchyDropdowns();
        await primeStorageCaches();
        renderDepartmentRoster();
    }
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Database error')); }
}

/**
 * Entry point for the Departments hub card: primes the SAME caches the Inventory tree and
 * department groups already use (renderEditableInfraTree() populates globalDeptsCache/
 * globalBoxesCache/globalDrawersCache/globalToolsCache; loadDeptGroups() populates
 * globalDeptGroupsCache), then renders the roster table from them. Reuses
 * renderEditableInfraTree() purely for its side effect on the caches -- it also (harmlessly)
 * re-renders the Inventory tree's own DOM, which isn't visible from here.
 */
async function loadDepartmentsWorkspace() {
    await Promise.all([primeStorageCaches(), loadDeptGroups()]);
    renderDepartmentRoster();
}

/**
 * Fetches GET /api/storage + GET /api/tools and populates globalDeptsCache/globalBoxesCache/
 * globalDrawersCache/globalToolsCache WITHOUT rendering the Master Storage & Asset Tree --
 * unlike renderEditableInfraTree() (which does both together), for a view that only needs the
 * CACHES. Confirmed live as a real, not theoretical, fix: calling renderEditableInfraTree() from
 * loadDepartmentsWorkspace() built (and image-loaded) the entire tree into its own off-screen
 * container every single time the Departments hub was opened -- hundreds of <img> tags, one per
 * tool's photo in the whole system -- which queued behind the browser's per-host connection limit
 * and delayed an unrelated PUT /api/departments/:id save by several real seconds, long enough to
 * look like the save silently did nothing in testing.
 */
async function primeStorageCaches() {
    const [storageRes, toolsRes] = await Promise.all([fetch('/api/storage'), fetch('/api/tools')]);
    const storage = await storageRes.json();
    const tools = await toolsRes.json();
    globalDeptsCache = storage.departments;
    globalBoxesCache = storage.toolboxes;
    globalDrawersCache = storage.drawers;
    globalToolsCache = tools.tools;
}

/** True if department deptId has ANY tool assigned to it, of any status, anywhere under any of its toolboxes/drawers -- the same question PUT /api/departments/:id enforces server-side before allowing no_tool_inventory to be turned on. Computed client-side from the already-loaded caches so the entity modal's checkbox can be disabled (with an explanation) before a doomed save, not just after one. */
function deptHasAnyTools(deptId) {
    const boxIds = new Set(globalBoxesCache.filter(b => b.dept_id == deptId).map(b => b.box_id));
    const drawerIds = new Set(globalDrawersCache.filter(d => boxIds.has(d.box_id)).map(d => d.drawer_id));
    return globalToolsCache.some(t => drawerIds.has(t.drawer_id));
}

/** Renders #dept-roster-body from globalDeptsCache/globalDeptGroupsCache -- one row per department, each opening the SAME shared entity modal the Master Storage & Asset Tree's department header already opens (openEntityModal('department', id)). A second, additional way into that modal, not a replacement for the tree's own department rows. */
function renderDepartmentRoster() {
    const body = document.getElementById('dept-roster-body');
    if (!body) return;
    if (!globalDeptsCache.length) {
        body.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted);">No departments yet.</td></tr>`;
        return;
    }
    body.innerHTML = globalDeptsCache
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => {
            const group = globalDeptGroupsCache.find(g => g.group_id == d.cross_checkout_group_id);
            return `<tr style="cursor:pointer;" onclick="openEntityModal('department', '${d.dept_id}')">
                <td>${icon('building-2')} ${d.name}</td>
                <td style="font-family:monospace;">${d.prefix_code}</td>
                <td>${group ? group.name : '--'}</td>
                <td>${d.no_tool_inventory ? '<span style="color:var(--muted);">Not Tracked</span>' : 'Tracked'}</td>
            </tr>`;
        }).join('');
}

/** Fetches GET /api/department-groups into globalDeptGroupsCache and renders #dept-groups-list -- one row per group with an inline-editable name (blur-to-rename) and a delete button. Called at boot (bootstrapAdminUI) and after every create/rename/delete here so the list and the cache driving each department's edit-view dropdown both stay current. */
async function loadDeptGroups() {
    const container = document.getElementById('dept-groups-list');
    try {
        const res = await fetch('/api/department-groups');
        const data = await res.json();
        if (!data.success) throw new Error();
        globalDeptGroupsCache = data.groups;
        if (!container) return; // card hidden below super_admin, cache is still primed above
        container.innerHTML = globalDeptGroupsCache.length === 0
            ? `<span style="font-size:12px; color:var(--muted);">No groups yet -- departments check out independently by default.</span>`
            : globalDeptGroupsCache.map(g => `
                <div style="display:flex; align-items:center; gap:8px; background:var(--surface2); padding:6px 10px; border-radius:6px;">
                    <input class="form-input" style="flex:1; padding:4px 8px; font-size:13px;" value="${g.name}" onchange="renameDeptGroup(${g.group_id}, this.value)">
                    <span style="cursor:pointer; color:var(--red); display:inline-flex;" title="Delete group" onclick="deleteDeptGroup(${g.group_id})">${icon('x')}</span>
                </div>
            `).join('');
    } catch (e) {
        if (container) container.innerHTML = `<span style="font-size:12px; color:var(--red);">Failed to load.</span>`;
    }
}

/** Submits the "+ Add Group" row to POST /api/department-groups. */
async function submitNewDeptGroup() {
    const input = document.getElementById('new-dept-group-name');
    const name = input.value.trim();
    if (!name) return alert('⚠️ A group name is required.');
    const res = await fetch('/api/department-groups', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({ name }) });
    if (res.ok) { input.value = ''; await loadDeptGroups(); }
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to add group.')); }
}

/** Renames a department group in place (blur-to-save, no separate edit mode) via PUT /api/department-groups/:id. */
async function renameDeptGroup(groupId, newName) {
    const name = newName.trim();
    if (!name) return alert('⚠️ A group name is required.');
    const res = await fetch(`/api/department-groups/${groupId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({ name }) });
    if (res.ok) { await loadDeptGroups(); }
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to rename group.')); await loadDeptGroups(); }
}

/** Deletes a department group -- its member departments are just ungrouped (ON DELETE SET NULL), not touched otherwise. */
async function deleteDeptGroup(groupId) {
    if (!confirm('Delete this group? Departments in it will simply be ungrouped, not deleted.')) return;
    const res = await fetch(`/api/department-groups/${groupId}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
    if (res.ok) { await loadDeptGroups(); renderEditableInfraTree(); }
    else { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to delete group.')); }
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

        const labelExportDeptEl = document.getElementById('label-export-dept');
        if (labelExportDeptEl) labelExportDeptEl.innerHTML = '<option value="">All Departments</option>' + deptOptions;
    } catch(e) { console.error(e); }
}

/**
 * Cascades the barcode-label export's Toolbox select to the chosen Department -- see the
 * "4. Export Inventory" card. Scoped to globalBoxesCache (already kept in sync by
 * syncStorageHierarchyDropdowns()), not a fresh fetch.
 */
function onLabelExportDeptChange() {
    const deptId = document.getElementById('label-export-dept').value;
    const boxSelect = document.getElementById('label-export-box');
    const boxes = deptId ? globalBoxesCache.filter(b => b.dept_id == deptId) : globalBoxesCache;
    boxSelect.innerHTML = '<option value="">All Toolboxes</option>' + boxes.map(b => `<option value="${b.box_id}">${b.name}</option>`).join('');
}

/**
 * Builds the scoped query string for GET /api/tools/labels/export from whatever's selected
 * in the Department/Toolbox pair above -- Toolbox takes precedence if both are set (it's
 * already narrower than its department), matching the endpoint's "at most one filter" rule.
 */
function exportScopedLabels() {
    const deptId = document.getElementById('label-export-dept').value;
    const boxId = document.getElementById('label-export-box').value;
    const params = new URLSearchParams();
    if (boxId) params.set('box_id', boxId);
    else if (deptId) params.set('dept_id', deptId);
    window.location.href = `/api/tools/labels/export${params.toString() ? '?' + params.toString() : ''}`;
}

// Unified Editable Tree replacing the 3 old tables
/**
 * Recursively renders the full department -> toolbox -> drawer -> tool hierarchy into
 * #editable-infra-tree-container. Fetches GET /api/storage and GET /api/tools in parallel,
 * caches the results in globalDeptsCache/globalBoxesCache/globalDrawersCache/globalToolsCache
 * (consumed later by openEntityModal). globalToolGroupsCache -- consumed by the tool edit
 * form's Group dropdown -- is deliberately NOT re-fetched here on every tree render (this
 * function runs after every dept/box/drawer/tool create/edit/delete); it's primed once at
 * login (bootstrapAdminUI) and kept fresh by loadToolGroups() whenever groups are actually
 * managed in Reports. Builds nested HTML level by level:
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
 * drawers additionally have a toggle-icon (separate click target, with padding+negative-margin
 * for a real touch target on a phone/tablet without changing its visual size) for
 * expand/collapse, driven by toggleTreeVisibility() via the generated dept-content-/
 * box-content-/drawer-content- element ids; tools are leaves, so their whole row just opens
 * the modal.
 *
 * Every node's expanded/collapsed state is read from treeExpandState (default collapsed for
 * anything not in it) and baked into its initial display/chevron here, so this full rebuild --
 * which runs after every single dept/box/drawer/tool create/edit/delete, there's no
 * incremental patching -- doesn't dump the whole tree back open and lose whatever the admin
 * had drilled down into. The page's scroll position is saved/restored around the rebuild for
 * the same reason.
 */
async function renderEditableInfraTree() {
    const container = document.getElementById('editable-infra-tree-container');
    if(!container) return;

    // This function is called independently from a dozen+ places (every dept/box/drawer/tool
    // create/edit/delete) with no sequencing between calls. If two overlap -- a slow fetch
    // from an earlier call resolving after a newer one already rendered -- the stale call
    // would otherwise overwrite the fresh tree with outdated data AND yank the scroll position
    // back to wherever it was when the stale call started. This token guards against that:
    // only the call that's still the most recently started one is allowed to actually apply
    // its results.
    const renderToken = ++treeRenderToken;

    // This whole container is rebuilt from scratch below (not patched in place), which would
    // otherwise reset the page's scroll position every time -- jarring right after saving an
    // edit, when the admin is almost always still looking at the exact spot they just edited.
    // Restored once the rebuilt tree (now at its correct, taller-or-shorter height thanks to
    // treeExpandState) has actually settled, not synchronously -- the browser hasn't
    // recalculated layout yet immediately after innerHTML is assigned.
    const savedScrollY = window.scrollY;

    // Deliberately NOT replaced with a "Fetching..." placeholder here -- this function reruns
    // after every single create/edit/delete, and on a local/fast connection that placeholder
    // did nothing but collapse the whole tree to one line and then immediately re-expand it
    // once data arrived, a jarring flash for no real benefit. Leaving the previous render in
    // place until the new one is actually ready to swap in is both less disruptive and avoids
    // a second layout pass.
    try {
        const [storageRes, toolsRes] = await Promise.all([fetch('/api/storage'), fetch('/api/tools')]);
        const storage = await storageRes.json(); const tools = await toolsRes.json();

        // A newer call already started (and possibly already rendered) while this one was
        // still fetching -- bail out entirely rather than applying now-stale data over it,
        // touching neither the shared caches below nor the DOM/scroll position.
        if (renderToken !== treeRenderToken) return;

        globalDeptsCache = storage.departments;
        globalBoxesCache = storage.toolboxes;
        globalDrawersCache = storage.drawers;
        globalToolsCache = tools.tools;

        let html = '';
        storage.departments.forEach(dept => {
            const deptContentId = `dept-content-${dept.dept_id}`;
            // Departments default CLOSED, same as toolboxes/drawers below (treeExpandState[id]
            // === true) -- previously defaulted open on the theory that a handful of departments
            // wasn't where the clutter was, but James asked for the whole tree to start
            // collapsed, so this is now a uniform rule top to bottom rather than a dept-level
            // exception. Still per-id, so an admin's own expand/collapse choices persist across
            // a renderEditableInfraTree() rebuild exactly as before.
            const deptExpanded = treeExpandState[deptContentId] === true;

            // Clicking the toggle-icon expands/collapses; clicking the name opens the entity
            // modal (view details, or edit/delete if permitted) -- see openEntityModal().
            // The toggle icon's padding+negative-margin gives it a real touch target (was just
            // the bare glyph, too small to tap reliably on a phone/tablet) without changing its
            // visual size or nudging the row's layout.
            html += `<div class="card" style="border-left: 4px solid var(--accent); margin-bottom: 15px; padding: 15px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; user-select: none;">
                            <span class="tree-toggle-tap" style="cursor: pointer;" onclick="toggleTreeVisibility('${deptContentId}', this.parentElement)"><span class="icon toggle-icon" style="color: var(--muted);">${deptExpanded ? ICONS['chevron-down'] : ICONS['chevron-right']}</span></span>
                            <h4 style="margin: 0; cursor: pointer;" onclick="openEntityModal('department', '${dept.dept_id}')">
                                ${icon('building-2')} ${dept.name} <span style="font-weight:normal; color:var(--muted); font-size:13px;">(${dept.prefix_code})</span>
                            </h4>
                        </div>
                        <div id="${deptContentId}" style="display:${deptExpanded ? 'block' : 'none'};">`;

            const deptBoxes = storage.toolboxes.filter(b => b.dept_id === dept.dept_id);
            if(deptBoxes.length === 0) html += `<div class="tree-item" style="color:var(--muted);">No storage installed.</div>`;

            deptBoxes.forEach(box => {
                const boxTools = tools.tools.filter(t => { const dr = storage.drawers.find(d => d.drawer_id === t.drawer_id); return dr && dr.box_id === box.box_id; });
                const thumb = box.photo_url ? `<img src="${box.photo_url}" onclick="openImageModal('${box.photo_url}')" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover; cursor: zoom-in;">` : icon('toolbox');
                const boxContentId = `box-content-${box.box_id}`;
                const boxExpanded = treeExpandState[boxContentId] === true;

                html += `<div class="tree-node" style="padding: 10px;">
                            <div style="display: flex; align-items: center; gap: 10px; user-select: none;">
                                ${thumb}
                                <span class="tree-toggle-tap" style="cursor: pointer;" onclick="toggleTreeVisibility('${boxContentId}', this.parentElement)"><span class="icon toggle-icon" style="color: var(--muted);">${boxExpanded ? ICONS['chevron-down'] : ICONS['chevron-right']}</span></span>
                                <span onclick="openEntityModal('toolbox', '${box.box_id}')" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                                    <strong>${box.name}</strong>
                                    <span style="background: var(--surface); padding: 2px 6px; border-radius: 4px; font-size: 10px; color: var(--accent); font-family: monospace;">${box.qr_code || 'NO-ID'}</span>
                                    <span style="font-size:12px; color:var(--muted);">(${boxTools.length} Assets)</span>
                                </span>
                            </div>
                            <div id="${boxContentId}" style="margin-top: 10px; display:${boxExpanded ? 'block' : 'none'};">`;

                const boxDrawers = storage.drawers.filter(d => d.box_id === box.box_id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

                if(boxDrawers.length > 0) {
                    boxDrawers.forEach(dr => {
                        const drToolsList = tools.tools.filter(t => t.drawer_id === dr.drawer_id);
                        const drThumb = dr.photo_url ? `<img src="${dr.photo_url}" onclick="openImageModal('${dr.photo_url}')" style="width: 20px; height: 20px; border-radius: 4px; object-fit: cover; cursor: zoom-in;">` : icon('folder');
                        const drawerContentId = `drawer-content-${dr.drawer_id}`;
                        const drawerExpanded = treeExpandState[drawerContentId] === true;

                        html += `<div class="tree-child" style="padding: 6px 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                                    <div style="display: flex; align-items: center; gap: 8px; user-select: none;">
                                        ${drThumb}
                                        <span class="tree-toggle-tap" style="cursor: pointer;" onclick="toggleTreeVisibility('${drawerContentId}', this.parentElement)"><span class="icon toggle-icon" style="color: var(--muted);">${drawerExpanded ? ICONS['chevron-down'] : ICONS['chevron-right']}</span></span>
                                        <span onclick="openEntityModal('drawer', '${dr.drawer_id}')" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                                            <span style="font-weight: bold;">${dr.name}</span>
                                            <span style="font-size:11px; color:var(--muted); margin-left: 5px;">(${drToolsList.length} tools)</span>
                                        </span>
                                    </div>
                                    <div id="${drawerContentId}" style="margin-top: 8px; padding-left: 20px; border-left: 1px dashed var(--border); display:${drawerExpanded ? 'block' : 'none'};">`;

                        if (drToolsList.length === 0) {
                            html += `<div style="font-size: 12px; color: var(--muted); padding: 4px 0;">Drawer is empty.</div>`;
                        } else {
                            drToolsList.forEach(tool => {
                                const statusColor = tool.status === 'In' ? 'var(--green)' : (tool.status === 'Out' ? 'var(--accent)' : 'var(--red)');
                                const serialDisplay = tool.serial_number
                                    ? `<span style="font-size: 11px; color: var(--text);">S/N: <span style="font-family: monospace;">${tool.serial_number}</span></span>`
                                    : `<span style="font-size: 11px; color: var(--muted); font-style: italic;">No serial set</span>`;
                                // A calibrated tool is only actually trustworthy with BOTH a due
                                // date and a real calibration_records row on file -- matches the
                                // checkout hard-stop's own rule (see PUT /api/transactions), so
                                // what blocks a checkout is visible here before anyone scans it.
                                const calIsExpired = tool.cal_due_date && new Date(tool.cal_due_date) <= new Date(new Date().toDateString());
                                // A sub-assembly (migrations/018) that itself needs calibration and is out
                                // of cal blocks the PARENT's checkout regardless of the parent's own
                                // is_calibrated flag -- checked before that flag below, same ordering
                                // reason open-investigation is checked first (see blockedReason() in the
                                // Tool Groups section for the identical rule, mirrored here).
                                const blockedSub = (tool.sub_assemblies || []).find(sa => sa.is_calibrated && (!sa.cal_due_date || new Date(sa.cal_due_date) <= new Date(new Date().toDateString())));
                                const calDueDisplay = tool.has_open_investigation
                                    ? `<span style="font-size: 11px; color: var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} Investigation open</span>`
                                    : blockedSub
                                    ? `<span style="font-size: 11px; color: var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} Sub-assembly "${blockedSub.name}" needs cal</span>`
                                    : !tool.is_calibrated
                                    ? `<span style="font-size: 11px; color: var(--muted); font-style: italic;">Not calibrated</span>`
                                    : !tool.cal_due_date
                                        ? `<span style="font-size: 11px; color: var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} No due date</span>`
                                        : !tool.has_cal_record
                                            ? `<span style="font-size: 11px; color: var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} No certificate</span>`
                                            : calIsExpired
                                                ? `<span style="font-size: 11px; color: var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} Cal expired</span>`
                                                : `<span style="font-size: 11px; color: var(--text);">Cal Due: ${tool.cal_due_date.split('T')[0]}</span>`;

                                // Whole row opens the entity modal -- there's nothing to expand/collapse
                                // at this level (tools are leaves), so no separate toggle icon is needed.
                                // In Batch Move mode, a checkbox is prepended instead -- its own
                                // stopPropagation() keeps a checkbox click from also opening the modal.
                                const batchCheckbox = batchMoveMode
                                    ? `<input type="checkbox" onclick="event.stopPropagation();" onchange="toggleToolSelection(${tool.tool_id}, this.checked)" ${selectedToolIds.has(tool.tool_id) ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer; flex-shrink:0;">`
                                    : '';
                                // Same "photo, or a fallback icon" convention as the drawer row's own
                                // thumbnail just above (drThumb) and the entity modal's #em-thumb --
                                // click zooms via openImageModal() without also opening the entity
                                // modal underneath it (stopPropagation(), since the whole row itself
                                // is clickable here, unlike the drawer row's thumbnail which sits
                                // outside its own clickable span).
                                const toolThumb = tool.photo_url
                                    ? `<img src="${tool.photo_url}" onclick="event.stopPropagation(); openImageModal('${tool.photo_url}')" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover; cursor: zoom-in; flex-shrink: 0;">`
                                    : `<span style="width: 24px; height: 24px; display:flex; align-items:center; justify-content:center; flex-shrink:0; color: var(--muted);">${icon('wrench')}</span>`;
                                const altPartNumberList = (tool.alt_part_numbers || []).map(ap => ap.part_number);
                                const searchKey = [tool.name, tool.qr_code, tool.serial_number, tool.part_number, ...altPartNumberList].filter(Boolean).join(' ').toUpperCase();
                                html += `
                                    <div class="tool-tree-row" data-search="${searchKey.replace(/"/g, '&quot;')}" style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.02); cursor: pointer;" onclick="openEntityModal('tool', '${tool.qr_code}')">
                                        ${batchCheckbox}
                                        ${toolThumb}
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
        requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
        // A rebuild (every create/edit/delete) wipes the filtered-down DOM state, so re-apply
        // whatever search is still active instead of silently dropping back to the full tree.
        const searchInput = document.getElementById('inv-tree-search');
        if (searchInput && searchInput.value.trim()) filterInventoryTree();
    } catch (e) {
        // Logged, not just swallowed -- a silent catch here previously made a real bug (a
        // ReferenceError from an incomplete feature, accidentally shipped) look like a generic
        // "something broke" with no way to tell what from the UI alone.
        console.error('renderEditableInfraTree failed:', e);
        container.innerHTML = `<div style="color: var(--red); padding: 20px;">Error rendering map.</div>`;
    }
}

/**
 * Live-filters the Master Storage & Asset Tree down to tools matching #inv-tree-search
 * (substring match against name/QR code/serial/part number), bubbling visibility up through
 * drawer -> box -> department and force-expanding any ancestor a match is buried under --
 * otherwise a hit three collapsed levels down would be filtered to "visible" in the DOM but
 * still invisible behind closed chevrons. Clearing the search restores every level back to
 * treeExpandState's own collapsed/expanded state rather than leaving everything forced open.
 */
function filterInventoryTree() {
    const query = document.getElementById('inv-tree-search').value.trim().toUpperCase();
    if (!query) { restoreTreeExpandState(); return; }

    document.querySelectorAll('.tool-tree-row').forEach(row => {
        row.style.display = row.dataset.search.includes(query) ? '' : 'none';
    });

    const forceOpenIfHasMatch = (containerSelector) => {
        document.querySelectorAll(containerSelector).forEach(el => {
            const hasVisible = Array.from(el.querySelectorAll('.tool-tree-row')).some(r => r.style.display !== 'none');
            el.style.display = hasVisible ? '' : 'none';
            if (hasVisible) {
                const content = el.querySelector(':scope > [id^="drawer-content-"], :scope > [id^="box-content-"]');
                const toggleIcon = el.querySelector(':scope > div > .tree-toggle-tap > .toggle-icon');
                if (content) content.style.display = 'block';
                if (toggleIcon) toggleIcon.innerHTML = ICONS['chevron-down'];
            }
        });
    };
    // Drawers first, then boxes (whose "has a match" check now sees the drawers' updated
    // display), then department content divs, same bottom-up order.
    forceOpenIfHasMatch('.tree-child');
    forceOpenIfHasMatch('.tree-node');
    document.querySelectorAll('[id^="dept-content-"]').forEach(el => {
        const hasVisible = Array.from(el.querySelectorAll('.tool-tree-row')).some(r => r.style.display !== 'none');
        el.style.display = hasVisible ? 'block' : 'none';
        if (hasVisible) {
            const toggleIcon = el.previousElementSibling ? el.previousElementSibling.querySelector('.toggle-icon') : null;
            if (toggleIcon) toggleIcon.innerHTML = ICONS['chevron-down'];
        }
    });
}

/** Un-hides every tree wrapper a search may have hidden and resets each collapsible level back to its treeExpandState-tracked open/closed state (mirrors the same defaults renderEditableInfraTree() itself applies). */
function restoreTreeExpandState() {
    document.querySelectorAll('.tool-tree-row, .tree-child, .tree-node').forEach(el => { el.style.display = ''; });
    document.querySelectorAll('[id^="box-content-"], [id^="drawer-content-"]').forEach(el => {
        const expanded = treeExpandState[el.id] === true;
        el.style.display = expanded ? 'block' : 'none';
        const toggleIcon = el.previousElementSibling ? el.previousElementSibling.querySelector('.toggle-icon') : null;
        if (toggleIcon) toggleIcon.innerHTML = expanded ? ICONS['chevron-down'] : ICONS['chevron-right'];
    });
    document.querySelectorAll('[id^="dept-content-"]').forEach(el => {
        const expanded = treeExpandState[el.id] === true; // same default as renderEditableInfraTree()'s own deptExpanded
        el.style.display = expanded ? 'block' : 'none';
        const toggleIcon = el.previousElementSibling ? el.previousElementSibling.querySelector('.toggle-icon') : null;
        if (toggleIcon) toggleIcon.innerHTML = expanded ? ICONS['chevron-down'] : ICONS['chevron-right'];
    });
}

// ==========================================
// 3.5 BATCH MOVE (Master Storage & Asset Tree)
// ==========================================
/**
 * Toggles Batch Move mode: shows a checkbox on every tool row (re-renders the tree so they
 * appear) and the selection-count bar, or hides both and clears any in-progress selection
 * when turned back off.
 */
function toggleBatchMoveMode() {
    batchMoveMode = !batchMoveMode;
    const btn = document.getElementById('btn-batch-move-toggle');
    const bar = document.getElementById('batch-move-bar');
    const resultsEl = document.getElementById('batch-tool-results');
    if (btn) btn.classList.toggle('active', batchMoveMode);
    if (!batchMoveMode) selectedToolIds.clear();
    if (bar) bar.style.display = batchMoveMode ? 'flex' : 'none';
    if (resultsEl) resultsEl.style.display = 'none'; // don't carry a stale results list into/out of a fresh batch-select session
    updateBatchMoveCount();
    renderEditableInfraTree();
}

/** Adds/removes one tool_id from the running selection (called by each row's checkbox) and updates the count bar. */
function toggleToolSelection(toolId, checked) {
    if (checked) selectedToolIds.add(toolId); else selectedToolIds.delete(toolId);
    updateBatchMoveCount();
}

/** Clears the selection (e.g. "Clear Selection" button) without leaving Batch Move mode, and re-renders so every checkbox unchecks. */
function clearBatchMoveSelection() {
    selectedToolIds.clear();
    const resultsEl = document.getElementById('batch-tool-results');
    if (resultsEl) resultsEl.style.display = 'none';
    updateBatchMoveCount();
    renderEditableInfraTree();
}

function updateBatchMoveCount() {
    const el = document.getElementById('batch-move-count');
    if (el) el.textContent = `${selectedToolIds.size} tool(s) selected`;
}

/** Opens the destination-drawer picker, populating its Department select fresh from globalDeptsCache (same cascade pattern as the Ingest New Asset / tool-edit Location fields). Requires at least one tool selected. */
function openBatchMoveModal() {
    if (selectedToolIds.size === 0) return alert('⚠️ Select at least one tool first.');
    const subtitle = document.getElementById('batch-move-modal-subtitle');
    if (subtitle) subtitle.textContent = `Moving ${selectedToolIds.size} tool(s) -- choose a destination drawer.`;

    const deptSelect = document.getElementById('batch-move-dept');
    deptSelect.innerHTML = '<option value="">-- Select Department --</option>' + globalDeptsCache.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
    populateBoxSelect(document.getElementById('batch-move-box'), null);
    populateDrawerSelect(document.getElementById('batch-move-drawer'), null);

    document.getElementById('batch-move-modal-overlay').style.display = 'flex';
}

function closeBatchMoveModal() {
    document.getElementById('batch-move-modal-overlay').style.display = 'none';
}

/**
 * Builds the before-the-request lookup of each selected tool's qr_code/name from
 * globalToolsCache, so confirmBatchMove()/confirmBatchDelete() can still show a meaningful
 * label for a tool that the server reports as NOT affected (rare -- e.g. deleted/moved by
 * someone else between selecting it and submitting) rather than just a bare numeric id.
 * Captured before the request fires and before the post-action renderEditableInfraTree()
 * refresh replaces the cache, since a failed tool may no longer be in the fresh one at all.
 */
function captureBatchToolInfo(toolIds) {
    const info = {};
    toolIds.forEach(id => {
        const t = globalToolsCache.find(t => t.tool_id === id);
        info[id] = t ? { qr_code: t.qr_code, name: t.name } : { qr_code: `#${id}`, name: '' };
    });
    return info;
}

/** Submits the batch move to PUT /api/tools/batch-move, then closes the modal, clears the selection (but stays in Batch Move mode -- ready for another round), refreshes the tree, and shows a per-tool results list (renderBatchToolResults()) instead of one alert(). */
async function confirmBatchMove() {
    const drawerId = document.getElementById('batch-move-drawer').value;
    if (!drawerId) return alert('⚠️ Select a destination drawer.');

    const requestedIds = Array.from(selectedToolIds);
    const requestedInfo = captureBatchToolInfo(requestedIds);

    try {
        const res = await fetch('/api/tools/batch-move', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ tool_ids: requestedIds, drawer_id: drawerId })
        });
        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || 'Failed to move tools.'));

        closeBatchMoveModal();
        selectedToolIds.clear();
        updateBatchMoveCount();
        await renderEditableInfraTree();

        const succeededIds = new Set((data.results || []).map(r => r.tool_id));
        const results = requestedIds.map(id => ({
            ...requestedInfo[id],
            success: succeededIds.has(id),
            message: succeededIds.has(id) ? 'Moved' : 'Not found (already moved or deleted?)',
        }));
        renderBatchToolResults('batch-tool-results', results, { clickable: true });
    } catch (e) {
        alert('❌ Network error while moving tools.');
    }
}

/** Permanently deletes every selected tool (DELETE /api/tools/batch-delete) after a confirm() prompt -- there's no undo, unlike a move. Stays in Batch Select mode afterward, same as confirmBatchMove(), and shows the same per-tool results list (not clickable here -- a deleted tool no longer exists to open). */
async function confirmBatchDelete() {
    if (selectedToolIds.size === 0) return alert('⚠️ Select at least one tool first.');
    if (!confirm(`Permanently delete ${selectedToolIds.size} tool(s)? This cannot be undone.`)) return;

    const requestedIds = Array.from(selectedToolIds);
    const requestedInfo = captureBatchToolInfo(requestedIds);

    try {
        const res = await fetch('/api/tools/batch-delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ tool_ids: requestedIds })
        });
        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || 'Failed to delete tools.'));

        selectedToolIds.clear();
        updateBatchMoveCount();
        await renderEditableInfraTree();

        const succeededIds = new Set((data.results || []).map(r => r.tool_id));
        const results = requestedIds.map(id => ({
            ...requestedInfo[id],
            success: succeededIds.has(id),
            message: succeededIds.has(id) ? 'Deleted' : 'Not found (already deleted?)',
        }));
        renderBatchToolResults('batch-tool-results', results, { clickable: false });
    } catch (e) {
        alert('❌ Network error while deleting tools.');
    }
}

/**
 * Generic post-batch-action results list for the Master Storage & Asset Tree's Batch Select bar
 * -- one row per tool, success or failure, in a persistent panel instead of a single alert()
 * that only reported a count. Modeled on the ingest form's own renderAddToolResults() (same
 * idea -- a partial/mixed outcome, or here simply which exact tools were affected, stays
 * visible); kept as a separate function rather than shared since that one has its own
 * calibration-specific hint text this doesn't need. `clickable` opens a successful row's tool
 * entity card on click -- pass false for an action like delete, where there's nothing left to
 * open.
 */
function renderBatchToolResults(containerId, results, { clickable = false } = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const successCount = results.filter(r => r.success).length;
    container.style.display = 'block';
    container.innerHTML = `
        <div style="font-size:13px; margin-bottom:8px;"><strong>${successCount} of ${results.length} succeeded.</strong></div>
        <div style="display:flex; flex-direction:column; gap:4px; max-height:260px; overflow-y:auto;">
            ${results.map(r => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; border-radius:6px; background: var(--surface2);${r.success && clickable ? ' cursor:pointer;' : ''}"${r.success && clickable ? ` onclick="openEntityModal('tool', '${r.qr_code}')"` : ''}>
                    <span style="font-size:12px;">${r.name ? `${r.name} ` : ''}<span style="font-family:monospace; font-size:11px; color:var(--muted);">${r.qr_code}</span></span>
                    <span style="font-size:12px; color: ${r.success ? 'var(--green)' : 'var(--red)'};">${r.success ? icon('circle-check') : icon('circle-x')} ${r.message}</span>
                </div>
            `).join('')}
        </div>
    `;
}

/** Fetches GET /api/audits/today-status and renders one chip per department into #audit-status-body: muted styling when that department's mandatory audit for its own CURRENT shift window is already complete, or a red "-- Audit Pending" chip when it is not. Each department now resolves its OWN window from its OWN configured schedule (see the "Audit Schedule" card / getDeptAuditSchedule in server.js) -- schedules can differ per department, so the window label/time is shown inline per chip rather than as one shared line above them all. */
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
        container.innerHTML = data.departments.map(d => {
            const since = d.window_start ? new Date(d.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            if (d.audit_completed) {
                return `<span title="${d.window_label} window, since ${since}" style="font-size:11px; font-weight:bold; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,0.05); color: var(--muted);">${d.name}</span>`;
            }
            return `<span title="${d.window_label} window, since ${since}" style="font-size:11px; font-weight:bold; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,0.05); color: var(--red);">${d.name} -- Audit Pending (${d.window_label})</span>`;
        }).join('');
    } catch (e) {
        container.innerHTML = `<div style="color:var(--red); font-size:12px;">Failed to load audit status.</div>`;
    }
}

/** Converts minutes-since-midnight (as stored in audit_schedules.start_minute) to an "HH:MM" string for an <input type="time">. */
function auditMinutesToTimeString(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Converts an "HH:MM" <input type="time"> value back to minutes-since-midnight. Returns NaN for an empty/invalid value, left for the server to reject. */
function auditTimeStringToMinutes(timeStr) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr || '');
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
}

/**
 * Fills #audit-schedule-list (dept_admin+ only, see bootstrapAdminUI) from GET /api/audit-schedules
 * -- one section per department this user can manage. A department still on the implicit
 * default schedule shows its (read-only) windows plus a "Customize This Schedule" button;
 * once customized, every window is a real row with its own editable label/time and a delete
 * button, plus an "+ Add Window" row. Modeled on the Tool Groups admin list (loadToolGroups()
 * above) -- one delegated click handler routes every row action by data-action.
 */
async function loadAuditSchedules() {
    const container = document.getElementById('audit-schedule-list');
    if (!container || currentAdminWeight < 3) return;
    try {
        const res = await fetch('/api/audit-schedules');
        const data = await res.json();
        if (!res.ok || !data.success) { container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        container.innerHTML = data.departments.map(dept => `
            <div style="border-bottom:1px solid var(--border); padding:10px 0;" data-dept-section="${dept.dept_id}">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="font-weight:bold; font-size:13px;">${dept.name}</div>
                    ${dept.is_default ? `<span style="font-size:10px; color:var(--muted);">Using default schedule</span>` : ''}
                </div>
                <div style="display:flex; flex-direction:column; gap:6px;">
                    ${dept.windows.map(w => dept.is_default ? `
                        <div style="display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted);">
                            <span style="flex:1;">${w.label}</span>
                            <span>${auditMinutesToTimeString(w.start_minute)}</span>
                        </div>
                    ` : `
                        <div style="display:flex; align-items:center; gap:6px;" data-schedule-id="${w.schedule_id}">
                            <input class="form-input" style="flex:1; min-width:100px;" value="${w.label}" data-field="label">
                            <input class="form-input" type="time" style="width:110px;" value="${auditMinutesToTimeString(w.start_minute)}" data-field="start_minute">
                            <button type="button" class="btn-icon" title="Save" data-action="save-window">${icon('save')}</button>
                            <button type="button" class="btn-icon" title="Remove" data-action="delete-window">${icon('x')}</button>
                        </div>
                    `).join('')}
                    ${dept.is_default
                        ? `<button type="button" class="btn btn-secondary" style="width:auto; align-self:flex-start; margin-top:4px;" data-action="customize" data-dept-id="${dept.dept_id}">Customize This Schedule</button>`
                        : `<div style="display:flex; align-items:center; gap:6px; margin-top:4px;" data-add-row data-dept-id="${dept.dept_id}">
                               <input class="form-input" style="flex:1; min-width:100px;" placeholder="Label (e.g. Night Shift)" data-field="label">
                               <input class="form-input" type="time" style="width:110px;" data-field="start_minute">
                               <button type="button" class="btn-icon" title="Add Window" data-action="add-window">${icon('plus')}</button>
                           </div>`}
                </div>
            </div>`).join('');

        if (!container.dataset.delegated) {
            container.dataset.delegated = 'true';
            container.addEventListener('click', onAuditScheduleListClick);
        }
    } catch (e) {
        container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Single delegated click handler for #audit-schedule-list -- routes by data-action on the clicked element. */
function onAuditScheduleListClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'customize') customizeAuditSchedule(el.dataset.deptId);
    else if (el.dataset.action === 'add-window') {
        const rowEl = el.closest('[data-add-row]');
        addAuditWindow(rowEl.dataset.deptId, rowEl);
    }
    else if (el.dataset.action === 'save-window') saveAuditWindow(el.closest('[data-schedule-id]'));
    else if (el.dataset.action === 'delete-window') deleteAuditWindow(el.closest('[data-schedule-id]').dataset.scheduleId, el.closest('[data-dept-section]'));
}

/** Materializes a still-on-default department's schedule into real, editable rows (no functional change) via POST .../customize, then refreshes the list. */
async function customizeAuditSchedule(deptId) {
    try {
        const res = await fetch(`/api/departments/${deptId}/audit-schedule/customize`, { method: 'POST', headers: { 'X-Requested-With': 'ToolTracker' } });
        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || 'Failed to customize schedule.'));
        loadAuditSchedules();
    } catch (e) {
        alert('❌ Network error.');
    }
}

/**
 * Shared by addAuditWindow/saveAuditWindow: reads the label/time inputs out of `rowEl`,
 * validates, sends the given method/url, and on success refreshes both the schedule list and
 * the live status chips (the edit can change a window's label/time, which the status view
 * also shows). The two callers differ only in HTTP method/URL/error fallback text.
 */
async function submitAuditWindow(method, url, rowEl, fallbackMsg) {
    const label = rowEl.querySelector('[data-field="label"]').value;
    const startMinute = auditTimeStringToMinutes(rowEl.querySelector('[data-field="start_minute"]').value);
    if (Number.isNaN(startMinute)) return alert('⚠️ A start time is required.');
    try {
        const res = await fetch(url, {
            method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ label, start_minute: startMinute }),
        });
        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || fallbackMsg));
        loadAuditSchedules();
        loadAuditStatus();
    } catch (e) {
        alert('❌ Network error.');
    }
}

/** Reads the label/time inputs out of an "+ Add Window" row and POSTs a new window for that department. */
function addAuditWindow(deptId, rowEl) {
    return submitAuditWindow('POST', `/api/departments/${deptId}/audit-schedule`, rowEl, 'Failed to add audit window.');
}

/** Reads the label/time inputs out of an existing window row and PUTs the update. */
function saveAuditWindow(rowEl) {
    return submitAuditWindow('PUT', `/api/audit-schedule/${rowEl.dataset.scheduleId}`, rowEl, 'Failed to save audit window.');
}

/** Deletes one audit window, confirming first -- with an extra warning if it's the department's last one, since that reverts it to the default schedule (see server.js's getDeptAuditSchedule). `deptSectionEl` scopes the "is this the last one" check to just this department's rows, not every department shown in the list. */
async function deleteAuditWindow(scheduleId, deptSectionEl) {
    const isLast = (deptSectionEl ? deptSectionEl.querySelectorAll('[data-schedule-id]').length : 2) <= 1;
    const msg = isLast
        ? 'This is the last custom window for this department -- removing it will revert the department to the default schedule (Morning 04:00 / Afternoon 14:00). Continue?'
        : 'Remove this audit window?';
    if (!confirm(msg)) return;
    try {
        const res = await fetch(`/api/audit-schedule/${scheduleId}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || 'Failed to remove audit window.'));
        loadAuditSchedules();
        loadAuditStatus();
    } catch (e) {
        alert('❌ Network error.');
    }
}

/** Confirms with the operator, then sends DELETE /api/{type}/{id} for a department/toolbox/drawer (type is the plural REST segment, e.g. 'departments', 'toolboxes', 'drawers'); the API rejects non-empty structures. Refreshes the tree and dropdowns on success. */
async function deleteInfraItem(type, id) {
    if (!confirm(`Are you sure you want to delete this structure? It will only succeed if it is empty.`)) return;
    try {
        const res = await fetch(`/api/${type}/${id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
        if (res.ok) { closeEntityModal(); await renderEditableInfraTree(); syncStorageHierarchyDropdowns(); renderDepartmentRoster(); }
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
 * Looks up the next sequential barcode id for a prefix via GET /api/tools/next-id -- pure
 * fetch, no DOM side effects. Reused by fetchNextToolId() below (writes the result into
 * #add-tool-id as a live preview) and by addNewTool()'s batch-ingest loop (calls this fresh
 * once per tool actually being saved, since each save changes what the next lowest-unused
 * number is -- the authoritative id for tool N+1 of a batch can only be known once tool N has
 * actually been committed).
 */
async function fetchNextSequentialId(prefix) {
    const res = await fetch(`/api/tools/next-id?prefix=${prefix}-`);
    const data = await res.json();
    if (!data.success) throw new Error('Failed to generate the next barcode ID.');
    return `${prefix}-${data.next_sequence}`;
}

/**
 * Requests the next sequential tool barcode and writes the FULL id (prefix + sequence) into
 * the read-only #add-tool-id field, using the prefix carried on the selected #add-tool-dept
 * option's data-prefix attribute (see syncStorageHierarchyDropdowns). Deriving the prefix from
 * the department selection directly -- rather than a second, independent prefix dropdown -- is
 * what guarantees the barcode id and the drawer assignment always agree on department; that
 * mismatch was the root cause of tools ending up filed under the wrong department's boxes.
 *
 * At quantity > 1 (batch ingest, see onAddToolQuantityChange()) this id is only a PREVIEW of
 * where the batch will start -- #add-tool-id-range-note shows the full range it would currently
 * produce, but the real ids are each freshly fetched at save time (addNewTool()'s loop), so
 * this preview can't go stale/collide even if another tool gets created elsewhere in between.
 */
async function fetchNextToolId() {
    const deptSelect = document.getElementById('add-tool-dept');
    const idField = document.getElementById('add-tool-id');
    const rangeNote = document.getElementById('add-tool-id-range-note');
    const prefix = deptSelect.selectedOptions[0]?.dataset.prefix;
    const quantity = Math.max(1, parseInt(document.getElementById('add-tool-quantity').value, 10) || 1);
    if (!prefix) { idField.value = ''; idField.placeholder = 'Select a department first...'; rangeNote.style.display = 'none'; return; }

    idField.value = 'Generating...';
    try {
        idField.value = await fetchNextSequentialId(prefix);
        if (quantity > 1) {
            const firstNum = parseInt(idField.value.split('-').pop(), 10);
            const lastId = `${prefix}-${String(firstNum + quantity - 1).padStart(4, '0')}`;
            rangeNote.textContent = `Will assign ${quantity} sequential IDs: ${idField.value} through ${lastId}`;
            rangeNote.style.display = 'block';
        } else {
            rangeNote.style.display = 'none';
        }
    } catch (err) {
        idField.value = 'Error';
        rangeNote.style.display = 'none';
    }
}

/**
 * Change handler for #add-tool-quantity -- toggles the Ingest form between single-tool and
 * batch-ingest modes. At quantity > 1: the serial number field is cleared and disabled (a
 * shared serial would collide on the second tool via the duplicate-serial guard -- set
 * individual serials afterward via each tool's edit form if needed), the barcode scan-override
 * button is hidden (every id in a batch is always auto-assigned, never scanned off an existing
 * physical label), and the barcode field becomes a range preview instead of a single id (see
 * fetchNextToolId()).
 */
function onAddToolQuantityChange() {
    const quantityInput = document.getElementById('add-tool-quantity');
    const quantity = Math.max(1, parseInt(quantityInput.value, 10) || 1);
    quantityInput.value = quantity;

    const serialField = document.getElementById('add-tool-serial');
    serialField.disabled = quantity > 1;
    if (quantity > 1) serialField.value = '';

    document.getElementById('btn-add-tool-scan').style.display = quantity > 1 ? 'none' : '';
    fetchNextToolId();
    renderBatchCalRows();
}

/**
 * Switches the ingest form's calibration date fields between the single shared pair
 * (#add-tool-cal-fields, Quantity === 1) and one date pair per tool in the batch
 * (#add-tool-cal-batch-fields, Quantity > 1) -- each physical tool in a batch often has its own
 * actual calibration date (e.g. a mixed-date shipment), so a single shared date doesn't always
 * fit. Tools aren't named/ID'd yet at this point (barcode IDs are only fetched at save time, one
 * per tool, inside addNewTool()'s own loop), so rows are just labeled by position ("Tool 1",
 * "Tool 2"...), matching the order they'll be saved in. Re-rendering preserves whatever's already
 * typed into a row that still exists after the count changes (e.g. bumping Quantity from 3 to 5
 * keeps rows 1-3 as entered and only adds fresh rows 4-5).
 */
function renderBatchCalRows() {
    const quantity = Math.max(1, parseInt(document.getElementById('add-tool-quantity').value, 10) || 1);
    const isCalibrated = document.getElementById('add-tool-is-cal').checked;
    const singleFields = document.getElementById('add-tool-cal-fields');
    const batchFields = document.getElementById('add-tool-cal-batch-fields');
    const useBatchRows = isCalibrated && quantity > 1;

    singleFields.style.display = isCalibrated && quantity === 1 ? 'flex' : 'none';
    batchFields.style.display = useBatchRows ? 'flex' : 'none';
    if (!useBatchRows) return;

    const existing = [];
    for (let i = 0; i < quantity; i++) {
        existing.push({
            last: document.getElementById(`add-tool-last-cal-${i}`)?.value || '',
            due: document.getElementById(`add-tool-cal-due-${i}`)?.value || '',
        });
    }
    batchFields.innerHTML = existing.map((v, i) => `
        <div class="cal-date-pair" style="align-items:center;">
            <span style="font-size:12px; color:var(--muted); width:52px; flex-shrink:0;">Tool ${i + 1}</span>
            <div class="form-group" style="margin:0; flex:1;"><label class="form-label">Last Calibrated</label><input type="date" class="form-input" id="add-tool-last-cal-${i}" value="${v.last}" onchange="document.getElementById('add-tool-cal-due-${i}').value = oneYearFromDate(this.value)"></div>
            <div class="form-group" style="margin:0; flex:1;"><label class="form-label">Calibration Due</label><input type="date" class="form-input" id="add-tool-cal-due-${i}" value="${v.due}"></div>
        </div>
    `).join('');
}

/** Change handler for #add-tool-photo -- swaps the placeholder camera icon for a thumbnail of the chosen file, purely client-side (nothing uploaded yet, see addNewTool()). */
function previewAddToolPhoto() {
    const file = document.getElementById('add-tool-photo').files[0];
    const preview = document.getElementById('add-tool-photo-preview');
    if (!file) { preview.innerHTML = `<span class="icon" data-icon="camera" style="color: var(--muted);"></span>`; hydrateIcons(preview); return; }
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" style="width:100%;height:100%;object-fit:cover;">`;
}

/**
 * Validates and submits the "Ingest New Asset" form to POST /api/tools. Department, toolbox,
 * and drawer are all required (previously drawer alone was optional and unscoped, which is how
 * tools ended up filed under the wrong department -- see fetchNextToolId).
 *
 * #add-tool-quantity > 1 ingests that many identical tools in one pass -- same name/
 * description/part number/location/photo/calibration flag, each with its OWN barcode id
 * (fetched fresh per tool via fetchNextSequentialId(), never computed client-side in advance,
 * so it's correct even if something else creates a tool in the middle of a large batch) exactly
 * as if entered one at a time. At the default quantity of 1 this is indistinguishable from the
 * tool's original single-save behavior (same alert, same field reset) -- the loop below always
 * runs at least once either way.
 *
 * is_calibrated/last_cal_date/cal_due_date are now actually sent (previously the checkbox and
 * its date fields were visually present but never read here at all -- a real pre-existing gap,
 * not something this batch feature introduced, just one it would have been wrong to build on
 * top of unfixed). Checking "Requires Calibration Tracking" sets the flag on every tool in the
 * batch, but the dates themselves are per-tool, not shared -- each physical tool in a batch often
 * has its own real calibration date (e.g. a mixed-date shipment), so James asked for dates to be
 * entered per item rather than one shared date applied to all of them. See renderBatchCalRows()
 * for the Quantity > 1 per-tool rows (#add-tool-last-cal-N/#add-tool-cal-due-N); at Quantity ===
 * 1 the original single shared pair is still used. These are bare dates only, not a real
 * calibration_records row (provider, certificate, standard) -- for calibrated tools, the results
 * list below links straight to each new tool's own card, where "+ Log Calibration" already
 * exists for exactly that, same as it always has for a tool added one at a time.
 */
async function addNewTool() {
    const quantity = Math.max(1, parseInt(document.getElementById('add-tool-quantity').value, 10) || 1);
    const deptSelect = document.getElementById('add-tool-dept');
    const prefix = deptSelect.selectedOptions[0]?.dataset.prefix;
    const isCalibrated = document.getElementById('add-tool-is-cal').checked;

    const sharedFields = {
        name: document.getElementById('add-tool-name').value,
        description: document.getElementById('add-tool-desc').value,
        part_number: document.getElementById('add-tool-partnum').value || null,
        replacement_url: document.getElementById('add-tool-url').value,
        drawer_id: document.getElementById('add-tool-drawer').value,
        is_calibrated: isCalibrated,
    };
    // Calibration dates are per-tool, not shared -- at Quantity === 1 there's only ever the one
    // shared pair to read; at Quantity > 1, each tool reads its own row (see
    // renderBatchCalRows()), indexed to match the save order below.
    const calDatesFor = (i) => isCalibrated
        ? (quantity > 1
            ? { last_cal_date: document.getElementById(`add-tool-last-cal-${i}`)?.value || null, cal_due_date: document.getElementById(`add-tool-cal-due-${i}`)?.value || null }
            : { last_cal_date: document.getElementById('add-tool-last-cal').value || null, cal_due_date: document.getElementById('add-tool-cal-due').value || null })
        : { last_cal_date: null, cal_due_date: null };
    if (!sharedFields.name) return alert('⚠️ Name is required.');
    if (!deptSelect.value || !document.getElementById('add-tool-box').value || !sharedFields.drawer_id) {
        return alert('⚠️ Select a department, toolbox, and drawer for this asset.');
    }
    if (quantity === 1 && !document.getElementById('add-tool-id').value) return alert('⚠️ Barcode ID is required.');
    if (quantity > 1 && !prefix) return alert('⚠️ Select a department first.');

    // Serial number is single-tool only -- disabled/cleared client-side by
    // onAddToolQuantityChange() already, re-checked here since that's a UX nicety, not
    // validation a request could bypass. A shared serial across a batch would just collide on
    // the second tool anyway (the duplicate-serial guard), so this isn't a new restriction, just
    // one surfaced clearly instead of as a confusing per-item save failure.
    const serialNumber = quantity === 1 ? (document.getElementById('add-tool-serial').value || null) : null;
    const photoFile = document.getElementById('add-tool-photo').files[0];
    const saveBtn = document.getElementById('btn-save-asset');
    const originalBtnText = saveBtn.textContent;
    const results = [];

    saveBtn.disabled = true;
    try {
        for (let i = 0; i < quantity; i++) {
            if (quantity > 1) saveBtn.textContent = `Saving ${i + 1}/${quantity}...`;

            let qrCode;
            try {
                qrCode = quantity === 1 ? document.getElementById('add-tool-id').value : await fetchNextSequentialId(prefix);
            } catch (err) {
                results.push({ qr_code: '--', success: false, message: 'Failed to generate a barcode ID.' });
                continue;
            }

            try {
                const res = await fetch('/api/tools', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
                    body: JSON.stringify({ ...sharedFields, ...calDatesFor(i), qr_code: qrCode, serial_number: serialNumber })
                });
                const data = await res.json();
                if (!res.ok) { results.push({ qr_code: qrCode, success: false, message: data.error || 'Failed to save.' }); continue; }

                // Best-effort, same reasoning as every other photo upload in this app -- a tool
                // that was otherwise saved fine shouldn't be reported as failed over a photo
                // that can just as easily be added later from its own card (the only way this
                // worked before photo-at-ingest existed). POST /api/upload is the exact same
                // endpoint/entity_type the "Photo" button on an existing tool's card already
                // uses -- no bespoke "attach a photo at creation time" path on the server, just
                // this form sequencing the two existing requests back to back, once per tool.
                let message = 'Saved';
                if (photoFile) {
                    const formData = new FormData();
                    formData.append('photo', photoFile);
                    formData.append('entity_type', 'tool');
                    formData.append('entity_id', qrCode);
                    try {
                        const photoRes = await fetch('/api/upload', { method: 'POST', headers: { 'X-Requested-With': 'ToolTracker' }, body: formData });
                        if (!photoRes.ok) message = 'Saved (photo upload failed)';
                    } catch (err) {
                        message = 'Saved (photo upload failed)';
                    }
                }
                results.push({ qr_code: qrCode, success: true, message });
            } catch (err) {
                results.push({ qr_code: qrCode, success: false, message: 'Network error.' });
            }
        }
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalBtnText;
    }

    if (results.some(r => r.success)) {
        document.getElementById('add-tool-name').value = '';
        document.getElementById('add-tool-desc').value = '';
        document.getElementById('add-tool-serial').value = '';
        document.getElementById('add-tool-partnum').value = '';
        document.getElementById('add-tool-url').value = '';
        document.getElementById('add-tool-dept').value = '';
        document.getElementById('add-tool-box').innerHTML = '<option value="">-- Select a department first --</option>';
        document.getElementById('add-tool-drawer').innerHTML = '<option value="">-- Select a toolbox first --</option>';
        document.getElementById('add-tool-id').value = '';
        document.getElementById('add-tool-id-range-note').style.display = 'none';
        document.getElementById('add-tool-photo').value = '';
        document.getElementById('add-tool-quantity').value = '1';
        document.getElementById('add-tool-is-cal').checked = false;
        document.getElementById('add-tool-cal-fields').style.display = 'none';
        document.getElementById('add-tool-last-cal').value = '';
        document.getElementById('add-tool-cal-due').value = '';
        document.getElementById('add-tool-cal-batch-fields').innerHTML = '';
        previewAddToolPhoto();
        onAddToolQuantityChange(); // also re-hides the (already-empty) batch cal rows via renderBatchCalRows()
        await renderEditableInfraTree(); // awaited so globalToolsCache already has the new tools by the time the results list below is clickable
    }

    renderAddToolResults(results);
}

/**
 * Renders the post-save summary for addNewTool() -- one row per tool actually attempted,
 * success or failure, for both a single save and a batch (#add-tool-quantity > 1) alike. A
 * partial batch failure (e.g. a mid-batch network hiccup) stays visible instead of being
 * lumped into one pass/fail result the way a single alert() would be -- and a plain single-
 * tool save gets the same immediate path onward instead of a dead-end alert(). Each successful
 * row opens that tool's own entity card (openEntityModal(), same as clicking it in the Master
 * Storage & Asset Tree) -- the existing "+ Log Calibration" form, Sub-Assemblies section, and
 * Photo button there are how a tool's individual detail gets filled in, right away or later;
 * nothing new needed for that, the tool is already fully real and usable the moment it's
 * created either way.
 */
function renderAddToolResults(results) {
    const container = document.getElementById('add-tool-results');
    const successCount = results.filter(r => r.success).length;
    container.style.display = 'block';
    container.innerHTML = `
        <div style="font-size:13px; margin-bottom:8px;">
            <strong>${successCount} of ${results.length} saved.</strong>
            ${successCount ? ' Click a tool below to open its card -- log calibration, add sub-assemblies, attach a photo, etc. -- or come back to it later.' : ''}
        </div>
        <div style="display:flex; flex-direction:column; gap:4px; max-height:260px; overflow-y:auto;">
            ${results.map(r => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; border-radius:6px; background: var(--surface2);${r.success ? ' cursor:pointer;' : ''}"${r.success ? ` onclick="openEntityModal('tool', '${r.qr_code}')"` : ''}>
                    <span style="font-family:monospace; font-size:12px;">${r.qr_code}</span>
                    <span style="font-size:12px; color: ${r.success ? 'var(--green)' : 'var(--red)'};">${r.success ? icon('circle-check') : icon('circle-x')} ${r.message}</span>
                </div>
            `).join('')}
        </div>
    `;
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
async function initCameraCore(elementId, callback) {
    document.getElementById(elementId).style.display = 'block';
    // html5QrAdminInstance is one shared module-level scanner -- if a previous scan is still
    // actively running (e.g. the operator opened this scanner, then clicked a different scan
    // button before anything decoded), .clear() alone throws ("Cannot clear while scan is
    // ongoing, close it first"), aborting this function before the new instance ever starts.
    // .stop() first (the correct way to halt an active scan) avoids that; both are wrapped since
    // calling either on an already-stopped/never-started instance can itself reject/throw.
    if (html5QrAdminInstance) {
        try { await html5QrAdminInstance.stop(); } catch (e) { /* already stopped */ }
        try { html5QrAdminInstance.clear(); } catch (e) { /* nothing to clear */ }
    }
    html5QrAdminInstance = new Html5Qrcode(elementId);
    html5QrAdminInstance.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: 250, aspectRatio: 1.0 }, // matches the .camera-reader CSS's fixed 1:1 box so the preview doesn't stretch/squish when the phone rotates
        (txt) => { playScanFeedback(); html5QrAdminInstance.stop().then(() => { document.getElementById(elementId).style.display = 'none'; callback(txt); }); }
    ).catch((err) => { alert("Camera Error"); document.getElementById(elementId).style.display = 'none'; });
}
/** Opens the login-screen scanner and writes the decoded badge id into #admin-badge. Shares #admin-login-reader with startQrLoginCamera() below -- only one scan happens at a time on this screen either way, so one reader element/camera stream serves both entry points. */
function startAdminLoginCamera() { initCameraCore('admin-login-reader', (txt) => { document.getElementById('admin-badge').value = txt; }); }

/** Opens the login-card scanner (see "Scan Login Card" on #auth-wall) -- decoded text goes straight to handleQrLoginScan() instead of filling a field, since a login card logs straight in with no PIN. */
function startQrLoginCamera() { initCameraCore('admin-login-reader', handleQrLoginScan); }

/**
 * Submits a scanned login-card token to POST /api/login/qr -- no PIN involved, unlike
 * loginAdmin() below. On success, hands off to bootstrapAdminUI() exactly the same as a normal
 * badge/PIN login; on failure (card not recognized, or the account's been deactivated/reissued
 * since this card was printed), surfaces the error and leaves the manual form available.
 */
async function handleQrLoginScan(token) {
    try {
        const response = await fetch('/api/login/qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await response.json();
        if (!response.ok) return alert('❌ ' + (data.error || 'Login card not recognized.'));
        bootstrapAdminUI(data.user);
    } catch (err) {
        alert('Server connection failure.');
    }
}
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
        const currentDeptGroup = globalDeptGroupsCache.find(g => g.group_id == entity.cross_checkout_group_id);
        // Whether THIS department currently has any tool, of any status, assigned to it anywhere
        // under it -- the same question PUT /api/departments/:id enforces server-side before
        // allowing no_tool_inventory to be turned on, computed here too so the checkbox can be
        // disabled (with an explanation) before a doomed save attempt rather than after one.
        const hasTools = deptHasAnyTools(entity.dept_id);
        readHtml = `
            <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Prefix Code</div><div style="font-size:14px;margin-top:4px;font-family:monospace;">${entity.prefix_code}</div></div>
            <div style="margin-top:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Cross-Checkout Group</div><div style="font-size:14px;margin-top:4px;">${currentDeptGroup ? currentDeptGroup.name : '-- None --'}</div></div>
            <div style="margin-top:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Tool Inventory</div><div style="font-size:14px;margin-top:4px;">${entity.no_tool_inventory ? 'Not tracked (excluded from audits)' : 'Tracked'}</div></div>
        `;
        fieldsHtml = `
            <div class="form-group"><label class="form-label">Department Name</label><input class="form-input" id="em-input-name" value="${entity.name}"></div>
            <div class="form-group">
                <label class="form-label">Prefix Code</label>
                <div style="padding:8px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size:13px; font-family:monospace; color:var(--muted);">${entity.prefix_code}</div>
                <div style="font-size:11px; color: var(--muted); margin-top:4px;">Can't be changed after creation -- it's embedded in every existing barcode ID under this department.</div>
            </div>
            <div class="form-group">
                <label class="form-label">Cross-Checkout Group</label>
                <select class="form-select" id="em-input-dept-group">
                    <option value="">-- None --</option>
                    ${globalDeptGroupsCache.map(g => `<option value="${g.group_id}" ${g.group_id == entity.cross_checkout_group_id ? 'selected' : ''}>${g.name}</option>`).join('')}
                </select>
                <div style="font-size:11px; color: var(--muted); margin-top:4px;">Departments sharing a group can freely check out each other's tools -- manage groups from Department Management.</div>
            </div>
            <div class="form-group">
                <label class="form-label" style="display:flex; align-items:center; gap:8px; cursor:${hasTools ? 'not-allowed' : 'pointer'};">
                    <input type="checkbox" id="em-input-no-inventory" ${entity.no_tool_inventory ? 'checked' : ''} ${hasTools ? 'disabled' : ''}>
                    This department does not track tool inventory
                </label>
                <div style="font-size:11px; margin-top:4px; color:${hasTools ? 'var(--red)' : 'var(--muted)'};">
                    ${hasTools
                        ? "Can't enable -- this department still has tools assigned. Move or retire them first."
                        : 'Removes this department from the Audit Schedule card and the audit-status dashboard/kiosk chips -- for a department that will never hold a tool.'}
                </div>
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
        // Read-only, so offered regardless of canEditInfra -- same level as viewing the modal at all.
        actionsHtml += `<button class="btn btn-secondary" style="width:auto;" onclick="openToolboxPrintSheet('${entity.box_id}')">${icon('printer')} Print Sheet</button>`;
        actionsHtml += `<button class="btn btn-secondary" style="width:auto;" onclick="openToolCardsPrintSheet('${entity.box_id}')">${icon('id-card')} Print Tool Cards</button>`;

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
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Tool Positions (Shadow Board Map)</div>
                    ${canEditTools ? `<button type="button" class="btn-icon" style="width:28px;height:28px;padding:0;" title="Open large editor to drag tools into position" onclick="openPositionEditor(${entity.drawer_id})">${icon('move')}</button>` : ''}
                </div>
                <div id="em-position-map-wrap" style="position:relative;display:inline-block;max-width:100%;border-radius:8px;overflow:hidden;border:1px solid var(--border);line-height:0;">
                    <img id="em-position-map-img" src="${entity.photo_url}" style="display:block;max-width:100%;">
                    <div id="em-position-map-markers" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"></div>
                </div>
                <div id="em-position-map-controls" style="margin-top:10px;"></div>
            </div>
        ` : '';

        // Photo is gated at canEditTools (tool_rep+), one level below Edit/Delete's
        // canEditInfra (dept_admin+) -- keeping a drawer's shadow-board photo current (and
        // placing tool positions on it, see the Tool Positions section above, already
        // canEditTools-gated) is routine day-to-day inventory upkeep, not a structural change
        // to storage itself the way renaming or deleting a drawer is.
        if (canEditInfra) {
            actionsHtml += `
                <button class="btn btn-secondary" id="em-btn-edit" onclick="toggleModalEditMode(true)">${icon('pencil')} Edit Details</button>
                <button class="btn btn-primary" id="em-btn-save" style="display:none;" onclick="saveEntityUpdates()">${icon('save')} Save Changes</button>
            `;
        }
        if (canEditTools) {
            actionsHtml += `<button class="btn btn-secondary" onclick="triggerPhotoUpload('drawer', '${entity.drawer_id}')" style="width:auto;">${icon('camera')} Photo</button>`;
        }
        if (canEditInfra) {
            actionsHtml += `<button class="btn btn-secondary" onclick="deleteInfraItem('drawers', '${entity.drawer_id}')" style="width:auto; color: var(--red); border-color: var(--red);">${icon('x')} Delete</button>`;
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
            <div style="margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase; margin-bottom:8px;">Alt Part Numbers</div>
                <div style="display:flex; flex-wrap:wrap; gap:6px;${canEditTools ? ' margin-bottom:8px;' : ''}">
                    ${(entity.alt_part_numbers || []).length === 0
                        ? `<span style="color:var(--muted); font-style:italic; font-size:12px;">None</span>`
                        : entity.alt_part_numbers.map(ap => `
                            <span style="display:inline-flex; align-items:center; gap:6px; background:var(--surface); padding:3px 8px; border-radius:4px; font-size:12px; font-family:monospace;">
                                ${ap.part_number}
                                ${canEditTools ? `<span style="cursor:pointer; color:var(--red); display:inline-flex;" onclick="deleteAltPartNumber(${ap.alt_id}, '${entity.qr_code}')" title="Remove">${icon('x')}</span>` : ''}
                            </span>
                        `).join('')}
                </div>
                ${canEditTools ? `
                    <div style="display:flex; gap:6px;">
                        <input class="form-input" id="em-new-alt-partnum" style="text-transform:uppercase; font-size:12px; padding:6px 10px;" placeholder="e.g. MS35206-262" oninput="uppercaseInput(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();addAltPartNumber('${entity.tool_id}','${entity.qr_code}');}">
                        <button type="button" class="btn-icon" style="width:auto; padding:6px 12px; font-size:12px; flex-shrink:0;" onclick="addAltPartNumber('${entity.tool_id}','${entity.qr_code}')">${icon('plus')} Add</button>
                    </div>
                ` : ''}
            </div>
            <div style="display: flex; gap: 30px; margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Status</div><div style="font-size:14px;margin-top:4px;font-weight:bold;color:var(--accent);">${entity.status}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Calibration</div><div style="font-size:14px;margin-top:4px;font-weight:bold;">${calText}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Group</div><div style="font-size:14px;margin-top:4px;font-weight:bold;">${entity.group_name || '--'}</div></div>
            </div>
            <div style="margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Barcode</div>
                    ${entity.barcode_image_url_small ? `
                        <a href="${entity.barcode_image_url_small}" download style="color:var(--blue); font-size:11px; text-decoration:none;">${icon('download')} Download</a>
                    ` : ''}
                </div>
                ${entity.barcode_image_url_small
                    ? `<div style="text-align:center;"><img src="${entity.barcode_image_url_small}" onclick="openImageModal('${entity.barcode_image_url_small}')" style="width:100px;height:100px;object-fit:contain;background:#fff;border-radius:4px;cursor:zoom-in;"></div>`
                    : `<span style="color:var(--muted); font-size:11px;">No barcode on file.</span>`}
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
                    <div class="cal-date-pair" style="margin-bottom:10px;">
                        <div class="form-group" style="margin:0;"><label class="form-label">Calibration Date</label><input type="date" class="form-input" id="em-cal-date" onchange="document.getElementById('em-cal-due').value = oneYearFromDate(this.value)"></div>
                        <div class="form-group" style="margin:0;"><label class="form-label">Due Date</label><input type="date" class="form-input" id="em-cal-due"></div>
                    </div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Provider / Lab</label><input class="form-input" id="em-cal-provider" placeholder="e.g. Snap-on Calibration Services"></div>
                    <div class="form-group" style="margin-bottom:4px;"><label class="form-label">Certificate / Reference #</label><input class="form-input" id="em-cal-cert" placeholder="e.g. CERT-2026-04231"></div>
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; text-transform:none; font-size:12px; color:var(--muted); margin-bottom:10px;">
                        <input type="checkbox" id="em-cal-cert-pending" onchange="toggleCertPending('em-cal-cert', this.checked)"> Certificate not yet received from vendor -- can be added later once it arrives
                    </label>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Standard Used <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="em-cal-standard" placeholder="e.g. NIST-traceable"></div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Vendor Tracking # <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="em-cal-vendor-tracking" placeholder="e.g. this vendor's own serial/asset ID, if different from ours"></div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Notes <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="em-cal-notes"></div>
                    <div class="form-group" style="margin-bottom:10px;">
                        <label class="form-label">Result</label>
                        <select class="form-select" id="em-cal-result">
                            <option value="Pass">Pass</option>
                            <option value="Fail">Fail -- out of tolerance</option>
                        </select>
                        <div style="font-size:11px; color:var(--muted); margin-top:4px;">A Fail blocks this tool from checkout immediately and opens a trace-back investigation for every task it did since its last passing calibration.</div>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-secondary" style="width:auto;" onclick="toggleCalLogForm(false)">Cancel</button>
                        <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitCalLogForm('${entity.tool_id}', '${entity.qr_code}')">Save Record</button>
                    </div>
                </div>
            </div>
        `;
        // Sub-assemblies (migrations/018) -- e.g. the specific die on a crimper. Unlike
        // calibration history/incidents/investigations above, this data is already embedded
        // on `entity` (see GET /api/tools' sub_assemblies lateral join), so it's rendered
        // directly here instead of needing its own async loader. currentEntitySubAssemblies
        // backs openEditSubAssemblyForm()'s by-id lookup. Any sub that itself needs
        // calibration and is out of cal blocks THIS tool's checkout -- see the A1 hard-stop in
        // POST /api/transactions -- so its status pill uses the same red/expired treatment as
        // the parent's own calibration block above.
        currentEntitySubAssemblies = entity.sub_assemblies || [];
        const today = new Date(new Date().toDateString());
        const subRows = currentEntitySubAssemblies.length === 0
            ? `<span style="color:var(--muted); font-style:italic; font-size:12px;">No sub-assemblies.</span>`
            : currentEntitySubAssemblies.map(sa => {
                let pill;
                if (!sa.is_calibrated) {
                    pill = `<span style="color:var(--muted); font-style:italic;">Not calibrated</span>`;
                } else if (!sa.cal_due_date) {
                    pill = `<span style="color:var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} No due date</span>`;
                } else if (new Date(sa.cal_due_date) <= today) {
                    pill = `<span style="color:var(--red); font-weight:bold;">${icon('circle-x', 'icon-danger')} Cal expired</span>`;
                } else {
                    pill = `<span>Cal Due: ${sa.cal_due_date.split('T')[0]}</span>`;
                }
                const partLine = sa.part_number ? ` <span style="color:var(--muted); font-family:monospace; font-size:11px;">(${sa.part_number})</span>` : '';
                const controls = canEditTools ? `
                    <span style="cursor:pointer; color:var(--muted);" onclick="openEditSubAssemblyForm(${sa.sub_id})" title="Edit">${icon('pencil')}</span>
                    <span style="cursor:pointer; color:var(--red);" onclick="deleteSubAssembly(${sa.sub_id}, '${entity.qr_code}')" title="Delete">${icon('x')}</span>` : '';
                return `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.02); font-size:12px;">
                    <span>${sa.name}${partLine}</span>
                    <span style="display:flex; align-items:center; gap:10px;">${pill}${controls}</span>
                </div>`;
            }).join('');
        readHtml += `
            <div id="em-sub-assemblies-container" style="margin-top:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Sub-Assemblies</div>
                    ${canEditTools ? `<button type="button" class="btn-icon" style="width:auto; padding:4px 10px; font-size:11px;" onclick="toggleSubAssemblyForm(true)">${icon('plus')} Add Sub-Assembly</button>` : ''}
                </div>
                <div id="em-sub-assemblies-list" style="margin-top:4px;">${subRows}</div>

                <div id="em-sub-assembly-form" style="display:none; margin-top:10px; background: rgba(255,255,255,0.02); padding:12px; border-radius:8px; border:1px solid var(--border);">
                    <input type="hidden" id="em-sub-edit-id" value="">
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Name</label><input class="form-input" id="em-sub-name" placeholder="e.g. 10 AWG Die"></div>
                    <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom:10px;">
                        <div class="form-group" style="margin:0;"><label class="form-label">Part Number</label><input class="form-input" id="em-sub-part-number" style="text-transform:uppercase;" oninput="uppercaseInput(this)"></div>
                        <div class="form-group" style="margin:0;"><label class="form-label">Serial Number</label><input class="form-input" id="em-sub-serial" style="text-transform:uppercase;" oninput="uppercaseInput(this)"></div>
                    </div>
                    <div class="form-group" style="margin-bottom:10px;">
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; text-transform:none; font-size:13px;"><input type="checkbox" id="em-sub-is-calibrated" onchange="toggleSubCalFields()"> Requires Calibration Tracking</label>
                    </div>
                    <div id="em-sub-cal-fields" style="display:none; margin-bottom:10px;">
                        <div class="cal-date-pair">
                            <div class="form-group" style="margin:0;"><label class="form-label">Last Calibrated</label><input type="date" class="form-input" id="em-sub-last-cal" onchange="document.getElementById('em-sub-cal-due').value = oneYearFromDate(this.value)"></div>
                            <div class="form-group" style="margin:0;"><label class="form-label">Calibration Due</label><input type="date" class="form-input" id="em-sub-cal-due"></div>
                        </div>
                    </div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Notes <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="em-sub-notes"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-secondary" style="width:auto;" onclick="toggleSubAssemblyForm(false)">Cancel</button>
                        <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitSubAssemblyForm('${entity.tool_id}', '${entity.qr_code}')">Save Sub-Assembly</button>
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
                            ${entity.status === 'In' ? `<option value="RESOLVED">Found / Repaired -- Return to Service</option>` : ''}
                            <option value="WRITTEN_OFF">Write Off -- Retire Permanently</option>
                        </select>
                        ${entity.status !== 'In' ? `<div style="font-size:11px; color: var(--muted); margin-top:4px;">To resolve as Found/Repaired, scan this tool in (Check-In) at the kiosk first -- that's the actual "it's back" moment. Come back here afterward just to close out the incident record, or write it off now if it's gone for good.</div>` : ''}
                    </div>
                    <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Resolution Notes</label><input class="form-input" id="em-incident-notes" placeholder="e.g. Found in Drawer 3, mislabeled during last audit"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitIncidentResolve('${entity.tool_id}', '${entity.qr_code}')">Submit Resolution</button>
                    </div>
                </div>
            </div>
        `;
        // #em-trace-investigations-list is populated asynchronously by
        // loadTraceInvestigations() below -- a compact summary only (which investigations
        // exist for this tool and their review progress); actually recording review outcomes
        // and closing/overriding happens from the shop-wide Trace-Back Investigations card in
        // Reports (see loadTraceInvestigationsList()/openTraceInvestigationDetail()), same
        // split as Work Orders. Shown for every tool, not just calibrated ones -- a failed
        // calibration auto-opens one, but the manual "+ Open Investigation" path is just as
        // useful for a non-calibrated tool suspected of a defect (e.g. a customer complaint).
        readHtml += `
            <div id="em-trace-investigations-container" style="margin-top:15px;">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Trace-Back Investigations</div>
                <div id="em-trace-investigations-list" style="font-size:12px;color:var(--muted);margin-top:4px;">Loading...</div>
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
                 // staying the same or retiring from these states. "In" is deliberately NOT
                 // offered here (or anywhere in this dropdown, for any status) -- a flagged
                 // tool only returns to service by actually being scanned in at the kiosk
                 // (Check-In), not by an admin editing its status. That kiosk scan is the real
                 // accountability moment; this form can't substitute for it.
            statusFieldHtml = `
                <div class="form-group"><label class="form-label">Physical Status</label>
                    <select class="form-select" id="em-input-status">
                        <option value="${entity.status}" selected>${entity.status} (No Change)</option>
                        <option value="Retired">Retired (Permanent)</option>
                    </select>
                    <div style="font-size:11px; color: var(--muted); margin-top:4px;">To bring this tool back into service, scan it in (Check-In) at the kiosk -- editing status here can't do that.</div>
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

        // Every group is offered regardless of department (not filtered to the tool's current
        // location) -- simpler than a live-filtered cascade, and mis-grouping across
        // departments is a minor data-hygiene issue rather than a security concern here.
        const groupOptions = '<option value="">-- No Group --</option>' +
            globalToolGroupsCache.map(g => `<option value="${g.group_id}" ${g.group_id == entity.group_id ? 'selected' : ''}>${g.name}${g.department_name ? ` (${g.department_name})` : ''}</option>`).join('');

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
                <div class="form-group"><label class="form-label">Serial Number</label><input class="form-input" id="em-input-serial" style="text-transform:uppercase;" oninput="uppercaseInput(this)" value="${entity.serial_number || ''}" placeholder="Optional"></div>
                <div class="form-group"><label class="form-label">Part Number (for reordering)</label><input class="form-input" id="em-input-partnum" style="text-transform:uppercase;" oninput="uppercaseInput(this)" value="${entity.part_number || ''}" placeholder="Optional"></div>
            </div>
            <div class="form-group"><label class="form-label">Group <span style="color:var(--muted);text-transform:none;">(optional -- part of a tracked kit/assembly)</span></label><select class="form-select" id="em-input-group">${groupOptions}</select></div>
            <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
                <div class="form-group"><label class="form-label">Replacement URL</label><input class="form-input" id="em-input-url" value="${entity.replacement_url || ''}"></div>
                ${statusFieldHtml}
            </div>
            <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 8px; border: 1px solid var(--border);">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; margin-bottom: 10px;">
                    <input type="checkbox" id="em-input-is-cal" ${entity.is_calibrated ? 'checked' : ''} onchange="document.getElementById('em-cal-dates').style.display = this.checked ? 'flex' : 'none'">
                    <strong>Requires Calibration</strong>
                </label>
                <div id="em-cal-dates" class="cal-date-pair" style="display: ${entity.is_calibrated ? 'flex' : 'none'};">
                    <div class="form-group" style="margin: 0;"><label class="form-label">Last Cal</label><input type="date" class="form-input" id="em-input-last-cal" value="${lastCal}" onchange="document.getElementById('em-input-cal-due').value = oneYearFromDate(this.value)"></div>
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

        const grantedDepts = entity.granted_depts || [];
        const grantedLabels = grantedDepts.map(g => {
            const dept = globalDeptsCache.find(d => d.dept_id == g.dept_id);
            return dept ? `${dept.name} (${ROLE_LABELS[g.role] || g.role})` : null;
        }).filter(Boolean);
        titleHtml = `<h3 style="margin:0;">${entity.full_name}</h3>`;
        readHtml = `
            <div style="display: flex; gap: 30px; margin-bottom:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Username</div><div style="font-size:14px;margin-top:4px;font-family:monospace;">${entity.username || '--'}</div></div>
                <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Email</div><div style="font-size:14px;margin-top:4px;">${entity.email || '--'}</div></div>
            </div>
            <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Department</div><div style="font-size:14px;margin-top:4px;">${entity.department_name || '--'}</div></div>
            <div style="margin-top:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">System Role</div><div style="font-size:14px;margin-top:4px;font-weight:bold;color:var(--accent);">${ROLE_LABELS[entity.role] || entity.role}</div></div>
            ${grantedLabels.length > 0 ? `<div style="margin-top:15px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Also Manages</div><div style="font-size:14px;margin-top:4px;">${grantedLabels.join(', ')}</div></div>` : ''}
            <div style="margin-top:15px; background: var(--surface2); padding: 12px; border-radius: 8px;">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">Login Card</div>
                ${entity.has_login_card ? `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img src="/api/users/${entity.badge_id}/login-card.png" onclick="openImageModal('/api/users/${entity.badge_id}/login-card.png')" style="width:70px;height:70px;object-fit:contain;background:#fff;border-radius:4px;cursor:zoom-in;">
                        <div style="display:flex; flex-direction:column; gap:6px;">
                            <button class="btn btn-secondary" style="width:auto;" onclick="printUserLoginCard('${entity.badge_id}')">${icon('printer')} Print Card</button>
                            <button class="btn btn-secondary" style="width:auto; font-size:11px;" onclick="issueUserLoginCard('${entity.badge_id}', true)">${icon('refresh-cw')} Reissue (invalidates old card)</button>
                        </div>
                    </div>
                ` : `
                    <button class="btn btn-secondary" style="width:auto;" onclick="issueUserLoginCard('${entity.badge_id}', false)">${icon('qr-code')} Generate Login Card</button>
                `}
            </div>
        `;
        fieldsHtml = `
            <div class="form-group">
                <label class="form-label">System Role</label>
                <select class="form-select" id="em-input-role">${roleOptionsUpTo(currentAdminWeight, entity.role)}</select>
                <div style="font-size:11px; color: var(--muted); margin-top:4px;">You can only assign roles up to your own level. This is their HOME role (${entity.department_name || '--'}) -- see below for independent roles in other departments.</div>
            </div>
            ${currentAdminWeight >= 4 ? `
                <div class="form-group" id="em-dept-access-section">
                    <label class="form-label">Per-Department Roles</label>
                    <div style="font-size:11px; color: var(--muted); margin-bottom:6px;">Grant this person an independent role in additional departments (e.g. dept_admin at home, tool_rep elsewhere). Capped at your own role -- super_admin can't be granted this way, it's a global role, not a per-department one.</div>
                    <div style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto; padding:8px; background: rgba(255,255,255,0.02); border-radius:6px; border:1px solid var(--border);">
                        ${globalDeptsCache.filter(d => d.dept_id != entity.dept_id).map(d => {
                            const existingGrant = grantedDepts.find(g => g.dept_id == d.dept_id);
                            return `
                            <div style="display:flex; align-items:center; gap:8px; font-size:13px;">
                                <span style="flex:1;">${d.name}</span>
                                <select class="em-input-granted-dept" data-dept-id="${d.dept_id}" style="width:auto; padding:4px 8px; font-size:12px;">
                                    <option value="">-- Not Granted --</option>
                                    ${roleOptionsUpTo(Math.min(currentAdminWeight, 3), existingGrant ? existingGrant.role : null)}
                                </select>
                            </div>`;
                        }).join('') || `<div style="font-size:12px; color: var(--muted);">No other departments exist yet.</div>`}
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

    if (type === 'tool') { loadCalibrationHistory(entity.tool_id); loadIncidentHistory(entity.tool_id); loadTraceInvestigations(entity.tool_id); }
    if (type === 'drawer' && entity.photo_url) { renderPositionMap(entity); }
}

/**
 * Shared data prep for both the compact position-map preview (renderPositionMap) and the
 * full-screen position editor (renderPositionEditor) -- splits a drawer's tools into
 * placed/unplaced and gives both the same status-to-marker-color mapping, so the two views
 * can't silently drift apart on what counts as "placed" or what color a status gets.
 */
function getDrawerPositionData(drawer) {
    const drawerTools = globalToolsCache.filter(t => t.drawer_id === drawer.drawer_id);
    return {
        drawerTools,
        placed: drawerTools.filter(t => t.position_x !== null && t.position_y !== null),
        unplaced: drawerTools.filter(t => t.position_x === null || t.position_y === null),
        statusColor: (status) => status === 'In' ? 'var(--green)' : (status === 'Out' ? 'var(--accent)' : 'var(--red)'),
    };
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

    const { drawerTools, placed, unplaced, statusColor } = getDrawerPositionData(drawer);
    // Excludes Retired tools, unlike getDrawerPositionData()'s own drawerTools -- matches the
    // print sheet's established "empty" definition (see emptyDrawerStamp()) without changing
    // that shared helper's behavior for its other callers.
    const isEmpty = !globalToolsCache.some(t => t.drawer_id === drawer.drawer_id && t.status !== 'Retired');

    markersEl.innerHTML = placed.map(t => `
        <div title="${t.name} (${t.status})" onclick="event.stopPropagation();${canEditTools ? ` unplaceToolPosition('${t.qr_code}')` : ''}"
             style="position:absolute; left:${t.position_x * 100}%; top:${t.position_y * 100}%; transform:translate(-50%,-50%);
                    width:16px; height:16px; border-radius:50%; background:${statusColor(t.status)}; border:2px solid #fff;
                    box-shadow:0 0 4px rgba(0,0,0,0.6); pointer-events:auto;${canEditTools ? ' cursor:pointer;' : ''}"></div>
    `).join('') + (isEmpty ? emptyDrawerStamp(20) : '');

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
        if (positionEditorDrawerId) renderPositionEditor();
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
        if (positionEditorDrawerId) renderPositionEditor();
    } catch (err) {
        alert('❌ Network error while removing marker.');
    }
}

/**
 * Full-screen position editor (#position-editor-overlay) -- a larger, drag-enabled version of
 * the compact shadow-board preview above, opened via the "move" button next to a drawer's
 * Tool Positions section. Markers here can be dragged to reposition (not just click-to-place/
 * click-to-remove like the compact map, whose markers are too small to drag reliably), and an
 * optional snap-to-grid keeps placements tidy. placeToolPosition()/unplaceToolPosition() refresh
 * this editor too (see `positionEditorDrawerId` check in each) so edits made here or in the
 * compact map stay in sync without re-rendering twice.
 */
let positionEditorDrawerId = null;
const POSITION_GRID_STEP = 0.02; // 50x50 grid -- finer than the original 0.05 (20x20) per James's feedback, for easier precise pinpointing

// Batch-select state for the full-screen editor -- see togglePositionBatchSelect(). Lets several
// stale placements be cleared in one request instead of one click-and-confirm per marker, the
// common need right after a drawer gets a new reference photo (the old positions no longer line
// up, and re-placing everything is much easier starting from a clean slate).
let peBatchSelectMode = false;
let peSelectedQrCodes = new Set();

/** Snaps a fractional (0-1) coordinate to POSITION_GRID_STEP when #pe-snap-toggle is checked, and always clamps to [0,1]. */
function snapPositionCoord(v) {
    const clamped = Math.max(0, Math.min(1, v));
    const snapOn = document.getElementById('pe-snap-toggle')?.checked;
    return snapOn ? Math.round(clamped / POSITION_GRID_STEP) * POSITION_GRID_STEP : clamped;
}

/** Opens the full-screen position editor for a drawer (must already have a photo). */
function openPositionEditor(drawerId) {
    const drawer = globalDrawersCache.find(d => d.drawer_id == drawerId);
    if (!drawer || !drawer.photo_url) return;
    positionEditorDrawerId = drawer.drawer_id;
    peBatchSelectMode = false;
    peSelectedQrCodes.clear();
    document.getElementById('pe-title').textContent = drawer.name;
    document.getElementById('pe-map-img').src = drawer.photo_url;
    document.getElementById('position-editor-overlay').style.display = 'flex';
    renderPositionEditor();
}

/** Closes the position editor. Edits are already saved live (each drag/click PUTs immediately), so this just hides the overlay. */
function closePositionEditor() {
    document.getElementById('position-editor-overlay').style.display = 'none';
    document.getElementById('pe-map-img').src = '';
    positionEditorDrawerId = null;
    peBatchSelectMode = false;
    peSelectedQrCodes.clear();
}

/** Toggles batch-select mode: clicking a marker then toggles its selection instead of dragging/removing it. Turning it off clears any in-progress selection. */
function togglePositionBatchSelect() {
    peBatchSelectMode = !peBatchSelectMode;
    if (!peBatchSelectMode) peSelectedQrCodes.clear();
    renderPositionEditor();
}

/** Adds/removes one tool's qr_code from the batch selection (called by a marker click while peBatchSelectMode is on). */
function togglePositionMarkerSelection(qrCode) {
    if (peSelectedQrCodes.has(qrCode)) peSelectedQrCodes.delete(qrCode); else peSelectedQrCodes.add(qrCode);
    renderPositionEditor();
}

/** Selects every currently-placed tool in this drawer at once -- the common case right after a new photo, where every existing marker needs clearing to start fresh. */
function selectAllPositionMarkers() {
    const drawer = globalDrawersCache.find(d => d.drawer_id === positionEditorDrawerId);
    if (!drawer) return;
    const { placed } = getDrawerPositionData(drawer);
    placed.forEach(t => peSelectedQrCodes.add(t.qr_code));
    renderPositionEditor();
}

/** Empties the batch selection without leaving batch-select mode. */
function deselectAllPositionMarkers() {
    peSelectedQrCodes.clear();
    renderPositionEditor();
}

/**
 * Clears the shadow-board position for every selected tool in one request
 * (PUT /api/tools/batch-unplace), confirming first since there's no undo -- the batch
 * counterpart to unplaceToolPosition(). Stays in batch-select mode afterward, ready for another
 * round, same convention as the Master Storage & Asset Tree's own batch-select actions.
 */
async function batchUnplaceSelectedMarkers() {
    if (peSelectedQrCodes.size === 0) return alert('⚠️ Select at least one marker first.');
    const qrCodes = Array.from(peSelectedQrCodes);
    if (!confirm(`Clear the shadow-board position for ${qrCodes.length} tool(s)? They'll move back to "Not Yet Pinpointed" until re-placed.`)) return;

    try {
        const res = await fetch('/api/tools/batch-unplace', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ qr_codes: qrCodes }),
        });
        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || 'Failed to clear positions.'));

        qrCodes.forEach(qr => {
            const tool = globalToolsCache.find(t => t.qr_code === qr);
            if (tool) { tool.position_x = null; tool.position_y = null; }
        });
        peSelectedQrCodes.clear();
        const drawer = globalDrawersCache.find(d => d.drawer_id == document.getElementById('em-target-id').value);
        if (drawer) renderPositionMap(drawer);
        if (positionEditorDrawerId) renderPositionEditor();
    } catch (err) {
        alert('❌ Network error while clearing positions.');
    }
}

/** (Re)draws the position editor's grid lines, markers, and unplaced-tool picker for the currently open drawer. */
function renderPositionEditor() {
    const drawer = globalDrawersCache.find(d => d.drawer_id === positionEditorDrawerId);
    const markersEl = document.getElementById('pe-markers');
    const controlsEl = document.getElementById('pe-controls');
    const imgEl = document.getElementById('pe-map-img');
    const gridEl = document.getElementById('pe-grid-overlay');
    if (!drawer || !markersEl || !controlsEl || !imgEl) return;

    const batchToggleBtn = document.getElementById('btn-pe-batch-toggle');
    const batchBar = document.getElementById('pe-batch-bar');
    const batchCountEl = document.getElementById('pe-batch-count');
    if (batchToggleBtn) batchToggleBtn.classList.toggle('active', peBatchSelectMode);
    if (batchBar) batchBar.style.display = peBatchSelectMode ? 'flex' : 'none';
    if (batchCountEl) batchCountEl.textContent = `${peSelectedQrCodes.size} selected`;

    const snapOn = document.getElementById('pe-snap-toggle')?.checked;
    gridEl.style.backgroundSize = `${POSITION_GRID_STEP * 100}% ${POSITION_GRID_STEP * 100}%`;
    gridEl.style.backgroundImage = snapOn
        ? 'linear-gradient(to right, rgba(255,255,255,0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.35) 1px, transparent 1px)'
        : 'none';

    const { drawerTools, placed, unplaced, statusColor } = getDrawerPositionData(drawer);
    // Excludes Retired tools, unlike getDrawerPositionData()'s own drawerTools -- matches the
    // print sheet's established "empty" definition (see emptyDrawerStamp()) without changing
    // that shared helper's behavior for its other callers.
    const isEmpty = !globalToolsCache.some(t => t.drawer_id === drawer.drawer_id && t.status !== 'Retired');

    // In batch-select mode, a click toggles selection instead of dragging/removing the marker --
    // selected markers get a thick accent-colored ring in place of the plain white border so the
    // running selection is visible at a glance across a dense drawer.
    markersEl.innerHTML = placed.map(t => {
        const selected = peBatchSelectMode && peSelectedQrCodes.has(t.qr_code);
        const interactionAttr = peBatchSelectMode
            ? `onclick="togglePositionMarkerSelection('${t.qr_code}')"`
            : `onpointerdown="startDragMarker(event, '${t.qr_code}', this)"`;
        const border = selected ? '4px solid var(--accent)' : '2px solid #fff';
        const boxShadow = selected ? '0 0 0 3px rgba(203,96,21,0.55), 0 0 6px rgba(0,0,0,0.7)' : '0 0 4px rgba(0,0,0,0.6)';
        return `
        <div title="${t.name} (${t.status})" ${interactionAttr}
             style="position:absolute; left:${t.position_x * 100}%; top:${t.position_y * 100}%; transform:translate(-50%,-50%);
                    width:26px; height:26px; border-radius:50%; background:${statusColor(t.status)}; border:${border};
                    box-shadow:${boxShadow}; pointer-events:auto; cursor:${peBatchSelectMode ? 'pointer' : 'grab'}; touch-action:none;"></div>`;
    }).join('') + (isEmpty ? emptyDrawerStamp(40) : '');

    if (unplaced.length === 0) {
        imgEl.onclick = null;
        controlsEl.innerHTML = drawerTools.length === 0
            ? `<div style="color:var(--muted);">No tools assigned to this drawer yet.</div>`
            : `<div style="color:var(--muted);">Every tool in this drawer is placed. Drag a marker to move it, or click (without dragging) to remove it.</div>`;
        return;
    }

    controlsEl.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:white;">
            <label style="margin:0;white-space:nowrap;">Click the photo to place:</label>
            <select class="form-select" id="pe-tool-select" style="width:auto;flex:1;min-width:200px;">
                ${unplaced.map(t => `<option value="${t.qr_code}">${t.name} (${t.qr_code})</option>`).join('')}
            </select>
        </div>
        <div style="font-size:11px;color:#ccc;margin-top:6px;">Drag an existing marker to reposition it, or click it (without dragging) to remove it.</div>
    `;
    imgEl.onclick = (event) => {
        const select = document.getElementById('pe-tool-select');
        if (!select || !select.value) return;
        const rect = imgEl.getBoundingClientRect();
        const x = snapPositionCoord((event.clientX - rect.left) / rect.width);
        const y = snapPositionCoord((event.clientY - rect.top) / rect.height);
        placeToolPosition(select.value, x, y);
    };
}

/**
 * Wires up a drag gesture on a position-editor marker, starting from its pointerdown. Moves the
 * marker live (visual only) as the pointer moves; on release, a real drag (>4px moved) commits
 * the new position via placeToolPosition(), while a plain click/tap (no movement) instead removes
 * the marker via unplaceToolPosition(), mirroring the compact map's click-to-remove convention.
 * Uses setPointerCapture so move/up keep firing on the marker even once the pointer leaves it.
 * The image rect and snap-to-grid setting are captured once here rather than re-read on every
 * pointermove (neither can change mid-gesture) -- this runs on the highest-frequency event in
 * the feature, so avoiding a repeated getBoundingClientRect()/DOM lookup per move matters.
 * Listens for pointercancel as well as pointerup (a gesture can be interrupted by an alt-tab, OS
 * gesture, or multi-touch) and drops the change rather than committing a possibly-partial drag --
 * without this, the listeners would leak on that marker and the next drag would double them up.
 */
function startDragMarker(event, qrCode, markerEl) {
    event.preventDefault();
    const startX = event.clientX, startY = event.clientY;
    const imgEl = document.getElementById('pe-map-img');
    const rect = imgEl.getBoundingClientRect();
    const snapOn = document.getElementById('pe-snap-toggle')?.checked;
    const snap = (v) => {
        const clamped = Math.max(0, Math.min(1, v));
        return snapOn ? Math.round(clamped / POSITION_GRID_STEP) * POSITION_GRID_STEP : clamped;
    };
    let moved = false, pendingX = null, pendingY = null;
    markerEl.setPointerCapture(event.pointerId);
    markerEl.style.cursor = 'grabbing';

    const onMove = (e) => {
        if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        moved = true;
        pendingX = snap((e.clientX - rect.left) / rect.width);
        pendingY = snap((e.clientY - rect.top) / rect.height);
        markerEl.style.left = (pendingX * 100) + '%';
        markerEl.style.top = (pendingY * 100) + '%';
    };
    const onEnd = (e) => {
        markerEl.removeEventListener('pointermove', onMove);
        markerEl.removeEventListener('pointerup', onEnd);
        markerEl.removeEventListener('pointercancel', onEnd);
        markerEl.style.cursor = 'grab';
        if (e.type === 'pointercancel') return;
        if (moved) placeToolPosition(qrCode, pendingX, pendingY);
        else unplaceToolPosition(qrCode);
    };
    markerEl.addEventListener('pointermove', onMove);
    markerEl.addEventListener('pointerup', onEnd);
    markerEl.addEventListener('pointercancel', onEnd);
}

/**
 * Fills in #em-cal-history-list (inside the #em-cal-history-container block rendered by
 * openEntityModal for every tool) from GET /api/tools/:id/calibration-history -- every
 * completed calibration cycle, newest first, not just the tool's current due date. Called
 * with the tool's real numeric tool_id (not qr_code, unlike most of this file's tool
 * lookups) since that's what the endpoint expects (and is threaded through to
 * triggerPhotoUpload('calibration', cal_id, toolId) below, since a calibration_records row
 * has no tree/list of its own to refresh after a photo upload). Leaves the header/"+ Log
 * Calibration" button/form alone -- only the list itself is replaced, so re-calling this
 * after submitCalLogForm() doesn't need to re-render the whole container. Each record shows
 * either its certificate photo thumbnail (click to open full-size) or a camera icon to attach
 * one, so a paper certificate can be scanned/photographed and kept alongside the typed
 * provider/cert-number fields rather than only the reference number. A record logged with
 * cert_pending (migrations/023 -- vendor hasn't issued one yet) shows "Certificate Pending"
 * instead and a "+ Add Cert #" control (toggleCertBackfillForm()/submitCertBackfill() below) to
 * backfill it once received, rather than silently staying incomplete forever.
 */
async function loadCalibrationHistory(toolId) {
    const listEl = document.getElementById('em-cal-history-list');
    if (!listEl) return;
    try {
        const res = await fetch(`/api/tools/${toolId}/calibration-history`);
        const data = await res.json();
        if (!res.ok || !data.records.length) {
            listEl.innerHTML = `No completed calibration cycles on record yet.`;
            currentCalHistoryRecords = [];
            return;
        }
        currentCalHistoryRecords = data.records;

        // A record is "superseded" if some OTHER record's supersedes_cal_id points at it (see
        // migrations/024 and toggleCorrectionForm() below) -- computed here, not stored, since
        // it depends on the full list. Corrections never delete or hide the original: both rows
        // stay in this list, cross-referenced by date rather than by position (a correction's
        // own cal_date can sort it anywhere in the list, not necessarily next to what it fixes).
        const byId = new Map(data.records.map(r => [r.cal_id, r]));
        const supersededIds = new Set(data.records.filter(r => r.supersedes_cal_id).map(r => r.supersedes_cal_id));

        listEl.innerHTML = data.records.map(r => {
            const isSuperseded = supersededIds.has(r.cal_id);
            const correctedBy = isSuperseded ? data.records.find(x => x.supersedes_cal_id === r.cal_id) : null;
            const corrects = r.supersedes_cal_id ? byId.get(r.supersedes_cal_id) : null;
            return `
            <div style="padding:8px 0; border-bottom:1px solid var(--border); display:flex; gap:10px; align-items:center; ${isSuperseded ? 'opacity:0.55;' : ''}">
                ${r.photo_url
                    ? (r.photo_url.toLowerCase().endsWith('.pdf')
                        ? `<a href="${r.photo_url}" target="_blank" title="View attached certificate" style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--accent);">${icon('clipboard-list')}</a>`
                        : `<img src="${r.photo_url}" onclick="openImageModal('${r.photo_url}')" style="width:36px;height:36px;object-fit:cover;border-radius:4px;cursor:zoom-in;flex-shrink:0;">`)
                    : `<button type="button" class="btn-icon" style="width:36px;height:36px;padding:0;flex-shrink:0;" title="Attach a photo of the certificate" onclick="triggerPhotoUpload('calibration', ${r.cal_id}, '${toolId}')">${icon('camera')}</button>`}
                <div style="flex:1;">
                    <div style="display:flex; justify-content:space-between; font-size:13px;"><strong style="color:var(--text); ${isSuperseded ? 'text-decoration:line-through;' : ''}">${r.cal_date.split('T')[0]}</strong><span>Due: ${r.due_date.split('T')[0]}</span></div>
                    ${isSuperseded ? `<div style="font-size:11px; color:var(--orange); font-weight:bold; margin-top:2px;">${icon('triangle-alert', 'icon-warning')} Corrected${correctedBy ? ` -- see the ${correctedBy.cal_date.split('T')[0]} entry${correctedBy.correction_reason ? ` (${correctedBy.correction_reason})` : ''}` : ''}</div>` : ''}
                    ${corrects ? `<div style="font-size:11px; color:var(--accent); font-weight:bold; margin-top:2px;">${icon('pencil')} Correction of the ${corrects.cal_date.split('T')[0]} entry${r.correction_reason ? ` -- ${r.correction_reason}` : ''}</div>` : ''}
                    <div style="font-size:12px; color:var(--text); margin-top:2px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                        <span style="flex:1; min-width:150px;">
                            ${r.cert_pending
                                ? `${r.provider} &mdash; <span style="color:var(--orange); font-weight:bold;">Certificate Pending</span>`
                                : `${r.provider} &mdash; Cert# <span style="font-family:monospace;">${r.certificate_number}</span>`}
                        </span>
                        <span style="display:flex; gap:6px; flex-shrink:0;">
                            ${r.cert_pending && !isSuperseded ? `<button type="button" class="btn-icon" style="padding:2px 8px; font-size:11px;" onclick="toggleCertBackfillForm(${r.cal_id})">+ Add Cert #</button>` : ''}
                            ${!isSuperseded ? `<button type="button" class="btn-icon" style="padding:2px 8px; font-size:11px;" onclick="toggleCorrectionForm(${r.cal_id}, '${toolId}')">${icon('pencil')} Correct</button>` : ''}
                        </span>
                    </div>
                    ${r.cert_pending && !isSuperseded ? `
                    <div id="cert-backfill-form-${r.cal_id}" style="display:none; margin-top:6px; gap:6px;">
                        <input class="form-input" id="cert-backfill-input-${r.cal_id}" placeholder="Certificate / Reference #" style="flex:1; margin:0;">
                        <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitCertBackfill(${r.cal_id}, '${toolId}')">Save</button>
                    </div>` : ''}
                    <div id="correction-form-${r.cal_id}" style="display:none;"></div>
                    ${r.result === 'Fail' ? `<div style="font-size:11px; color:var(--red); font-weight:bold; margin-top:2px;">${icon('circle-x', 'icon-danger')} FAILED -- out of tolerance</div>` : ''}
                    ${r.standard_used ? `<div style="font-size:11px;">Standard: ${r.standard_used}</div>` : ''}
                    ${r.vendor_tracking_id ? `<div style="font-size:11px;">Vendor Tracking #: <span style="font-family:monospace;">${r.vendor_tracking_id}</span></div>` : ''}
                    ${r.notes ? `<div style="font-size:11px;">${r.notes}</div>` : ''}
                    <div style="font-size:10px; margin-top:2px;">Recorded by ${r.recorded_by_name || 'Unknown'}</div>
                </div>
            </div>
        `;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<span style="color:var(--red);">Failed to load.</span>`;
    }
}

/** Shows/hides the inline "Certificate / Reference #" backfill row for one pending calibration record (see loadCalibrationHistory()'s cert_pending branch). */
function toggleCertBackfillForm(calId) {
    const form = document.getElementById(`cert-backfill-form-${calId}`);
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
}

/** Submits the backfilled certificate number to PUT /api/calibration-records/:cal_id/certificate (migrations/023), then reloads this tool's calibration history so the record switches from "Certificate Pending" to showing the real number. */
async function submitCertBackfill(calId, toolId) {
    const input = document.getElementById(`cert-backfill-input-${calId}`);
    const certificateNumber = input.value.trim();
    if (!certificateNumber) return alert('⚠️ Enter a certificate/reference number.');
    try {
        const res = await fetch(`/api/calibration-records/${calId}/certificate`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ certificate_number: certificateNumber })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to update certificate number.')); }
        loadCalibrationHistory(toolId);
    } catch (e) {
        alert('❌ Network error.');
    }
}

/**
 * Shows/hides the inline correction form (#correction-form-${calId}) for one calibration
 * history row, lazily building it from the record's CURRENT values (currentCalHistoryRecords,
 * populated by loadCalibrationHistory()) on first open rather than baking a full form into
 * every row up front. Pre-filled so correcting one wrong field doesn't require re-typing
 * everything else; a required Reason field (see migrations/024) is the one addition beyond
 * what "+ Log Calibration" itself collects.
 */
function toggleCorrectionForm(calId, toolId) {
    const container = document.getElementById(`correction-form-${calId}`);
    if (!container) return;
    if (container.style.display === 'block') {
        container.style.display = 'none';
        return;
    }
    const r = currentCalHistoryRecords.find(x => x.cal_id === calId);
    if (!r) return;
    container.innerHTML = `
        <div style="margin-top:8px; background: rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--orange);">
            <div style="font-size:11px; color:var(--orange); font-weight:bold; margin-bottom:8px;">${icon('triangle-alert', 'icon-warning')} Saving this adds a new, linked record -- the original entry above is never changed or hidden.</div>
            <div class="cal-date-pair" style="margin-bottom:10px;">
                <div class="form-group" style="margin:0;"><label class="form-label">Calibration Date</label><input type="date" class="form-input" id="correct-cal-date-${calId}" value="${r.cal_date.split('T')[0]}" onchange="document.getElementById('correct-cal-due-${calId}').value = oneYearFromDate(this.value)"></div>
                <div class="form-group" style="margin:0;"><label class="form-label">Due Date</label><input type="date" class="form-input" id="correct-cal-due-${calId}" value="${r.due_date.split('T')[0]}"></div>
            </div>
            <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Provider / Lab</label><input class="form-input" id="correct-cal-provider-${calId}" value="${r.provider || ''}"></div>
            <div class="form-group" style="margin-bottom:4px;"><label class="form-label">Certificate / Reference #</label><input class="form-input" id="correct-cal-cert-${calId}" value="${r.cert_pending ? '' : (r.certificate_number || '')}" ${r.cert_pending ? 'disabled' : ''}></div>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; text-transform:none; font-size:12px; color:var(--muted); margin-bottom:10px;">
                <input type="checkbox" id="correct-cal-cert-pending-${calId}" ${r.cert_pending ? 'checked' : ''} onchange="toggleCertPending('correct-cal-cert-${calId}', this.checked)"> Certificate not yet received from vendor
            </label>
            <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Standard Used <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="correct-cal-standard-${calId}" value="${r.standard_used || ''}"></div>
            <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Vendor Tracking # <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="correct-cal-vendor-tracking-${calId}" value="${r.vendor_tracking_id || ''}"></div>
            <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Notes <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input class="form-input" id="correct-cal-notes-${calId}" value="${r.notes || ''}"></div>
            <div class="form-group" style="margin-bottom:10px;">
                <label class="form-label">Result</label>
                <select class="form-select" id="correct-cal-result-${calId}">
                    <option value="Pass" ${r.result === 'Pass' ? 'selected' : ''}>Pass</option>
                    <option value="Fail" ${r.result === 'Fail' ? 'selected' : ''}>Fail -- out of tolerance</option>
                </select>
            </div>
            <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Reason for Correction</label><input class="form-input" id="correct-cal-reason-${calId}" placeholder="e.g. Calibration date was mis-typed as last year"></div>
            <div style="display:flex; gap:8px;">
                <button type="button" class="btn btn-secondary" style="width:auto;" onclick="toggleCorrectionForm(${calId}, '${toolId}')">Cancel</button>
                <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitCorrection(${calId}, '${toolId}')">Save Correction</button>
            </div>
        </div>
    `;
    container.style.display = 'block';
}

/**
 * Submits a correction to POST /api/calibration-records/:cal_id/correct (migrations/024), which
 * inserts a new linked record rather than touching the original. On success, rebuilds the infra
 * tree and reopens this tool's entity modal fresh (same pattern submitCalLogForm() uses, not the
 * lighter reload submitCertBackfill() does) since a correction can move the tool's live
 * last_cal_date/cal_due_date/is_calibrated, which other parts of the open modal/tree display.
 */
async function submitCorrection(calId, toolId) {
    const calDate = document.getElementById(`correct-cal-date-${calId}`).value;
    const dueDate = document.getElementById(`correct-cal-due-${calId}`).value;
    const provider = document.getElementById(`correct-cal-provider-${calId}`).value.trim();
    const certPending = document.getElementById(`correct-cal-cert-pending-${calId}`).checked;
    const certificateNumber = document.getElementById(`correct-cal-cert-${calId}`).value.trim();
    const standardUsed = document.getElementById(`correct-cal-standard-${calId}`).value.trim();
    const vendorTrackingId = document.getElementById(`correct-cal-vendor-tracking-${calId}`).value.trim();
    const notes = document.getElementById(`correct-cal-notes-${calId}`).value.trim();
    const result = document.getElementById(`correct-cal-result-${calId}`).value;
    const reason = document.getElementById(`correct-cal-reason-${calId}`).value.trim();

    if (!calDate || !dueDate) return alert('⚠️ Calibration date and due date are both required.');
    if (!provider) return alert('⚠️ Calibration provider is required.');
    if (!certPending && !certificateNumber) return alert('⚠️ A certificate/reference number is required, unless marked as pending from the vendor.');
    if (!reason) return alert('⚠️ A reason for the correction is required.');

    try {
        const res = await fetch(`/api/calibration-records/${calId}/correct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({
                cal_date: calDate, due_date: dueDate, provider,
                certificate_number: certPending ? null : certificateNumber, cert_pending: certPending,
                standard_used: standardUsed || null, vendor_tracking_id: vendorTrackingId || null,
                notes: notes || null, result, correction_reason: reason
            })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to correct calibration record.')); }
        await renderEditableInfraTree();
        const tool = globalToolsCache.find(t => t.tool_id == toolId);
        if (tool) openEntityModal('tool', tool.qr_code);
    } catch (e) {
        alert('❌ Network error.');
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
        document.getElementById('em-cal-cert-pending').checked = false;
        toggleCertPending('em-cal-cert', false);
        document.getElementById('em-cal-standard').value = '';
        document.getElementById('em-cal-vendor-tracking').value = '';
        document.getElementById('em-cal-notes').value = '';
        document.getElementById('em-cal-result').value = 'Pass';
    }
}

/**
 * Grays out and clears a certificate-number field when its paired "not yet received from
 * vendor" checkbox is checked (migrations/023's cert_pending bypass -- James: "we dont have
 * access to certs from the vendor, so calibration cert uploads need a methodical bypass").
 * Re-enables it when unchecked. Shared by both calibration-logging forms (admin.js's
 * #em-cal-cert and kiosk.js's own #cal-cert-number, each wired to their own copy of this
 * function since they're separate pages).
 */
function toggleCertPending(certInputId, isPending) {
    const input = document.getElementById(certInputId);
    input.disabled = isPending;
    if (isPending) input.value = '';
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
    const certPending = document.getElementById('em-cal-cert-pending').checked;
    const certificateNumber = document.getElementById('em-cal-cert').value.trim();
    const standardUsed = document.getElementById('em-cal-standard').value.trim();
    const vendorTrackingId = document.getElementById('em-cal-vendor-tracking').value.trim();
    const notes = document.getElementById('em-cal-notes').value.trim();
    const result = document.getElementById('em-cal-result').value;

    if (!calDate || !dueDate) return alert('⚠️ Calibration date and due date are both required.');
    if (!provider) return alert('⚠️ Calibration provider is required.');
    if (!certPending && !certificateNumber) return alert('⚠️ A certificate/reference number is required, unless marked as pending from the vendor.');

    try {
        const res = await fetch(`/api/tools/${toolId}/calibration-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ cal_date: calDate, due_date: dueDate, provider, certificate_number: certPending ? null : certificateNumber, cert_pending: certPending, standard_used: standardUsed || null, vendor_tracking_id: vendorTrackingId || null, notes: notes || null, result })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to log calibration record.')); }
        await renderEditableInfraTree();
        openEntityModal('tool', qrCode);
    } catch (e) {
        alert('Network Error.');
    }
}

/** Shows/hides #em-sub-assembly-form, clearing it back to a blank "add" state when hidden (so the next open -- whether Add or Edit -- never shows stale leftover values from whatever was being edited before). */
function toggleSubAssemblyForm(show) {
    const form = document.getElementById('em-sub-assembly-form');
    if (!form) return;
    form.style.display = show ? 'block' : 'none';
    if (!show) {
        document.getElementById('em-sub-edit-id').value = '';
        document.getElementById('em-sub-name').value = '';
        document.getElementById('em-sub-part-number').value = '';
        document.getElementById('em-sub-serial').value = '';
        document.getElementById('em-sub-is-calibrated').checked = false;
        document.getElementById('em-sub-last-cal').value = '';
        document.getElementById('em-sub-cal-due').value = '';
        document.getElementById('em-sub-notes').value = '';
        toggleSubCalFields();
    }
}

/** Shows/hides the sub-assembly form's calibration date fields based on its "Requires Calibration Tracking" checkbox -- same show-on-check convention as the main ingest form. */
function toggleSubCalFields() {
    const checked = document.getElementById('em-sub-is-calibrated').checked;
    document.getElementById('em-sub-cal-fields').style.display = checked ? 'block' : 'none';
}

/** Opens #em-sub-assembly-form pre-filled for editing -- looks the sub-assembly up in currentEntitySubAssemblies (set by openEntityModal()) rather than needing a fetch, since that list is already the full, current data for this tool's modal. */
function openEditSubAssemblyForm(subId) {
    const sa = currentEntitySubAssemblies.find(s => s.sub_id === subId);
    if (!sa) return;
    toggleSubAssemblyForm(true);
    document.getElementById('em-sub-edit-id').value = sa.sub_id;
    document.getElementById('em-sub-name').value = sa.name;
    document.getElementById('em-sub-part-number').value = sa.part_number || '';
    document.getElementById('em-sub-serial').value = sa.serial_number || '';
    document.getElementById('em-sub-is-calibrated').checked = sa.is_calibrated;
    document.getElementById('em-sub-last-cal').value = sa.last_cal_date ? sa.last_cal_date.split('T')[0] : '';
    document.getElementById('em-sub-cal-due').value = sa.cal_due_date ? sa.cal_due_date.split('T')[0] : '';
    document.getElementById('em-sub-notes').value = sa.notes || '';
    toggleSubCalFields();
}

/** Saves #em-sub-assembly-form -- POSTs a new sub-assembly, or PUTs an edit when #em-sub-edit-id is set. Refreshes the tree (globalToolsCache doesn't otherwise know about sub-assembly changes) and reopens this same tool's modal fresh, same pattern as submitCalLogForm() above. */
async function submitSubAssemblyForm(toolId, qrCode) {
    const subId = document.getElementById('em-sub-edit-id').value;
    const name = document.getElementById('em-sub-name').value.trim();
    const partNumber = document.getElementById('em-sub-part-number').value.trim();
    const serialNumber = document.getElementById('em-sub-serial').value.trim();
    const isCalibrated = document.getElementById('em-sub-is-calibrated').checked;
    const lastCal = document.getElementById('em-sub-last-cal').value;
    const calDue = document.getElementById('em-sub-cal-due').value;
    const notes = document.getElementById('em-sub-notes').value.trim();

    if (!name) return alert('⚠️ A sub-assembly name is required.');
    if (isCalibrated && !calDue) return alert('⚠️ Calibration Due Date is required.');

    const url = subId ? `/api/sub-assemblies/${subId}` : `/api/tools/${toolId}/sub-assemblies`;
    const method = subId ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ name, part_number: partNumber || null, serial_number: serialNumber || null, is_calibrated: isCalibrated, last_cal_date: lastCal || null, cal_due_date: calDue || null, notes: notes || null })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to save sub-assembly.')); }
        await renderEditableInfraTree();
        openEntityModal('tool', qrCode);
    } catch (e) {
        alert('Network Error.');
    }
}

/** Deletes a sub-assembly after confirmation, then refreshes/reopens the tool's modal, same pattern as the other tool-detail mutations above. */
async function deleteSubAssembly(subId, qrCode) {
    if (!confirm('Delete this sub-assembly? This cannot be undone.')) return;
    try {
        const res = await fetch(`/api/sub-assemblies/${subId}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to delete sub-assembly.')); }
        await renderEditableInfraTree();
        openEntityModal('tool', qrCode);
    } catch (e) {
        alert('Network Error.');
    }
}

/** Adds one alternate part number (migrations/019) to a tool -- e.g. a MIL-SPEC equivalent alongside the primary commercial/OEM part_number. No confirm()/undo ceremony on this or its delete counterpart below -- unlike a sub-assembly, a bare alternate part number string is trivial to re-add if removed by mistake. */
async function addAltPartNumber(toolId, qrCode) {
    const input = document.getElementById('em-new-alt-partnum');
    const partNumber = input.value.trim();
    if (!partNumber) return;
    try {
        const res = await fetch(`/api/tools/${toolId}/alt-part-numbers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ part_number: partNumber })
        });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to add alternate part number.')); }
        await renderEditableInfraTree();
        openEntityModal('tool', qrCode);
    } catch (e) {
        alert('Network Error.');
    }
}

/** Removes one alternate part number. See addAltPartNumber()'s doc comment for why this skips a confirm() prompt. */
async function deleteAltPartNumber(altId, qrCode) {
    try {
        const res = await fetch(`/api/alt-part-numbers/${altId}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' } });
        if (!res.ok) { const data = await res.json(); return alert('❌ ' + (data.error || 'Failed to remove alternate part number.')); }
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
        if (type === 'department') {
            endpoint = `/api/departments/${id}`;
            payload.cross_checkout_group_id = document.getElementById('em-input-dept-group').value || null;
            payload.no_tool_inventory = document.getElementById('em-input-no-inventory').checked;
        }
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
            payload.group_id = document.getElementById('em-input-group').value || null;
            if (!payload.drawer_id) return alert('⚠️ Select a Department, Toolbox, and Drawer for this asset.');
        }
    }

    try {
        const res = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify(payload) });
        if(!res.ok) { const data = await res.json(); alert('❌ ' + (data.error || 'Failed to save.')); return; }

        // The per-department role selects (super_admin viewers only, see openEntityModal) are
        // a second, independent form on the same modal -- submitted as its own request to
        // PUT /api/users/:badge_id/department-access rather than folded into the role payload
        // above, since it's a full-replace of a separate table, not a users column.
        const grantedDeptEls = document.querySelectorAll('.em-input-granted-dept');
        if (type === 'user' && grantedDeptEls.length > 0) {
            const grants = Array.from(grantedDeptEls)
                .filter(el => el.value)
                .map(el => ({ dept_id: el.dataset.deptId, role: el.value }));
            const grantRes = await fetch(`/api/users/${id}/department-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({ grants }) });
            if (!grantRes.ok) { const data = await grantRes.json(); alert('❌ Role saved, but department access failed: ' + (data.error || 'Unknown error.')); }
        }

        closeEntityModal();
        if (type === 'user') { loadUsers(); loadRosterDirectory(); } else { await renderEditableInfraTree(); renderDepartmentRoster(); }
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

/** HTML-attribute-safe escape -- work_order is free text typed by anyone at the kiosk (no
 *  admin approval step), unlike most other strings rendered in this file, so it's the one
 *  place in the Work Orders card that needs real escaping rather than trusting the source. */
function escapeHtmlAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

/**
 * Fills #work-orders-list (Reports workspace) from GET /api/work-orders -- one row per
 * distinct work_order ever typed in at checkout (see migrations/012_work_orders.sql), newest
 * activity first. Click delegation on the container (rather than per-row onclick handlers)
 * specifically because work_order is untrusted free text -- embedding it straight into an
 * inline onclick="..." string would be a real injection risk; data-wo (HTML-attribute-
 * escaped) plus a single delegated listener avoids that entirely.
 */
async function loadWorkOrders() {
    const container = document.getElementById('work-orders-list');
    if (!container) return;
    try {
        const res = await fetch('/api/work-orders');
        const data = await res.json();
        if (!res.ok || !data.success) { container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        if (data.work_orders.length === 0) {
            container.innerHTML = `<div style="font-size:12px; color:var(--muted); font-style:italic;">No work orders recorded yet.</div>`;
            return;
        }

        container.innerHTML = data.work_orders.map(wo => {
            const isClosed = !!wo.closed_at;
            const statusBadge = isClosed
                ? `<span style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--muted);">CLOSED</span>`
                : wo.out_count > 0
                    ? `<span style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--accent);">${wo.out_count} OUT</span>`
                    : `<span style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--green);">READY TO CLOSE</span>`;
            const woAttr = escapeHtmlAttr(wo.work_order);
            return `
                <div style="border-bottom:1px solid var(--border); padding:10px 0;">
                    <div class="wo-row" data-wo="${woAttr}" data-action="toggle" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
                        <div>
                            <div style="font-weight:bold; font-size:13px;">${woAttr}</div>
                            <div style="font-size:11px; color:var(--muted);">${wo.tool_count} tool(s) -- last activity ${new Date(wo.last_activity).toLocaleDateString()}</div>
                        </div>
                        ${statusBadge}
                    </div>
                    <div class="wo-detail" data-wo="${woAttr}" style="display:none; margin-top:10px;"></div>
                </div>`;
        }).join('');

        if (!container.dataset.delegated) {
            container.dataset.delegated = 'true';
            container.addEventListener('click', onWorkOrdersListClick);
        }
    } catch (e) {
        container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Single delegated click handler for #work-orders-list -- routes by data-action (toggle / close / reopen) on the clicked element. */
function onWorkOrdersListClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const workOrder = el.dataset.wo;
    if (el.dataset.action === 'toggle') toggleWorkOrderDetail(workOrder);
    else if (el.dataset.action === 'close') closeWorkOrder(workOrder);
    else if (el.dataset.action === 'reopen') reopenWorkOrder(workOrder);
}

/** Expands/collapses one work order's tool list, lazy-loading it from GET /api/work-orders/:wo/tools the first time. */
async function toggleWorkOrderDetail(workOrder) {
    const detail = document.querySelector(`.wo-detail[data-wo="${CSS.escape(workOrder)}"]`);
    if (!detail) return;
    if (detail.style.display === 'block') { detail.style.display = 'none'; return; }

    detail.style.display = 'block';
    detail.innerHTML = 'Loading…';
    try {
        const res = await fetch(`/api/work-orders/${encodeURIComponent(workOrder)}/tools`);
        const data = await res.json();
        if (!res.ok || !data.success) { detail.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        const rows = data.tools.map(t => `
            <tr>
                <td style="font-family:monospace; font-size:11px;">${t.qr_code}</td>
                <td style="font-size:12px;">${t.tool_name}</td>
                <td style="font-size:11px; color:var(--muted);">${t.checked_out_by || '--'}</td>
                <td style="font-size:11px; color:var(--muted);">${t.checked_in_at ? new Date(t.checked_in_at).toLocaleString() : '<span style="color:var(--accent);">Still out</span>'}</td>
            </tr>`).join('');

        const woAttr = escapeHtmlAttr(workOrder);
        const actionBtn = data.closed_at
            ? `<button class="btn btn-secondary" style="width:auto; margin-top:10px;" data-action="reopen" data-wo="${woAttr}">${icon('circle-check', 'icon-success')} Reopen</button>`
            : `<button class="btn btn-secondary" style="width:auto; margin-top:10px;" data-action="close" data-wo="${woAttr}">${icon('circle-check', 'icon-success')} Close Out</button>`;

        detail.innerHTML = `
            <div class="table-responsive-wrapper">
                <table style="width:100%; font-size:12px;">
                    <thead><tr><th>Barcode</th><th>Tool</th><th>Checked Out By</th><th>Returned</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${actionBtn}`;
    } catch (e) {
        detail.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Closes a work order via POST /api/work-orders/:wo/close, then refreshes the list. Server-side rejects if any tool is still out (409 TOOLS_STILL_OUT). */
async function closeWorkOrder(workOrder) {
    const res = await fetch(`/api/work-orders/${encodeURIComponent(workOrder)}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || 'Failed to close work order.'));
    loadWorkOrders();
}

/** Reopens a closed work order via POST /api/work-orders/:wo/reopen, then refreshes the list. */
async function reopenWorkOrder(workOrder) {
    const res = await fetch(`/api/work-orders/${encodeURIComponent(workOrder)}/reopen`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' }, body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || 'Failed to reopen work order.'));
    loadWorkOrders();
}

/**
 * Fills #em-trace-investigations-list (tool modal, every tool) from
 * GET /api/tools/:id/trace-investigations -- a compact read-only summary (reason, window,
 * status, review progress) plus a link to work each one from the shop-wide Trace-Back
 * Investigations card in Reports, and a "+ Open Investigation" button for opening one
 * manually (e.g. a customer complaint) rather than only via a failed calibration.
 */
async function loadTraceInvestigations(toolId) {
    const listEl = document.getElementById('em-trace-investigations-list');
    if (!listEl) return;
    try {
        const res = await fetch(`/api/tools/${toolId}/trace-investigations`);
        const data = await res.json();
        if (!res.ok) { listEl.innerHTML = `<span style="color:var(--red);">Failed to load.</span>`; return; }

        const rows = data.investigations.map(inv => `
                <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                        <span>${escapeHtmlAttr(inv.reason)}</span>${renderTraceStatusBadge(inv)}
                    </div>
                    <div style="font-size:10px; color:var(--muted); margin-top:2px;">Opened ${new Date(inv.created_at).toLocaleDateString()} by ${inv.opened_by_name || 'Unknown'} -- see Reports &gt; Trace-Back Investigations to work it.</div>
                </div>`).join('');

        listEl.innerHTML = `
            ${rows || `<div style="font-style:italic;">No investigations for this tool.</div>`}
            <button type="button" class="btn-icon" style="width:auto; padding:4px 10px; font-size:11px; margin-top:8px;" onclick="toggleTraceOpenForm(true)">${icon('plus')} Open Investigation</button>
            <div id="em-trace-open-form" style="display:none; margin-top:10px; background: rgba(255,255,255,0.02); padding:12px; border-radius:8px; border:1px solid var(--border);">
                <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Reason</label><input class="form-input" id="em-trace-reason" placeholder="e.g. Customer complaint about torque accuracy"></div>
                <div class="flex-grid-3" style="grid-template-columns: 1fr 1fr; margin-bottom:10px;">
                    <div class="form-group" style="margin:0;"><label class="form-label">Window Start <span style="color:var(--muted);text-transform:none;">(optional)</span></label><input type="date" class="form-input" id="em-trace-start"></div>
                    <div class="form-group" style="margin:0;"><label class="form-label">Window End</label><input type="date" class="form-input" id="em-trace-end" value="${new Date().toISOString().slice(0, 10)}"></div>
                </div>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="btn btn-secondary" style="width:auto;" onclick="toggleTraceOpenForm(false)">Cancel</button>
                    <button type="button" class="btn btn-primary" style="width:auto;" onclick="submitTraceOpenForm('${toolId}')">Open</button>
                </div>
            </div>`;
    } catch (e) {
        listEl.innerHTML = `<span style="color:var(--red);">Failed to load.</span>`;
    }
}

/** Shows/hides the "+ Open Investigation" inline form in the tool modal. */
function toggleTraceOpenForm(show) {
    const form = document.getElementById('em-trace-open-form');
    if (form) form.style.display = show ? 'block' : 'none';
}

/** Submits the manual "Open Investigation" form to POST /api/tools/:id/trace-investigations, then reloads the tool's investigation list and the shop-wide Reports card. */
async function submitTraceOpenForm(toolId) {
    const reason = document.getElementById('em-trace-reason').value.trim();
    const windowStart = document.getElementById('em-trace-start').value;
    const windowEnd = document.getElementById('em-trace-end').value;
    if (!reason) return alert('⚠️ A reason is required.');

    const res = await fetch(`/api/tools/${toolId}/trace-investigations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
        body: JSON.stringify({ reason, window_start: windowStart || null, window_end: windowEnd ? `${windowEnd}T23:59:59` : null })
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || 'Failed to open investigation.'));
    loadTraceInvestigations(toolId);
    loadTraceInvestigationsList();
}

/**
 * Renders the small OPEN/CLOSED pill shared by both the tool modal's compact summary
 * (loadTraceInvestigations) and the Reports card's list/detail views -- one source of truth
 * for the markup so all three stay visually consistent. `elId`, if given, is stamped onto the
 * span so a later refresh-in-place (see renderTraceInvestigationDetail) can find and replace
 * just this badge without re-rendering the whole list.
 */
function renderTraceStatusBadge(inv, elId) {
    const idAttr = elId ? ` id="${elId}"` : '';
    return inv.status === 'OPEN'
        ? `<span${idAttr} style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--accent);">OPEN -- ${inv.reviewed_count}/${inv.review_count} reviewed</span>`
        : `<span${idAttr} style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--muted);">CLOSED${inv.overridden ? ' (OVERRIDE)' : ''}</span>`;
}

/**
 * Fills #trace-investigations-list (Reports workspace) from GET /api/trace-investigations --
 * one row per investigation, newest first, across every tool. Same delegated-click pattern as
 * Work Orders. `reason` is escaped (unlike opened_by_name/closed_by_name, which come from
 * users.full_name) because a manually-opened investigation's reason is free text typed into
 * this form, same trust tier as work_order.
 */
async function loadTraceInvestigationsList() {
    const container = document.getElementById('trace-investigations-list');
    if (!container) return;
    try {
        const res = await fetch('/api/trace-investigations');
        const data = await res.json();
        if (!res.ok || !data.success) { container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        if (data.investigations.length === 0) {
            container.innerHTML = `<div style="font-size:12px; color:var(--muted); font-style:italic;">No investigations opened yet.</div>`;
            return;
        }

        container.innerHTML = data.investigations.map(inv => `
                <div style="border-bottom:1px solid var(--border); padding:10px 0;">
                    <div class="ti-row" data-id="${inv.investigation_id}" data-action="toggle" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; gap:8px;">
                        <div>
                            <div style="font-weight:bold; font-size:13px;">${inv.tool_name} <span style="color:var(--muted); font-family:monospace; font-weight:normal;">(${inv.qr_code})</span></div>
                            <div style="font-size:11px; color:var(--muted);">${escapeHtmlAttr(inv.reason)}</div>
                        </div>
                        ${renderTraceStatusBadge(inv, `ti-badge-${inv.investigation_id}`)}
                    </div>
                    <div class="ti-detail" data-id="${inv.investigation_id}" style="display:none; margin-top:10px;"></div>
                </div>`).join('');

        if (!container.dataset.delegated) {
            container.dataset.delegated = 'true';
            container.addEventListener('click', onTraceInvestigationsListClick);
        }
    } catch (e) {
        container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Single delegated click handler for #trace-investigations-list -- routes by data-action on the clicked element. */
function onTraceInvestigationsListClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    if (el.dataset.action === 'toggle') toggleTraceInvestigationDetail(id);
    else if (el.dataset.action === 'save-review') saveTraceReview(id, el.dataset.reviewId);
    else if (el.dataset.action === 'close') closeTraceInvestigation(id);
    else if (el.dataset.action === 'override') overrideTraceInvestigation(id);
    else if (el.dataset.action === 'reopen') reopenTraceInvestigation(id);
}

/** Expands/collapses one investigation's full detail, rendering it via renderTraceInvestigationDetail() the first time it's shown. */
async function toggleTraceInvestigationDetail(id) {
    const detail = document.querySelector(`.ti-detail[data-id="${id}"]`);
    if (!detail) return;
    if (detail.style.display === 'block') { detail.style.display = 'none'; return; }
    detail.style.display = 'block';
    await renderTraceInvestigationDetail(id);
}

/**
 * Fetches and renders one investigation's full detail (every review row + close/override
 * controls) from GET /api/trace-investigations/:id into its already-visible .ti-detail
 * element, and refreshes that row's status-pill badge in place from the same response.
 * Used both to populate the panel on first expand (toggleTraceInvestigationDetail) and to
 * refresh it after a save/close/override/reopen action -- re-fetching just this one
 * investigation instead of the whole shop-wide list keeps the panel open and in place rather
 * than collapsing everything mid-review.
 */
async function renderTraceInvestigationDetail(id) {
    const detail = document.querySelector(`.ti-detail[data-id="${id}"]`);
    if (!detail) return;
    detail.innerHTML = 'Loading…';
    try {
        const res = await fetch(`/api/trace-investigations/${id}`);
        const data = await res.json();
        if (!res.ok || !data.success) { detail.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        const inv = data.investigation;
        const badgeEl = document.getElementById(`ti-badge-${id}`);
        if (badgeEl) badgeEl.outerHTML = renderTraceStatusBadge(
            { status: inv.status, overridden: inv.overridden, reviewed_count: data.reviews.filter(r => r.outcome !== 'PENDING').length, review_count: data.reviews.length },
            `ti-badge-${id}`
        );
        const outcomeOptions = (current) => ['PENDING', 'IN_TOLERANCE', 'OUT_OF_TOLERANCE', 'NOT_APPLICABLE']
            .map(o => `<option value="${o}" ${o === current ? 'selected' : ''}>${o.replace(/_/g, ' ')}</option>`).join('');

        const reviewRows = data.reviews.map(r => `
            <tr data-review-id="${r.review_id}">
                <td style="font-size:11px; color:var(--muted);">${new Date(r.used_at).toLocaleDateString()}</td>
                <td style="font-size:11px;">${r.work_order ? escapeHtmlAttr(r.work_order) : '--'}</td>
                <td style="font-size:11px; color:var(--muted);">${r.custodian_name || 'Unknown'}</td>
                <td><select class="form-select" style="font-size:11px; padding:4px;" data-field="outcome">${outcomeOptions(r.outcome)}</select></td>
                <td><input class="form-input" style="font-size:11px; padding:4px;" data-field="notes" value="${r.notes ? escapeHtmlAttr(r.notes) : ''}" placeholder="Notes"></td>
                <td><button type="button" class="btn-icon" style="width:auto; padding:4px 8px; font-size:11px;" data-action="save-review" data-id="${inv.investigation_id}" data-review-id="${r.review_id}">Save</button></td>
            </tr>`).join('');

        const closedBlock = inv.status === 'CLOSED'
            ? `<div style="margin-top:10px; font-size:12px;">
                    <strong>Conclusion:</strong> ${inv.conclusion || ''}<br>
                    <span style="color:var(--muted);">Closed ${new Date(inv.closed_at).toLocaleDateString()} by ${inv.closed_by_name || 'Unknown'}${inv.overridden ? ` -- OVERRIDE: ${inv.override_reason || ''}` : ''}</span>
                    <div style="margin-top:8px;"><button type="button" class="btn btn-secondary" style="width:auto;" data-action="reopen" data-id="${inv.investigation_id}">Reopen</button></div>
               </div>`
            : `<div style="margin-top:12px; background: rgba(255,255,255,0.02); padding:12px; border-radius:8px; border:1px solid var(--border);">
                    <div class="form-group" style="margin-bottom:8px;"><label class="form-label">Conclusion</label><input class="form-input" id="ti-conclusion-${inv.investigation_id}" placeholder="e.g. All tasks re-checked, none out of tolerance"></div>
                    <div class="form-group" style="margin-bottom:8px;"><label class="form-label">Override Reason <span style="color:var(--muted);text-transform:none;">(only needed to force-close with reviews still pending)</span></label><input class="form-input" id="ti-override-reason-${inv.investigation_id}" placeholder="e.g. Low-risk tasks, supervisor waived remaining review"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-primary" style="width:auto;" data-action="close" data-id="${inv.investigation_id}">Close Investigation</button>
                        <button type="button" class="btn btn-secondary" style="width:auto;" data-action="override" data-id="${inv.investigation_id}">Override &amp; Force-Close</button>
                    </div>
               </div>`;

        detail.innerHTML = `
            <div style="font-size:11px; color:var(--muted); margin-bottom:8px;">Suspect window: ${inv.window_start ? new Date(inv.window_start).toLocaleDateString() : 'tool creation'} &rarr; ${new Date(inv.window_end).toLocaleDateString()}</div>
            <div class="table-responsive-wrapper">
                <table style="width:100%; font-size:11px;">
                    <thead><tr><th>Used</th><th>Work Order</th><th>Custodian</th><th>Outcome</th><th>Notes</th><th></th></tr></thead>
                    <tbody>${reviewRows || '<tr><td colspan="6" style="color:var(--muted); font-style:italic;">No checkouts in this window.</td></tr>'}</tbody>
                </table>
            </div>
            ${closedBlock}`;
    } catch (e) {
        detail.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/**
 * Shared by every write action below (save review / close / override / reopen): POSTs, alerts
 * the server's error on failure, and on success re-renders just this one investigation's
 * detail panel in place (see renderTraceInvestigationDetail) rather than reloading and
 * re-rendering the entire shop-wide list -- which would also collapse every panel the
 * supervisor had open, including the one they were mid-review on.
 */
async function postTraceAction(id, url, body, fallbackMsg) {
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || fallbackMsg));
    renderTraceInvestigationDetail(id);
}

/** Saves one review row's outcome/notes, reading the outcome/notes inputs from the same table row. */
async function saveTraceReview(id, reviewId) {
    const row = document.querySelector(`tr[data-review-id="${reviewId}"]`);
    if (!row) return;
    const outcome = row.querySelector('[data-field="outcome"]').value;
    const notes = row.querySelector('[data-field="notes"]').value.trim();
    if (outcome === 'PENDING') return alert('⚠️ Select an outcome before saving.');
    postTraceAction(id, `/api/trace-investigations/${id}/reviews/${reviewId}`, { outcome, notes: notes || null }, 'Failed to save review.');
}

/** Closes an investigation -- server rejects (409) if any review is still PENDING. */
async function closeTraceInvestigation(id) {
    const conclusion = document.getElementById(`ti-conclusion-${id}`).value.trim();
    if (!conclusion) return alert('⚠️ A closing conclusion is required.');
    postTraceAction(id, `/api/trace-investigations/${id}/close`, { conclusion }, 'Failed to close investigation.');
}

/** Force-closes an investigation regardless of pending reviews. */
async function overrideTraceInvestigation(id) {
    const conclusion = document.getElementById(`ti-conclusion-${id}`).value.trim();
    const overrideReason = document.getElementById(`ti-override-reason-${id}`).value.trim();
    if (!conclusion) return alert('⚠️ A closing conclusion is required.');
    if (!overrideReason) return alert('⚠️ A reason for overriding pending reviews is required.');
    if (!confirm('Force-close this investigation with reviews still pending?')) return;
    postTraceAction(id, `/api/trace-investigations/${id}/override`, { conclusion, override_reason: overrideReason }, 'Failed to override investigation.');
}

/** Reopens a closed investigation. */
async function reopenTraceInvestigation(id) {
    postTraceAction(id, `/api/trace-investigations/${id}/reopen`, {}, 'Failed to reopen investigation.');
}

/** Shows/hides the "+ New Group" inline form (#new-group-form), populating its department select from globalDeptsCache and clearing its fields each time it's opened. */
function toggleNewGroupForm(show) {
    const form = document.getElementById('new-group-form');
    if (!form) return;
    form.style.display = show ? 'block' : 'none';
    if (show) {
        document.getElementById('new-group-name').value = '';
        document.getElementById('new-group-description').value = '';
        const deptEl = document.getElementById('new-group-dept');
        deptEl.innerHTML = '<option value="">-- No Department --</option>' + globalDeptsCache.map(d => `<option value="${d.dept_id}">${d.name}</option>`).join('');
    }
}

/** Submits the "+ New Group" form to POST /api/tool-groups, then refreshes the list and closes the form. */
async function submitNewGroup() {
    await saveToolGroup({
        url: '/api/tool-groups', method: 'POST',
        name: document.getElementById('new-group-name').value.trim(),
        dept_id: document.getElementById('new-group-dept').value || null,
        description: document.getElementById('new-group-description').value.trim(),
        fallbackMsg: 'Failed to create tool group.',
        onSuccess: () => toggleNewGroupForm(false)
    });
}

/** Shared by submitNewGroup (POST) and saveGroupEdit (PUT): validates the name, POSTs/PUTs, alerts the server's error on failure, and on success refreshes the shop-wide list (plus whatever else the caller needs done via onSuccess). */
async function saveToolGroup({ url, method, name, dept_id, description, fallbackMsg, onSuccess }) {
    if (!name) return alert('⚠️ A group name is required.');
    const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
        body: JSON.stringify({ name, dept_id, description: description || null })
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || fallbackMsg));
    if (onSuccess) onSuccess();
    loadToolGroups();
}

/**
 * Fills #tool-groups-list (Reports workspace) from GET /api/tool-groups -- one row per group
 * with roll-up member-status counts, alphabetical by name. Same delegated-click pattern as
 * Work Orders/Trace Investigations; `reason`-equivalent free text here (name/description) is
 * dept_admin+-typed (same trust tier as calibration notes elsewhere in this file), so unlike
 * Work Orders' work_order it isn't escaped -- consistent with how other admin-typed free text
 * is rendered throughout this file.
 */
async function loadToolGroups() {
    const container = document.getElementById('tool-groups-list');
    if (!container) return;
    try {
        const res = await fetch('/api/tool-groups');
        const data = await res.json();
        if (!res.ok || !data.success) { container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        globalToolGroupsCache = data.groups;

        if (data.groups.length === 0) {
            container.innerHTML = `<div style="font-size:12px; color:var(--muted); font-style:italic;">No tool groups yet.</div>`;
            return;
        }

        container.innerHTML = data.groups.map(g => `
                <div style="border-bottom:1px solid var(--border); padding:10px 0;">
                    <div class="tg-row" data-id="${g.group_id}" data-action="toggle" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; gap:8px;">
                        <div>
                            <div style="font-weight:bold; font-size:13px;">${g.name}${g.department_name ? ` <span style="color:var(--muted); font-weight:normal;">(${g.department_name})</span>` : ''}</div>
                            <div style="font-size:11px; color:var(--muted);">${g.member_count} tool(s) -- ${g.in_count} in, ${g.out_count} out${Number(g.flagged_count) > 0 ? `, ${g.flagged_count} flagged` : ''}</div>
                        </div>
                        ${Number(g.blocked_count) > 0
                            ? `<span style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--red);">${icon('circle-x', 'icon-danger')} ${g.blocked_count} BLOCKED</span>`
                            : `<span style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,0.05); color:var(--muted);">${g.member_count == 0 ? 'EMPTY' : 'OK'}</span>`}
                    </div>
                    <div class="tg-detail" data-id="${g.group_id}" style="display:none; margin-top:10px;"></div>
                </div>`).join('');

        if (!container.dataset.delegated) {
            container.dataset.delegated = 'true';
            container.addEventListener('click', onToolGroupsListClick);
        }
    } catch (e) {
        container.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Single delegated click handler for #tool-groups-list -- routes by data-action on the clicked element. */
function onToolGroupsListClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    if (el.dataset.action === 'toggle') toggleToolGroupDetail(id);
    else if (el.dataset.action === 'edit') toggleGroupEditForm(id, true);
    else if (el.dataset.action === 'cancel-edit') toggleGroupEditForm(id, false);
    else if (el.dataset.action === 'save-edit') saveGroupEdit(id);
    else if (el.dataset.action === 'delete') deleteToolGroup(id);
}

/** Expands/collapses one group's member list, lazy-loading it from GET /api/tool-groups/:id the first time. */
async function toggleToolGroupDetail(id) {
    const detail = document.querySelector(`.tg-detail[data-id="${id}"]`);
    if (!detail) return;
    if (detail.style.display === 'block') { detail.style.display = 'none'; return; }
    detail.style.display = 'block';
    await renderToolGroupDetail(id);
}

/**
 * Names why a group member is blocked from checkout (server already decided is_blocked --
 * this only picks the label). Open-investigation is checked FIRST because it applies to
 * every tool regardless of calibration, whereas a non-calibrated tool always has a null
 * cal_due_date -- checking cal_due_date first would misreport "No due date" for a
 * non-calibrated tool that's actually blocked by an open investigation.
 */
function blockedReason(m) {
    if (m.has_open_investigation) return 'Investigation open';
    if (m.blocked_sub_name) return `Sub-assembly "${m.blocked_sub_name}" needs cal`;
    if (!m.cal_due_date) return 'No due date';
    if (!m.has_cal_record) return 'No certificate';
    return 'Cal expired';
}

/** Fetches and renders one group's member list + edit/delete controls into its .tg-detail element. Also used to refresh after a save. */
async function renderToolGroupDetail(id) {
    const detail = document.querySelector(`.tg-detail[data-id="${id}"]`);
    if (!detail) return;
    detail.innerHTML = 'Loading…';
    try {
        const res = await fetch(`/api/tool-groups/${id}`);
        const data = await res.json();
        if (!res.ok || !data.success) { detail.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }

        const g = data.group;
        const memberRows = data.members.map(m => {
            const statusColor = m.status === 'In' ? 'var(--green)' : (m.status === 'Out' ? 'var(--accent)' : 'var(--red)');
            const calNote = m.is_blocked
                ? `<span style="color:var(--red);">${icon('circle-x', 'icon-danger')} ${blockedReason(m)}</span>`
                : (m.is_calibrated ? `<span style="color:var(--green);">In cal</span>` : '--');
            return `
            <tr>
                <td style="font-family:monospace; font-size:11px;">${m.qr_code}</td>
                <td style="font-size:12px;">${m.name}</td>
                <td style="font-size:11px; font-weight:bold; color:${statusColor};">${m.status}</td>
                <td style="font-size:11px;">${calNote}</td>
            </tr>`;
        }).join('');

        detail.innerHTML = `
            ${g.description ? `<div style="font-size:12px; color:var(--muted); margin-bottom:8px;">${g.description}</div>` : ''}
            <div class="table-responsive-wrapper">
                <table style="width:100%; font-size:11px;">
                    <thead><tr><th>Barcode</th><th>Tool</th><th>Status</th><th>Calibration</th></tr></thead>
                    <tbody>${memberRows || '<tr><td colspan="4" style="color:var(--muted); font-style:italic;">No tools assigned to this group yet -- assign one from its own Edit form.</td></tr>'}</tbody>
                </table>
            </div>
            <div id="tg-edit-form-${id}" style="display:none; margin-top:12px; background: rgba(255,255,255,0.02); padding:12px; border-radius:8px; border:1px solid var(--border);">
                <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Group Name</label><input class="form-input" id="tg-edit-name-${id}" value="${g.name}"></div>
                <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Department</label>
                    <select class="form-select" id="tg-edit-dept-${id}">
                        <option value="">-- No Department --</option>
                        ${globalDeptsCache.map(d => `<option value="${d.dept_id}" ${d.dept_id == g.dept_id ? 'selected' : ''}>${d.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Description</label><input class="form-input" id="tg-edit-description-${id}" value="${g.description || ''}"></div>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="btn btn-secondary" style="width:auto;" data-action="cancel-edit" data-id="${id}">Cancel</button>
                    <button type="button" class="btn btn-primary" style="width:auto;" data-action="save-edit" data-id="${id}">Save</button>
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button type="button" class="btn btn-secondary" style="width:auto;" data-action="edit" data-id="${id}">${icon('pencil')} Edit</button>
                <button type="button" class="btn btn-secondary" style="width:auto; color:var(--red); border-color:var(--red);" data-action="delete" data-id="${id}">${icon('x')} Delete</button>
            </div>`;
    } catch (e) {
        detail.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Shows/hides one group's inline edit form within its already-rendered detail panel. */
function toggleGroupEditForm(id, show) {
    const form = document.getElementById(`tg-edit-form-${id}`);
    if (form) form.style.display = show ? 'block' : 'none';
}

/** Saves a group's name/department/description via PUT /api/tool-groups/:id, then refreshes the shop-wide list (its row's name/department may have changed). */
async function saveGroupEdit(id) {
    await saveToolGroup({
        url: `/api/tool-groups/${id}`, method: 'PUT',
        name: document.getElementById(`tg-edit-name-${id}`).value.trim(),
        dept_id: document.getElementById(`tg-edit-dept-${id}`).value || null,
        description: document.getElementById(`tg-edit-description-${id}`).value.trim(),
        fallbackMsg: 'Failed to update tool group.'
    });
}

/** Deletes a group via DELETE /api/tool-groups/:id (its members are simply ungrouped, not deleted -- see migrations/014_tool_groups.sql), then refreshes the list. */
async function deleteToolGroup(id) {
    if (!confirm('Delete this group? Its member tools will simply be ungrouped, not deleted.')) return;
    const res = await fetch(`/api/tool-groups/${id}`, {
        method: 'DELETE', headers: { 'X-Requested-With': 'ToolTracker' }
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || 'Failed to delete tool group.'));
    loadToolGroups();
}

/**
 * Fills #calendar-feed-body (super_admin only card in the Reports workspace) from
 * GET /api/settings/calendar-feed-token. Shows setup instructions if CALENDAR_FEED_TOKEN
 * isn't configured server-side yet, or the actual subscribe URL (server-built on the known
 * public origin, NOT location.origin -- this page may be open on the LAN address) if it is.
 */
async function loadCalendarFeedInfo() {
    const body = document.getElementById('calendar-feed-body');
    if (!body) return;
    try {
        const res = await fetch('/api/settings/calendar-feed-token');
        if (!res.ok) { body.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`; return; }
        const data = await res.json();
        if (!data.configured) {
            body.innerHTML = `
                <div style="font-size:12px; color:var(--muted);">
                    Not set up yet. On the server, set <code>CALENDAR_FEED_TOKEN</code> in <code>.env</code> to a long random value, then restart:
                    <pre style="background:var(--surface2); padding:8px; border-radius:6px; margin-top:6px; overflow-x:auto;">node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</pre>
                </div>`;
            return;
        }
        const url = data.feedUrl;
        body.innerHTML = `
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <input class="form-input" id="calendar-feed-url" value="${url}" readonly style="flex:1; min-width:220px; font-family:monospace; font-size:12px;">
                <button class="btn-icon" id="calendar-feed-copy-btn" onclick="copyCalendarFeedUrl()" title="Copy link">${icon('copy')}</button>
                <a class="btn-icon" href="${url}" download="tooltracker-calibration.ics" title="Download snapshot">${icon('download')}</a>
            </div>
            <div style="font-size:11px; color:var(--muted); margin-top:8px;">Anyone with this link can view calibration due dates -- treat it like a password. Subscribe from your calendar app via "From URL" for auto-refresh, or use the download button for a one-time import.</div>`;
    } catch (e) {
        body.innerHTML = `<span style="color:var(--muted);">Could not load.</span>`;
    }
}

/** Copies the calendar feed URL built by loadCalendarFeedInfo() to the clipboard, with a manual-select fallback since the Clipboard API can silently fail outside a secure context. */
function copyCalendarFeedUrl() {
    const input = document.getElementById('calendar-feed-url');
    if (!input) return;
    const finish = (ok) => {
        const btn = document.getElementById('calendar-feed-copy-btn');
        if (!btn) return;
        const original = btn.innerHTML;
        btn.innerHTML = ok ? icon('circle-check', 'icon-success') : icon('circle-x', 'icon-danger');
        setTimeout(() => { btn.innerHTML = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(() => finish(true), () => { input.select(); finish(false); });
    } else {
        input.select();
        finish(false);
    }
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

// ==========================================
// CALIBRATION IMPORT -- MICRO PRECISION
// ==========================================
// See server.js's matching section header for the full design reasoning (why a review step,
// why matching mostly needs manual linking on day one, why the PDF is just an attached document
// rather than something parsed for data). This is a two-request flow: analyzeMpcImport() uploads
// everything and gets back a full proposal with nothing yet written to the database;
// commitMpcImport() sends back only the rows James actually checked.
let mpcAnalysisResult = null; // last response from POST .../analyze, re-rendered by renderMpcReviewScreen()
let mpcManualBindings = {}; // rowNum -> {toolId, qrCode, name} -- filled in by onMpcToolPickerInput() for "needs linking" rows

/** Uploads the inventory spreadsheet + any certificate PDFs to the analyze endpoint and renders the resulting review screen. Nothing is written to the database by this call. */
async function analyzeMpcImport() {
    const xlsxInput = document.getElementById('mpc-xlsx-file');
    const pdfInput = document.getElementById('mpc-pdf-files');
    if (!xlsxInput.files[0]) return alert('⚠️ Choose the inventory spreadsheet (.xlsx) first.');

    const formData = new FormData();
    formData.append('inventory', xlsxInput.files[0]);
    Array.from(pdfInput.files || []).forEach(f => formData.append('certificates', f));

    const btn = document.getElementById('mpc-analyze-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Analyzing...';

    try {
        const res = await fetch('/api/calibration-imports/micro-precision/analyze', {
            method: 'POST', headers: { 'X-Requested-With': 'ToolTracker' }, body: formData
        });
        let data;
        try { data = await res.json(); } catch (e) {
            return alert(`❌ Unexpected response from server (status ${res.status}). Try again with a smaller batch of files if it keeps happening.`);
        }
        if (!res.ok) return alert('❌ ' + (data.error || 'Failed to analyze the uploaded files.'));
        mpcAnalysisResult = data;
        mpcManualBindings = {};
        renderMpcReviewScreen();
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

/** One shared `<datalist>` of every non-Retired tool (qr_code + name, searchable by either since both are in the option's value), referenced by every "needs linking" row's picker input -- one shared list instead of a separate `<select>` with hundreds of `<option>`s repeated per row. */
function buildMpcToolDatalist() {
    const options = globalToolsCache
        .filter(t => t.status !== 'Retired')
        .sort((a, b) => a.qr_code.localeCompare(b.qr_code, undefined, { numeric: true }))
        .map(t => `<option value="${t.qr_code} -- ${t.name}">`)
        .join('');
    return `<datalist id="mpc-tool-datalist">${options}</datalist>`;
}

/**
 * Renders the four-bucket review screen from mpcAnalysisResult: "New Calibration Data"
 * (pre-checked, ready to import), "Needs Linking" (a tool-picker per row, checkbox disabled
 * until a valid tool is picked), "Certificate Available" (pre-checked -- the date is already on
 * file but a matching cert turned up in this batch with nothing attached yet, see certAttachable
 * in server.js's analyze endpoint), and "Already Up to Date" (collapsed, informational only, no
 * checkbox at all -- there's nothing to commit for these).
 */
function renderMpcReviewScreen() {
    const container = document.getElementById('mpc-import-review');
    if (!container || !mpcAnalysisResult) return;
    const { rows, summary, unmatchedCertificates } = mpcAnalysisResult;

    const newRows = rows.filter(r => r.match.status === 'new');
    const certAttachableRows = rows.filter(r => r.match.status === 'already_current' && r.match.certAttachable);
    const upToDateRows = rows.filter(r => r.match.status === 'already_current' && !r.match.certAttachable);
    const needsLinkingRows = rows.filter(r => r.match.status === 'needs_linking');

    // "Cal ID", not left bare -- this is Micro Precision's OWN tracking number for the gage
    // (their "Cal Control"/"MPC Control #"), not a manufacturer serial number. James flagged
    // that an unlabeled code reads ambiguously like it might BE the serial number; it's shown
    // separately (see the "SN:" badge below) and is a completely different value.
    const rowSummaryLine = (r) => `
        <span style="color:var(--muted); font-size:11px;">Cal ID</span> <span style="font-family:monospace;">${r.calControl}</span>${(r.manufacturer || r.description) ? ` -- ${[r.manufacturer, r.modelNumber, r.description].filter(Boolean).join(' ')}` : ''}${r.department ? ` <span style="color:var(--muted);">(${r.department})</span>` : ''}`;

    // A second verification signal alongside the Cal Control/serial match itself -- doesn't
    // block anything (vendor vs. ToolTracker department naming can legitimately differ), just
    // flags an auto-match worth a second look before it's trusted.
    const deptMismatchBadge = (r) => r.match.deptMismatch
        ? ` <span style="background:rgba(239,68,68,0.15); color:var(--red); padding:1px 6px; border-radius:8px; font-size:10px; font-weight:bold;" title="Vendor lists department &quot;${r.department}&quot;, but this tool is in &quot;${r.match.toolDeptName}&quot; in ToolTracker -- verify this match before importing.">${icon('triangle-alert')} dept mismatch</span>`
        : '';

    const newRowHtml = (r) => `
        <label style="display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--border); cursor:pointer;">
            <input type="checkbox" id="mpc-row-check-${r.rowNum}" checked style="width:16px; height:16px; flex-shrink:0;">
            <div style="flex:1; font-size:12px;">
                ${rowSummaryLine(r)}<br>
                <strong>${r.match.toolQrCode}</strong> -- ${r.match.toolName}${r.match.toolRetired ? ` <span style="color:var(--orange); font-weight:bold;">(Retired)</span>` : ''}${deptMismatchBadge(r)}
                <span style="color:var(--muted);"> -- Last Cal ${r.lastCalDate}, Due ${r.nextDueDate}</span>
                ${r.certificateFile ? ` ${icon('clipboard-list')} cert attached` : ''}
                ${r.calibrationStatus ? ` <span style="background:rgba(255,165,0,0.15); color:var(--orange); padding:1px 6px; border-radius:8px; font-size:10px; font-weight:bold;">vendor: ${r.calibrationStatus}</span>` : ''}
            </div>
        </label>`;

    const needsLinkingRowHtml = (r) => `
        <div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--border);">
            <input type="checkbox" id="mpc-row-check-${r.rowNum}" disabled style="width:16px; height:16px; flex-shrink:0;">
            <div style="flex:1; font-size:12px;">
                ${rowSummaryLine(r)}
                <span style="color:var(--muted);"> -- Last Cal ${r.lastCalDate}, Due ${r.nextDueDate}</span>
                ${r.serialNumber ? ` <span style="color:var(--muted);">SN: ${r.serialNumber}</span>` : ''}
                ${r.certificateFile ? ` ${icon('clipboard-list')} cert ready -- just needs a tool` : ''}
            </div>
            <input class="form-input" style="width:220px; margin:0;" list="mpc-tool-datalist" placeholder="Pick a tool..." oninput="onMpcToolPickerInput(${r.rowNum}, this.value)">
        </div>`;

    const upToDateRowHtml = (r) => `
        <div style="padding:4px 0; border-bottom:1px solid var(--border); font-size:12px; color:var(--muted);">
            ${rowSummaryLine(r)} -&gt; <strong>${r.match.toolQrCode}</strong> (already current as of ${r.match.currentLastCalDate})${deptMismatchBadge(r)}
        </div>`;

    // The date is already correct -- only the proof document is missing. No date fields shown
    // here (there's nothing to review about the date); checking this row just attaches the cert
    // to the existing record on commit (attachCertOnly in commitMpcImport()).
    const certAttachableRowHtml = (r) => `
        <label style="display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--border); cursor:pointer;">
            <input type="checkbox" id="mpc-row-check-${r.rowNum}" checked style="width:16px; height:16px; flex-shrink:0;">
            <div style="flex:1; font-size:12px;">
                ${rowSummaryLine(r)}<br>
                <strong>${r.match.toolQrCode}</strong> -- ${r.match.toolName}${deptMismatchBadge(r)}
                <span style="color:var(--muted);"> -- already current as of ${r.match.currentLastCalDate}</span>
                ${icon('clipboard-list')} cert ready to attach
            </div>
        </label>`;

    container.innerHTML = `
        ${buildMpcToolDatalist()}
        <div style="font-size:13px; margin-bottom:12px;">${summary.totalRows} gages read. <strong style="color:var(--green);">${summary.newImport}</strong> ready to import, <strong>${summary.needsLinking}</strong> need linking, ${summary.alreadyUpToDate} already up to date${summary.certAttachable ? ` (<strong style="color:var(--accent);">${summary.certAttachable}</strong> of those just need a certificate attached)` : ''}${summary.skipped ? `, ${summary.skipped} skipped (no calibration date on file yet)` : ''}.</div>
        ${newRows.length ? `<div style="margin-bottom:16px;"><div style="font-weight:bold; font-size:12px; text-transform:uppercase; color:var(--muted); margin-bottom:6px;">New Calibration Data (${newRows.length})</div>${newRows.map(newRowHtml).join('')}</div>` : ''}
        ${needsLinkingRows.length ? `<div style="margin-bottom:16px;"><div style="font-weight:bold; font-size:12px; text-transform:uppercase; color:var(--muted); margin-bottom:6px;">Needs Linking (${needsLinkingRows.length}) -- pick which ToolTracker tool each one is</div>${needsLinkingRows.map(needsLinkingRowHtml).join('')}</div>` : ''}
        ${certAttachableRows.length ? `<div style="margin-bottom:16px;"><div style="font-weight:bold; font-size:12px; text-transform:uppercase; color:var(--muted); margin-bottom:6px;">Certificate Available (${certAttachableRows.length}) -- date already on file, just attaching the proof document</div>${certAttachableRows.map(certAttachableRowHtml).join('')}</div>` : ''}
        ${upToDateRows.length ? `<details style="margin-bottom:16px;"><summary style="cursor:pointer; font-weight:bold; font-size:12px; text-transform:uppercase; color:var(--muted);">Already Up to Date (${upToDateRows.length})</summary>${upToDateRows.map(upToDateRowHtml).join('')}</details>` : ''}
        ${unmatchedCertificates && unmatchedCertificates.length ? `<details style="margin-bottom:16px;"><summary style="cursor:pointer; font-weight:bold; font-size:12px; text-transform:uppercase; color:var(--orange);">${icon('triangle-alert', 'icon-warning')} Certificate Files Not Used (${unmatchedCertificates.length})</summary><div style="font-size:11px; color:var(--muted); margin:6px 0;">These PDFs weren't attached to anything -- their filename didn't match a spreadsheet row's Cal Control and Last Cal Date.</div>${unmatchedCertificates.map(c => `<div style="padding:3px 0; font-size:12px; font-family:monospace;">${c.originalName} <span style="font-family:inherit; color:var(--muted);">-- ${c.reason}</span></div>`).join('')}</details>` : ''}
        <button type="button" class="btn btn-primary" id="mpc-commit-btn" style="width:auto;" onclick="commitMpcImport()">Import Selected</button>
        <div id="mpc-import-results" style="margin-top:12px;"></div>
    `;
    container.style.display = 'block';
}

/** Resolves a "needs linking" row's typed/picked datalist value ("AVI-0327 -- Wire Cutter") back to a real tool, records the binding, and auto-checks/unchecks that row's checkbox to match -- a row can only ever be imported once it resolves to a real, non-Retired tool. */
function onMpcToolPickerInput(rowNum, typedValue) {
    const qrCode = (typedValue || '').split(' -- ')[0].trim();
    const tool = globalToolsCache.find(t => t.qr_code === qrCode && t.status !== 'Retired');
    const checkbox = document.getElementById(`mpc-row-check-${rowNum}`);
    if (!checkbox) return;
    if (tool) {
        mpcManualBindings[rowNum] = { toolId: tool.tool_id, qrCode: tool.qr_code, name: tool.name };
        checkbox.disabled = false;
        checkbox.checked = true;
    } else {
        delete mpcManualBindings[rowNum];
        checkbox.disabled = true;
        checkbox.checked = false;
    }
}

/** Builds the commit payload from whichever rows are currently checked (reading straight from the DOM -- this screen doesn't re-render reactively, so the DOM is the simplest source of truth), validates no two checked rows share a tool, and POSTs it. */
async function commitMpcImport() {
    if (!mpcAnalysisResult) return;
    const actions = [];
    const seenToolIds = new Set();
    let duplicateBinding = false;

    mpcAnalysisResult.rows.forEach(row => {
        const checkbox = document.getElementById(`mpc-row-check-${row.rowNum}`);
        if (!checkbox || !checkbox.checked) return;

        // Already current on its date -- just attaching the proof document to the existing
        // record, not creating a new one, so this skips the toolId/lastCalDate resolution below.
        if (row.match.status === 'already_current' && row.match.certAttachable) {
            if (seenToolIds.has(row.match.toolId)) duplicateBinding = true;
            seenToolIds.add(row.match.toolId);
            actions.push({
                rowNum: row.rowNum, toolId: row.match.toolId, attachCertOnly: true, existingCalId: row.match.existingCalId,
                calControl: row.calControl, serialNumber: row.serialNumber,
                certificateStoredUrl: row.certificateFile ? row.certificateFile.storedUrl : null,
                certNumber: row.certificateFile ? row.certificateFile.certNumber : null
            });
            return;
        }

        let toolId = null, qrCode = null;
        if (row.match.status === 'new') {
            toolId = row.match.toolId; qrCode = row.match.toolQrCode;
        } else if (row.match.status === 'needs_linking' && mpcManualBindings[row.rowNum]) {
            toolId = mpcManualBindings[row.rowNum].toolId; qrCode = mpcManualBindings[row.rowNum].qrCode;
        }
        if (!toolId) return;

        if (seenToolIds.has(toolId)) duplicateBinding = true;
        seenToolIds.add(toolId);

        actions.push({
            rowNum: row.rowNum, toolId, calControl: row.calControl, serialNumber: row.serialNumber,
            lastCalDate: row.lastCalDate, nextDueDate: row.nextDueDate, calibrationStatus: row.calibrationStatus,
            trackingStatus: row.trackingStatus,
            certificateStoredUrl: row.certificateFile ? row.certificateFile.storedUrl : null,
            certNumber: row.certificateFile ? row.certificateFile.certNumber : null
        });
    });

    if (actions.length === 0) return alert('⚠️ Nothing is checked to import.');
    if (duplicateBinding) return alert('⚠️ More than one row is bound to the same tool -- fix that before importing.');

    const btn = document.getElementById('mpc-commit-btn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Importing...';

    try {
        const res = await fetch('/api/calibration-imports/micro-precision/commit', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ToolTracker' },
            body: JSON.stringify({ actions })
        });
        const data = await res.json();
        if (!res.ok) { alert('❌ ' + (data.error || 'Import failed.')); return; }
        renderMpcImportResults(data);
        await renderEditableInfraTree();
    } catch (e) {
        alert('❌ Network error.');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

/** Renders commitMpcImport()'s per-row results into #mpc-import-results, below the (left in place) review checklist. */
function renderMpcImportResults(data) {
    const container = document.getElementById('mpc-import-results');
    if (!container) return;
    const rowsHtml = data.results.map(r => `
        <div style="display:flex; justify-content:space-between; gap:10px; padding:4px 0; border-bottom:1px solid var(--border); font-size:12px;">
            <div>${r.result === 'imported' ? icon('circle-check', 'icon-success') : icon('circle-x', 'icon-danger')} Cal ID ${r.calControl}${r.toolQrCode ? ` -&gt; ${r.toolQrCode}` : ''}</div>
            <div style="color:var(--muted); text-align:right;">${r.message}</div>
        </div>`).join('');
    container.innerHTML = `
        <div style="font-weight:bold; margin-bottom:8px;">${data.summary.imported} imported, ${data.summary.errors} error(s).</div>
        <div style="max-height:400px; overflow-y:auto;">${rowsHtml}</div>`;
}

// Restore an existing admin session on page load, if there is one (see restoreAdminSession()).
restoreAdminSession();