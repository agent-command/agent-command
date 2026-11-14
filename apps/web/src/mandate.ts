import { MANDATE_PRESETS } from '@playerthree/connect';
import type { Mandate, Scope } from 'playerthree/control';

export type MandatePreset = keyof typeof MANDATE_PRESETS;
export const MODE_LABEL = { autonomous: 'Autonomous', author: 'Policy author', advisor: 'Advisor', custom: 'Custom' } as const;
export const MODES = Object.keys(MANDATE_PRESETS) as MandatePreset[];

/** Presets are labels for exact permissions, never a second stored setting. */
export function mandateMode(scopes: readonly Scope[], mandate: Pick<Mandate, 'autonomy'>): MandatePreset | 'custom' {
  return MODES.find((key) => {
    const preset = MANDATE_PRESETS[key];
    return mandate.autonomy === preset.autonomy && scopes.length === preset.scopes.length && preset.scopes.every((scope) => scopes.includes(scope));
  }) ?? 'custom';
}
