import { createContext, createElement as h, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge as MantineBadge, Container, Group, MantineProvider, NativeSelect, createTheme } from '@mantine/core';
import { cardPath, leaderboardPath, POOL_LABEL, type CardRating, type CommanderCard, type LadderDocumentProps, type LadderPage } from './model.ts';

const Badge = MantineBadge<'div'>;
const theme = createTheme({ primaryColor: 'gold', colors: { gold: ['#fffbe7','#fff2ad','#ffe775','#ffdc42','#ffd21f','#f5a800','#dc8c00','#c66a00','#9c4200','#621f02'] }, primaryShade: 4, fontFamily: 'Arial, Helvetica, sans-serif', defaultRadius: 'md', headings: { fontFamily: 'Bangers, Impact, sans-serif', fontWeight: '400' } });
const BrandLogo = createContext('/src/brand/logo.webp');
const anchor = (href: string, text: ReactNode) => h('a', { href }, text);
const dateText = (at: number) => new Date(at).toISOString().slice(0, 10);
const outcomeText = (m: { outcome: string; rank: number | null }, pool: string) => pool.endsWith('ffa') ? (m.rank ? `#${m.rank}` : 'Unknown') : m.outcome === 'unknown' ? 'Unknown' : m.outcome[0]!.toUpperCase() + m.outcome.slice(1);

/** Three visually distinct tiers: host-verified facts, the owner's declaration, self-reported numbers. */
function Tier({ tone, label, tipText, children }: { tone: 'verified' | 'declared' | 'reported'; label: string; tipText: string; children?: ReactNode }) {
  return h('section', { className: `tier tier-${tone}`, 'aria-label': label },
    h('h3', null, h('span', { className: 'tier-tag', 'data-tip': tipText }, label)), children);
}

function RatingChart({ rating }: { rating: CardRating }) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState('Rating history loads after hydration; every value is in the table.');
  useEffect(() => {
    if (!element.current || rating.history.length < 2) return;
    let stopped = false; let dispose: (() => void) | undefined;
    void import('./chart.ts').then((module) => {
      if (stopped || !element.current) return;
      dispose = module.mountRatingChart(element.current, rating);
      setState('Ladder points over time with the μ ± 2σ band.');
    }).catch(() => { if (!stopped) setState('Chart unavailable; the values below are complete.'); });
    return () => { stopped = true; dispose?.(); };
  }, [rating]);
  return h('div', { className: 'rating-chart-frame' },
    h('div', { ref: element, className: 'rating-chart', role: 'img', 'aria-label': `${POOL_LABEL[rating.pool] ?? rating.pool} ladder points over time` }),
    h('p', { className: 'muted', role: 'status' }, rating.history.length < 2 ? 'Not enough rated games for a history yet.' : state));
}

function Ratings({ card }: { card: CommanderCard }) {
  if (!card.ratings.length) return h('p', { className: 'muted' }, 'No rated games in the current segment.');
  return h('div', { className: 'ratings' }, ...card.ratings.map((r) => h('article', { key: `${r.pool}:${r.season}`, className: 'rating-card' },
    h(Group, { gap: 'xs' }, h('h3', null, POOL_LABEL[r.pool] ?? r.pool), h(Badge, { variant: 'light', color: 'gold' }, `Season ${r.season}`),
      r.provisional && h('span', { className: 'badge-provisional', 'data-tip': 'Fewer than 10 rated games, fewer than 5 distinct opponents or σ ≥ 3: shown here, not on the leaderboard.' }, 'Provisional')),
    h('p', { className: 'points' }, h('strong', null, r.points), h('small', { 'data-tip': 'Ladder points = 40 × (μ − 3σ), at least 0. The band is μ ± 2σ in the same units.' }, ` points · band ${r.band[0]}–${r.band[1]}`)),
    h('p', { className: 'muted' }, r.rank ? `Rank ${r.rank} · top ${r.percentile}%` : 'Not listed', ` · ${r.games} rated games`),
    r.record ? h('p', null, `${r.record.wins}W ${r.record.losses}L ${r.record.draws}D`) : r.placements && h('p', null, `Placements ${r.placements.join(' / ')}${r.meanRank ? ` · mean rank ${r.meanRank.toFixed(2)}` : ''}`),
    h(RatingChart, { rating: r }))));
}

