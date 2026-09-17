// Generates the extension's PNG icons with zero dependencies (node's zlib is enough
// to emit a valid PNG). Placeholder art: a blue rounded tile with a white "S" cut out
// of it — replace with real artwork whenever you have it.
//
//   node extension/icons/make-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 128];

// Brand colours — keep in step with web/styles.css.
const BG = [37, 99, 235];     // blue-600
const BG2 = [14, 116, 144];   // cyan-700, for the diagonal wash
const FG = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// The glyph: a chunky "S" drawn on a 8x8 grid, scaled to the icon.
const GLYPH = [
  "..######",
  ".###..##",
  ".###....",
  "..#####.",
  "....###.",
  "....###.",
  "##..###.",
  "######..",
];

function pixel(size, x, y) {
  const r = size * 0.18;          // corner radius
  const inset = size * 0.06;
  const gx = x - inset;
  const gy = y - inset;
  const inner = size - inset * 2;

  // Rounded-rect mask; outside the tile is fully transparent.
  const cx = Math.min(Math.max(gx, r), inner - r);
  const cy = Math.min(Math.max(gy, r), inner - r);
  const outside = gx < 0 || gy < 0 || gx >= inner || gy >= inner
    || Math.hypot(gx - cx, gy - cy) > r;
  if (outside) return [0, 0, 0, 0];

  // Glyph area: centred square covering ~62% of the tile.
  const cell = inner * 0.62 / 8;
  const originX = inset + (inner - cell * 8) / 2;
  const originY = inset + (inner - cell * 8) / 2;
  const col = Math.floor((x - originX) / cell);
  const row = Math.floor((y - originY) / cell);
  if (row >= 0 && row < 8 && col >= 0 && col < 8 && GLYPH[row][col] === "#") {
    return [...FG, 255];
  }

  // Diagonal wash from BG to BG2 so the tile does not look flat at 128px.
  const t = (gx + gy) / (inner * 2);
  return [
    Math.round(BG[0] + (BG2[0] - BG[0]) * t),
    Math.round(BG[1] + (BG2[1] - BG[1]) * t),
    Math.round(BG[2] + (BG2[2] - BG[2]) * t),
    255,
  ];
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;   // filter type 0 (none)
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(size, x + 0.5, y + 0.5);
      const at = y * stride + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const file = join(HERE, `bluespite-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
