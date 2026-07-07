-- ==========================================
-- Migration 002: PIN hashing + brute-force lockout + role integrity
-- ==========================================
-- Adds pin_hash alongside the existing plaintext pin column (deliberately NOT
-- dropping pin here -- that happens in a later cleanup migration once the app
-- has run on pin_hash in production for a burn-in period). See
-- scripts/backfill-pin-hashes.js, which must be run once after this migration
-- and before deploying the server.js version that reads pin_hash.
--
-- Also adds per-badge brute-force lockout columns and a CHECK constraint on
-- role, closing a data-integrity gap noticed while touching this table (role
-- was previously free text with no validation at the DB layer).

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_pin_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('super_admin', 'dept_admin', 'tool_rep', 'technician'));
    END IF;
END $$;
