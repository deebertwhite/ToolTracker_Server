-- ==========================================
-- Migration 014: Tool groups (assemblies/kits)
-- ==========================================
-- A lightweight logical tag over existing tools -- a named set (e.g. "Torque Wrench Kit #3")
-- that a shop tracks and uses together, so a supervisor can see the whole kit's status
-- (how many pieces are present/out, whether any calibrated member is out of compliance) at a
-- glance instead of checking each tool individually. Purely additive: tools are still scanned
-- in/out individually exactly as before, nothing about the checkout flow changes. A tool
-- belongs to at most one group at a time, matching the physical reality of a bundled kit --
-- no join table needed for that, just a nullable FK column.

CREATE TABLE IF NOT EXISTS tool_groups (
    group_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    dept_id INTEGER REFERENCES departments(dept_id) ON DELETE SET NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Deleting a group just ungroups its members (they keep existing as normal individually
-- tracked tools) rather than blocking or cascading -- a group is a logical tag, not a
-- physical container the way a toolbox/drawer is.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES tool_groups(group_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tools_group_id ON tools(group_id);
