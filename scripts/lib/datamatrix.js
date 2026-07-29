// Shared Data Matrix rendering helpers used by generate-tool-labels.js and
// generate-size-test-sheet.js. Kept in one place so both scripts compute
// physical sizing the exact same way.

const bwipjs = require('bwip-js');

const MM_PER_INCH = 25.4;

// Common options needed to make bwip-js actually print the human-readable text
// under a Data Matrix symbol. includetext alone silently does nothing for 2D
// symbologies in bwip-js -- alttext must also be set to the same value.
function textOptions(text) {
    return { includetext: true, alttext: text, textxalign: 'center', textsize: 9 };
}

// Renders at scale:1 with zero padding, so the resulting pixel dimensions are
// exactly the pure code's module grid size (including bwip-js's built-in quiet
// zone), with no human-readable text row included.
async function getModuleGridSize(text) {
    const png = await bwipjs.toBuffer({ bcid: 'datamatrix', text, scale: 1, paddingwidth: 0, paddingheight: 0 });
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// --- Standard CRC32 (used by the PNG chunk format) -- Node has no built-in CRC32. ---
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Inserts a pHYs chunk (physical pixel density) into a raw PNG buffer, right after
 * IHDR, so image viewers/print dialogs that respect DPI metadata (Photoshop, GIMP,
 * most OS print-preview panes) print/display it at the correct real-world size when
 * the user picks "actual size" / 100%, instead of falling back to some arbitrary
 * default (commonly 96 DPI) that would silently make the code the wrong physical size.
 * bwip-js does not expose an option for this, so it's done here by hand -- pHYs is a
 * standard, well-documented PNG chunk, not a hack.
 */
function withPhysicalDpi(pngBuffer, dpi) {
    const pixelsPerMeter = Math.round(dpi / 0.0254);
    const data = Buffer.alloc(9);
    data.writeUInt32BE(pixelsPerMeter, 0); // pixels per unit, X
    data.writeUInt32BE(pixelsPerMeter, 4); // pixels per unit, Y
    data.writeUInt8(1, 8);                 // unit specifier: 1 = meters

    const typeAndData = Buffer.concat([Buffer.from('pHYs', 'ascii'), data]);
    const chunk = Buffer.concat([
        Buffer.alloc(4), // length, filled below
        typeAndData,
        Buffer.alloc(4), // CRC, filled below
    ]);
    chunk.writeUInt32BE(data.length, 0);
    chunk.writeUInt32BE(crc32(typeAndData), chunk.length - 4);

    // PNG structure: 8-byte signature, then IHDR chunk (length+type+data+crc = 8+13+4=25 bytes).
    // pHYs is valid anywhere before the first IDAT; inserting right after IHDR is conventional.
    const IHDR_END = 8 + 25;
    return Buffer.concat([pngBuffer.subarray(0, IHDR_END), chunk, pngBuffer.subarray(IHDR_END)]);
}

/**
 * Generates a PNG whose Data Matrix module grid is sized as close as possible to
 * targetMm x targetMm at the given DPI (any human-readable text row, if enabled,
 * adds extra height beyond that -- it never affects module scale/scannability).
 * bwip-js's `scale` is an integer pixels-per-module, so the achievable size is
 * rounded to the nearest whole step -- the actual resulting size is always
 * returned alongside the requested one so callers can report it honestly. A high
 * default DPI (1200) is used specifically so that step is fine-grained enough to
 * tell small sizes like 6mm and 8mm apart -- at 300 DPI they can round to the exact
 * same pixel count and produce identical output, which defeats the point of a
 * size-comparison test. The resulting PNG also carries a pHYs chunk (see
 * withPhysicalDpi) so "print at 100%" actually reflects the requested size.
 *
 * `padding` (bwip-js module units, applied symmetrically on all sides, default 0) is
 * deliberately left at 0 for the existing print/engrave callers below, which are
 * calibrated for exact physical code sizing and where extra padding would either
 * enlarge the physical label or shrink the code to compensate -- neither desirable for
 * something meant to be engraved at a confirmed-scannable size. A caller generating a
 * label purely for on-screen viewing (see generateBarcodeLabel() in server.js) can pass
 * a positive value for clearer breathing room around the code and its human-readable ID.
 */
async function generatePngAtSize(text, targetMm, dpi = 1200, withText = true, padding = 0) {
    const grid = await getModuleGridSize(text);
    const targetPx = (targetMm / MM_PER_INCH) * dpi;
    const scale = Math.max(1, Math.round(targetPx / grid.width));
    const opts = { bcid: 'datamatrix', text, scale, paddingwidth: padding, paddingheight: padding };
    if (withText) Object.assign(opts, textOptions(text));
    const rawPng = await bwipjs.toBuffer(opts);
    const png = withPhysicalDpi(rawPng, dpi);
    const actualCodeMm = (grid.width * scale / dpi) * MM_PER_INCH; // size of the scannable code itself, excluding any text row or padding
    return { png, dpi, scale, requestedMm: targetMm, actualCodeMm };
}

/**
 * Generates an SVG whose Data Matrix CODE (not the overall canvas) measures targetMm
 * wide, by injecting width/height into bwip-js's raw viewBox-only SVG output.
 *
 * Important: when a text row is included, bwip-js widens the whole canvas to fit the
 * text if the text is wider than the code (very common at small sizes -- e.g. "AVI-000001"
 * needs more horizontal room than a 10mm code does). If width/height were set to
 * targetMm directly on that wider viewBox, the uniform scaling would shrink the CODE
 * itself below the requested size to make the wider canvas fit -- exactly the opposite
 * of what a precise engraving size needs. So the scale factor here is always derived
 * from the pure code grid width (no text), then applied to the actual viewBox
 * dimensions -- the code always ends up exactly targetMm, and the overall label may end
 * up wider than that if text needs the room, which is scaled proportionally rather than
 * silently making the code smaller.
 */
async function generateSvgAtSize(text, targetMm, withText = true) {
    const grid = await getModuleGridSize(text); // pure code width in the same units as the viewBox below, text-free

    const opts = { bcid: 'datamatrix', text, scale: 1, paddingwidth: 0, paddingheight: 0 };
    if (withText) Object.assign(opts, textOptions(text));
    const rawSvg = await bwipjs.toSVG(opts);

    const viewBoxMatch = rawSvg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    if (!viewBoxMatch) throw new Error('Could not parse viewBox from bwip-js SVG output.');
    const viewBoxWidth = parseFloat(viewBoxMatch[1]);
    const viewBoxHeight = parseFloat(viewBoxMatch[2]);

    const scaleFactor = targetMm / grid.width; // mm per SVG unit, anchored to the CODE's width, not the (possibly text-widened) canvas
    const widthMm = viewBoxWidth * scaleFactor;
    const heightMm = viewBoxHeight * scaleFactor;

    const sized = rawSvg.replace('<svg ', `<svg width="${widthMm.toFixed(2)}mm" height="${heightMm.toFixed(2)}mm" `);
    return { svg: sized, widthMm, heightMm, codeWidthMm: targetMm };
}

module.exports = { getModuleGridSize, generatePngAtSize, generateSvgAtSize, textOptions };
