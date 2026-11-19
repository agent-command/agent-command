import { describe, expect, it } from 'vitest';
import { MANDATE_PRESETS } from '@playerthree/connect';
import { mandateMode, MODES } from '../src/mandate.ts';

describe('mandate modes', () => {
  it.each(MODES)('derives %s from scopes and autonomy regardless of scope order', (mode) => {
    const preset = MANDATE_PRESETS[mode];
    expect(mandateMode([...preset.scopes].reverse(), preset)).toBe(mode);
  });

  it('shows Custom for permissions or autonomy outside the presets', () => {
    expect(mandateMode(['policy'], { autonomy: 'autonomous' })).toBe('custom');
    expect(mandateMode(MANDATE_PRESETS.autonomous.scopes, { autonomy: 'supervised' })).toBe('custom');
    expect(mandateMode([], { autonomy: 'supervised' })).toBe('custom');
  });
});
