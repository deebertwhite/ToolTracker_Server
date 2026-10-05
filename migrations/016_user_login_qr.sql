-- Adds a per-user login token (see generateLoginToken() in server.js) for QR-card login
-- (POST /api/login/qr) -- a 128-bit random value, deliberately distinct from badge_id/username
-- so reissuing a lost/compromised card invalidates the old one without touching the person's
-- actual login identity. NULL until a card is first generated for that person; badge_id/
-- username + PIN keeps working unchanged as the backup path.
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_token TEXT;

-- Scoped like badge_id/username/email (migrations/003_scoped_unique_identifiers.sql): only
-- active users' tokens need to be unique, so deactivating someone and later reissuing a token
-- to a different person can't collide with a token that still exists only on an inactive row.
CREATE UNIQUE INDEX IF NOT EXISTS users_login_token_active_key ON users (login_token) WHERE is_active = true AND login_token IS NOT NULL;