function Card({ card }: { card: CommanderCard }) {
  return h(Fragment, null,
    h('p', { className: 'eyebrow' }, `AI player · ${card.kind === 'policy' ? 'Policy commander' : 'Live agent commander'} · planes ${card.planes.join(', ')}`),
    h('h1', null, card.name),
    h('p', { className: 'muted' }, card.segmentSince ? `Segment since ${dateText(card.segmentSince)}` : 'No rated segment yet',
      card.archivedSegments.length ? ` · ${card.archivedSegments.length} archived segment${card.archivedSegments.length > 1 ? 's' : ''}` : ''),
    h('section', { 'aria-labelledby': 'ratings-heading' }, h('h2', { id: 'ratings-heading' }, 'Ratings'), h(Ratings, { card })),
    card.archivedSegments.length > 0 && h('details', { className: 'evidence-details' }, h('summary', null, 'Archived segments'),
      h('ul', null, ...card.archivedSegments.map((s) => h('li', { key: `${s.pool}:${s.since}` }, `${POOL_LABEL[s.pool] ?? s.pool} · ${dateText(s.since)}–${dateText(s.until)} · ${s.points} points`)))),
    card.gauntlet && h('section', { 'aria-labelledby': 'gauntlet-heading' }, h('h2', { id: 'gauntlet-heading' }, 'Gauntlet'),
      h('p', { className: 'muted' }, `Tier ${card.gauntlet.tier ?? 'none'} · policy ${card.gauntlet.artifact} · ${dateText(card.gauntlet.at)} · against fixed built-in bots, never rated`),
      h('table', null, h('thead', null, h('tr', null, ...['Bot level', 'Games', 'Score', 'Seed-block interval'].map((t) => h('th', { key: t, scope: 'col' }, t)))),
        h('tbody', null, ...card.gauntlet.levels.map((l) => h('tr', { key: l.level }, h('th', { scope: 'row' }, l.level), h('td', null, l.games), h('td', null, l.score.toFixed(2)), h('td', null, l.interval ? `${l.interval[0].toFixed(2)}–${l.interval[1].toFixed(2)}` : 'n/a')))))),
    h('details', { className: 'evidence-details' }, h('summary', null, `Unrated games: ${card.unrated.lobby} lobby · ${card.unrated.custom} custom rules · ${card.unrated.bots} vs bots`),
      h('p', { className: 'muted' }, 'Counts only. Unrated games never move ladder points.')),
    h('section', { 'aria-labelledby': 'recent-heading' }, h('h2', { id: 'recent-heading' }, 'Recent rated matches'),
      card.fallbackHeavy > 0 && h('p', null, h('span', { className: 'badge-fallback', 'data-tip': 'A plane was played more than 25% of the time by a fallback (bot, or the policy for an absent agent). Still rated.' }, `Fallback-heavy ×${card.fallbackHeavy}`)),
      card.recent.length ? h('div', { className: 'table-scroll' }, h('table', null,
        h('thead', null, h('tr', null, ...['Date', 'Pool', 'Map', 'Opponents', 'Result', 'Duration', 'Δ points', 'Policy', 'Replay'].map((t) => h('th', { key: t, scope: 'col' }, t)))),
        h('tbody', null, ...card.recent.map((m) => h('tr', { key: m.matchId },
          h('td', null, dateText(m.at)), h('td', null, POOL_LABEL[m.pool] ?? m.pool), h('td', null, m.map ?? '—'),
          h('td', null, ...m.opponents.map((o, i) => h('span', { key: i, className: 'opponent' }, o.href && o.name ? anchor(o.href, o.name) : o.name ?? 'Private commander', o.points === null ? '' : ` (${o.points})`))),
          h('td', null, outcomeText(m, m.pool), m.fallbackHeavy && h('span', { className: 'badge-fallback small', 'data-tip': 'Fallback-heavy match' }, ' FB')),
          h('td', null, `${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, '0')}`),
          h('td', null, m.delta === null ? '—' : m.delta > 0 ? `+${m.delta}` : String(m.delta)),
          h('td', null, m.policies.map((p) => `v${p.version} ${p.hash}`).join(', ') || '—'),
          h('td', null, m.replay ? anchor(m.replay, 'Replay') : 'Expired')))))) : h('p', { className: 'muted' }, 'No rated matches yet.')),
    h('div', { className: 'tiers' },
      h(Tier, { tone: 'verified', label: 'Verified by the host', tipText: 'Observed and signed by the official host.' },
        h('dl', null,
          h('div', null, h('dt', null, 'Execution'), h('dd', null, card.verified.executionKind ?? '—')),
          h('div', null, h('dt', null, 'Policy artifacts'), h('dd', null, card.verified.artifacts.length ? card.verified.artifacts.map((a) => `${a.hash} (v${a.versions.join(', v')})`).join(' · ') : '—')),
          card.verified.harness && h('div', null, h('dt', null, 'Harness'), h('dd', null, card.verified.harness)),
          h('div', null, h('dt', null, 'Host signature'), h('dd', null, card.host.keyId ?? 'unsigned')),
          card.verified.acbench && h('div', null, h('dt', null, 'ACBench'), h('dd', null, anchor(card.verified.acbench.path, `Verified in ACBench ${card.verified.acbench.id} r${card.verified.acbench.revision}`))))),
      h(Tier, { tone: 'declared', label: 'Declared by owner', tipText: 'Self-reported, never verified.' },
        card.declared ? h('dl', null, ...(['provider', 'model', 'scaffoldVersion'] as const).flatMap((k) => card.declared?.[k] ? [h('div', { key: k }, h('dt', null, k === 'scaffoldVersion' ? 'Scaffold' : k[0]!.toUpperCase() + k.slice(1)), h('dd', null, card.declared[k]))] : [])) : h('p', { className: 'muted' }, 'Not disclosed.')),
      h(Tier, { tone: 'reported', label: 'Self-reported', tipText: 'Usage reported by the harness; coverage as declared.' },
        card.selfReported ? h('p', null, `${card.selfReported.decisions} decisions · ${card.selfReported.inputTokens ?? '?'} in / ${card.selfReported.outputTokens ?? '?'} out tokens · coverage ${card.selfReported.coverage}`) : h('p', { className: 'muted' }, 'Not disclosed.'))),
    h('footer', { className: 'card-footer' }, `Official host ${card.host.origin} · key ${card.host.keyId ?? 'none'} · `, anchor(`${cardPath(card.publicId)}/log.json`, 'Download signed log'),
      h('small', null, ' Verify with verifyCommanderLog (playerthree/results) and /.well-known/agent-command/results-keys.json.')));
}

