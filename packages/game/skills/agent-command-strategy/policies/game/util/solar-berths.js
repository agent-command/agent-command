// Agent Command's built-in bot library: packages/game/src/util/solar-berths.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/** Shared Orbit array berth lattice, in the army's canonical frame. Planning only, never per tick. */
import { dmath } from './fdlibm.js';
import { norm } from './math.js';

export const BERTH_GAP = 0.25;
const BERTH_FIRST = 4.5;
const BERTH_MIN = 2;
const BERTH_MAX = 24;

/** Nearest rings first, facing the map centre; offsets from home, outside the ruin and map rim. */
export function solarBerths(home, size, shadeRadius, ruin, bodySpacing = BERTH_MIN) {
  const spacing = Math.max(shadeRadius, BERTH_MIN, bodySpacing) + BERTH_GAP;
  const out = [];
  for (let r = BERTH_FIRST; out.length < BERTH_MAX && r < size; r += spacing) {
    const step = 2 * dmath.asin(Math.min(1, spacing / (2 * r)));
    const n = Math.floor(Math.PI / 2 / step) + 1;
    for (let k = 0; k < n && out.length < BERTH_MAX; k++) {
      const a = Math.PI / 4 + ((k - (n - 1) / 2) * step);
      const x = home.x + r * dmath.cos(a);
      const y = home.y + r * dmath.sin(a);
      if (x < 1 || y < 1 || x > size - 1 || y > size - 1 || norm(x - size / 2, y - size / 2) < ruin) continue;
      out.push({ x: x - home.x, y: y - home.y });
    }
  }
  return out;
}
