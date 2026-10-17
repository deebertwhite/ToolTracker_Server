-- Lets a wrong calibration_records entry (e.g. a mis-typed date) be fixed without ever deleting
-- or overwriting the original row -- James: "we need a way to update the data if a mistake is
-- made but not override the data so that no one can hide information." A correction is a NEW
-- row pointing back at the one it fixes via supersedes_cal_id; the original row is never
-- touched, so the full history (right or wrong) stays visible in the admin panel's calibration
-- history list. correction_reason is required by the application layer (not a DB constraint,
-- consistent with how other required-field validation in this app lives in server.js) whenever
-- supersedes_cal_id is set.
ALTER TABLE calibration_records ADD COLUMN IF NOT EXISTS supersedes_cal_id INTEGER REFERENCES calibration_records(cal_id) ON DELETE SET NULL;
ALTER TABLE calibration_records ADD COLUMN IF NOT EXISTS correction_reason TEXT;
