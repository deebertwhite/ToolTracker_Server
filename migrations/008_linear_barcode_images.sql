-- ==========================================
-- Migration 008: Second, linear (1D) barcode label per tool
-- ==========================================
-- tools.barcode_image_url (migration 004) holds the auto-generated Data Matrix label.
-- Data Matrix is compact, but plenty of cheap USB/laser barcode scanners are 1D-only and
-- simply cannot read a 2D symbol at all. This adds a second, independently-generated
-- Code 128 label alongside it (see generateLinearBarcodePng() in scripts/lib/datamatrix.js)
-- so either kind of scanner -- or a phone camera, which reads both -- works. Purely
-- additive: barcode_image_url is untouched, existing tools just get this backfilled.

ALTER TABLE tools ADD COLUMN IF NOT EXISTS linear_barcode_image_url TEXT;
