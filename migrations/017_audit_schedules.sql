-- Per-department configurable mandatory-audit windows. A department with no rows here falls
-- back to the app's hardcoded default (Morning 04:00 / Afternoon 14:00) -- see
-- DEFAULT_AUDIT_SCHEDULE in server.js -- so this migration deliberately seeds nothing and every
-- existing department's behavior is unchanged until a manager actively customizes it.
CREATE TABLE audit_schedules (
    schedule_id SERIAL PRIMARY KEY,
    dept_id INTEGER NOT NULL REFERENCES departments(dept_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
    UNIQUE (dept_id, start_minute)
);
