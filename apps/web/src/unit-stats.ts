/**
 * Icon-first unit stats for the selection panel and production tooltips. Every value comes from the match's compiled
 * rules (`compileRules(rules).stats`), DAMAGE_VS and the kind's weapon mount, with passive research applied the way
 * the sim applies it. Fog-safe: callers pass their own army's completed research, or for a hostile army only the
 * upgrades this army has observed of it (`research.seen`); a kind's base stats are public.
 */
import {
  ARMORS, DAMAGE_VS, PLANES, STRUCTURE_KINDS, TICK_RATE, UPGRADE_IDS, UPGRADES, compileRules,
  type Armor, type Plane, type RuleTables, type Rules, type StatKey, type StatKind, type UpgradeId, type Weapon, type WeaponMount,
} from '@agent-command/game/contract';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { ARMOR_LABEL, MOUNT_LABEL, PLANE_NAME, WEAPON_LABEL } from './text.ts';

export interface KindStats {
  kind: StatKind;
  hp: number;
  /** Shield values are active only in Orbit; regeneration is HP/second, delay is ticks. */
  shield: number;
  shieldRegen: number;
  shieldDelay: number;
  dmg: number;
  /** ticks between shots */
  cooldown: number;
  range: number;
  speed: number;
  vision: number;
  /** incoming damage multiplier from research (1 = none) */
  damageTaken: number;
  armor: Armor;
  weapon?: Weapon;
  mount?: WeaponMount;
  targets: readonly Plane[];
  splash: number;
}

const compiled = new WeakMap<Rules, RuleTables>();
/** A match's rules compiled once per rules object (views reuse it), never per render. */
export function ruleTables(rules: Rules): RuleTables {
  let tables = compiled.get(rules);
  if (!tables) compiled.set(rules, (tables = compileRules(rules)));
  return tables;
}

/** The kind's stats on a plane under the given researched upgrades: the sim's modifier order and clamps. */
export function kindStats(tables: RuleTables, kind: StatKind, plane: Plane, research: readonly UpgradeId[]): KindStats {
  const row = tables.stats[kind];
  const structure = (STRUCTURE_KINDS as readonly string[]).includes(kind);
  const stat = (key: StatKey): number => {
    let value = key === 'damage_taken' ? 1 : key === 'hp' && kind === 'spire' ? tables.spireHp[plane] : row[key];
    for (const id of UPGRADE_IDS) {
      const upgrade = UPGRADES[id];
      if (!research.includes(id) || (upgrade.scope !== 'team' && plane !== upgrade.at)) continue;
      for (const effect of upgrade.effects) {
        if (effect.kind !== 'modifier' || effect.stat !== key) continue;
        const target = effect.target;
        const hit = 'kinds' in target ? target.kinds.includes(kind) : 'structures' in target ? structure : kind === 'spire' && plane === target.segment;
        if (hit) value = (value + (effect.add ?? 0)) * (effect.multiply ?? 1);
      }
    }
    return key === 'damage_taken' && kind === 'spire' ? Math.max(1 - tables.econ.shieldCap, value) : Math.max(0, value);
  };
  return {
    kind, hp: stat('hp'), dmg: stat('dmg'), cooldown: stat('cooldown'), range: stat('range'), speed: stat('speed'), vision: stat('vision'),
    shield: plane === 'orbit' ? row.shield ?? 0 : 0,
    shieldRegen: plane === 'orbit' ? row.shieldRegen ?? 0 : 0,
    shieldDelay: plane === 'orbit' ? row.shieldDelay ?? 0 : 0,
    damageTaken: stat('damage_taken'), armor: row.armor, weapon: row.weapon, mount: row.mount, targets: row.targets, splash: row.splash,
  };
}

const num = (n: number) => String(Math.round(n * 10) / 10);
/** One value, or the group's range. */
function span(list: readonly KindStats[], pick: (s: KindStats) => number, unit = ''): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of list) {
    const v = pick(s);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === hi ? `${num(lo)}${unit}` : `${num(lo)}–${num(hi)}${unit}`;
}
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

export interface StatCell {
  parts: [IconName, string?][];
  label: string;
  detail: string;
}

/**
 * Stat cells for one kind or a group (shared values, else ranges). `hp` adds a health cell: current/max (a group's
 * totals), or the maximum alone for a kind not yet built. `shield` supplies the visible snapshot's current/max
 * totals; omitted for production tooltips, which show registry capacity. The selection bar owns hull health.
 */
