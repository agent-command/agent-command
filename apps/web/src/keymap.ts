/**
 * Keyboard layouts. `classic` (default, like StarCraft II / Age of Empires IV classic grids): arrows and screen
 * edges pan, A attack-move, S stop, D deorbit. `wasd` (player setting "WASD camera"): W A S D pan too, and the three
 * commands they displace move to the keys directly below them on the bottom row, so the left hand never leaves the
 * pan cluster: Z attack-move (under A), X stop (under S), V deorbit (C under D is already scan; V is its neighbour).
 * Every other command keeps its key in both layouts. Persisted in localStorage; changes notify listeners so every
 * on-screen key reference follows.
 */
import type { Plane } from '@agent-command/game/contract';
import { LENS_PEEK_META, TOOL_META, type ToolKeyCommand } from './tools/catalog.ts';

export type KeyLayout = 'classic' | 'wasd';
export type PanDir = 'up' | 'down' | 'left' | 'right';

/** Single-key commands (`KeyboardEvent.key`, lower case, no Ctrl). */
export type KeyCommand = ToolKeyCommand | 'idle' | 'diveDown' | 'diveUp';

/** Camera/selection commands are not tools; tool bindings live only in the catalog. */
const NAVIGATION_KEYS = { idle: 'i', diveDown: 'q', diveUp: 'e' } as const;

function makeKeymap(layout: KeyLayout): Readonly<Record<KeyCommand, string>> {
  return {
    ...Object.fromEntries(TOOL_META.flatMap((tool) => tool.hotkey ? [[tool.id, tool.hotkey[layout]]] : [])),
    ...NAVIGATION_KEYS,
    [LENS_PEEK_META.id]: LENS_PEEK_META.hotkey[layout],
  } as Record<KeyCommand, string>;
}

const KEYMAPS = { classic: makeKeymap('classic'), wasd: makeKeymap('wasd') };

/** Plane availability, names and instructions come from the same catalog as the command cards. */
export function planeToolHelp(plane: Plane, layout: KeyLayout = keyLayout()): { id: string; label: string; hint: string; key?: string }[] {
  return [...TOOL_META, LENS_PEEK_META]
    .filter((tool) => tool.id !== 'default' && (tool.planes as readonly Plane[]).includes(plane))
    .map((tool) => ({ id: tool.id, label: tool.label, hint: tool.hint, key: tool.hotkey?.[layout].toUpperCase() }));
}

const ARROWS: Readonly<Record<string, PanDir>> = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
const PAN: Readonly<Record<KeyLayout, Readonly<Record<string, PanDir>>>> = {
  classic: ARROWS,
  wasd: { ...ARROWS, w: 'up', s: 'down', a: 'left', d: 'right' },
};

/** Keys with fixed meanings outside the letter map (`KeyboardEvent.key`, lower case): never reassigned. */
export const FIXED_KEYS: readonly string[] = ['`', '\\', 'enter', 'escape', 'tab', ' ', 'home', 'f1', 'f2', 'f3', 'f4', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** The agent console toggle (`KeyboardEvent.code`; on US layouts the `\` key). */
export const CONSOLE_KEY = 'Backslash';
export const CONSOLE_KEY_LABEL = '\\';

export function keymap(layout: KeyLayout): Readonly<Record<KeyCommand, string>> {
  return KEYMAPS[layout];
}

/** The command bound to a lower-case key in this layout. */
export function commandFor(key: string, layout: KeyLayout): KeyCommand | undefined {
  for (const [cmd, k] of Object.entries(KEYMAPS[layout])) if (k === key) return cmd as KeyCommand;
  return undefined;
}

/** The pan direction of a lower-case key in this layout. */
export function panFor(key: string, layout: KeyLayout): PanDir | undefined {
  return PAN[layout][key];
}

/** Every key that pans in this layout. */
export function panKeys(layout: KeyLayout): string[] {
  return Object.keys(PAN[layout]);
}

/** On-screen label of a command's key. */
export function keyLabel(cmd: KeyCommand, layout: KeyLayout = keyLayout()): string {
  return KEYMAPS[layout][cmd].toUpperCase();
}

// ------------------------------------------------------------------ the player setting

const STORAGE_KEY = 'agent-command.keys';
const listeners = new Set<(layout: KeyLayout) => void>();
let current: KeyLayout | undefined;

export function keyLayout(): KeyLayout {
  if (current === undefined) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: default */
    }
    current = stored === 'wasd' ? 'wasd' : 'classic';
  }
  return current;
}

export function setKeyLayout(layout: KeyLayout): void {
  if (layout === keyLayout()) return;
  current = layout;
  try {
    localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    /* storage unavailable: this session only */
  }
  for (const l of listeners) l(layout);
}

/** Layout changes. Returns unsubscribe. */
export function onKeyLayout(listener: (layout: KeyLayout) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
