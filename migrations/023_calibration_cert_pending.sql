-- ==========================================
-- Migration 023: Calibration certificate pending (vendor bypass)
-- ==========================================
-- James: "Currently we dont have access to certs from the vendor, so calibration cert uploads
-- need a methodical bypass for the time being." A calibration can now be logged with its
-- certificate/reference number marked as not-yet-received, instead of being blocked entirely
-- until the vendor sends the paperwork -- but deliberately tracked (cert_pending), not just
-- silently allowed, so an incomplete record can be found and backfilled later rather than
-- quietly staying incomplete forever. provider stays required either way (which vendor it went
-- to IS already known; it's only their certificate number that's missing for now).

ALTER TABLE calibration_records ADD COLUMN IF NOT EXISTS cert_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calibration_records ALTER COLUMN certificate_number DROP NOT NULL;
ALTER TABLE calibration_records ADD CONSTRAINT calibration_records_cert_check CHECK (cert_pending = true OR certificate_number IS NOT NULL);
