// Converts raw 1920×1080 README captures to JPEG (mozjpeg q80, ≤ 1600 px wide), optionally cropped.
// Usage: node tools/readme-art/shots.mjs <rawDir> [outDir=docs/media]
// Captures come from tools/readme-art/capture.mjs (headless WebGL2 against an isolated dev server, scenes in scenes.mjs).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nm = `${root}node_modules/.pnpm`;
const dir = readdirSync(nm).find((d) => d.startsWith('sharp@'));
if (!dir) throw new Error(`missing sharp in ${nm}: run pnpm install`);
const { default: sharp } = await import(`${nm}/${dir}/node_modules/sharp/dist/index.mjs`);

const [raw, out = `${root}docs/media`] = process.argv.slice(2);
if (!raw) throw new Error('usage: node tools/readme-art/shots.mjs <rawDir> [outDir]');

/** README image → raw capture (PNG in rawDir) and an optional crop in capture pixels. */
const SHOTS = {
  'home.jpg': { src: 'home.png' },
  'create-game.jpg': { src: 'create-game-bot.png' },
  'commanders.jpg': { src: 'commanders.png' },
  'console.jpg': { src: 'console.png' },
  'fight.jpg': { src: 'fight.png' },
  'depths.jpg': { src: 'depths.png' },
  'sky.jpg': { src: 'sky.png' },
  'orbit.jpg': { src: 'orbit.png' },
  'stack.jpg': { src: 'stack.png' },
  'placement.jpg': { src: 'place2.png' },
  'command-card.jpg': { src: 'fight.png', crop: { left: 504, top: 872, width: 980, height: 204 } },
  'observer.jpg': { src: 'observer.png' },
};

for (const [name, { src, crop }] of Object.entries(SHOTS)) {
  let img = sharp(`${raw}/${src}`);
  if (crop) img = img.extract(crop);
  const info = await img.resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(`${out}/${name}`);
  console.log(name, `${info.width}×${info.height}`, Math.round(info.size / 1024), 'KiB');
}
