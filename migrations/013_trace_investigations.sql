-- ==========================================
-- Migration 013: Sub-tolerance trace-back investigations
-- ==========================================
-- When a calibrated tool fails calibration, its measurements since it was last known-good
-- are suspect -- every task it performed in that window needs to be traced back and
-- re-checked. Previously calibration_records had no pass/fail concept at all (every logged
-- calibration was implicitly treated as a routine pass), so there was nothing to trigger
-- this from.
--
-- result defaults to 'Pass' (backfilling existing rows correctly, since none of them were
-- ever tracked as a failure) so the common case -- logging a routine passing calibration --
-- stays exactly as simple as it already was; only the failure path is new.

ALTER TABLE calibration_records ADD COLUMN IF NOT EXISTS result VARCHAR(10) NOT NULL DEFAULT 'Pass' CHECK (result IN ('Pass', 'Fail'));

-- One row per investigation. At most one OPEN investigation per tool at a time -- a second
-- failure while one is already open should feed into the same investigation, not fork a
-- competing one.
CREATE TABLE IF NOT EXISTS trace_investigations (
    investigation_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool_id INTEGER NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    triggering_cal_id INTEGER REFERENCES calibration_records(cal_id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    -- Suspect window: from the last known-good calibration (NULL = since the tool's own
    -- creation -- no prior passing record exists at all) up to when the failure was
    -- detected/measured. A manually-opened investigation can narrow this to a chosen range.
    window_start TIMESTAMP,
    window_end TIMESTAMP NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    opened_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    closed_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    conclusion TEXT,
    -- Supervisor override: force-closed rather than every review actually being worked
    -- through, with a mandatory reason -- permanent record of who waived what.
    overridden BOOLEAN NOT NULL DEFAULT false,
    override_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trace_investigations_tool_id ON trace_investigations(tool_id);
CREATE UNIQUE INDEX IF NOT EXISTS trace_investigations_one_open_per_tool_uq ON trace_investigations(tool_id) WHERE status = 'OPEN';

-- One row per task (checkout) in the suspect window, auto-populated from audit_logs when the
-- investigation opens. Snapshotted (work_order, custodian_name, timestamps) rather than
-- joined live, so the record stays accurate even if the underlying user is later deactivated
-- or the checkout's own audit_logs row is somehow altered.
CREATE TABLE IF NOT EXISTS trace_reviews (
    review_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    investigation_id INTEGER NOT NULL REFERENCES trace_investigations(investigation_id) ON DELETE CASCADE,
    audit_log_id INTEGER REFERENCES audit_logs(log_id) ON DELETE SET NULL,
    work_order TEXT,
    custodian_name TEXT,
    used_at TIMESTAMP NOT NULL,
    returned_at TIMESTAMP,
    outcome VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING', 'IN_TOLERANCE', 'OUT_OF_TOLERANCE', 'NOT_APPLICABLE')),
    checked_with_tool_id INTEGER REFERENCES tools(tool_id) ON DELETE SET NULL,
    notes TEXT,
    reviewed_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trace_reviews_investigation_id ON trace_reviews(investigation_id);
