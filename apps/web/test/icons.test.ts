// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ARMORS, EVENT_KINDS, KINDS, PLANES, QUEUE_ITEMS, SCHEDULE_KINDS, SUPPORT_NEEDS, UPGRADE_IDS, WEAPONS } from '@agent-command/game/contract';
import { icon, ICONS, type IconName } from '../src/icons.ts';
import { CARD_SLOTS, TOOL_META } from '../src/tools/catalog.ts';
import { PLANE_MACROS } from '../src/text.ts';

const chrome = ['alloy', 'energy', 'daylight', 'dawn', 'dusk', 'asteroid', 'time_cap', 'flood', 'scan', 'chat', 'console', 'settings', 'leave', 'spectate', 'invite', 'commanders', 'keyboard', 'queue', 'cancel', 'formation_wedge', 'formation_line', 'formation_escort'];
const harnesses = ['claude-code', 'claude-api', 'codex', 'opencode', 'pi', 'oh-my-pi', 'hermes', 'generic', 'playerthree-runner', 'playerthree-bridge', 'bot', 'human', 'none', 'token'];

describe('one typed icon registry', () => {
  it('covers every game, queue, research, event, plane, tool, macro and harness concept', () => {
    for (const name of [...KINDS, ...QUEUE_ITEMS, ...UPGRADE_IDS, ...EVENT_KINDS, ...PLANES, ...SCHEDULE_KINDS,
      ...WEAPONS.map((w) => `weapon_${w}`), ...ARMORS.map((a) => `armor_${a}`),
      ...TOOL_META.map((tool) => tool.id), ...Object.values(PLANE_MACROS).flat(), ...chrome, ...harnesses]) {
      expect(ICONS, name).toHaveProperty(name);
      expect(ICONS[name as IconName].length, name).toBeGreaterThan(0);
    }
  });
  it('keeps the orbital dart and broad escort silhouettes distinguishable', () => {
    expect(ICONS.skiff).not.toEqual(ICONS.bastion);
    expect(ICONS.skiff).not.toEqual(ICONS.interceptor);
    expect(ICONS.bastion).not.toEqual(ICONS.lancer);
    expect(ICONS.warden).not.toEqual(ICONS.trooper);
    expect(ICONS.breacher).not.toEqual(ICONS.trooper);
    expect(ICONS.drill_yard).not.toEqual(ICONS.shaft);
    expect(ICONS.weapon_flamer).not.toEqual(ICONS.weapon_rifle);
    expect(ICONS.gunship).not.toEqual(ICONS.interceptor);
    expect(ICONS.gunship).not.toEqual(ICONS.bomber);
    expect(ICONS.weapon_shotgun).not.toEqual(ICONS.weapon_rifle);
    for (const name of ['stat_shield', 'stat_shield_regen', 'stat_shield_delay'] as const)
      expect(icon(name).childElementCount).toBeGreaterThan(0);
  });
  it('gives every command-card action its own glyph (no two orders on one card look alike)', () => {
    // `anchor` is a CARD_SLOTS tool; its Release action on the Sky card shares that glyph, never on the card together.
    const names = [...Object.keys(CARD_SLOTS), 'aggressive', 'defensive', 'formation_wedge', 'formation_line', 'formation_escort', 'more', 'hangar', 'launch', 'airdrop', 'seed',
      ...SUPPORT_NEEDS.map((need) => `need_${need}`)] as IconName[];
    const glyphs = new Map<string, string>();
    for (const name of names) {
      const glyph = JSON.stringify(ICONS[name]);
      expect(glyphs.get(glyph), `${name} reuses ${glyphs.get(glyph)}`).toBeUndefined();
      glyphs.set(glyph, name);
    }
    // Research and its ability, and the Depths events and their verbs, share one glyph.
    expect(ICONS.aegis_projectors).toBe(ICONS.aegis);
    expect(ICONS.ascent_thrusters).toBe(ICONS.ascend);
    expect(ICONS.collapse).toBe(ICONS.undermine);
    expect(ICONS.breach_opened).toBe(ICONS.breach);
    expect(ICONS.hole_bridged).toBe(ICONS.bridge);
  });
  it('renders local decorative ink SVGs with fixed geometry and no remote assets', () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const svg = icon(name, 22);
      expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('width')).toBe('22');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.querySelector('image, use, title')).toBeNull();
      expect(svg.childElementCount).toBeGreaterThan(0);
    }
  });
});