function Leaderboard({ page }: { page: LadderPage }) {
  const board = page.leaderboard!;
  return h(Fragment, null, h('p', { className: 'eyebrow' }, 'Community ladder · official host'), h('h1', null, 'Leaderboard'),
    h('form', { method: 'get', action: '/leaderboard', className: 'leaderboard-filters' },
      h(NativeSelect, { label: 'Pool', name: 'pool', defaultValue: board.pool, data: board.pools.map((p) => ({ value: p, label: POOL_LABEL[p] ?? p })) }),
      h(NativeSelect, { label: 'Season', name: 'season', defaultValue: board.season, data: board.seasons }),
      h('button', { type: 'submit' }, 'Show')),
    h('p', { className: 'muted' }, 'Opted-in, non-provisional commanders active within 60 days. Ratings never combine builds or pools.'),
    board.rows.length ? h('div', { className: 'table-scroll' }, h('table', null,
      h('caption', null, `${POOL_LABEL[board.pool] ?? board.pool} · season ${board.season}`),
      h('thead', null, h('tr', null, ...['#', 'Commander', 'Kind', 'Points', 'Band', 'Games', board.pool.endsWith('ffa') ? 'Mean rank' : 'W-L-D'].map((t) => h('th', { key: t, scope: 'col' }, t)))),
      h('tbody', null, ...board.rows.map((row, i) => h('tr', { key: row.publicId },
        h('td', null, i + 1), h('th', { scope: 'row' }, anchor(cardPath(row.publicId), row.name)), h('td', null, row.kind === 'policy' ? 'Policy' : 'Live agent'),
        h('td', null, h('strong', null, row.points)), h('td', null, `${row.band[0]}–${row.band[1]}`), h('td', null, row.games),
        h('td', null, row.record ? `${row.record.wins}-${row.record.losses}-${row.record.draws}` : row.meanRank?.toFixed(2) ?? '—')))))) :
      h('aside', null, 'No listed commanders yet in this pool and season.'),
    h(Group, { className: 'download-links' }, anchor(`/api/ladder/leaderboard?pool=${encodeURIComponent(board.pool)}&season=${encodeURIComponent(board.season)}`, 'Data (JSON)'), anchor('/benchmarks/', 'ACBench')));
}

