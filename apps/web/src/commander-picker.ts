/** The one way to choose a commander from my roster for a slot: compatibility, labels and the exact ref sent. */
import type { Plane } from '@agent-command/game/contract';
import type { CommanderRef } from '@agent-command/game/lobby';
import { agentText, rosterAgent } from './agent-button.ts';
import { h } from './dom.ts';
import type { RosterCommander } from './profile.ts';
import { tip } from './tooltip.ts';

/** Option value prefix inside the occupant selector; stable for automation (`commander:<id>`). */
export const COMMANDER_VALUE = 'commander:';

/** Why a commander cannot take a seat of another army: the server's `commander_other_army`. */
export const otherArmyTip = (name: string, army: string): string => `${name} already plays ${army}. A commander plays one army per match: clear it there first.`;

export interface CommanderPicker {
  /** Only commanders compatible with every role in the slot. */
  readonly commanders: readonly RosterCommander[];
  readonly options: HTMLOptGroupElement;
  /** The exact private ref for a picked option value, or undefined when the value is not one of mine or is greyed out. */
  ref(value: string): CommanderRef | undefined;
}

/** `otherArmy`: commander id → label of the other army it already plays in this match (greyed out with a tip). */
export function commanderPicker(roster: readonly RosterCommander[] | undefined, roles: readonly Plane[], selectedId: string | undefined, disabled: boolean, otherArmy?: ReadonlyMap<string, string>): CommanderPicker {
  const commanders = (roster ?? []).filter((commander) => roles.every((role) => commander.roles.includes(role)));
  const options = h('optgroup', { label: 'My commanders', disabled },
    ...commanders.map((commander) => {
      const army = otherArmy?.get(commander.id);
      const option = h('option', { value: `${COMMANDER_VALUE}${commander.id}`, selected: commander.id === selectedId, disabled: army !== undefined || undefined }, army === undefined ? agentText(rosterAgent(commander)) : `${agentText(rosterAgent(commander))} · plays ${army}`);
      return army === undefined ? option : tip(option, otherArmyTip(commander.name, army));
    }));
  return {
    commanders, options,
    ref(value) {
      const commander = commanders.find((entry) => `${COMMANDER_VALUE}${entry.id}` === value);
      if (!commander || otherArmy?.has(commander.id)) return undefined;
      const version = roles.length === 1 ? commander.policy.activeByRole[roles[0]!] : null;
      return { id: commander.id, kind: commander.kind, ...(commander.kind === 'policy' && version != null ? { version } : {}) };
    },
  };
}
