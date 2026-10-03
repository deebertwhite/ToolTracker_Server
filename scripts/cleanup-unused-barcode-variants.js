// ==========================================
// One-time cleanup: unused barcode label variants
// ==========================================
// The app used to generate 6 label images per tool (Data Matrix + Code 128, each at
// small/medium/large) and now generates just one (10mm Data Matrix, see
// generateToolBarcodeLabel() in server.js) -- the other 5 sizes/formats went unused. This
// deletes whatever of those 5 files still exist on disk for every tool and nulls their now-dead
// DB columns, leaving only barcode_image_url_small populated.
//
// Idempotent -- safe to re-run; already-null columns and already-missing files are just
// skipped. Run once on the Pi after deploying the barcode-simplification change.
//
// Usage: node scripts/cleanup-unused-barcode-variants.js

const fs = require('fs');
const path = require('path');
const { getPool } = require('./lib/db');

// Mirrors BASE_STORAGE_PATH's resolution in server.js.
const BASE_STORAGE_PATH = process.env.BASE_STORAGE_PATH || path.join(__dirname, '..');
const UPLOAD_DIR = path.join(BASE_STORAGE_PATH, 'public', 'uploads');

const UNUSED_COLUMNS = [
    'barcode_image_url',
    'barcode_image_url_large',
    'linear_barcode_image_url',
    'linear_barcode_image_url_small',
    'linear_barcode_image_url_large',
];

function deleteIfExists(url) {
    if (!url) return false;
    const filePath = path.join(UPLOAD_DIR, url.replace(/^\/uploads\//, ''));
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

async function main() {
    const pool = getPool();
    const { rows } = await pool.query(
        `SELECT tool_id, qr_code, ${UNUSED_COLUMNS.join(', ')} FROM tools
         WHERE ${UNUSED_COLUMNS.map(c => `${c} IS NOT NULL`).join(' OR ')}`
    );

    if (rows.length === 0) {
        console.log('Nothing to clean up -- no tool has any of the unused barcode variants on file.');
        await pool.end();
        return;
    }

    console.log(`Cleaning up ${rows.length} tool(s)...\n`);
    let filesDeleted = 0;
    for (const tool of rows) {
        for (const col of UNUSED_COLUMNS) {
            if (deleteIfExists(tool[col])) filesDeleted++;
        }
        console.log(`  OK    ${tool.qr_code}`);
    }

    const toolIds = rows.map(r => r.tool_id);
    await pool.query(`UPDATE tools SET ${UNUSED_COLUMNS.map(c => `${c} = NULL`).join(', ')} WHERE tool_id = ANY($1::int[])`, [toolIds]);

    await pool.end();
    console.log(`\nDone. Cleared ${UNUSED_COLUMNS.length} unused column(s) on ${rows.length} tool(s), deleted ${filesDeleted} orphaned file(s).`);
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
