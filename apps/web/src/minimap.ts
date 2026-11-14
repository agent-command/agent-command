/**
 * The field map: four stacked journal pages, one isometric diamond per plane (Orbit on top), each on its own paper.
 * Fog has three tiers: never explored = blank paper, explored = the pencil sketch, visible now = painted. On top, in
 * ink: units (army-colour dots), fights, threats (amber + hatch: impacts, enemy charges, tremors), remembered enemy
 * structures (red pencil), the sun wedges (with the dawn about to arrive), island drift paths and the camera
 * footprint. Pages are oriented like the army's starting camera (your base toward the bottom): each army's map is the
 * NW army's turned by its frame. Hovering a page fades the pages stacked above it so it can be read whole. Click a page
 * to dive there.
 */
import { CELL, PLANES, SURFACE, TICK_RATE, UNIT_KINDS, canonX, canonY, footprint, frameOf, islandAt, rotX, rotY, sunOffset, surfaceFeature, type ArmyId, type Kind, type Plane, type View } from '@agent-command/game/contract';
import { PLANE_ACCENT, PLANE_CHAPTER } from './dom.ts';
import { CHARGE_PLANES, IMPACT_PLANES } from './overlay.ts';
import { contestedPoints } from './post-tip.ts';
import { HEAT_CELL } from './world/combat.ts';
import { SIDE_HEX, THREAT_HEX, sideHex } from './world/common.ts';
import { DARK, LINE, LODE_PAINT, PAPER, PENCIL, RICH_ORE_PAINT, SHADOW } from './world/palette.ts';
import { PATH_AHEAD_S, SUN_AHEAD_S } from './world/plan.ts';
import type { World } from './world/world.ts';

// Fixed journal-page pixels preserve the S48 layout; larger maps get smaller pixels per tile.
const PAGE_X = 48 * 1.85;
const PAGE_Y = 48 * 0.92;
const STEP = 62; // vertical gap between plane diamonds
const TOP = 14;
const LEFT = 26;
const W = LEFT + PAGE_X * 2 + 8;
const H = TOP + STEP * 3 + PAGE_Y * 2 + 8;
const IS_UNIT = new Set<string>(UNIT_KINDS);

/** CSS can shrink the field-map page; hit testing always uses its logical drawing coordinates. */
export function minimapPoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): { sx: number; sy: number } {
  return { sx: (clientX - rect.left) * W / rect.width, sy: (clientY - rect.top) * H / rect.height };
}

/**
 * Quarter turns from map to page for `army`: its corner goes to the bottom of the diamond (the NW army's pages are
 * turned 180°, the SE army's not at all), i.e. (2 − frame) turns.
 */
export const minimapTurns = (army: ArmyId): number => (6 - frameOf(army)) & 3;

type RGB = [number, number, number];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const PAPER_RGB: Record<Plane, RGB> = { depths: hex(PAPER.depths), surface: hex(PAPER.surface), sky: hex(PAPER.sky), orbit: hex(PAPER.orbit) };
const PENCIL_RGB: Record<Plane, RGB> = { depths: hex(PENCIL.depths), surface: hex(PENCIL.surface), sky: hex(PENCIL.sky), orbit: hex(PENCIL.orbit) };
/** Watercolour paint per Depths knowledge cell (the palette of docs/art/DIRECTIONS.md §1). */
const CELL_RGB: Record<number, RGB> = {
  [CELL.bedrock]: [40, 33, 29],
  [CELL.rock]: [90, 74, 82],
  [CELL.ore]: [95, 201, 184],
  [CELL.tunnel]: [199, 167, 122],
  [CELL.fortified]: [111, 143, 176],
  [CELL.rail]: [233, 220, 196],
  [CELL.magma]: [255, 90, 26],
  // the Mother Lode in the contested (rich) lode paint, never the plain ore teal
  [CELL.lode]: hex(LODE_PAINT.rich),
  // a permanent lava lake a deeper red-orange than a passing flood; a bridge deck in its timber; green ore emerald
  [CELL.lake]: [214, 64, 18],
  [CELL.bridge]: [122, 86, 54],
  [CELL.rich]: hex(RICH_ORE_PAINT.crystal),
};
const SURFACE_RGB: Record<number, RGB> = {
  [SURFACE.ground]: [154, 184, 106],
  [SURFACE.cliff]: [169, 151, 138],
  [SURFACE.forest]: [104, 140, 76],
  [SURFACE.high]: [220, 199, 145],
  [SURFACE.ford]: [127, 178, 194],
  [SURFACE.water]: [51, 105, 137],
  [SURFACE.fault]: [255, 138, 58],
  [SURFACE.highForest]: [136, 155, 92],
  [SURFACE.highFord]: [149, 193, 204],
  [SURFACE.highWater]: [73, 127, 159],
  [SURFACE.highFault]: [255, 164, 80],
};
/** Surface holes (public), by code in the per-update hole grid (0 = none). */
const HOLE_CODE: Record<string, number> = { crater: 1, sinkhole: 2, chasm: 3, breach: 4 };
const HOLE_RGB: RGB[] = [[0, 0, 0], [150, 96, 70], [90, 74, 64], [58, 42, 34], [150, 110, 190]];
const SKY_RGB: RGB = [196, 216, 228];
const ORBIT_RGB: RGB = [44, 49, 96];
const SUN_RGB: RGB = [246, 231, 191];

