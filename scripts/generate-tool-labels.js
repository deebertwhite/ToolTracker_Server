// ==========================================
// Data Matrix label generator
// ==========================================
// Free, offline, one-time utility: reads every non-retired tool's qr_code straight out of
// the live database and renders a Data Matrix code for each one, so the printed/engraved
// codes can never drift out of sync with what's actually in the system.
//
// Produces two formats per tool:
//   tool_labels/png/<qr_code>.png -- for printing on adhesive labels
//   tool_labels/svg/<qr_code>.svg -- vector, for importing into laser engraving software
//                                    (LightBurn etc.) at an exact real-world size
//
// Uses bwip-js (pure JS, no native build step, MIT licensed -- no cost, no external service).
// Run again any time to regenerate everything (e.g. after adding new tools) -- it always
// overwrites, it does not append.
//
// IMPORTANT: before engraving/printing a full batch, run generate-size-test-sheet.js first
// and physically confirm your chosen size scans reliably with your actual camera/lighting.
//
// Usage: node scripts/generate-tool-labels.js [target-size-mm]
//   (defaults to 15mm if not given -- pass a size confirmed via the size-test sheet)

const fs = require('fs');
const path = require('path');
const { getPool } = require('./lib/db');
const { generatePngAtSize, generateSvgAtSize } = require('./lib/datamatrix');

const OUTPUT_DIR = path.join(__dirname, '..', 'tool_labels');
const PNG_DIR = path.join(OUTPUT_DIR, 'png');
const SVG_DIR = path.join(OUTPUT_DIR, 'svg');
const TARGET_SIZE_MM = parseFloat(process.argv[2]) || 15;
const PNG_DPI = 1200; // high resolution so the requested mm size rounds to an accurate pixel count, and is embedded in the PNG itself (see withPhysicalDpi) so "print at 100%" is correct

const pool = getPool();

async function main() {
    fs.mkdirSync(PNG_DIR, { recursive: true });
    fs.mkdirSync(SVG_DIR, { recursive: true });

    const result = await pool.query(
        `SELECT qr_code, name, serial_number FROM tools WHERE status != 'Retired' ORDER BY qr_code ASC`
    );
    await pool.end();

    if (result.rows.length === 0) {
        console.log('No non-retired tools found -- nothing to generate.');
        return;
    }

    console.log(`Generating at ${TARGET_SIZE_MM}mm (PNG @ ${PNG_DPI} DPI, SVG as exact vector mm) -- pass a different size as an argument, e.g. "node scripts/generate-tool-labels.js 10".\n`);

    const manifestLines = ['qr_code,name,serial_number,requested_mm,actual_code_mm,png_file,svg_file'];

    for (const tool of result.rows) {
        const safeName = tool.qr_code.replace(/[^A-Za-z0-9_-]/g, '_');
        const pngFile = `${safeName}.png`;
        const svgFile = `${safeName}.svg`;

        const { png, actualCodeMm } = await generatePngAtSize(tool.qr_code, TARGET_SIZE_MM, PNG_DPI);
        fs.writeFileSync(path.join(PNG_DIR, pngFile), png);

        const { svg } = await generateSvgAtSize(tool.qr_code, TARGET_SIZE_MM);
        fs.writeFileSync(path.join(SVG_DIR, svgFile), svg);

        manifestLines.push([tool.qr_code, `"${(tool.name || '').replace(/"/g, '""')}"`, tool.serial_number || '', TARGET_SIZE_MM, actualCodeMm.toFixed(2), pngFile, svgFile].join(','));
        console.log(`Generated ${pngFile} / ${svgFile}  (${tool.name}) -- code is ${actualCodeMm.toFixed(2)}mm`);
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.csv'), manifestLines.join('\n'));
    console.log(`\nDone. ${result.rows.length} label(s) written to:`);
    console.log(`  ${PNG_DIR}  (print these on label sheets at 100% / actual size -- do not use "fit to page")`);
    console.log(`  ${SVG_DIR}  (import these into laser engraving software -- they carry their own exact mm size)`);
    console.log(`A manifest.csv was written alongside them for reference.`);
}

main().catch(err => {
    console.error('Label generation failed:', err);
    process.exit(1);
});
