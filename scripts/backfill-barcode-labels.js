// ==========================================
// Barcode label backfill / rebase
// ==========================================
// Generates the one Data Matrix label image (10mm, see BARCODE_LABEL_MM in server.js) for
// tools that need one, using the exact same generation settings (padding, name row, size) as
// generateToolBarcodeLabel() in server.js. Every tool created or renamed from here on gets one
// generated/regenerated automatically, so this script exists for two distinct cases:
//
//   node scripts/backfill-barcode-labels.js          -- default, idempotent: only fills in
//       tools still missing a label (barcode_image_url_small IS NULL). Safe to re-run any
//       time, e.g. after a bulk CSV import, or to cover tools created before any of these
//       label features existed.
//
//   node scripts/backfill-barcode-labels.js --all    -- rebase: regenerates the label for
//       EVERY non-retired tool from scratch and overwrites existing files, even if already
//       present. Use this after a label-format change (e.g. adding the name row) so every
//       already-generated label picks up the new format, not just tools created afterward.
//
// Retired tools are always skipped -- their qr_code has already been mangled with a
// "-RET-<id>" suffix (see POST /api/tools) and a label for a retired tool serves no purpose.
//
// Previously generated 6 variants (Data Matrix + Code 128, each at small/medium/large); dropped
// to just the one small Data Matrix (2026-10) once the shop settled on a single size/format.

const fs = require('fs');
const path = require('path');
const { getPool } = require('./lib/db');
const { generatePngAtSize, addNameRow } = require('./lib/datamatrix');

// Mirrors BASE_STORAGE_PATH's resolution in server.js (process.env.BASE_STORAGE_PATH,
// falling back to the project root) so this writes to the exact same directory the running
// app serves from, whether run on the PC (default) or the Pi (BASE_STORAGE_PATH set in .env).
const BASE_STORAGE_PATH = process.env.BASE_STORAGE_PATH || path.join(__dirname, '..');
const BARCODE_LABEL_DIR = path.join(BASE_STORAGE_PATH, 'public', 'uploads', 'barcodes');
const BARCODE_LABEL_MM = 10;
const BARCODE_LABEL_PADDING = 20;
const BARCODE_LABEL_TEXT_YOFFSET = -12;
const BARCODE_LABEL_BACKGROUND = 'FFFFFF';

const REBASE_ALL = process.argv.includes('--all');

async function generateLabel(qrCode, name) {
    const safeName = qrCode.replace(/[^A-Za-z0-9_-]/g, '_');
    const { png } = await generatePngAtSize(qrCode, BARCODE_LABEL_MM, 1200, true, BARCODE_LABEL_PADDING, BARCODE_LABEL_TEXT_YOFFSET, BARCODE_LABEL_BACKGROUND);
    const labeled = await addNameRow(png, name);
    const filename = `${safeName}-small.png`;
    fs.writeFileSync(path.join(BARCODE_LABEL_DIR, filename), labeled);
    return `/uploads/barcodes/${filename}`;
}

async function main() {
    fs.mkdirSync(BARCODE_LABEL_DIR, { recursive: true });

    const pool = getPool();
    const { rows } = await pool.query(
        REBASE_ALL
            ? `SELECT tool_id, qr_code, name FROM tools WHERE status != 'Retired' ORDER BY tool_id ASC`
            : `SELECT tool_id, qr_code, name FROM tools WHERE barcode_image_url_small IS NULL AND status != 'Retired' ORDER BY tool_id ASC`
    );

    if (rows.length === 0) {
        console.log('No tools need backfilling -- every non-retired tool already has a label image.');
        await pool.end();
        return;
    }

    console.log(`${REBASE_ALL ? 'Rebasing' : 'Generating'} barcode labels for ${rows.length} tool(s)...\n`);

    let failures = 0;
    for (const tool of rows) {
        try {
            const url = await generateLabel(tool.qr_code, tool.name);
            await pool.query('UPDATE tools SET barcode_image_url_small = $1 WHERE tool_id = $2', [url, tool.tool_id]);
            console.log(`  OK    ${tool.qr_code}`);
        } catch (err) {
            failures++;
            console.error(`  FAIL  ${tool.qr_code}: ${err.message}`);
        }
    }

    await pool.end();

    console.log(`\nDone. ${rows.length - failures} succeeded, ${failures} failed.`);
    if (failures > 0) {
        console.error('One or more tools failed to generate a label -- safe to re-run.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
