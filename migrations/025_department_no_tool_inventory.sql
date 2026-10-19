-- Some departments never hold tools and never will (e.g. a pure admin/office department).
-- Flagging that explicitly lets audit-facing surfaces stop treating "zero tools right now" as
-- "temporarily empty, needs auditing like any other department" and instead treat it as
-- "permanently exempt." Enabling this is gated server-side (PUT /api/departments/:id) on the
-- department currently having zero tools of any status.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS no_tool_inventory BOOLEAN NOT NULL DEFAULT FALSE;
