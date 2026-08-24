-- ==========================================
-- Migration 011: Duplicate-serial-number guard
-- ==========================================
-- Prevents two tools from ever sharing the same serial number (normalized for case and
-- surrounding whitespace, so "SN-1" and "sn-1 " collide) -- previously nothing stopped a
-- typo'd re-add of an existing tool from silently creating a second row for the same
-- physical asset. Enforced in the database (not just the application) so it also catches
-- CSV import and any future write path, not just the one place someone remembers to check.
--
-- Partial (WHERE serial_number is set) since plenty of tools legitimately have none.

CREATE UNIQUE INDEX IF NOT EXISTS tools_serial_number_active_uq
    ON tools (LOWER(TRIM(serial_number)))
    WHERE serial_number IS NOT NULL AND TRIM(serial_number) != '';
