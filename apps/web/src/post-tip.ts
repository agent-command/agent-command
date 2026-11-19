/** Hover tip for a Surface forward post (a home post or a contested point): who holds it, its capture when known, and what holding it gives. */
import { type Entity, type MatchData, type Rules, type Side, type View } from '@agent-command/game/contract';
import { armyLabel } from './armies.ts';
import type { TipContent } from './tooltip.ts';

const POINTS = new WeakMap<MatchData, ReadonlySet<string>>();

/** Ids of the match's contested points (matchData.posts kind contested), computed once per match bootstrap. */
export function contestedPoints(match: MatchData): ReadonlySet<string> {
  let ids = POINTS.get(match);
  if (!ids) POINTS.set(match, (ids = new Set(match.posts.filter((p) => p.kind === 'contested').map((p) => p.id))));
  return ids;
}

/** 'Contested point' for the contested point at (x, y) (an event's spot) among `posts`, else 'Forward post'. */
export function postName(posts: MatchData['posts'] | undefined, x: number, y: number): string {
  return posts?.some((p) => p.kind === 'contested' && Math.abs(p.x - x) <= 0.5 && Math.abs(p.y - y) <= 0.5) ? 'Contested point' : 'Forward post';
}

export function postTip(post: Entity, view: View, rules: Rules): TipContent {
  const whose = (side: Side) => side === view.army ? 'yours' : side === 'neutral' ? 'nobody' : armyLabel(view.match!, side);
  const r = rules.surface;
  const point = view.match ? contestedPoints(view.match).has(post.id) : false;
  const home = point ? undefined : view.match?.posts.find((p) => p.id === post.id)?.home;
  const lines: string[] = [];
  const pct = post.progress === undefined ? '' : ` ${Math.round(post.progress * 100)}%`;
  if (post.state === 'contested') lines.push(`Contested: hostile units on it together, no progress${pct ? ` (at${pct})` : ''}.`);
  else if (post.state === 'capturing' && pct) lines.push(`Being captured:${pct}.`);
  else if (pct) lines.push(`Capture fading:${pct}.`);
  const radius = point ? r.contestedPostBuildRadius : r.postBuildRadius;
  lines.push(`Held: ${r.postVision}-tile vision over cliffs and onto plateaus, ${radius > 0 ? `${radius}-tile build radius` : 'no build radius'}, heals wounded Surface units within ${r.postHealRadius} tiles (${r.postHealPool} HP/s shared, at most ${r.postHealRate} HP/s each).`);
  if (point && r.postScore > 0) lines.push('Seconds held break a Spire HP tie at the time cap.');
  const capture = point ? r.contestedCaptureTime : r.postCaptureTime;
  lines.push(post.side === view.army
    ? 'Keep Surface units near it to hold it.'
    : `Right-click with Surface units to take it (${capture}s uncontested within ${r.postCaptureRadius} tiles).`);
  const name = point ? 'Contested point' : home === view.army ? 'Home post' : home && view.match ? `${armyLabel(view.match, home)} home post` : 'Forward post';
  return { title: `${name} · held by ${whose(post.side)}`, description: lines.join(' ') };
}
