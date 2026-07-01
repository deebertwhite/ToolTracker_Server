// ==========================================
// DASHBOARD LOGIC
// ==========================================

let globalTools = [];

async function bootDashboard() {
    await fetchStorageTree();
    await loadGlobalDashboard();
}

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
        const outTools = data.out_tools || [];
        const flaggedTools = data.flagged_tools || [];
        const calTools = data.cal_tools || [];
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
                return `<tr>
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
                return `<tr>
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

                return `<tr>
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

function loadLocationView(type, filterValue, title, subtitle) {
    document.getElementById('view-global').style.display = 'none';
    document.getElementById('view-location').style.display = 'block';
    document.getElementById('loc-title').textContent = title;
    document.getElementById('loc-subtitle').textContent = type === 'dept' ? `Department Code: ${subtitle}` : subtitle;

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    let filteredTools = [];
    if (type === 'dept') { filteredTools = globalTools.filter(t => t.department_name === title); } 
    else if (type === 'box') { filteredTools = globalTools.filter(t => t.toolbox_name === title); }

    const tbody = document.getElementById('loc-table-body');
    if (filteredTools.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted);">No tools currently assigned to this location.</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredTools.map(t => {
        let statusColor = t.status === 'In' ? 'var(--green)' : (t.status === 'Out' ? 'var(--accent)' : 'var(--red)');
        return `<tr>
            <td style="font-family: monospace;">${t.qr_code}</td>
            <td><strong>${t.name}</strong></td>
            <td style="font-size:12px; color:var(--muted);">${t.toolbox_name || '--'} / ${t.drawer_name || '--'}</td>
            <td style="color: ${statusColor}; font-weight: bold;">${t.status}</td>
        </tr>`;
    }).join('');
}

// Initialize on load
window.onload = bootDashboard;