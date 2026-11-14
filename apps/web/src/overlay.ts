/**
 * 2D overlay on top of the 3D canvas, drawn in the field journal's ink: unit icons, HP / progress bars, cross-plane
 * chevrons (what is above and below the focused plane), charge and impact countdowns, "last seen" ghosts, every hostile
 * Spire objective, drag box, order pings, placement previews and agent speech as paper notes.
 * Strokes are sepia on the light papers and chalk on the dark ones; threats are amber stamps with an ink rim and a
 * hatch strip, never colour alone. Allocation-free per frame: strings, widths, fonts and the hatch are cached.
 */
import { AIRCRAFT, COLOURS, PLANES, PLANE_Y, STATS, STRUCTURE_KINDS, TICK_RATE, UNIT_KINDS, buildRadiusOf, footprint, hostileSide, isNeutralKind, islandAt, type ArmyId, type Colour, type Kind, type MatchData, type Plane, type View } from '@agent-command/game/contract';
import { COLOUR_LABEL } from './armies.ts';
import { PLANE_ACCENT } from './dom.ts';
import { PeekPoints } from './peek.ts';
import { fadeValue } from './world/fade.ts';
import { AIM_Y, SIDE_HEX, THREAT_HEX, relation, sideHex } from './world/common.ts';
import { DARK, LINE, PAPER } from './world/palette.ts';
import { PATH_AHEAD_S } from './world/plan.ts';
import type { World } from './world/world.ts';
import { groundAt } from './world/terrain.ts';
import { SPIRE_SPAN, spireBaseY } from './world/spires.ts';
import type { PlacementFootprint } from './footprints.ts';
import { ContactOverlay } from './contact-overlay.ts';
import type { Contacts } from './tools/contacts.ts';
import { DROP_HEX } from './tools/drop.ts';
import type { Lens } from './tools/lens.ts';
import { DOTS_FROM, DOTS_FULL } from './unit-dots.ts';
import { iconPath } from './icons.ts';
import { contestedPoints } from './post-tip.ts';
import { CanvasCursor } from './cursors.ts';

/** Hostile Spire labels, named by colour when several hostiles stand (cached: the overlay never allocates per frame). */
const SPIRE_LABEL = Object.fromEntries(COLOURS.map((c) => [c, `${COLOUR_LABEL[c].toUpperCase()} SPIRE`])) as Record<Colour, string>;
const OBJECTIVE_LABEL = Object.fromEntries(COLOURS.map((c) => [c, `${SPIRE_LABEL[c]} · OBJECTIVE`])) as Record<Colour, string>;

export interface Ping {
  x: number;
  y: number;
  plane: Plane;
  color: string;
  t0: number;
}

export interface Preview {
  x: number;
  y: number;
  plane: Plane;
  /** radius in tiles; 0 = one-tile square */
  radius: number;
  color: string;
  label: string;
  footprint?: PlacementFootprint;
  height?: number;
  /** Placing a radius-bound Surface structure: shade the own build radius and the enemy no-build zone. */
  buildRadius?: boolean;
  /**
   * A solar berth: a thin ink outline `berth` tiles square round (x, y), a dot tinted `color` (the expected output) and
   * `label` as a compact chip, instead of the washed ring and handwritten label.
   */
  berth?: number;
}

const IS_UNIT = new Set<string>(UNIT_KINDS);
type Flags = Partial<Record<Kind, true>>;
const AIR = new Set<string>(UNIT_KINDS.filter((kind) => STATS[kind].plane === 'sky' || STATS[kind].plane === 'orbit'));
const STRUCTURE: Flags = Object.fromEntries(STRUCTURE_KINDS.map((kind) => [kind, true as const]));
const AIRCRAFT_FLAGS: Flags = Object.fromEntries(AIRCRAFT.map((kind) => [kind, true as const]));
/** Enemy kinds worth flagging when they sit on the plane above / below the focused one. */
const CROSS: Record<Plane, { above: Flags; below: Flags }> = {
  depths: { above: { trooper: true, tank: true, shaft: true }, below: {} },
  surface: { above: { ...AIRCRAFT_FLAGS, relay: true }, below: { sapper: true, digger: true, trooper: true } },
  sky: { above: Object.fromEntries(UNIT_KINDS.filter((kind) => STATS[kind].plane === 'orbit').map((kind) => [kind, true as const])), below: { flak: true, turret: true, tank: true } },
  orbit: { above: {}, below: { ...AIRCRAFT_FLAGS, relay: true } },
};
const XY = { x: 0, y: 0 };
/** Progress bar colour per busy state (construction, charges, captures, breach digs, bridging, rail laying). */
const PROGRESS_COLOR: Partial<Record<string, string>> = {
  constructing: '#7fd6ff',
  capturing: '#7fd6ff',
  undermining: '#ff6a3d',
  breaching: '#b98bff',
  bridging: '#ffd34d',
  laying: '#9fc6e0',
};
/** Planes that show impact / charge countdowns (hoisted: the draw loop allocates nothing). */
export const IMPACT_PLANES = ['surface', 'sky'] as const;
export const CHARGE_PLANES = ['surface', 'depths'] as const;

// ---- ink and type (the same families as style.css)
const SEPIA = '#2b2019';
const NOTE = '#f7f0de';
const SHADE = 'rgba(20,12,6,0.28)';
const HP_GOOD = '#7bb04f';
const HP_MID = '#e0a43a';
const HP_LOW = '#d0493a';
const TREMOR = '#ffb36b';
/** Red pencil for remembered enemy structures, per paper (light / dark). */
const RED_PENCIL = { light: '#a8392f', dark: '#ff9d8c' };
const STAMP = '"IM Fell English SC", "Iowan Old Style", Georgia, serif';
const HAND = 'Caveat, "Segoe Print", "Bradley Hand", cursive';
const F_STAMP_S = `11px ${STAMP}`;
const F_STAMP = `13px ${STAMP}`;
const F_HAND_S = `600 15px ${HAND}`;
const F_HAND = `700 18px ${HAND}`;
const F_NOTE = `600 17px ${HAND}`;
const F_PREVIEW = `600 17px ${HAND}`;
/** Solar berth preview: the output dot's radius and its chip's lift above the berth centre (px). */
const BERTH_DOT = 3.5;
const BERTH_CHIP = 18;
const DASH = [5, 3];
const NO_DASH: number[] = [];
/** Placement refusal red, shared by invalid footprint cells and the enemy no-build zone. */
const INVALID = '#ef4941';
/**
 * Ring samples projecting farther than this many viewport sizes from the centre break the ring: they sit near the
 * camera plane, where the projection runs off to infinity.
 */
