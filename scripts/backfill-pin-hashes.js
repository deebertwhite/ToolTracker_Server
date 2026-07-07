// ==========================================
// PIN hash backfill (one-time, run once after migrations/002_pin_hashing.sql)
// ==========================================
// Hashes every user's existing plaintext PIN into the new pin_hash column using the
// same bcrypt implementation server.js uses for new PINs going forward -- one hashing
// code path, not a separate SQL-side implementation. Idempotent: only touches rows
// where pin_hash is still NULL, so it's safe to re-run if interrupted partway through.
//
// Deploy order matters: run this BEFORE deploying the server.js version that reads
// pin_hash instead of pin. The old pin column is left untouched (not dropped) so a
// rollback of server.js alone restores service if anything here needs re-checking.
//
// Usage: node scripts/backfill-pin-hashes.js

const bcrypt = require('bcrypt');
const { getPool } = require('./lib/db');

const BCRYPT_COST_FACTOR = 12;

async function main() {
    const pool = getPool();
    const { rows } = await pool.query(
        `SELECT user_id, badge_id, pin FROM users WHERE pin_hash IS NULL ORDER BY user_id ASC`
    );

    if (rows.length === 0) {
        console.log('No users need backfilling -- every user already has a pin_hash.');
        await pool.end();
        return;
    }

    console.log(`Hashing PINs for ${rows.length} user(s)...\n`);

    let failures = 0;
    for (const user of rows) {
        try {
            const hash = await bcrypt.hash(user.pin, BCRYPT_COST_FACTOR);
            await pool.query('UPDATE users SET pin_hash = $1 WHERE user_id = $2', [hash, user.user_id]);
            console.log(`  OK    ${user.badge_id}`);
        } catch (err) {
            failures++;
            console.error(`  FAIL  ${user.badge_id}: ${err.message}`);
        }
    }

    await pool.end();

    console.log(`\nDone. ${rows.length - failures} succeeded, ${failures} failed.`);
    if (failures > 0) {
        console.error('One or more users failed to hash -- re-run this script (it is safe to re-run, only NULL pin_hash rows are touched) before deploying the new server.js.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
