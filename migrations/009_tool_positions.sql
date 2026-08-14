-- ==========================================
-- Migration 009: Tool positions on a drawer's photo (visual shadow-board map)
-- ==========================================
-- Drawers already have a photo (photo_url, migration 000). This adds a click-to-place
-- position for each tool within that photo, so the admin panel and dashboard can render a
-- live visual map of a drawer -- each tool's shadow-board spot, colored by its current
-- status -- instead of only a text list. Fractional (0.0-1.0, relative to the photo's own
-- width/height) rather than pixel coordinates so the map still lines up correctly no matter
-- what size the photo is displayed at, and survives the photo being re-uploaded at a
-- different resolution. NULL in either column means "not placed yet" -- most tools until an
-- admin marks them, not an error state.

ALTER TABLE tools ADD COLUMN IF NOT EXISTS position_x REAL;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS position_y REAL;
