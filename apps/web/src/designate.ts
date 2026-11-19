import { VISION_BITS_PER_WORD, type View } from '@agent-command/game/contract';

export type DigPriority = 0 | 1 | 2;
export interface DigRect { x0: number; y0: number; x1: number; y1: number }
export interface DigPoint { x: number; y: number }
export interface DigModifiers { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }

/** Clear wins over urgent; modifiers belong to the gesture, never the unit order queue. */
export function digPriority(modifiers: DigModifiers): DigPriority {
  return modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey ? 0 : modifiers.shiftKey ? 2 : 1;
}

/** Inclusive tile rectangle, clipped at the map edge; either drag direction gives the same cells. */
export function digRect(start: DigPoint, end: DigPoint, size: number): DigRect | undefined {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return undefined;
  const cell = (n: number) => Math.max(0, Math.min(size - 1, Math.floor(n)));
  const ax = cell(start.x), ay = cell(start.y), bx = cell(end.x), by = cell(end.y);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export const digArea = (r: DigRect): number => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

/** The wire uses 30 bits per word, exactly like vision, not JavaScript's 32-bit word size. */
export function digTagged(words: readonly number[], cell: number): boolean {
  return ((words[Math.floor(cell / VISION_BITS_PER_WORD)] ?? 0) & (1 << (cell % VISION_BITS_PER_WORD))) !== 0;
}

export function digCount(tags: View['designations'], size: number): number {
  let count = 0;
  for (let i = 0; i < size * size; i++) if (digTagged(tags.normal, i) || digTagged(tags.urgent, i)) count++;
  return count;
}
