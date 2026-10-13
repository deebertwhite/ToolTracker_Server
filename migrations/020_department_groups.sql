-- ==========================================
-- Migration 020: Cross-checkout department groups
-- ==========================================
-- Lets a shop declare that certain departments share tools freely -- e.g. "AVI" and "MX" are
-- both under one "Maintenance" umbrella -- exempting them from the cross-department checkout
-- restriction (see POST /api/transactions in server.js) in both directions. One group per
-- department via a nullable FK, same shape as tool_groups/tools.group_id (migrations/014):
-- a group is a logical tag, not a physical container, so deleting a group just ungroups its
-- departments (ON DELETE SET NULL) rather than blocking or cascading.

CREATE TABLE IF NOT EXISTS department_groups (
    group_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(150) NOT NULL
);

ALTER TABLE departments ADD COLUMN IF NOT EXISTS cross_checkout_group_id INTEGER REFERENCES department_groups(group_id) ON DELETE SET NULL;
