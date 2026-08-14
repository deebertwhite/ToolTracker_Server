// ==========================================
// Barcode label backfill / rebase
// ==========================================
// Generates all 6 label images (2 formats x 3 sizes) for tools that need one -- Data Matrix
// and Code 128, each at small/medium/large -- using the exact same generation settings
// (padding, name row, size presets) as generateAllBarcodeLabels() in server.js. Every tool
// created or renamed from here on gets all 6 generated/regenerated automatically, so this
// script exists for two distinct cases:
//
//   node scripts/backfill-barcode-labels.js          -- default, idempotent: only fills in
//       tools still missing at least one of the 6 (any URL column NULL). Safe to re-run any
//       time, e.g. after a bulk CSV import, or to cover tools created before any of these
//       label features existed.
//
//   node scripts/backfill-barcode-labels.js --all    -- rebase: regenerates all 6 for EVERY
//       non-retired tool from scratch and overwrites existing files, even if already
//       present. Use this after a label-format change (e.g. adding the name row, or adding
//       the small/large sizes) so every already-generated label picks up the new format,
//       not just tools created afterward.
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
const BARCODE_LABEL_PADDING = 20;
const BARCODE_LABEL_TEXT_YOFFSET = -12;
const BARCODE_LABEL_BACKGROUND = 'FFFFFF';

// Keep in sync with BARCODE_SIZES / BARCODE_LABEL_COLUMNS in server.js.
const BARCODE_SIZES = {
    small: { dmMm: 10, linearScale: 2 },
    medium: { dmMm: 15, linearScale: 3 },
    large: { dmMm: 20, linearScale: 5 },
};
const BARCODE_LABEL_COLUMNS = {
    'datamatrix-small': 'barcode_image_url_small',
    'datamatrix-medium': 'barcode_image_url',
    'datamatrix-large': 'barcode_image_url_large',
    'linear-small': 'linear_barcode_image_url_small',
    'linear-medium': 'linear_barcode_image_url',
    'linear-large': 'linear_barcode_image_url_large',
};
const ALL_COLUMNS = Object.values(BARCODE_LABEL_COLUMNS);

const REBASE_ALL = process.argv.includes('--all');

async function generateOneLabel(qrCode, name, size, format) {
    const safeName = qrCode.replace(/[^A-Za-z0-9_-]/g, '_');
    const sizeSuffix = size === 'medium' ? '' : `-${size}`;
    const { dmMm, linearScale } = BARCODE_SIZES[size];

    let png, filename;
    if (format === 'datamatrix') {
        ({ png } = await generatePngAtSize(qrCode, dmMm, 1200, true, BARCODE_LABEL_PADDING, BARCODE_LABEL_TEXT_YOFFSET, BARCODE_LABEL_BACKGROUND));
        filename = `${safeName}${sizeSuffix}.png`;
    } else {
        ({ png } = await generateLinearBarcodePng(qrCode, linearScale, BARCODE_LABEL_BACKGROUND));
        filename = `${safeName}-1d${sizeSuffix}.png`;
    }
    const labeled = await addNameRow(png, name);
    fs.writeFileSync(path.join(BARCODE_LABEL_DIR, filename), labeled);
    return `/uploads/barcodes/${filename}`;
}

async function main() {
    fs.mkdirSync(BARCODE_LABEL_DIR, { recursive: true });

    const pool = getPool();
    const missingAnyClause = ALL_COLUMNS.map(c => `${c} IS NULL`).join(' OR ');
    const { rows } = await pool.query(
        REBASE_ALL
            ? `SELECT tool_id, qr_code, name FROM tools WHERE status != 'Retired' ORDER BY tool_id ASC`
            : `SELECT tool_id, qr_code, name FROM tools WHERE (${missingAnyClause}) AND status != 'Retired' ORDER BY tool_id ASC`
    );

    if (rows.length === 0) {
        console.log('No tools need backfilling -- every non-retired tool already has all 6 label images.');
        await pool.end();
        return;
    }

    console.log(`${REBASE_ALL ? 'Rebasing' : 'Generating'} barcode labels for ${rows.length} tool(s)...\n`);

    let failures = 0;
    for (const tool of rows) {
        try {
            const urls = {};
            for (const format of ['datamatrix', 'linear']) {
                for (const size of ['small', 'medium', 'large']) {
                    urls[BARCODE_LABEL_COLUMNS[`${format}-${size}`]] = await generateOneLabel(tool.qr_code, tool.name, size, format);
                }
            }
            await pool.query(
                `UPDATE tools SET barcode_image_url = $1, barcode_image_url_small = $2, barcode_image_url_large = $3,
                        linear_barcode_image_url = $4, linear_barcode_image_url_small = $5, linear_barcode_image_url_large = $6
                 WHERE tool_id = $7`,
                [urls.barcode_image_url, urls.barcode_image_url_small, urls.barcode_image_url_large,
                 urls.linear_barcode_image_url, urls.linear_barcode_image_url_small, urls.linear_barcode_image_url_large,
                 tool.tool_id]
            );
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
