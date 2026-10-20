-- A dedicated, stable, tool-level Cal ID field (the vendor's own tracking number for a gage --
-- "Cal Control" in Micro Precision's export) -- James: visible and editable right alongside
-- Serial Number, not just inferred from whatever calibration_records row happens to be most
-- recent. This is what the importer now matches against directly (see findToolByCalId in
-- server.js), which is what actually lets a tool auto-match on the very first import once its
-- Cal ID is on file, rather than needing a prior committed record to have ever set
-- calibration_records.vendor_tracking_id first.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS cal_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS tools_cal_id_active_uq ON tools (LOWER(TRIM(cal_id))) WHERE cal_id IS NOT NULL AND TRIM(cal_id) <> '';
