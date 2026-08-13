// Shared Data Matrix rendering helpers used by generate-tool-labels.js and
// generate-size-test-sheet.js. Kept in one place so both scripts compute
// physical sizing the exact same way.

const bwipjs = require('bwip-js');
const sharp = require('sharp');
const { crc32 } = require('./crc32');

const MM_PER_INCH = 25.4;

// Common options needed to make bwip-js actually print the human-readable text
// under a Data Matrix symbol. includetext alone silently does nothing for 2D
// symbologies in bwip-js -- alttext must also be set to the same value.
//
// textYOffset (bwip-js "points", optional) overrides bwip-js's own default vertical gap
// between the code and this text row, which visually reads as the text nearly touching the
// code -- confirmed too tight for on-screen viewing (see generateBarcodeLabel() in
// server.js). Positive values move the text UP (toward/into the code); more negative moves
// it DOWN, away from the code. Left undefined for the print/engrave callers below, which
// keep bwip-js's own default so their already-confirmed-scannable physical sizing/layout
// stays exactly as calibrated.
function textOptions(text, textYOffset) {
    const opts = { includetext: true, alttext: text, textxalign: 'center', textsize: 9 };
    if (textYOffset !== undefined) opts.textyoffset = textYOffset;
    return opts;
}

// Renders at scale:1 with zero padding, so the resulting pixel dimensions are
// exactly the pure code's module grid size (including bwip-js's built-in quiet
// zone), with no human-readable text row included.
async function getModuleGridSize(text) {
    const png = await bwipjs.toBuffer({ bcid: 'datamatrix', text, scale: 1, paddingwidth: 0, paddingheight: 0 });
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
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
 *
 * `textYOffset` (bwip-js "points", optional) is passed straight through to textOptions() --
 * see its comment there. Left undefined preserves bwip-js's own default gap exactly as
 * every existing caller already relies on.
 *
 * `backgroundColor` (hex, no '#', optional) makes bwip-js render an opaque fill instead of
 * its own default: a fully TRANSPARENT background (confirmed via the raw alpha channel --
 * every "white" pixel is actually alpha 0, not an opaque white). That's invisible -- not
 * just blank -- on anything but a plain white page, which is exactly why a tool's on-screen
 * barcode label (see generateBarcodeLabel() in server.js) rendered as nothing but the dark
 * modal backdrop when opened in the image lightbox: black modules on a transparent fill,
 * over a near-black overlay, is black-on-black. Left undefined for the print/engrave
 * callers below, which print onto physical white paper/material anyway and where changing
 * pixel format could interact with how engraving software reads the alpha channel --
 * not worth touching without a real reason.
 */
async function generatePngAtSize(text, targetMm, dpi = 1200, withText = true, padding = 0, textYOffset, backgroundColor) {
    const grid = await getModuleGridSize(text);
    const targetPx = (targetMm / MM_PER_INCH) * dpi;
    const scale = Math.max(1, Math.round(targetPx / grid.width));
    const opts = { bcid: 'datamatrix', text, scale, paddingwidth: padding, paddingheight: padding };
    if (backgroundColor !== undefined) opts.backgroundcolor = backgroundColor;
    if (withText) Object.assign(opts, textOptions(text, textYOffset));
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

function escapeXml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Greedy word-wrap into at most maxLines lines of at most maxCharsPerLine characters each.
// If the text still doesn't fit, the last line is truncated with an ellipsis rather than
// silently dropping words -- a shortened-but-honest name beats one that just cuts off.
function wrapText(text, maxCharsPerLine, maxLines) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const allLines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxCharsPerLine) {
            current = candidate;
        } else {
            if (current) allLines.push(current);
            current = word;
        }
    }
    if (current) allLines.push(current);

    if (allLines.length <= maxLines) return allLines;

    const lines = allLines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    if (last.length > maxCharsPerLine - 1) last = last.slice(0, maxCharsPerLine - 1);
    lines[maxLines - 1] = last.trimEnd() + '…';
    return lines;
}

/**
 * Composites a tool name as a second, smaller text row underneath an already-rendered
 * Data Matrix + ID label PNG (see generatePngAtSize). Not done via bwip-js's own
 * `alttext` -- confirmed empirically that an embedded newline there just collapses to a
 * single line rather than stacking, and letting a long name widen bwip-js's own canvas
 * (its normal behavior when text is wider than the code) would blow out the label's
 * on-screen proportions instead of sitting cleanly underneath it. Rendering the name as
 * its own SVG text row and compositing it on with sharp (already a project dependency)
 * gives full control over wrapping/centering instead.
 * @param {Buffer} labelPng - a PNG buffer from generatePngAtSize (code + ID row)
 * @param {string} name - the tool's name; falsy/blank returns labelPng unchanged
 * @returns {Promise<Buffer>} a new PNG, taller than the input by the name row's height
 */
async function addNameRow(labelPng, name) {
    if (!name || !name.trim()) return labelPng;

    const { width, height } = await sharp(labelPng).metadata();

    // Sized relative to the label's own width so it scales with BARCODE_LABEL_SIZE_MM
    // rather than assuming a fixed pixel size -- visually confirmed at the default 15mm/
    // 1200dpi settings to read clearly while staying smaller than the ID row above it.
    const fontSize = Math.round(width * 0.052);
    const lineHeight = Math.round(fontSize * 1.35);
    const maxCharsPerLine = Math.max(6, Math.floor((width * 0.92) / (fontSize * 0.56)));
    const lines = wrapText(name, maxCharsPerLine, 2);
    const topPad = Math.round(fontSize * 0.5);
    const rowHeight = topPad + lineHeight * lines.length;

    const textRows = lines.map((line, i) =>
        `<text x="50%" y="${topPad + i * lineHeight + fontSize * 0.8}" text-anchor="middle" font-family="monospace" font-size="${fontSize}" fill="#000000">${escapeXml(line)}</text>`
    ).join('');
    const nameSvg = `<svg width="${width}" height="${rowHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff"/>${textRows}</svg>`;
    const nameRowPng = await sharp(Buffer.from(nameSvg)).png().toBuffer();

    return sharp(labelPng)
        .extend({ bottom: rowHeight, background: '#ffffff' })
        .composite([{ input: nameRowPng, top: height, left: 0 }])
        .png()
        .toBuffer();
}

module.exports = { getModuleGridSize, generatePngAtSize, generateSvgAtSize, textOptions, addNameRow };
