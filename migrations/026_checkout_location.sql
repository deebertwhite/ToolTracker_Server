-- An optional free-text note of where a tool is actually going when checked out (e.g. "Hangar 2",
-- "Customer site -- Acme Air"), alongside the existing work_order column -- James: a value-add
-- for later reporting/trace-back, logged now even before any admin UI is built around it. Same
-- per-tool-row logging and check-in-inherits-from-last-checkout treatment as work_order (see
-- POST /api/transactions in server.js); no index yet since nothing queries by it yet.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS location TEXT;
