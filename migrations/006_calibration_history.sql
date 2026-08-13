-- ==========================================
-- Migration 006: Calibration traceability history
-- ==========================================
-- Until now, a calibrated tool only carried its CURRENT last_cal_date/cal_due_date on the
-- tools row itself -- each new calibration cycle overwrote the last one, leaving no history.
-- That's not enough to demonstrate calibration "traceable to NIST or other national/
-- international standards" the way 14 CFR 21.137(f) (and the AS9100/Part 145 quality-system
-- language that mirrors it) expects -- an auditor needs to see every calibration event, not
-- just today's snapshot.
--
-- One row per completed calibration cycle, populated from the QA-transfer completion step
-- (see POST /api/transfers/:id/complete-cal in server.js) -- that's the one place in this app
-- where a calibration actually happens. provider/certificate_number are required there since
-- this shop's calibrations are done by an outside vendor/lab that issues a certificate; a
-- shop doing calibration in-house would still have somewhere to note who/what performed it,
-- just without a vendor certificate number.

CREATE TABLE IF NOT EXISTS calibration_records (
    cal_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool_id INTEGER NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    cal_date DATE NOT NULL,
    due_date DATE NOT NULL,
    provider VARCHAR(150) NOT NULL,
    certificate_number VARCHAR(100) NOT NULL,
    standard_used VARCHAR(150),
    notes TEXT,
    recorded_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_calibration_records_tool_id ON calibration_records(tool_id);
