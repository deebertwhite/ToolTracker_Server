-- Per-department control over which notification types that department cares about -- James:
-- "letting departments control how and when they are notified." Slack/email destinations stay
-- shop-wide (one webhook, plus each department's own admins' emails -- see server.js's
-- getNotificationRecipients()), but each department can opt out of a given event type
-- independently. Default TRUE on all three so a department that never touches this setting keeps
-- getting notified exactly like before this feature existed -- adding this never silently
-- goes quiet for anyone.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS notify_incidents BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS notify_still_checked_out BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS notify_cal_due BOOLEAN NOT NULL DEFAULT TRUE;
