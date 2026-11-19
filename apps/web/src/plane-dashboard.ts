/**
 * The top bar's plane dashboard (plane scope, the default): the plane in view's Spire pair, its two key numbers, its
 * next item in plain words, the time left with the win condition, and the other three planes' Spires as mini bars that
 * turn into pulsing "<plane> hit" pills. Every figure comes from the team's own view (spectators: each army's own
 * view). Blocks have fixed widths; long text ends in an ellipsis or wraps to two lines, with the full text in its tip.
 */
import { PLANES, hostileSide, type ArmyId, type Kind, type Plane } from '@agent-command/game/contract';
import { armyLabel, matchArmy } from './armies.ts';
import { h, PLANE_ACCENT } from './dom.ts';
import type { MatchView } from './match-view.ts';
import { daylight, timeLeft, type PlaneLead } from './plan-hud.ts';
import { DASH_STAT_LABEL, DASH_TEXT, PLANE_NAME, WEATHER_WORD, winLine } from './text.ts';
import { ledgerClock, ledgerNumber } from './topbar.ts';
import { tip } from './tooltip.ts';

/** Mini Spires run Orbit → Depths, like the plane chips; the plane in view hides its own. */
const MINI_PLANES = [...PLANES].reverse();
const SURFACE_ARMY: readonly Kind[] = ['tank', 'trooper', 'flak', 'breacher'];

export interface DashboardInput {
  focus: Plane;
  /** The Orbit layer's sun angle now (the daylight stat). */
  sunAngle: number;
  /** The plane chips' leading item per plane (PlaneChips.lead). */
  lead: (plane: Plane) => PlaneLead;
  /** Spectators hold every army's own view: a rival's Spire reads from its own view, and "You" names the army. */
  peer?: (army: ArmyId) => MatchView | undefined;
}

interface SpireRow { army: ArmyId; ours: boolean; who: HTMLElement; bar: HTMLElement; fill: HTMLElement; text: HTMLElement }

