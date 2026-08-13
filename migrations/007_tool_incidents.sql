-- ==========================================
-- Migration 007: Tool incident tracking (lost/broken/worn lifecycle)
-- ==========================================
-- Until now, reporting a tool Broken/Missing/Worn just set tools.status/status_reason and
-- logged one audit_logs row -- there was no structured record of the incident itself (where
-- it was last known to be, what happened, what was done about it) and, worse, no record at
-- all of how/when/by whom it got RESOLVED: PUT /api/tools/:id changes status but never wrote
-- an audit_logs row, so a tool going from "Missing" back to "In" left no trace. For a shop
-- that cares about FOD (a genuinely lost tool is a real safety concern, not just an
-- inventory nuisance), the full lifecycle -- reported, investigated, resolved -- needs to be
-- a real record, not just the tool's current status.

CREATE TABLE IF NOT EXISTS tool_incidents (
    incident_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool_id INTEGER NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    incident_type VARCHAR(20) NOT NULL CHECK (incident_type IN ('Missing', 'Broken', 'Worn')),
    reported_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    reported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_known_status VARCHAR(20), -- the tool's status immediately before this report (e.g. 'Out' -- was it checked out when it went missing?)
    last_known_location TEXT, -- department/toolbox/drawer snapshot at time of report, since the tool's drawer_id can change later
    description TEXT, -- circumstances, from the kiosk report's notes field
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'WRITTEN_OFF')),
    resolution_notes TEXT,
    resolved_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_incidents_tool_id ON tool_incidents(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_incidents_open ON tool_incidents(tool_id) WHERE status = 'OPEN';
