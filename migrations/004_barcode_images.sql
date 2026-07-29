-- ==========================================
-- Migration 004: Per-tool Data Matrix label image
-- ==========================================
-- Adds a column to hold the auto-generated Data Matrix label image for each tool, separate
-- from photo_url (the tool's actual picture). Generated server-side at tool creation time
-- (see generateBarcodeLabel() in server.js) with extra padding around the code and its
-- human-readable ID compared to the bulk print/engrave scripts in scripts/, which
-- deliberately use zero padding since they're calibrated for exact physical label sizing --
-- this one is for on-screen viewing/selection in the admin panel instead.
--
-- Run scripts/backfill-barcode-labels.js once after this migration to generate labels for
-- any tool created before this feature existed.

ALTER TABLE tools ADD COLUMN IF NOT EXISTS barcode_image_url TEXT NULL;
