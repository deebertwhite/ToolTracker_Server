// ==========================================
// Data Matrix size-test sheet generator
// ==========================================
// Generates ONE real tool's code at several candidate physical sizes, as both PNG
// (print on paper/label stock) and SVG (import into laser engraving software), so you
// can physically test-scan each size with your actual kiosk/admin camera and lighting
// BEFORE committing to a size for the full tool batch.
//
// Uses a real code already in your database (not a dummy value) so a successful test
// scan is a genuine end-to-end confirmation, not just a decode of arbitrary text.
//
// Usage: node scripts/generate-size-test-sheet.js [qr_code]
//   (defaults to the first non-retired tool alphabetically if no code is given)

const fs = require('fs');
const path = require('path');
const { getPool } = require('./lib/db');
const { generatePngAtSize, generateSvgAtSize } = require('./lib/datamatrix');

const OUTPUT_DIR = path.join(__dirname, '..', 'tool_labels', 'size_test');
const CANDIDATE_SIZES_MM = [20, 15, 12, 10, 8, 6, 5, 4, 3];
// Sizes below ~5mm run into a different constraint than pure resolution: most phone rear
// cameras have a minimum focus distance (commonly 5-10cm even with autofocus). A code
// that small requires getting close enough to fill the frame adequately for decoding --
// if that required distance is closer than the camera can actually focus at, it'll be
// blurry no matter how good the camera is. That's a real physical limit worth hitting
// during this test, not just a resolution number to calculate.
const PNG_DPI = 1200; // high resolution so small mm differences (e.g. 6mm vs 8mm) round to visibly distinct pixel counts

const pool = getPool();

async function main() {
    const requestedCode = process.argv[2];
    let qrCode, toolName;

    if (requestedCode) {
        const res = await pool.query(`SELECT qr_code, name FROM tools WHERE qr_code = $1`, [requestedCode]);
        await pool.end();
        if (res.rows.length === 0) { console.error(`No tool found with qr_code "${requestedCode}".`); process.exit(1); }
        ({ qr_code: qrCode, name: toolName } = res.rows[0]);
    } else {
        const res = await pool.query(`SELECT qr_code, name FROM tools WHERE status != 'Retired' ORDER BY qr_code ASC LIMIT 1`);
        await pool.end();
        if (res.rows.length === 0) { console.error('No non-retired tools found in the database.'); process.exit(1); }
        ({ qr_code: qrCode, name: toolName } = res.rows[0]);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`Using real tool code "${qrCode}" (${toolName}) for the size test.\n`);

    const readmeLines = [
        `Data Matrix size test sheet -- code used: ${qrCode} (${toolName})`,
        ``,
        `HOW TO USE THIS:`,
        `1. Print the PNG files at 100% / "actual size" (NOT "fit to page" -- that will silently`,
        `   change the physical size and invalidate the test). Or import the SVG files into your`,
        `   laser engraving software at 1:1 scale and engrave one of each on scrap material.`,
        `2. Under your actual shop lighting, scan each size with the real kiosk or admin camera`,
        `   (not a phone camera at a desk -- test with the actual hardware/distance you'll use).`,
        `3. Note the smallest size that scans reliably on the FIRST try, more than once, from a`,
        `   normal handheld distance -- that's your practical minimum, with a safety margin.`,
        `4. Re-run generate-tool-labels.js with that size, e.g.:`,
        `     node scripts/generate-tool-labels.js 10`,
        ``,
        `Files in this folder (both PNG and SVG generated per size):`,
    ];

    for (const sizeMm of CANDIDATE_SIZES_MM) {
        const safeSize = String(sizeMm).replace('.', '_');

        const { png, actualCodeMm } = await generatePngAtSize(qrCode, sizeMm, PNG_DPI);
        const pngFile = `test_${safeSize}mm.png`;
        fs.writeFileSync(path.join(OUTPUT_DIR, pngFile), png);

        const { svg, widthMm, heightMm, codeWidthMm } = await generateSvgAtSize(qrCode, sizeMm);
        const svgFile = `test_${safeSize}mm.svg`;
        fs.writeFileSync(path.join(OUTPUT_DIR, svgFile), svg);

        readmeLines.push(`  ${sizeMm}mm requested -> ${pngFile} (code renders at ${actualCodeMm.toFixed(2)}mm @ ${PNG_DPI} DPI), ${svgFile} (code is exactly ${codeWidthMm}mm; overall file with text label is ${widthMm.toFixed(2)}mm x ${heightMm.toFixed(2)}mm)`);
        console.log(`Generated ${sizeMm}mm test files (PNG code ~${actualCodeMm.toFixed(2)}mm, SVG code exactly ${codeWidthMm}mm, overall SVG ${widthMm.toFixed(2)}mm wide)`);
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, 'README.txt'), readmeLines.join('\n'));
    console.log(`\nDone. Test files written to: ${OUTPUT_DIR}`);
    console.log(`Read README.txt in that folder for how to run the physical test.`);
}

main().catch(err => {
    console.error('Size-test sheet generation failed:', err);
    process.exit(1);
});
