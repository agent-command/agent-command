/**
 * Short HUD motion on the Web Animations API (Field Journal: calm, ease-out, ~150-250 ms). No timers and no frame
 * loop: the browser runs each animation and nothing is left ticking once it ends; a widget cancels whatever is still
 * running when it is disposed. Also the player's motion preferences: the system's reduced motion and the "Dive
 * effects" setting (world/dive.ts).
 */
export const EASE_OUT = 'cubic-bezier(0.22, 0.7, 0.3, 1)';

/** The player asked for less motion: no slides or transforms, opacity changes only. */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const DIVE_FX_KEY = 'agent-command.dive-fx';
const diveListeners = new Set<(on: boolean) => void>();
let diveFx: boolean | undefined;

/** Settings "Dive effects": the inked plane transition (speed lines, smear, tint). On unless the player switched it off. */
export function diveEffects(): boolean {
  if (diveFx === undefined) {
    try {
      diveFx = localStorage.getItem(DIVE_FX_KEY) !== 'off';
    } catch {
      diveFx = true; // storage unavailable: default
    }
  }
  return diveFx;
}

export function setDiveEffects(on: boolean): void {
  if (on === diveEffects()) return;
  diveFx = on;
  try {
    localStorage.setItem(DIVE_FX_KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable: this session only */
  }
  for (const l of diveListeners) l(on);
}

/** Dive effects changes. Returns unsubscribe. */
export function onDiveEffects(listener: (on: boolean) => void): () => void {
  diveListeners.add(listener);
  return () => diveListeners.delete(listener);
}

/** Where each element is drawn now (its top, transforms included). Read-only: take it before any DOM write. */
export function measureTops(els: Iterable<Element>): Map<Element, number> {
  const tops = new Map<Element, number>();
  for (const el of els) tops.set(el, el.getBoundingClientRect().top);
  return tops;
}

/** The animations one widget runs. */
export class Motion {
  private readonly running = new Set<Animation>();
  /** The FLIP slide of each element, replaced when it moves again mid-slide. */
  private readonly slides = new Map<Element, Animation>();

  /** Animate `el`; `done` runs when the animation ends (at once where the API is missing), never when it is cancelled. */
  play(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions, done?: () => void): Animation | undefined {
    if (typeof el.animate !== 'function') {
      done?.();
      return undefined;
    }
    const a = el.animate(keyframes, options);
    this.running.add(a);
    a.onfinish = () => {
      a.onfinish = a.oncancel = null;
      this.running.delete(a);
      // Filled effects otherwise keep their element alive after removal and evade dispose().
      a.cancel();
      done?.();
    };
    a.oncancel = () => this.running.delete(a);
    return a;
  }

  /**
   * The second half of a FLIP: after the DOM writes, slide every element of `before` (from `measureTops`, which saw any
   * slide still running) from where it was drawn to its new place. One layout read for all elements, then the writes.
   */
  flip(before: Map<Element, number>, duration: number): void {
    for (const el of before.keys()) {
      this.slides.get(el)?.cancel();
      this.slides.delete(el);
    }
    const moves: [Element, number][] = [];
    for (const [el, top] of before) {
      if (!el.isConnected) continue;
      const dy = top - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) moves.push([el, dy]);
    }
    for (const [el, dy] of moves) {
      const a = this.play(el, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration, easing: EASE_OUT }, () => this.slides.delete(el));
      if (a) this.slides.set(el, a);
    }
  }

  /** Cancel everything still running. */
  dispose(): void {
    for (const a of this.running) a.cancel();
    this.running.clear();
    this.slides.clear();
  }
}