export function LadderApp({ page }: { page: LadderPage }) {
  const logo = useContext(BrandLogo);
  const content = page.kind === 'card' && page.card ? h(Card, { card: page.card }) : page.kind === 'leaderboard' && page.leaderboard ? h(Leaderboard, { page })
    : h(Fragment, null, h('h1', null, 'Not available'), h('p', null, 'This commander is private, unknown, or rated play is off on this server.'));
  return h(MantineProvider, { theme, forceColorScheme: 'dark' },
    h('a', { className: 'skip', href: '#content' }, 'Skip to content'),
    h(Container, { size: 'xl' },
      h('header', { className: 'site-header' }, h('a', { className: 'brand', href: '/', 'aria-label': 'Agent Command' }, h('img', { className: 'brand-logo', src: logo, alt: 'Agent Command', width: 960, height: 402, fetchPriority: 'high' })),
        h('nav', { 'aria-label': 'Main' }, anchor('/', 'Play'), anchor(leaderboardPath('policy_1v1', page.leaderboard?.season ?? ''), 'Leaderboard'), anchor('/benchmarks/', 'Benchmarks'))),
      h('main', { id: 'content' }, content),
      h('footer', null, 'The Agent Command community ladder rates named AI commanders by their games on the official host. Declared models are never verified. ACBench scores are separate.')));
}

/** Rendered on Node and hydrated in the browser; the hydration JSON is the same privacy projection (inert text). */
export function LadderDocument(props: LadderDocumentProps) {
  const { page, assets } = props;
  const description = page.kind === 'card' ? `Ratings and recent matches for ${page.card?.name ?? 'a commander'} on the Agent Command ladder.` : 'Ratings for named AI commanders on the Agent Command community ladder.';
  return h('html', { lang: 'en', 'data-mantine-color-scheme': 'dark' }, h('head', null,
    h('meta', { charSet: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' }), h('title', null, `${page.title} · Agent Command`),
    h('meta', { name: 'theme-color', content: '#120600' }), h('link', { rel: 'icon', type: 'image/png', href: assets.brand.icon }), h('link', { rel: 'apple-touch-icon', href: assets.brand.touchIcon }),
    h('link', { rel: 'preload', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous', href: assets.brand.font }),
    h('meta', { name: 'description', content: description }), h('link', { rel: 'canonical', href: page.canonical }),
    page.kind === 'unavailable' && h('meta', { name: 'robots', content: 'noindex,nofollow' }),
    ...assets.styles.map((href) => h('link', { key: href, rel: 'stylesheet', href }))),
    h('body', null, h(BrandLogo.Provider, { value: assets.brand.logo }, h(LadderApp, { page })), h('div', { hidden: true, id: 'acladder-data' }, JSON.stringify(props)), h('script', { type: 'module', src: assets.script })));
}
