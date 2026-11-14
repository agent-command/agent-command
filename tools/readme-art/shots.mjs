// Converts raw 1920×1080 README captures to JPEG (mozjpeg q80, ≤ 1600 px wide), optionally cropped.
// Usage: node tools/readme-art/shots.mjs <rawDir> [outDir=docs/media]
// Captures are taken headlessly against a dev server (`?renderer=webgl&debug`, framed with window.__agentCommand).
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
  'commanders.jpg': { src: 'commanders2.png' },
  'console.jpg': { src: 'console.png' },
  'fight.jpg': { src: 'fight-b.png' },
  'depths.jpg': { src: 'depths.png' },
  'sky.jpg': { src: 'sky2.png' },
  'orbit.jpg': { src: 'orbit2.png' },
  'stack.jpg': { src: 'stack2.png' },
  'placement.jpg': { src: 'place2.png' },
  'command-card.jpg': { src: 'cmdcard.png', crop: { left: 505, top: 875, width: 980, height: 200 } },
  'observer.jpg': { src: 'observer2.png' },
};

for (const [name, { src, crop }] of Object.entries(SHOTS)) {
  let img = sharp(`${raw}/${src}`);
  if (crop) img = img.extract(crop);
  const info = await img.resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(`${out}/${name}`);
  console.log(name, `${info.width}×${info.height}`, Math.round(info.size / 1024), 'KiB');
}
