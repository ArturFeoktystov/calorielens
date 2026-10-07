// When was a photo taken? Reads DateTimeOriginal from a JPEG's EXIF block, so a meal picked from
// the album lands on the day it was eaten. Returns null when the file has no usable date.

const EXIF_READ_BYTES = 256 * 1024; // the EXIF block sits at the start of the file

export async function photoTakenAt(file) {
  try {
    return parseExifDate(await file.slice(0, EXIF_READ_BYTES).arrayBuffer());
  } catch {
    return null;
  }
}

export function parseExifDate(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

  // Walk the JPEG segments to APP1 "Exif".
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) { // "Exif"
      return readTiff(view, offset + 10);
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // image data started
    offset += 2 + length;
  }
  return null;
}

function readTiff(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949; // "II"
  const u16 = (at) => view.getUint16(at, little);
  const u32 = (at) => view.getUint32(at, little);

  // Returns { tag: valueOffsetFieldPosition } for one IFD.
  const readIfd = (ifdOffset) => {
    const start = tiff + ifdOffset;
    const tags = {};
    const count = u16(start);
    for (let i = 0; i < count; i++) {
      const entry = start + 2 + i * 12;
      tags[u16(entry)] = entry + 8;
    }
    return tags;
  };
  const ascii = (field) => {
    const at = tiff + u32(field); // a 20-byte date never fits inline, so this is an offset
    let text = "";
    for (let i = 0; i < 19; i++) text += String.fromCharCode(view.getUint8(at + i));
    return text;
  };

  const ifd0 = readIfd(u32(tiff + 4));
  const exif = ifd0[0x8769] ? readIfd(u32(ifd0[0x8769])) : {};
  const field = exif[0x9003] ?? exif[0x9004] ?? ifd0[0x0132]; // DateTimeOriginal, Digitized, DateTime
  return field ? toDate(ascii(field)) : null;
}

// "2026:10:05 19:42:10" in the camera's local time.
function toDate(text) {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) || y < 2000 ? null : date;
}
