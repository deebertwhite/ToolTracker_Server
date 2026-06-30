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
    document.getElementById('nav-global').classList.add('active');

    try {
        const res = await fetch('/api/dashboard');
        const data = await res.json();

        document.getElementById('kpi-out').textContent = data.stats.total_out || 0;
        document.getElementById('kpi-flagged').textContent = data.stats.total_flagged || 0;
        document.getElementById('kpi-total').textContent = data.stats.total_tools || 0;

        const outBody = document.getElementById('dash-out-body');
        if (data.out_tools.length === 0) { outBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">All tools are secured.</td></tr>`; } 
        else {
            outBody.innerHTML = data.out_tools.map(t => {
                const time = new Date(t.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                return `<tr>
                    <td style="font-family: monospace;">${t.qr_code}</td>
                    <td><strong>${t.tool_name}</strong></td>
                    <td style="color: var(--accent); font-weight:bold;">👤 ${t.user_name || 'Unknown'}</td>
                    <td style="font-size:12px; color:var(--muted);">${time}</td>
                    <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
                </tr>`;
            }).join('');
        }

        const flagBody = document.getElementById('dash-flagged-body');
        if (data.flagged_tools.length === 0) { flagBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted);">No maintenance items flagged.</td></tr>`; } 
        else {
            flagBody.innerHTML = data.flagged_tools.map(t => {
                let badgeColor = t.status === 'Missing' ? 'var(--red)' : 'var(--orange)';
                let displayStatus = t.status;
                let reason = t.status_reason || 'No notes provided.';

                if (t.is_calibrated && t.cal_due_date) {
                    const due = new Date(t.cal_due_date);
                    const today = new Date();
                    if (due <= today) { badgeColor = 'var(--red)'; displayStatus = 'CAL OVERDUE'; reason = `Overdue since ${t.cal_due_date.split('T')[0]}`; } 
                    else if (due <= new Date(today.getTime() + (30 * 24 * 60 * 60 * 1000))) { badgeColor = 'var(--orange)'; displayStatus = 'CAL DUE SOON'; reason = `Due on ${t.cal_due_date.split('T')[0]}`; }
                }

                return `<tr>
                    <td style="font-family: monospace;">${t.qr_code}</td>
                    <td><strong>${t.tool_name}</strong></td>
                    <td><span style="background: ${badgeColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;">${displayStatus}</span></td>
                    <td style="font-size:12px; color:var(--muted);">${reason}</td>
                    <td>${t.dept_name || '--'} / ${t.box_name || '--'}</td>
                </tr>`;
            }).join('');
        }

        const toolsRes = await fetch('/api/tools');
        const toolsData = await toolsRes.json();
        globalTools = toolsData.tools;

    } catch (e) { alert('Failed to load dashboard data.'); }
}

function loadLocationView(type, filterValue, title, subtitle) {
    document.getElementById('view-global').style.display = 'none';
    document.getElementById('view-location').style.display = 'block';
    document.getElementById('loc-title').textContent = title;
    document.getElementById('loc-subtitle').textContent = type === 'dept' ? `Department Code: ${subtitle}` : subtitle;

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    event.currentTarget.classList.add('active');

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

// Boot the dashboard when the script loads
window.onload = bootDashboard;