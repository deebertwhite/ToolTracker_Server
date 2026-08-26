-- ==========================================
-- Migration 015: Calibration certificate photo
-- ==========================================
-- A calibration_records row already has a certificate/reference NUMBER, but nothing to view
-- the actual paper certificate itself -- this lets an admin attach a photo of it after the
-- fact, reusing the exact same column name (photo_url) and the same generic POST /api/upload
-- endpoint already used for tools/users/toolboxes/drawers, rather than inventing a
-- differently-named column that endpoint would need a special case to handle.

ALTER TABLE calibration_records ADD COLUMN IF NOT EXISTS photo_url TEXT;
