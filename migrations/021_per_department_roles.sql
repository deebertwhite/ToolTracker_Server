-- ==========================================
-- Migration 021: Per-department roles
-- ==========================================
-- Until now, a cross-department grant (migrations/005) just extended a user's one global role
-- to an additional department -- there was no way for a person's rank to differ by
-- department. This adds a role to each grant row: the rank this specific user holds in THIS
-- specific granted department, independent of their home-department role (users.role, which
-- is unchanged in meaning and never overridden by a grant).
--
-- super_admin is deliberately excluded from grantable roles -- it's treated as a global
-- *identity* throughout this app (checked directly via role === 'super_admin' in several
-- places, not just as a numeric weight), never purely department-scoped. A per-department
-- grant of super_admin would pass weight checks but fail those identity checks, producing an
-- inconsistent "sometimes super_admin" user.
--
-- Existing grant rows previously only ever meant "same as home role," and the admin UI that
-- created them was only ever shown for a dept_admin's own grants -- so every existing row is
-- backfilled to 'dept_admin' explicitly (not left to default) to preserve exactly what it
-- already meant before this migration, not silently reinterpreted.

ALTER TABLE user_department_access ADD COLUMN IF NOT EXISTS role VARCHAR(20);
UPDATE user_department_access SET role = 'dept_admin' WHERE role IS NULL;
ALTER TABLE user_department_access ALTER COLUMN role SET NOT NULL;
ALTER TABLE user_department_access ADD CONSTRAINT user_department_access_role_check CHECK (role IN ('technician', 'tool_rep', 'dept_admin'));
