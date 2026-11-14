export interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Ignore subpixel rounding at shared edges, not real intersections. */
export function overlaps(a: Box, b: Box, tolerance = 0.5): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
}

export function contains(outer: Box, inner: Box, tolerance = 0.5): boolean {
  return inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance
    && inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
}

export function layoutErrors(boxes: readonly Box[], width: number, height: number): string[] {
  const viewport = { name: 'viewport', left: 0, top: 0, right: width, bottom: height };
  const errors: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    if (a.right <= a.left || a.bottom <= a.top) errors.push(`${a.name}: empty panel`);
    if (!contains(viewport, a)) errors.push(`${a.name}: outside viewport`);
    for (const b of boxes.slice(i + 1)) if (overlaps(a, b)) errors.push(`${a.name} overlaps ${b.name}`);
  }
  return errors;
}
