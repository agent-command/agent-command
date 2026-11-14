import { isStructureKind, type Entity, type Plane, type Rules, type View } from '@agent-command/game/contract';
import type { CardAction } from './command-card.ts';
import type { Intent } from './controls.ts';
import { KIND_LABEL } from './text.ts';

/**
 * One deliberate removal, bound to the displayed entity and plane, never to a later selection. Two steps in the card
 * (the commanders screen's inline confirm / cancel pair; a native dialog would freeze the HUD mid-match): Destroy
 * arms `armed` for this structure, then Confirm sends the order or Keep disarms.
 */
export function structureActions(view: View, rules: Rules, plane: Plane, selection: readonly Entity[], act: (intents: Intent[]) => void,
  armed: string | undefined, arm: (id: string | undefined) => void): CardAction[] {
  const target = selection.length === 1 ? selection[0] : undefined;
  if (!target || target.side !== view.army || target.plane !== plane || target.hp <= 0
    || !isStructureKind(target.kind) || target.kind === 'spire' || target.state === 'constructing') return [];
  const id = target.id;
  const label = 'Destroy Structure';
  let description = `Permanently destroy ${KIND_LABEL[target.kind]} ${id}. No refund. Its footprint or island slot becomes available.`;
  if (target.kind === 'aerie') description += ` Sheltered aircraft evacuate with ${rules.sky.aerieLossHealth * 100}% of their remaining hull${rules.sky.aerieLossHealth === 0 ? ' (all occupants are lost)' : ''}.`;
  if (target.kind === 'aerie' || target.kind === 'shaft') description += ' Queued production at this structure stays blocked, including paid work. Cancel those entries separately for the normal queue refund.';
  if (target.kind === 'drill_yard') description += ' Trainees leave as Troopers; paid conversion work is lost without refund.';
  if (target.kind === 'mooring_tower') description += ' Its moored island is released and rises safely along its normal route.';
  if (target.kind === 'storm_seeder') description += ' Its active storm or warning ends.';
  if (target.plane === 'sky') description += ' The island keeps its remaining ore and undropped cargo; Drop Ore remains available.';
  if (armed !== id) {
    return [{
      id: 'structure:dismantle', group: 'commands', rank: 6, icon: 'dismantle', label,
      tip: { title: label, description },
      run: () => arm(id),
    }];
  }
  const segment = { id: 'structure:dismantle', label };
  return [
    {
      id: 'structure:dismantle', group: 'commands', rank: 6, icon: 'dismantle', label: `Confirm: ${label}`, on: true, segment,
      tip: { title: `Confirm: ${label}`, description, status: 'No refund' },
      run: () => { arm(undefined); act([{ kind: 'dismantle', structure: id }]); },
    },
    {
      id: 'structure:keep', group: 'commands', rank: 6, icon: 'cancel', label: 'Keep Structure', segment,
      tip: { title: 'Keep Structure', description: `Cancel destroying ${KIND_LABEL[target.kind]} ${id}.` },
      run: () => arm(undefined),
    },
  ];
}
