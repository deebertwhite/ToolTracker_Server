-- ==========================================
-- Migration 003: Scope badge_id/username/email uniqueness to active users only
-- ==========================================
-- Previously, badge_id/username/email were UNIQUE across the whole users table --
-- deactivating someone (is_active = false) does not delete their row, so their
-- identifiers stayed permanently reserved and blocked creating a new person with the
-- same badge/email/username. The only way to free them up was a hard DELETE, which
-- fails (correctly) if that person has any real audit_logs/tool_transfers history,
-- since those foreign keys have no ON DELETE behavior -- Postgres refuses to orphan
-- real historical accountability records.
--
-- Fix: replace the plain UNIQUE constraints with partial unique indexes that only
-- apply WHERE is_active = true. Deactivating someone is now sufficient on its own to
-- free their badge_id/username/email for a new person -- no rename/archive step
-- needed, and their original identifiers stay fully intact and readable on the old
-- (deactivated) row for historical lookup. Reactivating an old account while its
-- badge/email/username is already in use by a different active person still correctly
-- fails with a uniqueness violation, exactly as it should.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_badge_id_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS users_badge_id_active_key ON users (badge_id) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_active_key ON users (username) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_key ON users (email) WHERE is_active = true;
