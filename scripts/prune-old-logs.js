// ==========================================
// Log retention / rotation (one-shot, meant to run periodically via cron/systemd timer)
// ==========================================
// Deletes old files under logs/hourly/<DEPT>/ and logs/daily/<DEPT>/ past the configured
// retention window. Nothing in server.js does this on its own -- both loggers only ever
// append (see generateHourlyLog/generateDailyLog in server.js), so without this, both
// directories grow forever. In practice the actual bytes involved are small (each is a
// terse text line/block, not binary data -- a handful of MB per department per year even at
// a busy shop), so this exists for an intentional, bounded retention policy and directory
// tidiness more than real disk-space pressure.
//
// Usage:
//   node scripts/prune-old-logs.js               delete anything past retention
//   node scripts/prune-old-logs.js --dry-run      list what would be deleted, delete nothing
//   node scripts/prune-old-logs.js --log-dir=/mnt/external_drive/ToolTracker_Data/logs
//
// --log-dir defaults to ../logs relative to this script, which is only correct if
// BASE_STORAGE_PATH in server.js is still Option A (the default). If that's been switched to
// Option B (e.g. on the Pi, pointing at an external drive), pass the matching --log-dir here
// too -- the two aren't wired together automatically.
//
// Filenames that don't match the expected "<date>_hourly.log" / "<month>_daily.log" pattern
// are left alone rather than guessed at or deleted.

const fs = require('fs');
const path = require('path');

const HOURLY_RETENTION_DAYS = 730; // ~2 years
const DAILY_RETENTION_MONTHS = 24; // 2 years

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const logDirArg = args.find(a => a.startsWith('--log-dir='));
const LOG_DIR = logDirArg ? logDirArg.split('=')[1] : path.join(__dirname, '..', 'logs');

/** Parses the YYYY-MM-DD prefix off an hourly log filename (e.g. "2024-03-15_hourly.log"), returning null if it doesn't match. */
function parseHourlyDate(filename) {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_hourly\.log$/);
    return match ? new Date(match[1]) : null;
}

/** Parses the YYYY-MM prefix off a daily log filename (e.g. "2024-03_daily.log"), returning null if it doesn't match. */
function parseDailyMonth(filename) {
    const match = filename.match(/^(\d{4})-(\d{2})_daily\.log$/);
    return match ? new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, 1) : null;
}

/** Deletes (or, in --dry-run mode, just reports) every file under dir/<department>/ whose parsed date is before cutoff. Returns how many files and how many bytes were affected. */
function pruneDir(dir, parseDateFn, cutoff, label) {
    if (!fs.existsSync(dir)) return { deleted: 0, freedBytes: 0 };
    let deleted = 0, freedBytes = 0;

    for (const deptDir of fs.readdirSync(dir)) {
        const deptPath = path.join(dir, deptDir);
        if (!fs.statSync(deptPath).isDirectory()) continue;

        for (const file of fs.readdirSync(deptPath)) {
            const fileDate = parseDateFn(file);
            if (!fileDate || fileDate >= cutoff) continue;

            const filePath = path.join(deptPath, file);
            const size = fs.statSync(filePath).size;
            console.log(`${dryRun ? '[DRY RUN] Would delete' : 'Deleting'} ${label}/${deptDir}/${file} (${(size / 1024).toFixed(1)} KB)`);
            if (!dryRun) fs.unlinkSync(filePath);
            deleted++;
            freedBytes += size;
        }
    }
    return { deleted, freedBytes };
}

const now = new Date();
const hourlyCutoff = new Date(now); hourlyCutoff.setDate(hourlyCutoff.getDate() - HOURLY_RETENTION_DAYS);
const dailyCutoff = new Date(now); dailyCutoff.setMonth(dailyCutoff.getMonth() - DAILY_RETENTION_MONTHS);

const hourlyResult = pruneDir(path.join(LOG_DIR, 'hourly'), parseHourlyDate, hourlyCutoff, 'hourly');
const dailyResult = pruneDir(path.join(LOG_DIR, 'daily'), parseDailyMonth, dailyCutoff, 'daily');

const totalDeleted = hourlyResult.deleted + dailyResult.deleted;
const totalFreedKB = ((hourlyResult.freedBytes + dailyResult.freedBytes) / 1024).toFixed(1);
console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Done: ${totalDeleted} file(s) ${dryRun ? 'would be ' : ''}deleted, ${totalFreedKB} KB ${dryRun ? 'would be ' : ''}freed.`);
