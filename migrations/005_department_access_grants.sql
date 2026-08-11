-- ==========================================
-- Migration 005: Cross-department access grants for dept_admins
-- ==========================================
-- Lets a super_admin grant a specific dept_admin full access to departments beyond their
-- own home one -- for a manager who oversees more than one department in practice, without
-- loosening the rule for every dept_admin. A department listed here gets treated identically
-- to the user's home department everywhere access is checked (user creation, reports, etc.)
-- -- see getAccessibleDeptIds() usage in server.js.
--
-- Deliberately a separate table rather than a second dept_id column on users: a manager can
-- oversee any number of extra departments, and this keeps "home department" (used for badge
-- prefix generation, primary audit-log attribution, etc.) unambiguous and unchanged.

CREATE TABLE IF NOT EXISTS user_department_access (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    dept_id INTEGER NOT NULL REFERENCES departments(dept_id) ON DELETE CASCADE,
    granted_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, dept_id)
);
