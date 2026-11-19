/**
 * Game cursors: the converted C&C Generals cursors (public/cursors/, see scripts/cursors.mjs) as CSS `cursor` values.
 * 1x and nearest-neighbour 2x images through image-set so HiDPI stays pixel-crisp, the plain 1x URL for browsers
 * without image-set cursors, then a CSS keyword. Values are built once at load (tools read them every pointer move).
 */
import { CURSOR_HOTSPOTS, type CursorName } from './cursor-hotspots.ts';

const base = `${import.meta.env.BASE_URL}cursors/`;

/** CSS `cursor` value for a game cursor, falling back to `keyword`. */
export function cursor(name: CursorName, keyword: string): string {
  const { x, y } = CURSOR_HOTSPOTS[name];
  const one = `url(${base}${name}.png)`;
  return `image-set(${one} 1x, url(${base}${name}@2x.png) 2x) ${x} ${y}, ${one} ${x} ${y}, ${keyword}`;
}

/** The cursors the client uses, by meaning. */
export const CURSOR = {
  pointer: cursor('sccpointer', 'default'),
  select: cursor('sccselect', 'pointer'),
  attack: cursor('sccattack', 'crosshair'),
  attackMove: cursor('sccattmov', 'crosshair'),
  move: cursor('sccmove', 'crosshair'),
  waypoint: cursor('sccwaypoint', 'crosshair'),
  rally: cursor('sccrallypnt', 'crosshair'),
  beacon: cursor('sccplacebeacon', 'crosshair'),
  place: cursor('sccplace', 'crosshair'),
  build: cursor('sccrepair', 'crosshair'),
  charge: cursor('scctimedchg', 'crosshair'),
  sabotage: cursor('sccknifeattack', 'crosshair'),
  scan: cursor('sccspydrone', 'crosshair'),
  strike: cursor('sccsdiuplink', 'crosshair'),
  precise: cursor('sccsniper', 'crosshair'),
  enter: cursor('sccenter', 'default'),
  capture: cursor('sccguard', 'pointer'),
  grapple: cursor('sccfriendly', 'crosshair'),
  invalid: cursor('sccnoaction', 'not-allowed'),
  /** "Look at this": the recon drone, the set's closest thing to a magnifier. */
  view: cursor('sccspydrone', 'zoom-in'),
} as const;

/**
 * Edge-scroll arrows, indexed by screen direction in 45° steps clockwise from "right" (0 right, 2 down, 4 left,
 * 6 up), matching the source set's sccscroll0–7.
 */
export const SCROLL_CURSORS = [
  cursor('sccscroll0', 'e-resize'),
  cursor('sccscroll1', 'se-resize'),
  cursor('sccscroll2', 's-resize'),
  cursor('sccscroll3', 'sw-resize'),
  cursor('sccscroll4', 'w-resize'),
  cursor('sccscroll5', 'nw-resize'),
  cursor('sccscroll6', 'n-resize'),
  cursor('sccscroll7', 'ne-resize'),
] as const;

/** Edge-scroll cursor for an edge vector (x: −1 left … 1 right, y: −1 top … 1 bottom; not both 0). */
export function scrollCursor(x: number, y: number): string {
  const i = Math.round(Math.atan2(y, x) / (Math.PI / 4));
  return SCROLL_CURSORS[(i + 8) % 8]!;
}

/**
 * The battlefield input canvas's cursor: one per canvas (the Overlay owns it) for every session that takes the canvas.
 * Only player Controls set game cursors (tools, smart actions, edge scroll); the observer never does, so the canvas
 * keeps whatever was last set until something resets it. `reset` returns it to the page cursor (`--cursor-default`,
 * inherited) whenever no player session can be pointing at it: the pointer leaves, Controls are disposed, the world
 * resets (mode change, entry, rotation) and the observer enters. Writes only on change: values are long image-set strings.
 */
export class CanvasCursor {
  private readonly el: { readonly style: { cursor: string } };
  private now = '';

  constructor(el: { readonly style: { cursor: string } }) {
    this.el = el;
    el.style.cursor = '';
  }

  /** The game cursor set now ('' = the page cursor). */
  get value(): string { return this.now; }

  set(value: string): void {
    if (value !== this.now) this.el.style.cursor = this.now = value;
  }

  reset(): void { this.set(''); }
}

/**
 * Sets the page-wide cursors as CSS variables: `--cursor-default` (the game pointer; #app inherits it),
 * `--cursor-link` (buttons, links and other clickables use it instead of the OS hand), `--cursor-invalid` and
 * `--cursor-view` (click to inspect, e.g. the battlefield preview).
 */
export function installCursors(): void {
  const s = document.documentElement.style;
  s.setProperty('--cursor-default', CURSOR.pointer);
  s.setProperty('--cursor-link', CURSOR.pointer);
  s.setProperty('--cursor-invalid', CURSOR.invalid);
  s.setProperty('--cursor-view', CURSOR.view);
}
