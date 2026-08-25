-- ==========================================
-- Migration 012: Work orders (optional, dormant until used)
-- ==========================================
-- A "work order" is a free-text label carried on a checkout, not its own row -- same
-- approach CalTool uses. Nothing requires it: a checkout with no work_order behaves exactly
-- as it always has, so this is purely additive and invisible until someone actually types one
-- in. Check-in inherits the work_order from the tool's own last checkout automatically (see
-- POST /api/transactions), so an operator never has to remember/retype it.
--
-- work_order_closures existing (a row for a given work_order) means it's closed; deleting the
-- row reopens it -- same "presence of a row is the state" pattern already used elsewhere in
-- this schema (e.g. quarantine's open/resolved via status, not a separate table, but the
-- shape here mirrors CalTool's own work_order_closures table directly).

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS work_order TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_work_order ON audit_logs(work_order) WHERE work_order IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_order_closures (
    closure_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    work_order TEXT NOT NULL UNIQUE,
    note TEXT,
    closed_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    closed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
