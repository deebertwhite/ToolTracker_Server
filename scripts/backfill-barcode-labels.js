// ==========================================
// Barcode label backfill (one-time, run once after migrations/004_barcode_images.sql)
// ==========================================
// Generates a Data Matrix label PNG for every non-retired tool that doesn't have one yet,
// using the exact same generation settings (size, padding) as generateBarcodeLabel() in
// server.js -- this script exists only to cover tools created before that feature existed;
// every tool created from here on gets its label generated automatically at creation time.
// Idempotent: only touches rows where barcode_image_url is still NULL, so it's safe to
// re-run if interrupted partway through. Retired tools are skipped -- their qr_code has
// already been mangled with a "-RET-<id>" suffix (see POST /api/tools) and a label for a
// retired tool serves no purpose.
//
// Usage: node scripts/backfill-barcode-labels.js

const fs = require('fs');
const path = require('path');
const { getPool } = require('./lib/db');
const { generatePngAtSize } = require('./lib/datamatrix');

// Mirrors BASE_STORAGE_PATH's resolution in server.js (process.env.BASE_STORAGE_PATH,
// falling back to the project root) so this writes to the exact same directory the running
// app serves from, whether run on the PC (default) or the Pi (BASE_STORAGE_PATH set in .env).
const BASE_STORAGE_PATH = process.env.BASE_STORAGE_PATH || path.join(__dirname, '..');
const BARCODE_LABEL_DIR = path.join(BASE_STORAGE_PATH, 'public', 'uploads', 'barcodes');
const BARCODE_LABEL_SIZE_MM = 15;
const BARCODE_LABEL_PADDING = 20;
const BARCODE_LABEL_TEXT_YOFFSET = -12;
const BARCODE_LABEL_BACKGROUND = 'FFFFFF';

async function main() {
    fs.mkdirSync(BARCODE_LABEL_DIR, { recursive: true });

    const pool = getPool();
    const { rows } = await pool.query(
        `SELECT tool_id, qr_code FROM tools WHERE barcode_image_url IS NULL AND status != 'Retired' ORDER BY tool_id ASC`
    );

    if (rows.length === 0) {
        console.log('No tools need backfilling -- every non-retired tool already has a barcode_image_url.');
        await pool.end();
        return;
    }

    console.log(`Generating barcode labels for ${rows.length} tool(s)...\n`);

    let failures = 0;
    for (const tool of rows) {
        try {
            const safeName = tool.qr_code.replace(/[^A-Za-z0-9_-]/g, '_');
            const { png } = await generatePngAtSize(tool.qr_code, BARCODE_LABEL_SIZE_MM, 1200, true, BARCODE_LABEL_PADDING, BARCODE_LABEL_TEXT_YOFFSET, BARCODE_LABEL_BACKGROUND);
            fs.writeFileSync(path.join(BARCODE_LABEL_DIR, `${safeName}.png`), png);
            const barcodeUrl = `/uploads/barcodes/${safeName}.png`;
            await pool.query('UPDATE tools SET barcode_image_url = $1 WHERE tool_id = $2', [barcodeUrl, tool.tool_id]);
            console.log(`  OK    ${tool.qr_code}`);
        } catch (err) {
            failures++;
            console.error(`  FAIL  ${tool.qr_code}: ${err.message}`);
        }
    }

    await pool.end();

    console.log(`\nDone. ${rows.length - failures} succeeded, ${failures} failed.`);
    if (failures > 0) {
        console.error('One or more tools failed to generate a label -- safe to re-run (only NULL barcode_image_url rows are touched).');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
