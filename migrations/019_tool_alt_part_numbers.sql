-- ==========================================
-- Migration 019: Alternate part numbers
-- ==========================================
-- Some tools have more than one valid part number -- e.g. a commercial/OEM catalog number
-- alongside a MIL-SPEC equivalent. tools.part_number stays as the one primary/main number
-- (unchanged -- every existing feature built around it keeps working exactly as before);
-- this table holds any additional numbers a tool can also be looked up by. Purely additive
-- and purely informational -- no uniqueness constraint (part_number itself has never had one
-- either; two tools can legitimately share a cross-reference number) and no involvement in
-- calibration/checkout logic, unlike tool_sub_assemblies (migrations/018).

CREATE TABLE IF NOT EXISTS tool_alt_part_numbers (
    alt_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool_id INTEGER NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    part_number VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_alt_part_numbers_tool_id ON tool_alt_part_numbers(tool_id);
