import test from "node:test";
import assert from "node:assert/strict";
import { parseExifDate } from "./exif.js";

// A minimal JPEG: SOI + APP1 Exif with IFD0 -> Exif IFD -> DateTimeOriginal.
function jpegWithDate(date, little) {
  const tiff = new DataView(new ArrayBuffer(64));
  const u16 = (at, v) => tiff.setUint16(at, v, little);
  const u32 = (at, v) => tiff.setUint32(at, v, little);
  u16(0, little ? 0x4949 : 0x4d4d); u16(2, 42); u32(4, 8);
  u16(8, 1); u16(10, 0x8769); u16(12, 4); u32(14, 1); u32(18, 26); u32(22, 0); // IFD0
  u16(26, 1); u16(28, 0x9003); u16(30, 2); u32(32, 20); u32(36, 44); u32(40, 0); // Exif IFD
  [...date].forEach((c, i) => tiff.setUint8(44 + i, c.charCodeAt(0)));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...new Uint8Array(tiff.buffer)];
  const length = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...app1, 0xff, 0xd9]).buffer;
}

test("reads DateTimeOriginal, big- and little-endian", () => {
  for (const little of [false, true]) {
    const date = parseExifDate(jpegWithDate("2026:10:05 19:42:10", little));
    assert.deepEqual(date, new Date(2026, 9, 5, 19, 42, 10));
  }
});

test("no date for non-JPEG or JPEG without EXIF", () => {
  assert.equal(parseExifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(parseExifDate(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer), null);
});

test("rejects a zeroed date", () => {
  assert.equal(parseExifDate(jpegWithDate("0000:00:00 00:00:00", false)), null);
});
