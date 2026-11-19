export interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HudBounds {
  top?: ViewportRect;
  bottom?: ViewportRect;
  left?: ViewportRect;
  right?: ViewportRect;
}

/** The clear central world rectangle, in canvas-local CSS pixels (not drawing-buffer pixels). */
export function hudSafeArea(viewport: ViewportRect, panels: HudBounds): ViewportRect {
  const width = Math.max(0, viewport.right - viewport.left);
  const height = Math.max(0, viewport.bottom - viewport.top);
  const clampX = (x: number) => Math.max(0, Math.min(width, x - viewport.left));
  const clampY = (y: number) => Math.max(0, Math.min(height, y - viewport.top));
  const left = clampX(panels.left?.right ?? viewport.left);
  const right = clampX(panels.right?.left ?? viewport.right);
  const top = clampY(panels.top?.bottom ?? viewport.top);
  const bottom = clampY(panels.bottom?.top ?? viewport.bottom);
  // An impossibly small viewport has no clear area: collapse each crossed interval to its midpoint.
  return {
    left: Math.min(left, (left + right) / 2), right: Math.max(right, (left + right) / 2),
    top: Math.min(top, (top + bottom) / 2), bottom: Math.max(bottom, (top + bottom) / 2),
  };
}

/** Observe layout, never read DOM geometry in the render loop or change the HUD's own layout. */
export function observeHudSafeArea(hud: HTMLElement, canvas: HTMLCanvasElement, update: (area: ViewportRect) => void): () => void {
  // The columns include the rail/feed/console and queue/minimap, including their reserved gaps.
  const panels = {
    top: hud.querySelector<HTMLElement>('.topbar')!,
    bottom: hud.querySelector<HTMLElement>('.card')!,
    left: hud.querySelector<HTMLElement>('.journal-col')!,
    right: hud.querySelector<HTMLElement>('.field-col')!,
  };
  const bounds = (element: HTMLElement): DOMRect | undefined => element.getClientRects().length ? element.getBoundingClientRect() : undefined;
  const measure = () => update(hudSafeArea(canvas.getBoundingClientRect(), {
    top: bounds(panels.top), bottom: bounds(panels.bottom), left: bounds(panels.left), right: bounds(panels.right),
  }));
  const observer = new ResizeObserver(measure);
  observer.observe(canvas);
  observer.observe(hud);
  for (const panel of Object.values(panels)) observer.observe(panel);
  measure();
  return () => observer.disconnect();
}
