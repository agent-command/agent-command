#!/usr/bin/env node
/**
 * Converts the C&C Generals animated cursors (RIFF "ACON" .ani files in assets/cursors-src/) into static PNG cursors
 * for CSS: the first frame of each animation (with its CUR hotspot) at 1x and 2x (nearest neighbour, so pixel art
 * stays crisp on HiDPI). Writes public/cursors/<name>.png and <name>@2x.png, plus src/cursor-hotspots.ts (hotspots
 * per cursor, imported by src/cursors.ts). Run with `node apps/web/scripts/cursors.mjs` after changing the source
 * files; the outputs are committed.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'assets/cursors-src');
const OUT = join(root, 'public/cursors');

/** First icon frame of an ANI file (RIFF ACON → LIST fram → icon chunks), as the raw bytes of a .cur/.ico file. */
export function firstFrame(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'ACON') throw new Error('not an ANI file');
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'LIST' && buf.toString('ascii', p + 8, p + 12) === 'fram') {
      let q = p + 12;
      while (q + 8 <= p + 8 + size) {
        const cid = buf.toString('ascii', q, q + 4);
        const csize = buf.readUInt32LE(q + 4);
        if (cid === 'icon') return buf.subarray(q + 8, q + 8 + csize);
        q += 8 + csize + (csize & 1);
      }
    }
    p += 8 + size + (size & 1); // RIFF chunks are word-aligned
  }
  throw new Error('no icon frame');
}

/** Decodes the first image of a .cur/.ico file into RGBA, with the cursor hotspot. */
export function decodeCur(cur) {
  const type = cur.readUInt16LE(2); // 1 icon, 2 cursor
  const entry = 6;
  let hx = type === 2 ? cur.readUInt16LE(entry + 4) : 0;
  let hy = type === 2 ? cur.readUInt16LE(entry + 6) : 0;
  const size = cur.readUInt32LE(entry + 8);
  const off = cur.readUInt32LE(entry + 12);
  const img = cur.subarray(off, off + size);
  if (img.readUInt32BE(0) === 0x89504e47) return { png: img, hx, hy }; // PNG-compressed frame
  // BITMAPINFOHEADER DIB: height covers the XOR (colour) bitmap plus the AND (transparency) mask, bottom-up rows.
  const hdr = img.readUInt32LE(0);
  const w = img.readInt32LE(4);
  const h = img.readInt32LE(8) / 2;
  const bpp = img.readUInt16LE(14);
  const used = img.readUInt32LE(32);
  const colors = bpp <= 8 ? used || 1 << bpp : 0;
  const palette = hdr;
  const xor = palette + colors * 4;
  const xorStride = Math.ceil((w * bpp) / 32) * 4;
  const and = xor + xorStride * h;
  const andStride = Math.ceil(w / 32) * 4;
  const rgba = Buffer.alloc(w * h * 4);
  let alphaSeen = false;
  for (let y = 0; y < h; y++) {
    const row = xor + (h - 1 - y) * xorStride;
    const mrow = and + (h - 1 - y) * andStride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b, a = 255;
      if (bpp === 32) {
        b = img[row + x * 4]; g = img[row + x * 4 + 1]; r = img[row + x * 4 + 2]; a = img[row + x * 4 + 3];
        if (a) alphaSeen = true;
      } else if (bpp === 24) {
        b = img[row + x * 3]; g = img[row + x * 3 + 1]; r = img[row + x * 3 + 2];
      } else {
        const bit = x * bpp;
        const byte = img[row + (bit >> 3)];
        const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const c = palette + idx * 4;
        b = img[c]; g = img[c + 1]; r = img[c + 2];
      }
      const masked = (img[mrow + (x >> 3)] >> (7 - (x & 7))) & 1;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = bpp === 32 ? a : masked ? 0 : 255;
    }
  }
  // 32-bit frames without any alpha fall back to the AND mask.
  if (bpp === 32 && !alphaSeen)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const masked = (img[and + (h - 1 - y) * andStride + (x >> 3)] >> (7 - (x & 7))) & 1;
      rgba[(y * w + x) * 4 + 3] = masked ? 0 : 255;
    }
  return { rgba, w, h, hx, hy };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const meta = {};
  for (const file of (await readdir(SRC)).filter((f) => f.toLowerCase().endsWith('.ani')).sort()) {
    const name = basename(file, '.ani').toLowerCase();
    const frame = decodeCur(firstFrame(await readFile(join(SRC, file))));
    const base = frame.png ? sharp(frame.png) : sharp(frame.rgba, { raw: { width: frame.w, height: frame.h, channels: 4 } });
    const { width } = await base.clone().metadata().then((m) => (frame.png ? m : { width: frame.w }));
    await base.clone().png().toFile(join(OUT, `${name}.png`));
    await base.clone().resize(width * 2, null, { kernel: 'nearest' }).png().toFile(join(OUT, `${name}@2x.png`));
    meta[name] = { x: frame.hx, y: frame.hy, size: width };
    console.log(`${file} → ${name}.png ${width}px hotspot ${frame.hx},${frame.hy}`);
  }
  const lines = Object.entries(meta).map(([k, v]) => `  ${k}: { x: ${v.x}, y: ${v.y} },`).join('\n');
  await writeFile(
    join(root, 'src/cursor-hotspots.ts'),
    `/** Generated by scripts/cursors.mjs from assets/cursors-src/*.ani: hotspot (CSS px, 1x image) per cursor. */\n` +
      `export const CURSOR_HOTSPOTS = {\n${lines}\n} as const;\nexport type CursorName = keyof typeof CURSOR_HOTSPOTS;\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