const RING_REACH = 8;
/** Samples per build-radius circle and per no-build corner arc. */
const RADIUS_STEPS = 72;
const CORNER_STEPS = 12;
/** Height of the HUD top bar (style.css `.topbar`: 8 px offset + 54 px sheet); overlay markers stay below it. */
const TOP_BAR = 64;
/** Icon size (px) inside a stamp tag, e.g. the flame on BURNING. */
const TAG_ICON = 13;

/** "4.2s" for every tenth of a second up to 99.9 s, built on first use. */
const TENTHS: string[] = [];
const tenths = (secs: number): string => {
  const i = Math.max(0, Math.min(999, Math.round(secs * 10)));
  return (TENTHS[i] ??= `${(i / 10).toFixed(1)}s`);
};
/** "last seen 12s", built on first use. */
const SEEN: string[] = [];
const lastSeen = (secs: number): string => {
  const i = Math.min(5999, secs);
  return (SEEN[i] ??= `last seen ${i}s`);
};
const ISLAND_MARKS = [1, 2, 3, 4].map((j) => `+${(j * PATH_AHEAD_S) / 4}s`);
const ALLOY_LABELS = new Map<number, string>();
const alloyLabel = (amount: number): string => {
  let label = ALLOY_LABELS.get(amount);
  if (label === undefined) ALLOY_LABELS.set(amount, label = String(amount));
  return label;
};
/** "×3" for a count of Sky shooters, built on first use. */
const TIMES: string[] = [];
const times = (n: number): string => (TIMES[n] ??= `×${n}`);
/** Drop scope stamps by rock size (the core has its own word). */
const DROP_WORD = { pebble: 'PEBBLE', medium: 'ROCK', large: 'LARGE ROCK' } as const;
/** The fall path and deorbit reach: a pale line that reads on dark and light ground alike. */
const DROP_PATH = '#ffd0b0';
/** A drop the sim would refuse: pencil grey, dashed (the stamps say why). */
const DROP_REFUSED = '#b9b2a6';
const DROP_STAMP_STEP = 24;
/** Smallest strike ring (tiles): weapons without splash still mark their target. */
const STRIKE_MARK = 0.6;