// ---- ink
const SEPIA = '#2b2019';
const SHADE = 'rgba(30,20,12,0.28)';
const HEAT = '#d0493a';
/** Sky islands' shadows on the Surface page, as in the world (island positions are public). */
const ISLAND_SHADOW_ALPHA = 0.2;
const RED_PENCIL = { light: '#a8392f', dark: '#ff9d8c' };
const DRIFT = '#3d5a80';
/** Labels drawn on the dark minimap frame itself use the chrome's cream ink (style.css --ink). */
const CHROME_INK = '#fcfbe7';
const F_TAB = '12px "IM Fell English SC", "Iowan Old Style", Georgia, serif';
const F_IDLE = '600 13px Caveat, "Segoe Print", cursive';
const DASH = [3, 2];
const NO_DASH: number[] = [];
const IDLE: string[] = [];

export class Minimap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly off: Record<Plane, { c: HTMLCanvasElement; cx: CanvasRenderingContext2D; img: ImageData }>;
  private holes: Uint8Array;
  private size: number;
  private get a(): number { return PAGE_X / this.size; }
  private get b(): number { return PAGE_Y / this.size; }
  private readonly hatch: CanvasPattern;
  private last = 0;
  private terrainTick = -1;
  private terrainView: View | undefined;
  /** Own idle units per plane (for labels and the HUD). */
  readonly idle: Record<Plane, number> = { depths: 0, surface: 0, sky: 0, orbit: 0 };
  private readonly onPick: (plane: Plane, x: number, y: number) => void;
  /** Quarter turns from map to page for the viewing army (`minimapTurns`). */
  turns = 0;
  /** The page under the pointer; pages above it are faded while it is hovered. */
  private hover: Plane | undefined;

  constructor(onPick: (plane: Plane, x: number, y: number) => void, size: number) {
    this.onPick = onPick;
    this.size = size;
    this.holes = new Uint8Array(size * size);
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(W * 2);
    this.canvas.height = Math.round(H * 2);
    this.el.append(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = this.size;
      c.height = this.size;
      const cx = c.getContext('2d')!;
      return { c, cx, img: cx.createImageData(this.size, this.size) };
    };
    this.off = { depths: mk(), surface: mk(), sky: mk(), orbit: mk() };
    const tile = document.createElement('canvas');
    tile.width = 4;
    tile.height = 4;
    const t = tile.getContext('2d')!;
    t.fillStyle = THREAT_HEX;
    t.fillRect(0, 0, 4, 4);
    t.strokeStyle = SEPIA;
    t.lineWidth = 0.9;
    t.beginPath();
    for (const o of [-4, 0, 4]) {
      t.moveTo(o, 4);
      t.lineTo(o + 4, 0);
    }
    t.stroke();
    this.hatch = ctx.createPattern(tile, 'repeat')!;
    const at = (e: PointerEvent) => minimapPoint(e.clientX, e.clientY, this.canvas.getBoundingClientRect());
    this.canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const { sx, sy } = at(e);
      const plane = this.pageAt(sx, sy);
      const t = plane && this.tileAt(plane, sx, sy);
      if (plane && t) this.onPick(plane, t.x, t.y);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const { sx, sy } = at(e);
      const plane = this.pageAt(sx, sy);
      if (plane === this.hover) return;
      this.hover = plane;
      this.last = 0; // redraw now
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (this.hover === undefined) return;
      this.hover = undefined;
      this.last = 0;
    });
  }

  /** Minimap px → tile on `plane`'s page, or undefined off the page. */
  private tileAt(plane: Plane, sx: number, sy: number): { x: number; y: number } | undefined {
    const u = (sx - LEFT - this.size * this.a) / this.a;
    const v = (sy - this.originY(plane)) / this.b;
    const x = (u + v) / 2;
    const y = (v - u) / 2;
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return undefined;
    return { x: canonX(this.turns, x, y, this.size), y: canonY(this.turns, x, y, this.size) };
  }

  /**
   * The page under the pointer. A hovered page keeps the pointer while it stays on that page, even where a page
   * stacked above overlaps it (that page is faded then); otherwise the topmost page wins.
   */
  private pageAt(sx: number, sy: number): Plane | undefined {
    if (this.hover && this.tileAt(this.hover, sx, sy)) return this.hover;
    for (let i = PLANES.length - 1; i >= 0; i--) if (this.tileAt(PLANES[i]!, sx, sy)) return PLANES[i];
    return undefined;
  }

  private originY(plane: Plane): number {
    return TOP + STEP * (3 - PLANES.indexOf(plane));
  }

  /** Tile → minimap px, into the shared `PT`. */
  private px(plane: Plane, x: number, y: number): void {
    const rx = rotX(this.turns, x, y, this.size);
    y = rotY(this.turns, x, y, this.size);
    x = rx;
    PT[0] = LEFT + this.size * this.a + (x - y) * this.a;
    PT[1] = this.originY(plane) + (x + y) * this.b;
  }

  /** Registry rectangles use the same page projection and army rotation as the terrain cells. */
  private footprintPath(plane: Plane, kind: Kind, x: number, y: number): void {
    const f = footprint(kind)!;
    this.ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      this.px(plane, x + (i === 1 || i === 2 ? f.w / 2 : -f.w / 2), y + (i >= 2 ? f.h / 2 : -f.h / 2));
      if (i) this.ctx.lineTo(PT[0], PT[1]); else this.ctx.moveTo(PT[0], PT[1]);
    }
    this.ctx.closePath();
  }

  /** Repaint the four pages: blank paper, pencil sketch or paint per cell. */
  private terrain(world: World, view: View, angle: number): void {
    const ahead = angle + view.match!.sun.speed * SUN_AHEAD_S;
    const holes = this.holes;
    const { visible, explored } = world.fog;
    const { terrainCodes } = world.layers.surface.field;
    holes.fill(0);
    for (const hl of view.holes) holes[hl.y * this.size + hl.x] = HOLE_CODE[hl.kind] ?? 0;
    for (const plane of PLANES) {
      const { cx, img } = this.off[plane];
      const d = img.data;
      const vis = visible[plane];
      const seen = explored[plane];
      const paper = PAPER_RGB[plane];
      const pencil = PENCIL_RGB[plane];
      const dark = DARK[plane];
      for (let c = 0; c < this.size * this.size; c++) {
        let paint: RGB | undefined;
        let pub = false;
        let sun = 0;
        if (plane === 'depths') {
          if (view.depths[c] !== CELL.unknown) paint = CELL_RGB[view.depths[c] ?? 0];
        } else if (plane === 'surface') {
          const hole = holes[c]!;
          paint = hole ? HOLE_RGB[hole] : SURFACE_RGB[terrainCodes[c]!];
          pub = hole > 0 || surfaceFeature(terrainCodes[c]!) === SURFACE.fault;
        } else if (plane === 'sky') paint = SKY_RGB;
        else {
          paint = ORBIT_RGB;
          // the sun is public: lit wedges washed in, the band it reaches within SUN_AHEAD_S fainter
          const x = (c % this.size) + 0.5;
          const y = Math.floor(c / this.size) + 0.5;
          const { half, wedges } = view.match!.sun;
          sun = Math.abs(sunOffset(x, y, angle, this.size, wedges)) < half ? 0.5 : Math.abs(sunOffset(x, y, ahead, this.size, wedges)) < half ? 0.16 : 0;
        }
        let r = paper[0];
        let g = paper[1];
        let b = paper[2];
        if (paint && (vis[c] || pub)) {
          // painted: watercolour over the paper
          r = paint[0] * 0.88 + r * 0.12;
          g = paint[1] * 0.88 + g * 0.12;
          b = paint[2] * 0.88 + b * 0.12;
        } else if (paint && seen[c]) {
          // explored: graphite on light paper, chalk on dark, darker where the paint would be darker
          const lum = (paint[0] * 0.3 + paint[1] * 0.59 + paint[2] * 0.11) / 255;
          const k = dark ? 0.1 + lum * 0.36 : 0.12 + (1 - lum) * 0.42;
          r += (pencil[0] - r) * k;
          g += (pencil[1] - g) * k;
          b += (pencil[2] - b) * k;
        }
        if (sun) {
          r += (SUN_RGB[0] - r) * sun;
          g += (SUN_RGB[1] - g) * sun;
          b += (SUN_RGB[2] - b) * sun;
        }
        const o = c * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
    }
  }

  /** The next minute of every island's drift on the Sky page. */
  private paths(view: View, tick: number): void {
    const ctx = this.ctx;
    ctx.setLineDash(DASH);
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = DRIFT;
    ctx.beginPath();
    for (const p of view.islands) {
      for (let s = 0; s <= 24; s++) {
        const q = islandAt(p, tick + (s * PATH_AHEAD_S * TICK_RATE) / 24, XY);
        this.px('sky', q.x, q.y);
        if (s) ctx.lineTo(PT[0], PT[1]);
        else ctx.moveTo(PT[0], PT[1]);
      }
    }
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
  }

  /** Trace a plane's page outline (the diamond) into the current path. */
  private page(oy: number, dx: number, dy: number): void {
    const ctx = this.ctx;
    const cx = LEFT + this.size * this.a + dx;
    ctx.moveTo(cx, oy + dy);
    ctx.lineTo(cx + this.size * this.a, oy + this.size * this.b + dy);
    ctx.lineTo(cx, oy + this.size * this.b * 2 + dy);
    ctx.lineTo(cx - this.size * this.a, oy + this.size * this.b + dy);
    ctx.closePath();
  }

  draw(world: World, now: number): void {
    const view = world.view;
    if (!view || now - this.last < 100) return;
    const size = view.match.rules.map.size;
    if (size !== this.size) {
      this.size = size;
      this.holes = new Uint8Array(size * size);
      for (const plane of PLANES) {
        const off = this.off[plane];
        off.c.width = off.c.height = size;
        off.img = off.cx.createImageData(size, size);
      }
      this.terrainView = undefined;
      this.hover = undefined;
    }
    this.last = now;
    if (view.tick !== this.terrainTick || view.army !== this.terrainView?.army || view.match !== this.terrainView?.match) {
      this.terrain(world, view, world.layers.orbit.sunAngle.value);
      this.terrainTick = view.tick;
      this.terrainView = view;
    }
    const ctx = this.ctx;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    const army = view.army;
    this.turns = minimapTurns(army);
    const hoverAt = this.hover ? PLANES.indexOf(this.hover) : PLANES.length;
    const focus = world.rig.focus;
    for (const p of PLANES) this.idle[p] = 0;
    for (const tr of world.entities.tracks.values())
      if (tr.e.side === army && IS_UNIT.has(tr.e.kind) && tr.e.state === 'idle') this.idle[tr.e.plane]++;
    const pulse = 0.5 + Math.sin(now / 160) * 0.5;

    for (let pi = 0; pi < PLANES.length; pi++) {
      const plane = PLANES[pi]!;
      const oy = this.originY(plane);
      const ink = LINE[plane];
      const on = plane === focus;
      // pages stacked above a hovered page fade out of the way
      ctx.globalAlpha = pi > hoverAt ? 0.12 : 1;
      const pageAlpha = ctx.globalAlpha;
      // the page: cast shadow, paper (terrain + fog tiers), ink rule; the focused page gets a wash rim
      ctx.fillStyle = SHADE;
      ctx.beginPath();
      this.page(oy, 1.5, 2.5);
      ctx.fill();
      ctx.save();
      // Page transform of the cell image: the affine map px() applies, from its image of the unit axes.
      this.px(plane, 0, 0);
      const ox = PT[0], oy0 = PT[1];
      this.px(plane, 1, 0);
      const xx = PT[0] - ox, xy = PT[1] - oy0;
      this.px(plane, 0, 1);
      ctx.setTransform(2 * xx, 2 * xy, 2 * (PT[0] - ox), 2 * (PT[1] - oy0), 2 * ox, 2 * oy0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.off[plane].c, 0, 0);
      // combat heat: a red ink wash
      const hm = world.combat.heat[plane];
      ctx.fillStyle = HEAT;
      for (let i = 0; i < hm.length; i++) {
        const v = hm[i]!;
        if (v < 0.6) continue;
        ctx.globalAlpha = Math.min(0.75, v / 4) * (0.5 + pulse * 0.5) * pageAlpha;
        ctx.fillRect((i % world.combat.heatN) * HEAT_CELL, Math.floor(i / world.combat.heatN) * HEAT_CELL, HEAT_CELL, HEAT_CELL);
      }
      // Islands drifting overhead shade the Surface page faintly, at the world shadow's spot (tile units here).
      if (plane === 'surface') {
        const shadows = world.layers.islandShadows;
        ctx.fillStyle = SHADOW.surface;
        ctx.globalAlpha = ISLAND_SHADOW_ALPHA * pageAlpha;
        for (const tr of world.entities.tracks.values()) {
          const row = tr.e.kind === 'island' ? shadows.rows.get(tr.e.id) : undefined;
          if (row === undefined) continue;
          ctx.beginPath();
          ctx.arc(tr.rx + shadows.offset[0]!, tr.ry + shadows.offset[1]!, shadows.radius[row]!, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = pageAlpha;
      ctx.restore();
      // Only discovered deposits are in the view. Rich ore also has a second diamond, so hue is not the sole cue.
      if (plane === 'surface') for (const l of view.lodes) {
        this.px(plane, l.x + 0.5, l.y + 0.5);
        ctx.fillStyle = world.fog.visible.surface[l.y * this.size + l.x] ? (l.rich ? LODE_PAINT.rich : LODE_PAINT.ordinary) : PENCIL.surface;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.75;
        const x = PT[0];
        const y = PT[1];
        this.footprintPath(plane, 'headframe', l.x + 0.5, l.y + 0.5);
        ctx.fill();
        ctx.stroke();
        if (l.rich) {
          ctx.beginPath();
          ctx.moveTo(x + 3, y - 2);
          ctx.lineTo(x + 5, y);
          ctx.lineTo(x + 3, y + 2);
          ctx.lineTo(x + 1, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.beginPath();
      this.page(oy, 0, 0);
      if (on) {
        ctx.strokeStyle = PLANE_ACCENT[plane];
        ctx.lineWidth = 3.5;
        ctx.stroke();
      }
      ctx.strokeStyle = SEPIA;
      ctx.lineWidth = on ? 1.4 : 0.9;
      ctx.stroke();

      // spires
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.9;
      for (const a of view.match!.armies) {
        this.footprintPath(plane, 'spire', a.spireAt.x, a.spireAt.y);
        ctx.fillStyle = SIDE_HEX[a.colour];
        ctx.fill();
        ctx.stroke();
      }
      // remembered enemy structures: red pencil
      ctx.strokeStyle = DARK[plane] ? RED_PENCIL.dark : RED_PENCIL.light;
      ctx.lineWidth = 1;
      for (const m of world.entities.memory) {
        if (m.plane !== plane || world.entities.tracks.has(m.id)) continue;
        if (!footprint(m.kind)) continue;
        this.footprintPath(plane, m.kind, m.x, m.y);
        ctx.stroke();
      }
      if (plane === 'sky') this.paths(view, world.entities.renderTick);
      // units / structures: team-colour dots in an ink rim
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.75;
      const points = contestedPoints(view.match!);
      for (const tr of world.entities.tracks.values()) {
        const e = tr.e;
        if (e.plane !== plane || e.kind === 'spire') continue;
        this.px(plane, tr.rx, tr.ry);
        const x = PT[0];
        const y = PT[1];
        ctx.fillStyle = sideHex(e.side);
        ctx.beginPath();
        if (e.kind === 'island') {
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.globalAlpha = 0.55 * pageAlpha;
          ctx.fill();
          ctx.globalAlpha = pageAlpha;
          ctx.stroke();
          continue;
        }
        if (e.kind === 'post') {
          if (points.has(e.id)) {
            // A contested point: a diamond in the holder's colour (neutral ink when nobody holds it).
            ctx.moveTo(x, y - 3.8);
            ctx.lineTo(x + 3.8, y);
            ctx.lineTo(x, y + 3.8);
            ctx.lineTo(x - 3.8, y);
            ctx.closePath();
          } else {
            // A home post: a pennant on a staff in the holder's colour.
            ctx.moveTo(x - 1.5, y + 3);
            ctx.lineTo(x - 1.5, y - 3.5);
            ctx.lineTo(x + 3, y - 2);
            ctx.lineTo(x - 1.5, y - 0.5);
          }
          ctx.fill();
          ctx.stroke();
          continue;
        }
        const unit = IS_UNIT.has(e.kind);
        if (footprint(e.kind)) this.footprintPath(plane, e.kind, tr.rx, tr.ry);
        else if (unit) ctx.arc(x, y, 1.9, 0, Math.PI * 2);
        else ctx.rect(x - 2.4, y - 2.4, 4.8, 4.8);
        ctx.fill();
        ctx.stroke();
        if (unit && e.side === army && e.state === 'idle') {
          ctx.beginPath();
          ctx.arc(x, y, 3.4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // ink-wash tab with the chapter numeral, and the idle count
      const ty = oy + this.size * this.b;
      ctx.fillStyle = PLANE_ACCENT[plane];
      ctx.globalAlpha = (on ? 1 : 0.75) * pageAlpha;
      ctx.fillRect(0, ty - 9, 22, 13);
      ctx.globalAlpha = pageAlpha;
      ctx.fillStyle = SEPIA;
      ctx.font = F_TAB;
      ctx.textAlign = 'center';
      ctx.fillText(PLANE_CHAPTER[plane].numeral, 11, ty + 2);
      const idle = this.idle[plane];
      if (idle) {
        ctx.fillStyle = CHROME_INK;
        ctx.font = F_IDLE;
        ctx.textAlign = 'left';
        ctx.fillText((IDLE[idle] ??= `${idle} idle`), 1, ty + 16);
      }
      ctx.globalAlpha = 1;
    }

    // threats in amber + hatch with an ink rim: impacts (surface + sky), enemy charges (surface + depths), tremors
    for (const imp of view.impacts) for (const plane of IMPACT_PLANES) this.ping(plane, imp.x, imp.y, undefined, 3 + pulse * 3);
    for (const c of view.charges)
      for (const plane of CHARGE_PLANES) this.ping(plane, c.x + 0.5, c.y + 0.5, c.side === army ? sideHex(army) : undefined, 2.5 + pulse * 2.5);
    for (const t of view.tremors) this.ping('surface', t.x, t.y, undefined, 2 + pulse * 1.5);

    // camera footprint on the focused page: an ink quad
    ctx.strokeStyle = LINE[focus];
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const g = world.groundPoint(i === 0 || i === 3 ? 0 : innerWidth, i < 2 ? 60 : innerHeight, focus);
      this.px(focus, Math.max(-4, Math.min(this.size + 4, g.x)), Math.max(-4, Math.min(this.size + 4, g.y)));
      if (i) ctx.lineTo(PT[0], PT[1]);
      else ctx.moveTo(PT[0], PT[1]);
    }
    ctx.closePath();
    ctx.stroke();
  }

  /** A mark on a page: hatched amber (threat) or a team-colour ring (`color`), always ink-rimmed. */
  private ping(plane: Plane, x: number, y: number, color: string | undefined, r: number): void {
    const ctx = this.ctx;
    this.px(plane, x, y);
    ctx.beginPath();
    ctx.ellipse(PT[0], PT[1], r * 1.6, r * 0.8, 0, 0, Math.PI * 2);
    if (color) {
      ctx.strokeStyle = SEPIA;
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      return;
    }
    ctx.fillStyle = this.hatch;
    ctx.fill();
    ctx.strokeStyle = SEPIA;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

const PT: [number, number] = [0, 0];
const XY = { x: 0, y: 0 };
