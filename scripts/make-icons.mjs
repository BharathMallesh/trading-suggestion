#!/usr/bin/env node
// Draws the home-screen app icon (indigo tile, white rising chart line) as PNGs
// in static/: icon-180.png (iPhone), icon-192.png and icon-512.png (Android).
// No dependencies: rasterised here, PNG written with zlib.
//   node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [79, 91, 213]; // #4f5bd5
  const bg2 = [99, 72, 196]; // gradient end
  // chart: rising line with a dip, in tile coordinates 0..1
  const pts = [[0.18, 0.72], [0.38, 0.5], [0.52, 0.6], [0.8, 0.28]];
  const lineW = 0.065;
  const distSeg = (x, y, [ax, ay], [bx, by]) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  const S = 4; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let white = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          let d = Infinity;
          for (let k = 1; k < pts.length; k++) d = Math.min(d, distSeg(u, v, pts[k - 1], pts[k]));
          // arrow head dot at the end + baseline
          const dot = Math.hypot(u - pts[3][0], v - pts[3][1]) < lineW * 1.1;
          const base = v > 0.8 && v < 0.8 + lineW * 0.55 && u > 0.16 && u < 0.84;
          if (d < lineW / 2 || dot || base) white++;
        }
      }
      const a = white / (S * S);
      const g = (x + y) / (2 * size);
      const c = bg.map((b, i) => Math.round(b + (bg2[i] - b) * g));
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(c[i] * (1 - a) + 255 * a);
      px[o + 3] = 255; // full-bleed square: phones round the corners themselves
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const n of [180, 192, 512]) writeFileSync(new URL(`../static/icon-${n}.png`, import.meta.url), icon(n));
console.log('Wrote static/icon-180.png, icon-192.png, icon-512.png');
