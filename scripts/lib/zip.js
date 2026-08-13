// Minimal ZIP writer -- STORE method only (no compression). Every file this app zips (barcode
// label PNGs) is already compressed at the image format level, so deflating it again inside
// the zip would cost CPU for essentially no size benefit. The ZIP format itself is a small,
// stable, decades-old binary spec -- unlike a general compression scheme, there's nothing
// risky about hand-rolling it -- so this follows the same reasoning as the hand-rolled PNG
// pHYs chunk in datamatrix.js: own the ~100 lines of buffer-writing rather than pull in a
// dependency (archiver/jszip) just to avoid it.
//
// All multi-byte fields in the ZIP format are little-endian (PNG, by contrast, is big-endian).

const { crc32 } = require('./crc32');

const SIG_LOCAL_FILE_HEADER = 0x04034b50;
const SIG_CENTRAL_DIR_HEADER = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

function toDosDateTime(date) {
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

/**
 * Builds a ZIP archive (stored, uncompressed) from a list of entries.
 * @param {Array<{ name: string, data: Buffer }>} files - name is the path inside the archive
 *   (forward slashes for any subfolder); data is the raw file content.
 * @param {Date} [date] - mtime stamped on every entry; defaults to now.
 * @returns {Buffer} the complete .zip file, ready to write to disk or send as a response body
 */
function buildZip(files, date = new Date()) {
    const { dosTime, dosDate } = toDosDateTime(date);
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(SIG_LOCAL_FILE_HEADER, 0);
        localHeader.writeUInt16LE(20, 4);            // version needed to extract (2.0)
        localHeader.writeUInt16LE(0, 6);              // general purpose bit flag
        localHeader.writeUInt16LE(0, 8);              // compression method: stored
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(data.length, 18);   // compressed size (== uncompressed, stored)
        localHeader.writeUInt32LE(data.length, 22);   // uncompressed size
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);              // extra field length
        localParts.push(localHeader, nameBuf, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(SIG_CENTRAL_DIR_HEADER, 0);
        centralHeader.writeUInt16LE(20, 4);           // version made by
        centralHeader.writeUInt16LE(20, 6);           // version needed to extract
        centralHeader.writeUInt16LE(0, 8);            // general purpose bit flag
        centralHeader.writeUInt16LE(0, 10);           // compression method
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(data.length, 20); // compressed size
        centralHeader.writeUInt32LE(data.length, 24); // uncompressed size
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(0, 30);           // extra field length
        centralHeader.writeUInt16LE(0, 32);           // file comment length
        centralHeader.writeUInt16LE(0, 34);           // disk number start
        centralHeader.writeUInt16LE(0, 36);           // internal file attributes
        centralHeader.writeUInt32LE(0, 38);           // external file attributes
        centralHeader.writeUInt32LE(offset, 42);      // relative offset of this entry's local header
        centralParts.push(centralHeader, nameBuf);

        offset += localHeader.length + nameBuf.length + data.length;
    }

    const centralDirStart = offset;
    const centralDir = Buffer.concat(centralParts);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END_OF_CENTRAL_DIR, 0);
    end.writeUInt16LE(0, 4);                    // number of this disk
    end.writeUInt16LE(0, 6);                    // disk where central directory starts
    end.writeUInt16LE(files.length, 8);         // central dir records on this disk
    end.writeUInt16LE(files.length, 10);        // total central dir records
    end.writeUInt32LE(centralDir.length, 12);   // size of central directory
    end.writeUInt32LE(centralDirStart, 16);     // offset of start of central directory
    end.writeUInt16LE(0, 20);                   // comment length

    return Buffer.concat([...localParts, centralDir, end]);
}

module.exports = { buildZip };
