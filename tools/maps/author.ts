/** Dev-only authoring helper: explicit fixed geometry -> validated canonical JSON documents. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CELL, DEFAULT_RULES, SURFACE, spirePositions, type TerrainPreset } from '../../packages/game/src/rules/contract.ts';
import { createMapDocument, documentFromWorld, buildWorldFromDocument, rotateCell, setMapLayerValues, validateMapDocument, type MapDocument } from '../../packages/game/src/maps/document.ts';
import { mapDescriptor } from '../../packages/game/src/maps/registry.ts';
import { LODE_SEAL, LODE_POCKET } from '../../packages/game/src/maps/world.ts';
import { generateOrbitRegions } from '../../packages/game/src/maps/orbit.ts';

const AUTHORS = [
  { id: 'crossfire', size: 48, sides: 2, preset: 'chokepoint' },
  { id: 'twin_fords', size: 48, sides: 2, preset: 'rivers' },
  { id: 'crown', size: 48, sides: 2, preset: 'fortress' },
  { id: 'four_corners', size: 64, sides: 4, preset: 'highlands' },
] as const;

/** This is authoring geometry, not a random recipe: each named map is a fixed file. */
export function authorClassic(id: (typeof AUTHORS)[number]['id']): MapDocument {
  const spec = AUTHORS.find(entry => entry.id === id)!;
  const descriptor = mapDescriptor(id)!;
  const { size, sides } = spec;
  const width = sides === 2 ? size : size / 2;
  const height = size / 2;
  const metadata = { id, label: descriptor.label, identity: descriptor.identity, seed: 0, size, sides, spireInset: 3, preset: spec.preset as TerrainPreset };
  const document = createMapDocument(metadata);
  const surface = Array<number>(width * height).fill(SURFACE.ground);
  for (let y = 1; y < height; y++) for (let x = 1; x < width; x++) {
    const u = (x + y + 1 - size) / Math.SQRT2;
    const v = (x - y) / Math.SQRT2;
    let code: number = SURFACE.ground;
    if (id === 'crossfire') {
      if (Math.abs(u) < 1 && Math.abs(v) > 1.5 && Math.abs(v) < 18) code = SURFACE.cliff;
      else if (Math.abs(u) < 6 && Math.abs(v) < 8) code = SURFACE.high;
    } else if (id === 'twin_fords') {
      if (Math.abs(u) < 2) code = Math.abs(Math.abs(v) - 10) <= 2 ? SURFACE.ford : SURFACE.water;
      else if (Math.abs(u) < 5 && Math.abs(v) < 6) code = SURFACE.forest;
    } else if (id === 'crown') {
      const radius = Math.hypot(u, v);
      if (radius < 8) code = SURFACE.high;
      else if (radius < 10) code = Math.abs(u) < 2 || Math.abs(v) < 2 ? SURFACE.high : SURFACE.cliff;
      else if (Math.abs(v) > 14 && Math.abs(v) < 17) code = SURFACE.forest;
    } else {
      const radius = Math.hypot(x + 0.5 - 18, y + 0.5 - 18);
      if (radius < 7) code = SURFACE.high;
      else if (radius < 9) code = Math.abs(x - y) <= 2 || Math.abs(x + y - 35) <= 2 ? SURFACE.high : SURFACE.cliff;
    }
    if (Math.hypot(x - 3, y - 3) < 7) code = SURFACE.ground;
    surface[y * width + x] = code;
  }
  setMapLayerValues(document, 'Surface', surface);
  const world = buildWorldFromDocument(document);
  for (let c = 0; c < size * size; c++) {
    if (c % size === 0 || c % size === size - 1 || c < size || c >= size * (size - 1) || world.terrain[c] === SURFACE.cliff || world.terrain[c] === SURFACE.water) world.cells[c] = CELL.bedrock;
  }
  const p = spirePositions(3, size).blue;
  const start = Math.floor(p.y) * size + Math.floor(p.x);
  // A common cross-plane route skeleton; each rotated start receives the same corridor.
  const goal = sides === 2 ? rotateCell(start, size, 2) : (size / 2 - 1) * size + size / 2 - 1;
  const previous = new Int32Array(size * size).fill(-1);
  previous[start] = start;
  const queue = [start];
  for (let i = 0; i < queue.length && previous[goal]! < 0; i++) {
    const c = queue[i]!;
    for (const next of [c % size > 1 ? c - 1 : -1, c % size < size - 2 ? c + 1 : -1, c - size, c + size]) {
      if (next < size || next >= size * (size - 1) || previous[next]! >= 0 || world.terrain[next] === SURFACE.cliff || world.terrain[next] === SURFACE.water) continue;
      previous[next] = c;
      queue.push(next);
    }
  }
  if (previous[goal]! < 0) throw new Error(`${id}: authored route is disconnected`);
  for (let c = goal; ; c = previous[c]!) {
    world.cavern.push(c);
    for (let r = 0; r < sides; r++) world.cells[rotateCell(c, size, r * 4 / sides)] = CELL.tunnel;
    if (c === start) break;
  }
  const lodeSites = sides === 2 ? [[12, 5, false], [5, 12, false], [38, 9, true], [19, 20, true]] as const : [[12, 5, false], [5, 12, false], [23, 24, true]] as const;
  for (const [x, y, rich] of lodeSites) {
    // The outcrop and its apron stand on one level: a site touching a plateau is levelled onto it, never carved down.
    let level: number = SURFACE.ground;
    for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) {
      if (world.terrain[(y + dy) * size + x + dx] === SURFACE.high) level = SURFACE.high;
    }
    for (let r = 0; r < sides; r++) {
      const centre = rotateCell(y * size + x, size, r * 4 / sides);
      const loads = rich ? 160 : 80;
      world.lodes.push({ c: centre, rich, loads });
      for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) {
        const c = rotateCell((y + dy) * size + x + dx, size, r * 4 / sides);
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        world.cells[c] = ring === LODE_SEAL ? CELL.bedrock : ring === 0 ? CELL.rock : CELL.ore;
        world.ore[c] = ring === LODE_POCKET ? loads / 8 : 0;
        world.owner[c] = 0;
        world.terrain[c] = level;
      }
    }
  }
  // Fixed free veins give the diggers early work as well as sealed surface economy.
  for (const [x, y] of [[9, 8], [15, 15], [26, 13]]) for (let r = 0; r < sides; r++) {
    const c = rotateCell(y! * size + x!, size, r * 4 / sides);
    if (world.cells[c] === CELL.rock) { world.cells[c] = CELL.ore; world.ore[c] = 16; }
  }
  world.cavern = world.cavern.filter(c => world.cells[c] === CELL.tunnel);
  world.islands = [];
  for (const radius of [8, 14, 20]) for (let r = 0; r < sides; r++) world.islands.push({ r: radius * size / 48, a0: -Math.PI * 3 / 4 + r * Math.PI * 2 / sides, w: Math.PI * 2 / (20 * (radius * 5 + 30)) });
  world.orbitRegions = generateOrbitRegions(spec.preset, { ...DEFAULT_RULES.map, size }, sides);
  world.generation = { lodes: [], terrainEdits: [], stages: [] };
  const authored = documentFromWorld(world, metadata);
  const validation = validateMapDocument(authored);
  if (!validation.valid) throw new Error(`${id}: ${validation.errors.join('; ')}`);
  return authored;
}

if (process.argv.includes('--write')) {
  const directory = fileURLToPath(new URL('../../packages/game/maps/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  for (const { id } of AUTHORS) writeFileSync(`${directory}${id}.json`, `${JSON.stringify(authorClassic(id), null, 2)}\n`);
}