export function statCells(list: readonly KindStats[], hp?: { hp?: number; max: number; count: number }, shield?: { shield: number; max: number; count: number }): StatCell[] {
  const cells: StatCell[] = [];
  if (hp) cells.push({ parts: [['stat_hp', hp.hp === undefined ? num(hp.max) : `${num(hp.hp)}/${num(hp.max)}`]], label: 'Health', detail: hp.count > 1 ? `Total of ${hp.count} units` : 'Hit points' });
  const shielded = list.filter((s) => s.shield > 0);
  if (shielded.length || (shield?.max ?? 0) > 0) {
    cells.push({
      parts: [['stat_shield', shield ? `${num(shield.shield)}/${num(shield.max)}` : span(shielded, (s) => s.shield)]],
      label: 'Shield',
      detail: shield && shield.count > 1 ? `Total of ${shield.count} shielded units · absorbs damage before hull` : 'Orbit only · absorbs damage before hull',
    });
    if (shielded.length) {
      cells.push({ parts: [['stat_shield_regen', span(shielded, (s) => s.shieldRegen, '/s')]], label: 'Shield recharge', detail: 'Shield HP restored per second after leaving combat' });
      cells.push({ parts: [['stat_shield_delay', span(shielded, (s) => s.shieldDelay / TICK_RATE, 's')]], label: 'Recharge delay', detail: 'Time without dealing or taking damage before shield recharge' });
    }
  }
  const armed = list.filter((s) => s.dmg > 0 && s.weapon);
  const weapons = unique(armed.map((s) => s.weapon!));
  if (armed.length) {
    const weapon = weapons.length === 1 ? weapons[0]! : undefined;
    const splash = unique(armed.map((s) => s.splash)).filter((r) => r > 0);
    cells.push({
      parts: [[weapon ? `weapon_${weapon}` : 'stat_dmg', span(armed, (s) => s.dmg)]],
      label: 'Damage per shot',
      detail: `${weapons.map((w) => WEAPON_LABEL[w]).join(' / ')}${splash.length ? ` · splash ${splash.map(num).join('/')} tiles` : ' · single target'}`,
    });
    cells.push({ parts: [['stat_rate', span(armed, (s) => s.cooldown / TICK_RATE, 's')]], label: 'Cooldown', detail: `${span(armed, (s) => (s.cooldown > 0 ? TICK_RATE / s.cooldown : 0))} shots per second` });
    cells.push({ parts: [['stat_dps', span(armed, (s) => (s.cooldown > 0 ? (s.dmg * TICK_RATE) / s.cooldown : s.dmg))]], label: 'Damage per second', detail: 'Before armor multipliers' });
    cells.push({ parts: [['stat_range', span(armed, (s) => s.range)]], label: 'Range', detail: 'Tiles, centre to target edge' });
    const targets = PLANES.filter((p) => armed.some((s) => s.targets.includes(p)));
    cells.push({ parts: targets.map((p) => [p]), label: 'Can hit', detail: targets.map((p) => PLANE_NAME[p]).join(', ') });
    if (weapon) {
      const strong = ARMORS.filter((a) => DAMAGE_VS[weapon][a] > 1);
      const table = ARMORS.map((a) => `${ARMOR_LABEL[a]} ×${DAMAGE_VS[weapon][a]}`).join(' · ');
      if (strong.length) cells.push({ parts: strong.map((a) => [`armor_${a}`, `×${DAMAGE_VS[weapon][a]}`]), label: 'Strong vs', detail: `${WEAPON_LABEL[weapon]} damage: ${table}` });
    }
    const mounts = unique(armed.flatMap((s) => (s.mount ? [s.mount.kind] : [])));
    if (mounts.length) {
      const detail = unique(armed.flatMap((s) => (s.mount ? [s.mount.kind === 'forward' ? `${MOUNT_LABEL.forward} (${s.mount.arc}°)` : MOUNT_LABEL[s.mount.kind]] : []))).join(' / ');
      cells.push({ parts: mounts.map((m) => [`mount_${m}`]), label: 'Weapon mount', detail });
    }
  }
  const armors = unique(list.map((s) => s.armor));
  const taken = unique(list.map((s) => s.damageTaken)).filter((v) => v !== 1);
  const weak = unique(armors.flatMap((a) => (Object.keys(DAMAGE_VS) as Weapon[]).filter((w) => DAMAGE_VS[w][a] > 1).map((w) => WEAPON_LABEL[w])));
  cells.push({
    parts: armors.map((a) => [`armor_${a}`]),
    label: 'Armor',
    detail: `${armors.map((a) => ARMOR_LABEL[a]).join(' / ')}${weak.length ? ` · weak to ${weak.join(', ')}` : ''}${taken.length ? ` · takes ×${taken.map(num).join('/')} damage` : ''}`,
  });
  if (list.some((s) => s.speed > 0)) cells.push({ parts: [['stat_speed', span(list, (s) => s.speed)]], label: 'Speed', detail: 'Tiles per second' });
  cells.push({ parts: [['stat_vision', span(list, (s) => s.vision)]], label: 'Vision', detail: 'Sight radius in tiles' });
  return cells;
}

/**
 * A compact icon grid. In the panel each cell carries its own hint; `captions` (inside a tooltip, where hints can't
 * nest) prints the label and detail beside the value instead.
 */
export function statGrid(cells: readonly StatCell[], captions = false): HTMLElement {
  return h('div', { class: `stat-grid${captions ? ' captions' : ''}` }, ...cells.map((c) => {
    const value = c.parts.flatMap(([name, text]) => [icon(name, 13), text ? h('span', { class: 'num' }, text) : null]);
    const text = `${c.label}: ${c.parts.map(([name, t]) => t ?? name).join(' ')}`;
    return captions
      ? h('span', { class: 'stat' }, h('span', { class: 'stat-value' }, ...value), h('span', { class: 'stat-caption' }, `${c.label} · ${c.detail}`))
      : h('span', { class: `stat${c.parts.length > 1 || c.parts.some(([, t]) => (t?.length ?? 0) > 5) ? ' wide' : ''}`, 'data-tip': `${c.label} · ${c.detail}`, 'aria-label': text }, ...value);
  }));
}
