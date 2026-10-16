-- ==========================================
-- Migration 022: Calibration record vendor tracking ID
-- ==========================================
-- James: "We will need to account for if we change calibration vendors, and they use an
-- alternate SN for tracking." A calibration vendor sometimes tracks a tool under their own
-- serial/asset number on the certificate, different from tools.serial_number (the tool's own
-- physical serial). Attached to calibration_records rather than tools itself (confirmed via
-- AskUserQuestion) since the identifier is really "what THIS vendor called it on THIS
-- certificate" -- naturally handles a vendor change over time, since each historical record
-- keeps its own vendor+tracking-number pairing instead of one value on the tool getting
-- silently overwritten/ambiguous once a different vendor is used. Nullable/optional: plenty of
-- vendors (and all in-house calibration) have no separate tracking ID at all.

ALTER TABLE calibration_records ADD COLUMN IF NOT EXISTS vendor_tracking_id VARCHAR(100);
