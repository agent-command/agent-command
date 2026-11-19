/**
 * Peek-through for the translucent HUD overlays (event feed, build queue): when something the player is tracking
 * (a selected unit, an impact countdown) is drawn underneath one, that panel fades so the battlefield shows through.
 * The overlay records those screen points while it draws; this checks them against the panels a few times a second,
 * so the per-frame cost is only the point recording (a preallocated buffer, no allocation).
 */

/** Most tracked points per frame; extra points are ignored (a selection that large already covers the screen). */
export const PEEK_MAX = 64;
/** Milliseconds between panel checks: fast enough to feel immediate, far below frame rate. */
const CHECK_MS = 200;
/** Panels that peek. Buttons and reading surfaces (top bar, command card, rail) stay opaque. */
const SELECTOR = '.feed, .queue-panel';

export class PeekPoints {
  /** x, y pairs in CSS pixels of the overlay canvas (which covers the viewport from its top-left corner). */
  readonly xy = new Float32Array(PEEK_MAX * 2);
  n = 0;

  clear(): void {
    this.n = 0;
  }

  add(x: number, y: number): void {
    if (this.n >= PEEK_MAX) return;
    this.xy[this.n * 2] = x;
    this.xy[this.n * 2 + 1] = y;
    this.n++;
  }
}

/** Whether any of the first `n` points lies inside the rectangle (edges inclusive). */
export function anyInside(xy: Float32Array, n: number, left: number, top: number, right: number, bottom: number): boolean {
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2]!;
    const y = xy[i * 2 + 1]!;
    if (x >= left && x <= right && y >= top && y <= bottom) return true;
  }
  return false;
}

export class Peek {
  private next = 0;

  /** Toggles `peek` on each overlay panel that covers a tracked point; throttled to CHECK_MS. */
  update(now: number, points: PeekPoints): void {
    if (now < this.next) return;
    this.next = now + CHECK_MS;
    for (const el of document.querySelectorAll<HTMLElement>(SELECTOR)) {
      const r = el.getBoundingClientRect();
      const on = r.width > 0 && anyInside(points.xy, points.n, r.left, r.top, r.right, r.bottom);
      if (el.classList.contains('peek') !== on) el.classList.toggle('peek', on);
    }
  }
}