/** A speech note wrapped once: ≤ 3 lines of ~34 chars and the widest line. */
interface Wrapped {
  lines: string[];
  w: number;
}

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  /** The canvas's cursor, shared by whichever session (player Controls, observer) takes the canvas. */
  readonly cursor: CanvasCursor;
  private readonly ctx: CanvasRenderingContext2D;
  drag: { x0: number; y0: number; x1: number; y1: number } | undefined;
  readonly pings: Ping[] = [];
  preview: Preview | undefined;
  /** Retained O descriptor; the main camera projects its contacts without touching the peek scope. */
  contacts?: Contacts;
  private readonly contactOverlay = new ContactOverlay();
  private w = 0;
  private h = 0;
  /** Amber with diagonal ink hatching: the threat cue that does not depend on colour. */
  private readonly hatch: CanvasPattern;
  /** Text widths per font (keys are the cached strings above, so lookups never allocate). */
  private readonly widths = new Map<string, Map<string, number>>();
  private readonly wrapped = new WeakMap<object, Wrapped>();
  /** Ink and halo of the focused paper (set at the start of every frame). */
  private ink = SEPIA;
  private halo = PAPER.surface;
  private dark = false;
  /** Screen points of selected units and impact countdowns drawn this frame (peek-through targets, see peek.ts). */
  readonly peek = new PeekPoints();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.cursor = new CanvasCursor(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    const tile = document.createElement('canvas');
    tile.width = 6;
    tile.height = 6;
    const t = tile.getContext('2d')!;
    t.fillStyle = THREAT_HEX;
    t.fillRect(0, 0, 6, 6);
    t.strokeStyle = SEPIA;
    t.lineWidth = 1.3;
    t.beginPath();
    for (const o of [-6, 0, 6]) {
      t.moveTo(o, 6);
      t.lineTo(o + 6, 0);
    }
    t.stroke();
    this.hatch = ctx.createPattern(tile, 'repeat')!;
  }

  private resize(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(this.w * dpr) || this.canvas.height !== Math.round(this.h * dpr)) {
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Width of `text` in `font` (the context's font must already be `font`). */
  private width(font: string, text: string): number {
    let m = this.widths.get(font);
    if (!m) this.widths.set(font, (m = new Map()));
    let w = m.get(text);
    if (w === undefined) m.set(text, (w = this.ctx.measureText(text).width));
    return w;
  }

  /**
   * Trace a ground circle (tiles) at world height wy into the current path, as the arcs whose samples project in front
   * of the camera and within RING_REACH viewports. A sample behind the lens or near its plane breaks the ring there:
   * joined, it would wrap the ring through infinity into a screen-covering polygon whose huge (dashed) edges stall the
   * frame. True when the whole ring traced (a closed outline that may be filled).
   */
  private circle(world: World, x: number, y: number, wy: number, r: number): boolean {
    const ctx = this.ctx;
    const reach = RING_REACH * Math.max(this.w, this.h);
    let whole = true;
    let open = false;
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const p = world.project(x - world.size / 2 + Math.cos(a) * r, wy, y - world.size / 2 + Math.sin(a) * r);
      if (p.behind || !(Math.abs(p.x - this.w / 2) <= reach && Math.abs(p.y - this.h / 2) <= reach)) {
        whole = open = false;
        continue;
      }
      if (open) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      open = true;
    }
    return whole;
  }

  /** Is `e` one of `army`'s build-radius sources (own, live, completed); its radius in tiles, else 0. */
  private static sourceRadius(e: View['entities'][number], army: ArmyId, match: MatchData): number {
    return e.side === army && e.plane === 'surface' && e.state !== 'constructing' && e.hp > 0 ? buildRadiusOf(e.kind, match.rules.surface, contestedPoints(match).has(e.id)) : 0;
  }

  /** Project a Surface ground point (tiles) and extend the current path to it. */
  private groundTo(world: World, x: number, y: number, move: boolean): void {
    const p = world.project(x - world.size / 2, PLANE_Y.surface + groundAt(x, y, world.layers.surface.field) + 0.12, y - world.size / 2);
    if (move) this.ctx.moveTo(p.x, p.y);
    else this.ctx.lineTo(p.x, p.y);
  }

  /**
   * Placement mode: the own build radius (union of the sources' circles) as a faint army wash inside an inked edge,
   * and every hostile Spire's no-build zone (its footprint grown by enemySpireNoBuild) in refusal red. Built only from
   * own entities and public Spire positions, like the rule itself; hostile radii are never drawn.
   */
  private buildRadius(world: World, view: View, match: MatchData, army: ArmyId): void {
    const ctx = this.ctx;
    const rules = match.rules.surface;
    const own = sideHex(army);
    ctx.beginPath();
    for (const e of view.entities) {
      const r = Overlay.sourceRadius(e, army, match);
      if (!r) continue;
      for (let i = 0; i <= RADIUS_STEPS; i++) {
        const a = (i / RADIUS_STEPS) * Math.PI * 2;
        this.groundTo(world, e.x + Math.cos(a) * r, e.y + Math.sin(a) * r, i === 0);
      }
      ctx.closePath();
    }
    // Non-zero winding fills the union once, so overlaps do not darken.
    ctx.fillStyle = own;
    ctx.globalAlpha = 0.09;
    ctx.fill('nonzero');
    ctx.globalAlpha = 1;
    // The edge: only the arc pieces of each circle that no other source covers.
    ctx.beginPath();
    for (const e of view.entities) {
      const r = Overlay.sourceRadius(e, army, match);
      if (!r) continue;
      let open = false;
      for (let i = 0; i <= RADIUS_STEPS; i++) {
        const a = (i / RADIUS_STEPS) * Math.PI * 2;
        const x = e.x + Math.cos(a) * r, y = e.y + Math.sin(a) * r;
        let covered = false;
        for (const o of view.entities) {
          const ro = o === e ? 0 : Overlay.sourceRadius(o, army, match);
          if (ro && (x - o.x) ** 2 + (y - o.y) ** 2 < ro * ro) { covered = true; break; }
        }
        if (covered) { open = false; continue; }
        this.groundTo(world, x, y, !open);
        open = true;
      }
    }
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = own;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Hostile no-build zones (armies still in play): rounded rectangles, each Spire footprint grown by the rule distance.
    const f = footprint('spire')!;
    const d = rules.enemySpireNoBuild;
    ctx.beginPath();
    for (const foe of match.armies) {
      if (!hostileSide(match, army, foe.id) || view.eliminated.includes(foe.id)) continue;
      for (let k = 0; k < 4; k++) {
        const cx = foe.spireAt.x + (k === 0 || k === 3 ? f.w / 2 : -f.w / 2);
        const cy = foe.spireAt.y + (k < 2 ? f.h / 2 : -f.h / 2);
        for (let i = 0; i <= CORNER_STEPS; i++) {
          const a = ((k + i / CORNER_STEPS) * Math.PI) / 2;
          this.groundTo(world, cx + Math.cos(a) * d, cy + Math.sin(a) * d, k === 0 && i === 0);
        }
      }
      ctx.closePath();
    }
    ctx.fillStyle = INVALID;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash(DASH);
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = INVALID;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
  }

  /** Ink lettering with a paper halo, readable on any part of the page. */
  private label(text: string, x: number, y: number, fill: string, font: string): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = this.halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  /**
   * A stamped tag centred on (x, y): an optional `icon` (an `iconPath`), `word` in the stamp face, then optional
   * handwritten `num`. Threat tags are amber with a hatched strip and an ink rim; others are paper with a `strip`
   * colour edge.
   */
  private tag(word: string, num: string | undefined, x: number, y: number, threat: boolean, strip: string, icon?: Path2D): void {
    const ctx = this.ctx;
    ctx.font = F_STAMP;
    const ww = this.width(F_STAMP, word);
    let nw = 0;
    if (num) {
      ctx.font = F_HAND;
      nw = this.width(F_HAND, num) + 5;
    }
    const iw = icon ? TAG_ICON + 4 : 0;
    const w = 9 + 6 + iw + ww + nw + 7;
    const h = 21;
    const x0 = Math.round(x - w / 2);
    const y0 = Math.round(y - h + 4);
    ctx.fillStyle = SHADE;
    ctx.fillRect(x0 + 1.5, y0 + 2, w, h);
    ctx.fillStyle = threat ? THREAT_HEX : NOTE;
    ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = threat ? this.hatch : strip;
    ctx.fillRect(x0, y0, 9, h);
    ctx.strokeStyle = SEPIA;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(x0 + 9.5, y0);
    ctx.lineTo(x0 + 9.5, y0 + h);
    ctx.stroke();
    if (icon) {
      // the 24-unit icon box scaled to TAG_ICON px, stroked in ink like the HUD's SVG icons
      const k = TAG_ICON / 24;
      ctx.save();
      ctx.translate(x0 + 14, y0 + (h - TAG_ICON) / 2);
      ctx.scale(k, k);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(icon);
      ctx.restore();
    }
    ctx.fillStyle = SEPIA;
    ctx.textAlign = 'left';
    ctx.font = F_STAMP;
    ctx.fillText(word, x0 + 15 + iw, y0 + 15);
    if (num) {
      ctx.font = F_HAND;
      ctx.fillText(num, x0 + 15 + iw + ww + 5, y0 + 16);
    }
    ctx.textAlign = 'center';
  }

  /** An ink-ruled paper bar (HP, progress). */
  private bar(x: number, y: number, w: number, ratio: number, fill: string): void {
    const ctx = this.ctx;
    const x0 = Math.round(x - w / 2) + 0.5;
    const y0 = Math.round(y) + 0.5;
    ctx.fillStyle = NOTE;
    ctx.fillRect(x0, y0, w, 5);
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, w * Math.max(0, Math.min(1, ratio)), 5);
    ctx.strokeStyle = SEPIA;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, w + 1, 6);
  }

  draw(world: World, now: number): void {
    this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.contactOverlay.clear();
    const scope = world.lens?.scope;
    this.peek.clear();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const view = world.view;
    const focus = world.rig.focus;
    const diving = world.rig.diving;
    const army = world.army;
    const fi = PLANES.indexOf(focus);
    // Unit dots fade in between these camera distances (tiles; default view 30, max 78): only once models get small.
    const dots = Math.min(1, Math.max(0, (world.rig.dist - DOTS_FROM) / (DOTS_FULL - DOTS_FROM)));
    this.ink = LINE[focus];
    this.halo = PAPER[focus];
    this.dark = DARK[focus];

    if (view && !diving) {
      if (this.contacts) this.contactOverlay.draw(ctx, world, this.contacts);
      if (dots > 0) this.icons(world, focus, dots);
      this.bars(world, army, focus);
      this.cross(world, army, focus, fi, now);
      this.memory(world, focus, view.tick);
      this.objectives(world, view, army, focus, now);
      this.islandTimes(world, view);
      if (focus === 'surface' || focus === 'depths') {
        if (view.oreCaches) for (const cache of view.oreCaches) {
          const ore = focus === 'surface' ? cache : cache.below;
          if (!ore || ore.alloy <= 0) continue;
          const p = world.project(ore.x - world.size / 2, PLANE_Y[focus] + (focus === 'surface' ? groundAt(ore.x, ore.y, world.layers.surface.field) : 0) + 1, ore.y - world.size / 2);
          if (!p.behind) this.tag('ORE', alloyLabel(ore.alloy), p.x, p.y, false, '#71d6bf');
        }
      }
      if (focus === 'surface') {
        if (view.scorches) for (const scorch of view.scorches) {
          const left = (scorch.until - world.entities.renderTick) / TICK_RATE;
          if (left <= 0) continue;
          const p = world.project(scorch.x - world.size / 2, PLANE_Y.surface + groundAt(scorch.x, scorch.y, world.layers.surface.field) + 1, scorch.y - world.size / 2);
          if (!p.behind) this.tag('BURNING', tenths(left), p.x, p.y, true, THREAT_HEX, iconPath('volatile'));
        }
      }
    }

    if (view) this.speech(world, view, army, now);

    // impact countdowns (surface + sky markers)
    if (view)
      for (const imp of world.fx.falling) {
        const secs = world.fx.secondsLeft(imp, world.sinceView);
        for (const plane of IMPACT_PLANES) {
          if (fadeValue[plane] < 0.3) continue;
          const p = world.project(imp.x - world.size / 2, PLANE_Y[plane] + 1.2, imp.y - world.size / 2);
          if (p.behind) continue;
          this.tag('IMPACT', secs > 0.05 ? tenths(secs) : undefined, p.x, p.y, true, THREAT_HEX);
          this.peek.add(p.x, p.y);
        }
      }

    // planted charges: collapse countdown on the surface (and at the cell in the Depths)
    if (view)
      for (const c of view.charges) {
        const secs = Math.max(0, (c.tick - (view.tick + world.sinceView * TICK_RATE)) / TICK_RATE);
        for (const plane of CHARGE_PLANES) {
          if (fadeValue[plane] < 0.3) continue;
          const p = world.project(c.x + 0.5 - world.size / 2, PLANE_Y[plane] + 1.4, c.y + 0.5 - world.size / 2);
          if (p.behind) continue;
          const ours = c.side === army;
          this.tag(ours ? 'CHARGE' : 'COLLAPSE', tenths(secs), p.x, p.y, !ours, sideHex(army));
        }
      }

    // order pings
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const pg = this.pings[i]!;
      const k = (now - pg.t0) / 550;
      if (k >= 1) {
        this.pings.splice(i, 1);
        continue;
      }
      const wy = PLANE_Y[pg.plane] + (pg.plane === 'sky' ? 1 : 0.15);
      ctx.globalAlpha = 1 - k;
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? pg.color : this.ink;
        ctx.lineWidth = pass ? 2 : 4;
        ctx.beginPath();
        this.circle(world, pg.x, pg.y, wy, 0.3 + k * 0.9);
        ctx.stroke();
        ctx.beginPath();
        this.circle(world, pg.x, pg.y, wy, 0.12 + k * 0.4);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Structure selections follow their projected occupied rectangle, including the Spire.
    for (const tr of world.entities.tracks.values()) {
      if (!tr.visible || tr.e.plane !== world.rig.focus || !footprint(tr.e.kind)) continue;
      const selected = world.selected.has(tr.e.id);
      if (!selected && world.hovered !== tr.e.id) continue;
      const corners = world.projectFootprint(tr);
      if (!corners) continue;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        if (i) ctx.lineTo(corners[i * 2]!, corners[i * 2 + 1]!);
        else ctx.moveTo(corners[0]!, corners[1]!);
      }
      ctx.closePath();
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = selected ? 4 : 3;
      ctx.stroke();
      ctx.strokeStyle = sideHex(tr.e.side);
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
    }

    // placement / targeting preview: a wash of the order's colour inside an ink rim
    const pv = this.preview;
    if (pv) {
      let wy = pv.height ?? PLANE_Y[pv.plane] + 0.15;
      // Surface previews rest on the highest cell they cover so they stay on plateau tops (and above lode rock).
      if (pv.height === undefined && pv.plane === 'surface') {
        const field = world.layers.surface.field;
        let top = groundAt(pv.x, pv.y, field);
        if (pv.footprint) for (const cell of pv.footprint.cells) top = Math.max(top, groundAt(cell.x + 0.5, cell.y + 0.5, field));
        wy += top;
      }
      if (pv.buildRadius && view?.match) this.buildRadius(world, view, view.match, army);
      if (pv.berth !== undefined) {
        const h = pv.berth / 2;
        ctx.beginPath();
        for (let j = 0; j < 4; j++) {
          const p = world.project(pv.x + (j === 1 || j === 2 ? h : -h) - world.size / 2, wy, pv.y + (j >= 2 ? h : -h) - world.size / 2);
          if (j) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.strokeStyle = this.ink;
        ctx.lineWidth = 1.25;
        ctx.stroke();
        const c = world.project(pv.x - world.size / 2, wy, pv.y - world.size / 2);
        ctx.beginPath();
        ctx.arc(c.x, c.y, BERTH_DOT, 0, Math.PI * 2);
        ctx.fillStyle = pv.color;
        ctx.fill();
        ctx.strokeStyle = this.ink;
        ctx.lineWidth = 1;
        ctx.stroke();
        this.tag(pv.label, undefined, c.x, c.y - BERTH_CHIP, false, pv.color);
      } else if (pv.footprint) {
        for (const cell of pv.footprint.cells) {
          ctx.beginPath();
          for (let j = 0; j < 4; j++) {
            const p = world.project(cell.x + (j === 1 || j === 2 ? 1 : 0) - world.size / 2, wy, cell.y + (j >= 2 ? 1 : 0) - world.size / 2);
            if (j) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          }
          ctx.closePath();
          const color = cell.valid ? pv.color : INVALID;
          ctx.fillStyle = color;
          ctx.globalAlpha = cell.valid ? 0.22 : 0.48;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = this.ink;
          ctx.lineWidth = 3.5;
          ctx.stroke();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.75;
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        // A ring broken by the camera keeps its drawable arcs, unwashed.
        let closed = true;
        if (pv.radius > 0) closed = this.circle(world, pv.x, pv.y, wy, pv.radius);
        else {
          const cx = Math.floor(pv.x), cy = Math.floor(pv.y);
          for (let j = 0; j < 4; j++) {
            const p = world.project(cx + (j === 1 || j === 2 ? 1 : 0) - world.size / 2, wy, cy + (j >= 2 ? 1 : 0) - world.size / 2);
            if (j) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          }
          ctx.closePath();
        }
        if (closed) {
          ctx.fillStyle = pv.color;
          ctx.globalAlpha = 0.16;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = this.ink;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.strokeStyle = pv.color;
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }
      if (pv.berth === undefined) {
        const c = world.project(pv.x - world.size / 2, wy, pv.y - world.size / 2);
        this.label(pv.label, c.x, c.y - 18, this.ink, F_PREVIEW);
      }
    }

    // drag box: a dashed pencil frame with a faint wash
    const d = this.drag;
    if (d) {
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      const w = Math.abs(d.x1 - d.x0);
      const hh = Math.abs(d.y1 - d.y0);
      ctx.fillStyle = this.ink;
      ctx.globalAlpha = 0.07;
      ctx.fillRect(x, y, w, hh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(DASH);
      ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
      ctx.setLineDash(NO_DASH);
    }
    if (scope) this.dropScope(world, scope, world.lens.openness);
  }

  /**
   * The predicted drop or strike over the holo lens (tools/drop.ts), in perspective on the target's holo layer:
   * each tow's fall from where it hangs in Orbit down to the landing, its release column and deorbit reach, the public
   * blast ring, short motion trails of what stands in it (it may move away), and stamps beside the landing for the
   * payload and fall time and every warning (out of reach, inside the hull, an island over the blast, Sky screens,
   * friendly fire). Opens and closes with the hologram.
   */
  private dropScope(world: World, s: Lens, open: number): void {
    const f = s.drop;
    if (!f.active || open <= 0) return;
    const ctx = this.ctx;
    const h = s.layerY(s.target);
    const drop = f.kind === 'drop';
    const half = s.size / 2;
    const ox = s.viewportLeft, oy = s.viewportTop;
    // A refused drop (out of reach, core in the hull) is a dashed pencil ring: no strike red where nothing will land.
    const color = f.valid ? DROP_HEX : DROP_REFUSED;
    ctx.globalAlpha = open;
    ctx.setLineDash(DASH);
    for (let i = 0; i < f.count; i++) {
      const fx = f.from[i * 2]!, fy = f.from[i * 2 + 1]!;
      ctx.beginPath();
      const rock = s.project(fx - half, AIM_Y[s.source], fy - half);
      ctx.moveTo(rock.x - ox, rock.y - oy);
      const land = s.project(f.x - half, h, f.y - half);
      ctx.lineTo(land.x - ox, land.y - oy);
      if (drop) {
        this.layerCircle(s, fx, fy, h, 0.35);
        this.layerCircle(s, fx, fy, h, f.reach);
      }
      ctx.strokeStyle = this.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = drop && Math.hypot(fx - f.x, fy - f.y) > f.reach ? INVALID : DROP_PATH;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    ctx.setLineDash(f.valid ? NO_DASH : DASH);
    ctx.beginPath();
    this.layerCircle(s, f.x, f.y, h, Math.max(f.radius, STRIKE_MARK));
    if (f.valid) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.16 * open;
      ctx.fill();
      ctx.globalAlpha = open;
    }
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    // Motion trails: where each unit in or near the ring came from over the last snapshots.
    ctx.beginPath();
    for (const tr of world.entities.tracks.values()) {
      if (!tr.visible || tr.n < 2 || !s.stack.includes(tr.e.plane) || footprint(tr.e.kind)) continue;
      if (Math.hypot(tr.rx - f.x, tr.ry - f.y) > f.radius * 1.5) continue;
      const x0 = tr.sx[0]!, y0 = tr.sy[0]!;
      if (Math.hypot(tr.rx - x0, tr.ry - y0) < 0.15) continue;
      const ly = s.layerY(tr.e.plane);
      const a = s.project(x0 - half, ly, y0 - half);
      ctx.moveTo(a.x - ox, a.y - oy);
      const b = s.project(tr.rx - half, ly, tr.ry - half);
      ctx.lineTo(b.x - ox, b.y - oy);
    }
    ctx.strokeStyle = this.halo;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (open < 1) return;
    const land = s.project(f.x - half, h, f.y - half);
    const cx = land.x - ox, ly = land.y;
    let y = Math.max(ly, s.project(f.x - half, h, f.y + f.radius - half).y, s.project(f.x - half, h, f.y - f.radius - half).y) - oy + 26;
    const friendly = f.friendly.length;
    this.tag(!drop ? (f.bomb ? 'BOMB' : 'STRIKE') : f.core ? 'CORE' : DROP_WORD[f.rock ?? 'medium'], drop ? tenths(f.fall) : undefined, cx, y, false, color);
    if (f.outOfReach) this.tag('OUT OF REACH', undefined, cx, y += DROP_STAMP_STEP, true, THREAT_HEX);
    if (f.inHull) this.tag('INSIDE HULL', undefined, cx, y += DROP_STAMP_STEP, true, THREAT_HEX);
    if (friendly) this.tag('FRIENDLY FIRE', times(friendly), cx, y += DROP_STAMP_STEP, true, THREAT_HEX);
    if (f.ownIsland) this.tag('OWN ISLAND OVER', undefined, cx, y += DROP_STAMP_STEP, true, THREAT_HEX);
    if (f.enemyIsland) this.tag('ENEMY ISLAND OVER', undefined, cx, y += DROP_STAMP_STEP, true, THREAT_HEX);
    if (f.screens) this.tag(drop ? 'SKY SCREEN' : 'RETURN FIRE', times(f.screens), cx, y += DROP_STAMP_STEP, true, THREAT_HEX);
  }

  /** Trace a map circle on a holo layer (world height `y`) into the current path, through the lens's camera. */
  private layerCircle(s: Lens, x: number, z: number, y: number, r: number): void {
    const half = s.size / 2;
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const p = s.project(x - half + Math.cos(a) * r, y, z - half + Math.sin(a) * r);
      if (i) this.ctx.lineTo(p.x - s.viewportLeft, p.y - s.viewportTop);
      else this.ctx.moveTo(p.x - s.viewportLeft, p.y - s.viewportTop);
    }
  }

  /** Team-coloured, ink-rimmed dots under units (triangles for air) when zoomed out; `alpha` fades them in. */
  private icons(world: World, focus: Plane, alpha: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = alpha;
    for (const tr of world.entities.tracks.values()) {
      const e = tr.e;
      if (e.plane !== focus || !tr.visible || !IS_UNIT.has(e.kind)) continue;
      const air = AIR.has(e.kind);
      const p = world.project(tr.rx - world.size / 2, tr.wy, tr.ry - world.size / 2);
      if (p.behind) continue;
      const s = 5;
      ctx.fillStyle = sideHex(e.side);
      ctx.beginPath();
      if (air) {
        ctx.moveTo(p.x, p.y - s - 1);
        ctx.lineTo(p.x + s, p.y + s - 1);
        ctx.lineTo(p.x - s, p.y + s - 1);
        ctx.closePath();
      } else ctx.arc(p.x, p.y, s * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private bars(world: World, army: ArmyId, focus: Plane): void {
    for (const tr of world.entities.tracks.values()) {
      const e = tr.e;
      if (e.plane !== focus || !tr.visible || isNeutralKind(e.kind)) continue;
      const sel = world.selected.has(e.id);
      const hov = world.hovered === e.id;
      const structure = STRUCTURE[e.kind] === true;
      const damaged = e.hp < e.maxHp;
      if (!sel && !hov && !(damaged && (structure || e.side !== army))) continue;
      const p = world.project(tr.rx - world.size / 2, tr.wy + (e.kind === 'spire' ? 6 : 1.3), tr.ry - world.size / 2);
      if (p.behind) continue;
      if (sel) this.peek.add(p.x, p.y);
      const w = structure ? 46 : 28;
      const ratio = e.hp / e.maxHp;
      const own = e.side === army;
      this.bar(p.x, p.y, w, ratio, own ? (ratio > 0.6 ? HP_GOOD : ratio > 0.3 ? HP_MID : HP_LOW) : sideHex(e.side));
      if (e.progress !== undefined && e.progress < 1 && PROGRESS_COLOR[e.state]) {
        this.bar(p.x, p.y + 7, w, e.progress, PROGRESS_COLOR[e.state]!);
      }
    }
    if (focus !== 'sky' && focus !== 'surface') return;
    const ctx = this.ctx;
    const zone = focus === 'sky' ? 'island' : 'post';
    const rules = world.view?.match.rules.surface;
    const points = zone === 'post' && world.view?.match ? contestedPoints(world.view.match) : undefined;
    for (const tr of world.entities.tracks.values()) {
      const e = tr.e;
      if (e.kind !== zone) continue;
      const lift = zone === 'island' ? 2.4 : 1.6;
      const p = world.project(tr.rx - world.size / 2, tr.wy + lift, tr.ry - world.size / 2);
      if (p.behind) continue;
      // A post we hold: a faint dashed aura of its healing radius on the ground.
      if (zone === 'post' && rules && e.side === army) {
        const g = world.project(tr.rx - world.size / 2, tr.wy, tr.ry - world.size / 2);
        const edge = world.project(tr.rx + rules.postHealRadius - world.size / 2, tr.wy, tr.ry - world.size / 2);
        if (!g.behind && !edge.behind) {
          ctx.strokeStyle = PLANE_ACCENT.surface;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1.5;
          ctx.setLineDash(DASH);
          ctx.beginPath();
          ctx.arc(g.x, g.y, Math.abs(edge.x - g.x), 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
          ctx.globalAlpha = 1;
        }
      }
      // A contested point: a standing ring of its capture radius on the ground in the holder's colour (neutral ink when
      // nobody holds it), so the objective reads at a glance from any zoom.
      if (rules && points?.has(e.id)) {
        const g = world.project(tr.rx - world.size / 2, tr.wy, tr.ry - world.size / 2);
        const edge = world.project(tr.rx + rules.postCaptureRadius - world.size / 2, tr.wy, tr.ry - world.size / 2);
        if (!g.behind && !edge.behind) {
          ctx.strokeStyle = sideHex(e.side);
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(g.x, g.y, Math.abs(edge.x - g.x), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      // A contested zone (hostile alliances on it: capture frozen) shows its ring even before any progress.
      const contested = e.state === 'contested';
      const progress = e.progress ?? 0;
      if (!contested && (progress <= 0 || progress >= 1)) continue;
      ctx.strokeStyle = NOTE;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = contested ? THREAT_HEX : this.ink;
      ctx.lineWidth = contested ? 2 : 1;
      if (contested) ctx.setLineDash(DASH);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 19, 0, Math.PI * 2);
      ctx.moveTo(p.x + 13, p.y);
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.stroke();
      if (contested) ctx.setLineDash(NO_DASH);
      if (progress <= 0) continue;
      // Our own zone being taken fills in the threat colour; any other capture in the plane's accent.
      ctx.strokeStyle = e.side === army ? THREAT_HEX : PLANE_ACCENT[focus];
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress));
      ctx.stroke();
    }
  }

  /** Hostiles on the planes directly above / below the focus, projected onto the focused plane. */
  private cross(world: World, army: ArmyId, focus: Plane, fi: number, now: number): void {
    const ctx = this.ctx;
    const view = world.view!;
    const y0 = PLANE_Y[focus] + 0.3;
    ctx.globalAlpha = 0.7 + Math.sin(now / 180) * 0.3;
    let n = 0;
    for (const tr of world.entities.tracks.values()) {
      const e = tr.e;
      if (relation(army, e.side) !== 'hostile' || n > 60) continue;
      if (this.contactOverlay.drawn.has(e.id)) continue;
      const pi = PLANES.indexOf(e.plane);
      const up = pi === fi + 1 && CROSS[focus].above[e.kind] === true;
      const down = pi === fi - 1 && CROSS[focus].below[e.kind] === true;
      if (!up && !down) continue;
      const p = world.project(tr.rx - world.size / 2, y0, tr.ry - world.size / 2);
      if (p.behind) continue;
      n++;
      this.chevron(p.x, p.y, up, sideHex(e.side));
    }
    // tremors (sensed enemy diggers/sappers below our surface presence)
    if (focus === 'surface' || focus === 'depths')
      for (const t of view.tremors) {
        const p = world.project(t.x + 0.5 - world.size / 2, y0, t.y + 0.5 - world.size / 2);
        if (p.behind) continue;
        this.chevron(p.x, p.y, focus === 'depths', t.breach ? THREAT_HEX : TREMOR);
        if (focus !== 'surface') continue;
        ctx.globalAlpha = 1;
        if (t.breach) this.tag('BREACH INCOMING', undefined, p.x, p.y - 12, true, THREAT_HEX);
        else this.label('TREMOR', p.x, p.y - 12, this.ink, F_STAMP_S);
        ctx.globalAlpha = 0.7 + Math.sin(now / 180) * 0.3;
      }
    // falling asteroids seen from the Depths
    if (focus === 'depths')
      for (const imp of world.fx.falling) {
        const p = world.project(imp.x - world.size / 2, y0, imp.y - world.size / 2);
        if (!p.behind) this.chevron(p.x, p.y, true, THREAT_HEX);
      }
    ctx.globalAlpha = 1;
  }

  /** A double chevron pointing up / down: an ink stroke under the colour stroke. */
  private chevron(x: number, y: number, up: boolean, color: string): void {
    const ctx = this.ctx;
    const d = up ? -1 : 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? color : SEPIA;
      ctx.lineWidth = pass ? 2.25 : 4.5;
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 2 * d);
      ctx.lineTo(x, y + 4 * d);
      ctx.lineTo(x + 6, y - 2 * d);
      ctx.moveTo(x - 6, y - 7 * d);
      ctx.lineTo(x, y - 1 * d);
      ctx.lineTo(x + 6, y - 7 * d);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  /** Wrap a speech once per message (its object identity), measured in the note face. */
  private wrap(s: object, text: string): Wrapped {
    let wr = this.wrapped.get(s);
    if (wr) return wr;
    const lines: string[] = [];
    let line = '';
    let more = false;
    for (const word of text.split(' ')) {
      if (lines.length === 3) {
        more = true;
        break;
      }
      if ((line + ' ' + word).trim().length > 34 && line) {
        lines.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    if (lines.length < 3 && line) lines.push(line);
    else if (line) more = true;
    if (more) lines[2] = `${lines[2]}…`;
    this.ctx.font = F_NOTE;
    let w = 0;
    for (const l of lines) w = Math.max(w, this.ctx.measureText(l).width);
    wr = { lines, w };
    this.wrapped.set(s, wr);
    return wr;
  }

  /** Agent speech over our Spire segment per plane: a paper note in hand lettering (canvas text, never HTML). */
  private speech(world: World, view: View, army: ArmyId, now: number): void {
    const ctx = this.ctx;
    const list = world.speeches;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.until < now) list.splice(i, 1);
    let sp = view.match!.armies[0]!.spireAt;
    for (const a of view.match!.armies) if (a.id === army) sp = a.spireAt;
    for (const s of list) {
      const f = fadeValue[s.plane];
      if (f < 0.15) continue;
      const { lines, w } = this.wrap(s, s.text);
      // Above the drawn crystal's bob, seated where the Spire itself stands (terrain-supported on Surface).
      const p = world.project(sp.x - world.size / 2, spireBaseY(s.plane, sp.x, sp.y, world.layers.surface.field) + SPIRE_SPAN[s.plane][1] + 1, sp.y - world.size / 2);
      if (p.behind) continue;
      const bw = w + 26;
      const bh = lines.length * 18 + 12;
      const x = Math.round(p.x - bw / 2);
      const y = Math.round(p.y - bh - 12);
      ctx.globalAlpha = Math.min(1, f * 1.5) * Math.min(1, (s.until - now) / 600);
      // cast shadow, then the note with its tail, then the plane's wash down the left edge
      ctx.fillStyle = SHADE;
      ctx.fillRect(x + 2, y + 3, bw, bh);
      ctx.fillStyle = NOTE;
      ctx.strokeStyle = SEPIA;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + bw, y);
      ctx.lineTo(x + bw, y + bh);
      ctx.lineTo(p.x + 7, y + bh);
      ctx.lineTo(p.x - 2, y + bh + 10);
      ctx.lineTo(p.x - 5, y + bh);
      ctx.lineTo(x, y + bh);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = PLANE_ACCENT[s.plane];
      ctx.fillRect(x + 1, y + 1, 6, bh - 2);
      ctx.stroke();
      ctx.fillStyle = SEPIA;
      ctx.textAlign = 'left';
      ctx.font = F_NOTE;
      for (let j = 0; j < lines.length; j++) ctx.fillText(lines[j]!, x + 15, y + 20 + j * 18);
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;
    }
  }

  /** Time marks (+15 s … +60 s) along the drift path of hovered / selected islands. */
  private islandTimes(world: World, view: View): void {
    if (fadeValue.sky < 0.3) return;
    const tick = world.entities.renderTick;
    for (const p of view.islands) {
      if (world.hovered !== p.id && !world.selected.has(p.id)) continue;
      // An indefinite hold/return has no honest future drift ETA; resume marks only after route rejoin.
      if (p.pausedAt !== undefined) continue;
      for (let j = 1; j <= 4; j++) {
        const q = islandAt(p, tick + (j * PATH_AHEAD_S * TICK_RATE) / 4, XY);
        const s = world.project(q.x - world.size / 2, PLANE_Y.sky + 0.6, q.y - world.size / 2);
        if (s.behind) continue;
        this.label(ISLAND_MARKS[j - 1]!, s.x, s.y - 8, this.ink, j === 4 ? F_HAND : F_HAND_S);
      }
    }
  }

  /** "Last seen" notes in red pencil on remembered enemy structures. */
  private memory(world: World, focus: Plane, tick: number): void {
    const pencil = this.dark ? RED_PENCIL.dark : RED_PENCIL.light;
    for (const m of world.entities.memory) {
      if (m.plane !== focus || m.kind === 'spire' || world.entities.tracks.has(m.id)) continue;
      const p = world.project(m.x - world.size / 2, PLANE_Y[m.plane] + 1.6, m.y - world.size / 2);
      if (p.behind) continue;
      this.label(lastSeen(Math.max(0, Math.round((tick - m.seen) / TICK_RATE))), p.x, p.y, pencil, F_HAND_S);
    }
  }

  /** Every hostile Spire still in play as an objective (DESIGN §15.12); an all-seeing observer sees every Spire, named. */
  private objectives(world: World, view: View, army: ArmyId, focus: Plane, now: number): void {
    const match = view.match!;
    const all = world.observing === 'all';
    let hostiles = 0;
    for (const a of match.armies) if (all || hostileSide(match, army, a.id)) hostiles++;
    for (const a of match.armies)
      if ((all || hostileSide(match, army, a.id)) && !view.eliminated.includes(a.id)) this.objective(world, a.id, a.colour, a.spireAt, all || hostiles > 1, focus, now);
  }

  /** A hostile Spire as an objective: marker + segment HP when known; edge arrow when off-screen. */
  private objective(world: World, foe: ArmyId, colour: Colour, sp: { x: number; y: number }, named: boolean, focus: Plane, now: number): void {
    const ctx = this.ctx;
    const wy = spireBaseY(focus, sp.x, sp.y, world.layers.surface.field) + SPIRE_SPAN[focus][1] + 1.5;
    const p = world.project(sp.x - world.size / 2, wy, sp.y - world.size / 2);
    let hp: number | undefined;
    for (const tr of world.entities.tracks.values())
      if (tr.e.kind === 'spire' && tr.e.side === foe && tr.e.plane === focus) hp = tr.e.hp / tr.e.maxHp;
    const m = 40;
    // below the top bar, with room for the label above the marker
    const on = !p.behind && p.x > m && p.y > TOP_BAR + 50 && p.x < this.w - m && p.y < this.h - m;
    const col = SIDE_HEX[colour];
    const name = named ? SPIRE_LABEL[colour] : 'ENEMY SPIRE';
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    if (on) {
      const s = 7 + Math.sin(now / 300) * 1.5;
      const px = p.x;
      const py = p.y;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(px, py - s);
      ctx.lineTo(px + s, py);
      ctx.lineTo(px, py + s);
      ctx.lineTo(px - s, py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      this.label(focus === 'surface' ? (named ? OBJECTIVE_LABEL[colour] : 'ENEMY SPIRE · OBJECTIVE') : name, px, py - 14, this.ink, F_STAMP);
      if (hp !== undefined) this.bar(px, py + 12, 64, hp, col);
      return;
    }
    // off-screen: arrow at the edge (of the area below the top bar) pointing toward it
    const cx = this.w / 2;
    const cy = (this.h + TOP_BAR) / 2;
    let dx = p.x - cx;
    let dy = p.y - cy;
    if (p.behind) {
      dx = -dx;
      dy = -dy;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const k = Math.min((this.w / 2 - m) / Math.abs(dx || 1e-6), ((this.h - TOP_BAR) / 2 - m) / Math.abs(dy || 1e-6));
    const ax = cx + dx * k;
    const ay = cy + dy * k;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-6, -8);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    this.label(name, ax - dx * 28, ay - dy * 28 + 4, this.ink, F_STAMP_S);
  }
}