/** Writes only on change: identical live values cost no style work. */
function put(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export class PlaneDashboard {
  readonly el: HTMLElement;
  private readonly spireHead = h('div', { class: 'dash-k' });
  private readonly spireRows = h('div', { class: 'dash-rows' });
  private rows: SpireRow[] = [];
  private rowsKey = '';
  private readonly stats = [0, 1].map(() => {
    const value = h('b', { class: 'dash-v' });
    const label = h('span', { class: 'dash-l' });
    return { value, label, el: h('div', { class: 'dash-stat' }, value, label) };
  });
  private readonly statsBlock = h('div', { class: 'hud-chip dash-block dash-stats' }, ...this.stats.map((s) => s.el));
  private readonly nextHead = h('div', { class: 'dash-k' });
  private readonly nextText = h('div', { class: 'dash-text' });
  private readonly next = h('div', { class: 'hud-chip dash-block dash-next' }, this.nextHead, this.nextText);
  private readonly left = h('div', { class: 'dash-left' });
  private readonly win = h('div', { class: 'dash-text' });
  private readonly time = h('div', { class: 'hud-chip dash-block dash-time' }, this.left, this.win);
  private readonly minis: { plane: Plane; el: HTMLButtonElement; name: HTMLElement; hp: HTMLElement }[];
  /** Our Spire's tile, where a hit mini jumps to. */
  private home: { x: number; y: number } | undefined;

  constructor(jump: (plane: Plane, x?: number, y?: number) => void) {
    this.minis = MINI_PLANES.map((plane) => {
      const name = h('span', { class: 'dash-mini-name' });
      const hp = h('i', { class: 'dash-mini-hp' });
      const mini = { plane, name, hp, el: h('button', { type: 'button', class: 'dash-mini', 'data-plane': plane, style: `--accent:${PLANE_ACCENT[plane]}` }, hp, name) };
      // A hit Spire jumps to the Spire itself; a calm one just dives to its plane.
      mini.el.addEventListener('click', () => {
        const at = mini.el.classList.contains('hit') ? this.home : undefined;
        jump(plane, at?.x, at?.y);
      });
      return mini;
    });
    this.el = h('section', { class: 'plane-dash', 'aria-label': 'Plane dashboard' },
      h('div', { class: 'hud-chip dash-block dash-spire' }, this.spireHead, this.spireRows),
      this.statsBlock, this.next, this.time,
      h('div', { class: 'hud-chip dash-block dash-minis', role: 'group', 'aria-label': 'Other planes' }, ...this.minis.map((m) => m.el)));
  }

  update(v: MatchView, input: DashboardInput): void {
    const { focus } = input;
    this.home = matchArmy(v.match, v.army).spireAt;
    this.el.dataset.plane = focus;
    this.el.style.setProperty('--accent', PLANE_ACCENT[focus]);
    const ours = v.spire.find((s) => s.plane === focus);
    const hit = !!ours?.threatened && ours.hp > 0;
    this.spirePair(v, input, hit);
    this.keyNumbers(v, input);
    // Next on this plane: our Spire under attack outranks whatever the plane chip leads with.
    const lead = input.lead(focus);
    const name = PLANE_NAME[focus];
    put(this.nextHead, (hit ? DASH_TEXT.now : DASH_TEXT.next).replace('{plane}', name));
    const line = hit
      ? (input.peer ? DASH_TEXT.spireHitOf.replace('{army}', armyLabel(v.match, v.army)) : DASH_TEXT.spireHit).replace('{plane}', name)
      : lead.text;
    put(this.nextText, line);
    tip(this.next, line);
    this.next.classList.toggle('bad', hit);
    this.next.classList.toggle('warn', !hit && lead.tone !== 'quiet');
    // Time left and how this match is won (rules.spire.lossRule, never assumed).
    const cap = v.match.rules.spire.timeCap;
    const left = cap ? DASH_TEXT.left.replace('{time}', ledgerClock(timeLeft(v, v.tick))) : DASH_TEXT.noCap;
    const win = winLine(v.match, v.army, v.crowns, v.eliminated);
    put(this.left, left);
    put(this.win, win);
    tip(this.time, { title: left, description: win });
    for (const mini of this.minis) {
      mini.el.hidden = mini.plane === focus;
      if (mini.el.hidden) continue;
      const s = v.spire.find((x) => x.plane === mini.plane);
      const struck = !!s?.threatened && s.hp > 0;
      const planeName = PLANE_NAME[mini.plane];
      mini.el.classList.toggle('hit', struck);
      mini.hp.style.setProperty('--hp', `${s ? Math.max(0, Math.min(1, s.hp / s.maxHp)) * 100 : 0}%`);
      put(mini.name, struck ? DASH_TEXT.miniHit.replace('{plane}', planeName) : planeName);
      const label = `${planeName} Spire: ${s ? `${s.hp} / ${s.maxHp} HP` : DASH_TEXT.fallen}${struck ? ' · under attack' : ''}`;
      if (mini.el.getAttribute('aria-label') !== label) {
        mini.el.setAttribute('aria-label', label);
        tip(mini.el, { title: label, description: struck ? `Jump to your ${planeName} Spire` : `Dive to ${planeName}` });
      }
    }
  }

  /** This plane's Spire: ours, then one row per hostile army (seen health, or hatched while out of sight). */
  private spirePair(v: MatchView, input: DashboardInput, hit: boolean): void {
    const { focus, peer } = input;
    const hostiles = v.match.armies.filter((a) => hostileSide(v.match, v.army, a.id));
    const key = `${v.army}|${hostiles.map((a) => `${a.id}:${a.colour}`).join(',')}|${!!peer}`;
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      this.rows = [{ army: v.army, ours: true }, ...hostiles.map((a) => ({ army: a.id, ours: false }))].map(({ army, ours }) => {
        const fill = h('i', { class: 'dash-fill' });
        const text = h('b', { class: 'dash-bar-text' });
        const colour = matchArmy(v.match, army).colour;
        return { army, ours, fill, text, who: h('span', { class: 'dash-who' }, ours && !peer ? DASH_TEXT.you : armyLabel(v.match, army)),
          bar: h('div', { class: 'dash-bar', style: `--side:var(--army-${colour})` }, fill, text) };
      });
      this.spireRows.dataset.rows = String(this.rows.length);
      this.spireRows.replaceChildren(...this.rows.flatMap((r) => [r.who, r.bar]));
    }
    put(this.spireHead, DASH_TEXT.spire.replace('{plane}', PLANE_NAME[focus]));
    for (const row of this.rows) {
      const out = v.eliminated.includes(row.army);
      const segment = out ? undefined : row.ours ? v.spire.find((s) => s.plane === focus)
        : peer?.(row.army)?.spire.find((s) => s.plane === focus) ?? v.entities.find((e) => e.kind === 'spire' && e.side === row.army && e.plane === focus);
      const ratio = segment ? Math.max(0, Math.min(1, segment.hp / segment.maxHp)) : 0;
      const struck = row.ours && hit;
      const text = out ? DASH_TEXT.out : !segment ? DASH_TEXT.notScouted : segment.hp <= 0 ? DASH_TEXT.fallen : `${struck ? `${DASH_TEXT.hit} · ` : ''}${segment.hp} / ${segment.maxHp}`;
      row.bar.className = `dash-bar${!segment && !out ? ' unknown' : ''}${struck ? ' hit' : ''}${out || (segment && ratio === 0) ? ' dead' : ratio < 0.35 && segment ? ' low' : ''}`;
      row.fill.style.width = `${ratio * 100}%`;
      put(row.text, text);
      const label = `${row.ours && !peer ? 'Our' : armyLabel(v.match, row.army)} ${PLANE_NAME[focus]} Spire: ${text}`;
      if (row.bar.getAttribute('aria-label') !== label) {
        row.bar.setAttribute('aria-label', label);
        tip(row.bar, label);
      }
    }
  }

  /** The plane's two key numbers, all from the team's own view. */
  private keyNumbers(v: MatchView, input: DashboardInput): void {
    const { focus } = input;
    const count = (kinds: readonly Kind[]): number => {
      let n = 0;
      for (const e of v.entities) if (e.side === v.army && e.plane === focus && e.hp > 0 && kinds.includes(e.kind)) n++;
      return n;
    };
    let cells: [string, string, string, string];
    if (focus === 'surface') {
      const total = v.match.posts.length;
      const held = v.entities.reduce((n, e) => n + (e.kind === 'post' && e.side === v.army ? 1 : 0), 0);
      cells = [total ? `${held}/${total}` : String(count(SURFACE_ARMY)), total ? DASH_STAT_LABEL.posts : DASH_STAT_LABEL.army, String(count(['headframe'])), DASH_STAT_LABEL.headframes];
    } else if (focus === 'sky') {
      let seen = 0, held = 0;
      for (const e of v.entities) if (e.kind === 'island') { seen++; if (e.side === v.army) held++; }
      const storm = v.alerts.find((a) => a.plane === 'sky' && WEATHER_WORD[a.kind]);
      cells = [`${held}/${seen}`, DASH_STAT_LABEL.islands, storm ? WEATHER_WORD[storm.kind]! : 'clear', DASH_STAT_LABEL.weather];
    } else if (focus === 'orbit') {
      const sun = daylight(v, input.sunAngle);
      cells = [`${sun.lit}/${sun.arrays}`, DASH_STAT_LABEL.arrays, Number.isFinite(sun.edgeIn) ? `${sun.baseLit ? 'dusk' : 'dawn'} ${ledgerClock(sun.edgeIn)}` : '—', DASH_STAT_LABEL.sun];
    } else {
      const ore = (v.oreCaches ?? []).reduce((n, c) => n + (c.below?.alloy ?? 0), 0);
      cells = [String(count(['digger'])), DASH_STAT_LABEL.diggers, ledgerNumber(ore), DASH_STAT_LABEL.ore];
    }
    for (let i = 0; i < 2; i++) {
      const stat = this.stats[i]!;
      put(stat.value, cells[i * 2]!);
      put(stat.label, cells[i * 2 + 1]!);
    }
    tip(this.statsBlock, `${cells[0]} ${cells[1]} · ${cells[2]} ${cells[3]}`);
  }
}
