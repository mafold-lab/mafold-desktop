// The Windows taskbar has no badge count — `app.setBadgeCount` is macOS/Linux
// only — so on Windows the number is drawn into a small overlay icon
// (`BrowserWindow.setOverlayIcon`). That needs a PNG at runtime, and pulling an
// image library into the main process for a red dot with a digit in it would
// be the wrong trade: this file draws it with a 5×7 digit font and encodes the
// PNG with node's own zlib.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Encode straight RGBA (row-major, 4 bytes per pixel) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error("rgba size mismatch");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression, filter, interlace = 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 5×7 glyphs, one string per row, `#` = ink.
const GLYPHS: Record<string, string[]> = {
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": [" ### ", "#   #", "    #", "  ## ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": [" ### ", "#    ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", "  #  ", "  #  ", "  #  "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "    #", " ### "],
  "+": ["     ", "  #  ", "  #  ", "#####", "  #  ", "  #  ", "     "],
};

/** What the overlay says: the count up to 9, then "9+". Empty for zero. */
export const badgeText = (count: number): string =>
  !Number.isFinite(count) || count <= 0 ? "" : count > 9 ? "9+" : String(Math.floor(count));

/** A red disc with white text, `size`×`size`, as straight RGBA. */
export function renderBadge(text: string, size = 32): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = size / 2;
  const SS = 4; // supersampling for the disc edge
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - r;
          const dy = y + (sy + 0.5) / SS - r;
          if (dx * dx + dy * dy <= (r - 0.5) * (r - 0.5)) cover++;
        }
      }
      const i = (y * size + x) * 4;
      px[i] = 0xe5;
      px[i + 1] = 0x48;
      px[i + 2] = 0x4d;
      px[i + 3] = Math.round((cover / (SS * SS)) * 255);
    }
  }
  const glyphs = [...text].map((c) => GLYPHS[c]).filter(Boolean);
  if (glyphs.length === 0) return px;
  // One glyph is drawn big; two share the width.
  const scale = glyphs.length === 1 ? Math.floor(size / 10) * 2 : Math.max(1, Math.floor(size / 14));
  const gap = scale;
  const w = glyphs.length * 5 * scale + (glyphs.length - 1) * gap;
  const h = 7 * scale;
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  glyphs.forEach((rows, gi) => {
    rows.forEach((row, ry) => {
      [...row].forEach((ch, rx) => {
        if (ch !== "#") return;
        for (let yy = 0; yy < scale; yy++) {
          for (let xx = 0; xx < scale; xx++) {
            const x = ox + gi * (5 * scale + gap) + rx * scale + xx;
            const y = oy + ry * scale + yy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = 0xff;
            px[i + 3] = 0xff;
          }
        }
      });
    });
  });
  return px;
}

export const badgePng = (count: number, size = 32): Buffer | null => {
  const text = badgeText(count);
  return text ? encodePng(size, size, renderBadge(text, size)) : null;
};
