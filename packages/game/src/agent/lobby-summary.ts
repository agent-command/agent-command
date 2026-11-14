/**
 * The pre-match summary an agent sees in the lobby state (`match`, manifest.lobby): which map, layout and armies its
 * seat plays and how the rules differ from the standard ones. Public lobby data only (the lobby shows the same).
 */
import { t } from 'playerthree';
import { ARMIES, COLOURS, MAP_SIZES, MAX_MAP_SIZE, diffRules, type ArmyId, type Colour, type Rules } from '../rules/contract.ts';
import { RULE_FIELDS } from '../rules/match-rules.ts';

const ID = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
/** A changed rule's value is shown when its JSON fits; longer (list/object) values only name the rule. */
const RULE_VALUE_MAX = 64;

export const lobbySummarySchema = t.obj({
  map: t.str(64, ID, 'map id (topic maps)'),
  layout: t.str(64, ID, 'layout id: which corners play and who is allied'),
  size: t.int(MAP_SIZES[0], MAX_MAP_SIZE, 'map side in cells'),
  armies: t.list(t.obj({ army: t.enum(ARMIES), colour: t.enum(COLOURS) }), ARMIES.length, 'the armies in the match and their colours; one colour = allies'),
  rules: t.obj({
    custom: t.bool('true when any rule differs from the standard rules'),
    changed: t.list(t.obj({
      rule: t.str(128, '^[A-Za-z0-9_.*]{1,128}$', 'rule path (topic match-rules)'),
      value: t.opt(t.str(RULE_VALUE_MAX, undefined, 'the match value as JSON')),
    }), RULE_FIELDS.length, 'rules that differ from the standard ones; the full rules arrive as match data once the match starts'),
  }),
}, 'the match your seat is reserved or held for');

export interface LobbySummaryInput {
  mapId: string;
  layoutId: string;
  size: number;
  sides: readonly { id: ArmyId; alliance: Colour }[];
  rules: Rules;
}

export function lobbySummary(input: LobbySummaryInput): unknown {
  const changed = diffRules(input.rules);
  return {
    map: input.mapId,
    layout: input.layoutId,
    size: input.size,
    armies: input.sides.map((side) => ({ army: side.id, colour: side.alliance })),
    rules: {
      custom: changed.length > 0,
      changed: changed.map((diff) => {
        const json = JSON.stringify(diff.value);
        return { rule: diff.field.path.join('.'), ...(json.length <= RULE_VALUE_MAX ? { value: json } : {}) };
      }),
    },
  };
}
