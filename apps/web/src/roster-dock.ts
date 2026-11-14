/**
 * The roster dock: my named commanders as draggable AgentButton chips (online dot = an active harness connection).
 * The Commanders screen lists them; game setup drags chips from the dock onto seats. Drag data carries the commander
 * id only, never a credential.
 */
import type { ConnectionInfo } from '@playerthree/connect';
import type { Plane } from '@agent-command/game/contract';
import { agentButton, rosterAgent } from './agent-button.ts';
import { h } from './dom.ts';
import type { RosterCommander } from './profile.ts';

/** dataTransfer type of a dragged commander chip; the value is the commander id. */
export const COMMANDER_DRAG = 'application/x-agent-command-commander';

export interface RosterChipOptions {
  /** Shown as picked (aria-pressed). */
  selected?: boolean;
  /** Click / keyboard pick; without it the chip is drag-only. */
  onPick?: (commander: RosterCommander) => void;
  /** Dimmed: not compatible with the roles being filled. */
  unfit?: boolean;
}

/** One draggable commander chip. */
export function rosterChip(commander: RosterCommander, connections: readonly ConnectionInfo[] | undefined, options: RosterChipOptions = {}): HTMLElement {
  const { onPick } = options;
  const chip = agentButton(rosterAgent(commander, connections), {
    size: 'small',
    ...(onPick ? { onClick: () => onPick(commander), pressed: !!options.selected } : {}),
    className: [options.selected ? 'on' : '', options.unfit ? 'unfit' : ''].filter(Boolean).join(' ') || undefined,
  });
  chip.dataset.commanderId = commander.id;
  chip.draggable = true;
  chip.addEventListener('dragstart', (event) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(COMMANDER_DRAG, commander.id);
    event.dataTransfer.effectAllowed = 'link';
  });
  return chip;
}

export interface RosterDockOptions {
  /** Accessible name of the dock. */
  label?: string;
  /** Commander id shown as picked. */
  selected?: string;
  onPick?: (commander: RosterCommander) => void;
  /** Dims commanders not compatible with every one of these roles. */
  roles?: readonly Plane[];
}

/** Every commander as a chip; empty roster → an empty dock (callers render their own "connect" call to action). */
export function rosterDock(commanders: readonly RosterCommander[], connections: readonly ConnectionInfo[] | undefined, options: RosterDockOptions = {}): HTMLElement {
  return h('div', { class: 'roster-dock', role: 'group', 'aria-label': options.label ?? 'My commanders' },
    ...commanders.map((commander) => rosterChip(commander, connections, {
      selected: commander.id === options.selected,
      ...(options.onPick ? { onPick: options.onPick } : {}),
      unfit: !!options.roles && !options.roles.every((role) => commander.roles.includes(role)),
    })));
}

/** The commander id a drop carries, if it came from a roster chip. */
export function draggedCommander(event: DragEvent): string | undefined {
  return event.dataTransfer?.getData(COMMANDER_DRAG) || undefined;
}
