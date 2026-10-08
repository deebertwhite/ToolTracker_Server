-- ==========================================
-- Migration 018: Tool sub-assemblies
-- ==========================================
-- A true parent-child relationship, distinct from tool_groups (migration 014)'s flat peer
-- grouping of independently-scanned tools. A sub-assembly (e.g. the specific die on a crimper)
-- is never independently scanned/checked out -- no qr_code, no location, no In/Out status --
-- it's an attached record on its parent tool's card with its own part number and its own
-- independent calibration status. A calibrated parent can have sub-assemblies that are
-- themselves calibrated or not; a sub-assembly that needs calibration and is out of cal gates
-- the PARENT tool's checkout exactly like the parent's own expired calibration would (see
-- POST /api/transactions in server.js).
--
-- Deliberately no calibration_records-style certificate-history table for sub-assemblies in
-- this version -- just denormalized is_calibrated/last_cal_date/cal_due_date, the same shape
-- `tools` itself had before migration 006 added certificate history. If full cert-history
-- traceability is wanted for sub-assemblies later, the upgrade path is a twin table
-- (sub_assembly_calibration_records, FK'd to sub_id), not a polymorphic extension of
-- calibration_records itself.

CREATE TABLE IF NOT EXISTS tool_sub_assemblies (
    sub_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool_id INTEGER NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    part_number VARCHAR(100),
    serial_number TEXT,
    is_calibrated BOOLEAN NOT NULL DEFAULT false,
    last_cal_date DATE,
    cal_due_date DATE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_sub_assemblies_tool_id ON tool_sub_assemblies(tool_id);

-- Same guard as migrations/011_serial_number_uniqueness.sql, scoped to this table -- a
-- physical sub-assembly (e.g. a specific die) shouldn't be able to collide with another
-- sub-assembly's serial any more than two tools should. findDuplicateSerial() in server.js
-- additionally checks ACROSS tools and tool_sub_assemblies for a friendly message, but that
-- cross-table check is application-level only (Postgres can't enforce a UNIQUE constraint
-- across two separate tables) -- this index is what's actually enforced under concurrency
-- for duplicates within this table.
CREATE UNIQUE INDEX IF NOT EXISTS tool_sub_assemblies_serial_number_active_uq
    ON tool_sub_assemblies (LOWER(TRIM(serial_number)))
    WHERE serial_number IS NOT NULL AND TRIM(serial_number) != '';
