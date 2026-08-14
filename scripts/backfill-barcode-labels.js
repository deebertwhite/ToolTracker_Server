// ==========================================
// Barcode label backfill / rebase
// ==========================================
// Generates both label formats for tools that need one -- a Data Matrix PNG and a Code 128
// (linear/1D) PNG, using the exact same generation settings (size, padding, name row) as
// generateBarcodeLabel()/generateLinearBarcodeLabel() in server.js. Every tool created or
// renamed from here on gets both generated/regenerated automatically, so this script exists
// for two distinct cases:
//
//   node scripts/backfill-barcode-labels.js          -- default, idempotent: only fills in
//       whichever format(s) a tool is still missing (either URL column NULL). Safe to
//       re-run any time, e.g. after a bulk CSV import, or to cover tools created before
//       either label feature existed.
//
//   node scripts/backfill-barcode-labels.js --all    -- rebase: regenerates BOTH formats for
//       EVERY non-retired tool from scratch and overwrites existing files, even if already
//       present. Use this after a label-format change (e.g. adding the name row below the
//       ID) so every already-generated label picks up the new format, not just tools
//       created afterward.
//
// Retired tools are always skipped -- their qr_code has already been mangled with a
// "-RET-<id>" suffix (see POST /api/tools) and a label for a retired tool serves no purpose.

const fs = require('fs');
const path = require('path');
const { getPool } = require('./lib/db');
const { generatePngAtSize, generateLinearBarcodePng, addNameRow } = require('./lib/datamatrix');

// Mirrors BASE_STORAGE_PATH's resolution in server.js (process.env.BASE_STORAGE_PATH,
// falling back to the project root) so this writes to the exact same directory the running
// app serves from, whether run on the PC (default) or the Pi (BASE_STORAGE_PATH set in .env).
const BASE_STORAGE_PATH = process.env.BASE_STORAGE_PATH || path.join(__dirname, '..');
const BARCODE_LABEL_DIR = path.join(BASE_STORAGE_PATH, 'public', 'uploads', 'barcodes');
const BARCODE_LABEL_SIZE_MM = 15;
const BARCODE_LABEL_PADDING = 20;
const BARCODE_LABEL_TEXT_YOFFSET = -12;
const BARCODE_LABEL_BACKGROUND = 'FFFFFF';

const REBASE_ALL = process.argv.includes('--all');

async function main() {
    fs.mkdirSync(BARCODE_LABEL_DIR, { recursive: true });

    const pool = getPool();
    const { rows } = await pool.query(
        REBASE_ALL
            ? `SELECT tool_id, qr_code, name FROM tools WHERE status != 'Retired' ORDER BY tool_id ASC`
            : `SELECT tool_id, qr_code, name FROM tools WHERE (barcode_image_url IS NULL OR linear_barcode_image_url IS NULL) AND status != 'Retired' ORDER BY tool_id ASC`
    );

    if (rows.length === 0) {
        console.log('No tools need backfilling -- every non-retired tool already has both label formats.');
        await pool.end();
        return;
    }

    console.log(`${REBASE_ALL ? 'Rebasing' : 'Generating'} barcode labels for ${rows.length} tool(s)...\n`);

    let failures = 0;
    for (const tool of rows) {
        try {
            const safeName = tool.qr_code.replace(/[^A-Za-z0-9_-]/g, '_');

            const { png } = await generatePngAtSize(tool.qr_code, BARCODE_LABEL_SIZE_MM, 1200, true, BARCODE_LABEL_PADDING, BARCODE_LABEL_TEXT_YOFFSET, BARCODE_LABEL_BACKGROUND);
            const labeled = await addNameRow(png, tool.name);
            fs.writeFileSync(path.join(BARCODE_LABEL_DIR, `${safeName}.png`), labeled);
            const barcodeUrl = `/uploads/barcodes/${safeName}.png`;

            const { png: linearPng } = await generateLinearBarcodePng(tool.qr_code, BARCODE_LABEL_BACKGROUND);
            const linearLabeled = await addNameRow(linearPng, tool.name);
            fs.writeFileSync(path.join(BARCODE_LABEL_DIR, `${safeName}-1d.png`), linearLabeled);
            const linearBarcodeUrl = `/uploads/barcodes/${safeName}-1d.png`;

            await pool.query('UPDATE tools SET barcode_image_url = $1, linear_barcode_image_url = $2 WHERE tool_id = $3', [barcodeUrl, linearBarcodeUrl, tool.tool_id]);
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
