-- ==========================================
-- Migration 001: Beta feedback round
-- ==========================================
-- Adds a dedicated Serial Number field for tools (separate from the existing,
-- previously-unused part_number column), and a new tool_transfers table that
-- tracks the two-leg, two-party chain of custody when a tool is sent to a QA
-- department for calibration and returned. See the plan doc for full context:
-- "ToolTracker_Server -- Beta-Testing Feedback: Feature & Bug-Fix Push".

ALTER TABLE tools ADD COLUMN IF NOT EXISTS serial_number TEXT NULL;

CREATE TABLE IF NOT EXISTS tool_transfers (
    transfer_id              SERIAL PRIMARY KEY,
    tool_id                  INTEGER NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    home_dept_id             INTEGER NOT NULL REFERENCES departments(dept_id) ON DELETE RESTRICT,
    qa_dept_id               INTEGER NOT NULL REFERENCES departments(dept_id) ON DELETE RESTRICT,

    -- Captured at initiation for provenance only -- tools.drawer_id itself is
    -- never modified during a transfer cycle (a tool's home location never
    -- changes, only its status reflects that it's temporarily elsewhere).
    origin_drawer_id         INTEGER NULL REFERENCES drawers(drawer_id) ON DELETE SET NULL,

    -- AWAITING_QA_ACCEPT -> IN_CALIBRATION -> AWAITING_HOME_ACCEPT -> COMPLETE
    -- AWAITING_QA_ACCEPT -> CANCELLED
    status                   TEXT NOT NULL DEFAULT 'AWAITING_QA_ACCEPT',

    initiated_by_user_id     INTEGER NOT NULL REFERENCES users(user_id),
    initiated_at             TIMESTAMP NOT NULL DEFAULT NOW(),

    qa_accepted_by_user_id   INTEGER NULL REFERENCES users(user_id),
    qa_accepted_at           TIMESTAMP NULL,

    cal_completed_by_user_id INTEGER NULL REFERENCES users(user_id),
    cal_completed_at         TIMESTAMP NULL,

    home_accepted_by_user_id INTEGER NULL REFERENCES users(user_id),
    home_accepted_at         TIMESTAMP NULL,

    notes                    TEXT NULL,
    cancelled_reason         TEXT NULL,

    created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_transfers_tool_id ON tool_transfers(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_transfers_status ON tool_transfers(status);
CREATE INDEX IF NOT EXISTS idx_tool_transfers_qa_dept ON tool_transfers(qa_dept_id, status);
CREATE INDEX IF NOT EXISTS idx_tool_transfers_home_dept ON tool_transfers(home_dept_id, status);

-- Only one active (non-terminal) transfer per tool at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_transfers_one_active_per_tool
    ON tool_transfers(tool_id)
    WHERE status NOT IN ('COMPLETE', 'CANCELLED');
