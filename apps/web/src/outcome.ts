/**
 * End-of-match and elimination cards' content (DESIGN §15.12): the after-action table lists every army of the match
 * with its colour and final place, and an eliminated player picks the perspective to spectate the rest from.
 */
import { TICK_RATE, type ArmyId, type MatchData, type Report } from '@agent-command/game/contract';
import { COLOUR_LABEL, CORNER_LABEL, placeLabel } from './armies.ts';
import { PLANE_ACCENT, fmt, h } from './dom.ts';
import { icon } from './icons.ts';
import { SIDE_HEX } from './world/common.ts';
import { eventText, PLANE_NAME } from './text.ts';
import type { MatchView } from './match-view.ts';

const REPORT_TIMELINE_EVENTS = 12;

/** Presentation only: the joined game owns outcome audio, terminal state and observer handoff. */
export function outcomeCard(options: {
  outcome: Exclude<Report['outcome'], 'running'>;
  label: string;
  report: Report | undefined;
  view: MatchView | undefined;
  army: ArmyId | undefined;
  exit(): void;
  keepLooking(): void;
}): HTMLElement {
  const { outcome, label, report, view, army } = options;
  const title = outcome === 'win' ? 'VICTORY' : outcome === 'loss' ? 'DEFEAT' : 'DRAW';
  const rank = report?.rank ?? view?.rank;
  const armies = report?.armies.length ?? view?.match.armies.length ?? 0;
  const elapsedSeconds = Math.floor((report?.ticks ?? view?.tick ?? 0) / TICK_RATE);
  return h(
    'div',
    { class: `outcome-card ${outcome}` },
    h('div', { class: 'outcome-kicker' }, 'After-action report'),
    h('div', { class: 'outcome-title' }, title),
    h('div', { class: 'outcome-meta' }, `${label}${rank !== undefined && armies > 2 ? ` · ${placeLabel(rank)} of ${armies}` : ''} · ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`),
    report && army && view
      ? h(
          'div',
          { class: 'report' },
          outcomeTable(report, army),
          h(
            'div',
            { class: 'timeline' },
            h('div', { class: 'cmd-section' }, 'Key moments'),
            ...report.timeline.slice(-REPORT_TIMELINE_EVENTS).map((event) => {
              const { text, sev } = eventText(event, army, view.match);
              const eventSeconds = Math.floor(event.tick / TICK_RATE);
              return h(
                'div',
                { class: `ev ${sev}` },
                h('span', { class: 'ev-t' }, `${Math.floor(eventSeconds / 60)}:${String(eventSeconds % 60).padStart(2, '0')}`),
                h('span', { class: 'ev-p', style: `--accent:${PLANE_ACCENT[event.plane]}`, 'data-tip': PLANE_NAME[event.plane] }, icon(event.plane, 14)),
                text,
              );
            }),
          ),
        )
      : h('div', { class: 'muted' }, 'Waiting for the after-action report…'),
    h(
      'div',
      { class: 'outcome-actions' },
      h('button', { class: 'btn primary', 'data-tip': 'Back to lobby', 'aria-label': 'Back to lobby', onclick: options.exit }, icon('leave')),
      h('button', { class: 'btn ghost', 'data-tip': 'Keep looking', 'aria-label': 'Keep looking', onclick: options.keepLooking }, icon('spectate')),
    ),
  );
}

type Stat = keyof Report['armies'][number]['stats'];
const ROWS: readonly (readonly [string, Stat])[] = [
  ['Alloy mined', 'alloyMined'],
  ['Energy delivered', 'energyDelivered'],
  ['Units produced', 'produced'],
  ['Kills', 'kills'],
  ['Units lost', 'unitsLost'],
  ['Structures lost', 'structuresLost'],
  ['Collapses caused', 'collapses'],
  ['Asteroid impacts', 'impacts'],
  ['Interceptions', 'interceptions'],
  ['Island-seconds held', 'islandTicks'],
  ['Forward posts captured', 'postsCaptured'],
  ['Post-seconds held', 'postTicks'],
  ['Derelict cores cashed in', 'coreCashed'],
  ['Contested-point seconds', 'pointTicks'],
  ['Spire damage dealt', 'spireDamageDealt'],
];

/** One column per army in army order, headed in its colour ink; our column is marked; the first row is each place. */
export function outcomeTable(report: Report, me: ArmyId): HTMLTableElement {
  const armies = report.armies;
  return h('table', {},
    h('tr', {}, h('th', {}, ''), ...armies.map((a) => h('th', {
      'data-army': a.army, 'data-own': a.army === me ? '' : undefined, style: `color:var(--army-${a.colour}-ink)`,
      'data-tip': `${COLOUR_LABEL[a.colour]} · ${CORNER_LABEL[a.army]}${a.army === me ? ' · you' : ''}`,
    }, a.army === me ? 'You' : COLOUR_LABEL[a.colour]))),
    h('tr', { class: 'report-place' }, h('td', {}, 'Place'), ...armies.map((a) => h('td', { 'data-army': a.army }, a.rank === undefined ? '—' : placeLabel(a.rank)))),
    ...ROWS.map(([label, k]) => h('tr', {}, h('td', {}, label), ...armies.map((a) => h('td', {}, fmt(k === 'islandTicks' || k === 'postTicks' || k === 'pointTicks' ? a.stats[k] / TICK_RATE : a.stats[k]))))),
  );
}

/**
 * The eliminated player's perspective choice: All (no fog) first, then every army's own fog, each in its colour.
 * `choose` requests the observer pass; the observer opens on that perspective when the grant permits it.
 */
export function perspectiveChoice(match: Pick<MatchData, 'armies'>, me: ArmyId, choose: (perspective: ArmyId | 'all') => void): HTMLElement {
  return h('div', { class: 'outcome-perspectives', role: 'group', 'aria-label': 'Spectate' },
    h('button', { type: 'button', class: 'btn small', 'data-perspective': 'all', 'data-tip': 'Watch everything · no fog', 'aria-label': 'Spectate: all', onclick: () => choose('all') }, icon('spectate', 16), 'All'),
    ...match.armies.map((a) => {
      const name = a.id === me ? `${COLOUR_LABEL[a.colour]} (you)` : COLOUR_LABEL[a.colour];
      return h('button', { type: 'button', class: 'btn small', 'data-perspective': a.id, style: `--side:${SIDE_HEX[a.colour]}`, 'data-tip': `${name}'s fog · ${CORNER_LABEL[a.id]}`, 'aria-label': `Spectate: ${name}`, onclick: () => choose(a.id) }, icon('fog', 16), name);
    }));
}
