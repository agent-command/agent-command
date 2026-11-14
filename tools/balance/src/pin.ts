/**
 * Re-pin the reviewed agent-facing surface (manifest, schemas, skills, generated tools) after an intentional change:
 * `pnpm bench:pin`. Prints the old and new hash; benchmark results across a pin change are not comparable.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { surfaceHash } from 'playerthree';
import { definition } from '../../../packages/game/src/agent/adapter.ts';
import { SURFACE_HASH } from '../../../bench/surface.ts';

const file = new URL('../../../bench/surface.ts', import.meta.url);
const next = surfaceHash(definition.manifest);
if (next === SURFACE_HASH) {
  console.log(`surface unchanged: ${next}`);
} else {
  const src = await readFile(file, 'utf8');
  await writeFile(file, src.replace(SURFACE_HASH, next));
  console.log(`surface re-pinned: ${SURFACE_HASH} → ${next}`);
}
