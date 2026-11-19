import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LadderDocument } from '../src/ladder/components.ts';
import type { CommanderCard, LadderDocumentProps } from '../src/ladder/model.ts';

const assets: LadderDocumentProps['assets'] = { script: '/ladder.js', styles: ['/ladder.css'], brand: { logo: '/logo.webp', icon: '/icon.png', touchIcon: '/touch.png', font: '/font.woff2' } };

function card(over: Partial<CommanderCard> = {}): CommanderCard {
  return {
    publicId: 'c_public0000000000000', name: 'Iron Policy', kind: 'policy', planes: ['depths', 'surface', 'sky', 'orbit'], segmentSince: Date.UTC(2000, 9, 1), archivedSegments: [],
    ratings: [{ pool: 'policy_1v1', season: '2000Q4', points: 812, band: [760, 1100], rank: 3, percentile: 80, provisional: false, games: 14, record: { wins: 9, losses: 4, draws: 1 }, placements: null, meanRank: null, history: [] }],
    gauntlet: { tier: 'standard', artifact: 'abcdefabcdef', at: Date.UTC(2000, 10, 1), levels: [{ level: 'novice', games: 6, score: 1, interval: [1, 1] }, { level: 'standard', games: 6, score: 0.67, interval: [0.5, 0.83] }] },
    unrated: { lobby: 3, custom: 1, bots: 2 },
    recent: [
      { matchId: 'm1', at: Date.UTC(2000, 10, 2), pool: 'policy_1v1', map: 'crossfire', opponents: [{ name: null, href: null, points: 640 }], outcome: 'win', rank: 1, seconds: 754, delta: 18, fallbackHeavy: false, policies: [{ version: 3, hash: 'abcdefabcdef' }], replay: '/api/ladder/replays/m1' },
      { matchId: 'm2', at: Date.UTC(2000, 10, 3), pool: 'policy_1v1', map: 'crown', opponents: [{ name: 'Open Rival', href: '/commanders/c_rival', points: 900 }], outcome: 'loss', rank: 2, seconds: 600, delta: -12, fallbackHeavy: true, policies: [], replay: null },
    ],
    fallbackHeavy: 1,
    verified: { executionKind: 'policy', artifacts: [{ hash: 'abcdefabcdef', versions: [2, 3] }], harness: null, acbench: null },
    declared: null, selfReported: null, host: { origin: 'https://agentcommand.gg', keyId: 'k_0123456789abcdef' },
    ...over,
  };
}

const render = (props: LadderDocumentProps) => renderToString(createElement(LadderDocument, props));

describe('ladder pages', () => {
  it('renders the three label tiers distinctly, private opponents by placeholder and no native title attributes', () => {
    const html = render({ page: { kind: 'card', title: 'Iron Policy', canonical: 'https://agentcommand.gg/commanders/c_public0000000000000', card: card(), leaderboard: null }, assets });
    for (const tier of ['tier-verified', 'tier-declared', 'tier-reported']) expect(html).toContain(tier);
    expect(html).toContain('Verified by the host');
    expect(html).toContain('Declared by owner');
    expect(html).toContain('Self-reported, never verified');
    expect(html).toContain('Private commander');
    expect(html).toContain('href="/commanders/c_rival"');
    expect(html).toContain('Fallback-heavy ×1');
    expect(html).toContain('Download signed log');
    expect(html).toContain('812');
    expect(html.replace(/<title>[^<]*<\/title>/, '')).not.toMatch(/\stitle=/);
    expect(html).toMatch(/data-tip="[^"]+"/);
  });

  it('shows declared metadata and usage only when the owner disclosed them', () => {
    const hidden = render({ page: { kind: 'card', title: 'x', canonical: 'x', card: card(), leaderboard: null }, assets });
    expect(hidden).toContain('Not disclosed.');
    const shown = render({ page: { kind: 'card', title: 'x', canonical: 'x', card: card({ declared: { provider: 'Acme', model: 'acme-1' }, selfReported: { decisions: 40, inputTokens: 1000, outputTokens: 200, coverage: 'partial' } }), leaderboard: null }, assets });
    expect(shown).toContain('acme-1');
    expect(shown).toContain('coverage partial');
  });

  it('hydrates from an inert JSON node carrying only the page projection', () => {
    const props: LadderDocumentProps = { page: { kind: 'leaderboard', title: 'Leaderboard', canonical: 'x', card: null, leaderboard: { pool: 'policy_1v1', season: '2000Q4', pools: ['policy_1v1'], seasons: ['2000Q4'], rows: [{ publicId: 'c_a', name: 'Listed', kind: 'policy', points: 900, band: [800, 1000], games: 20, record: { wins: 12, losses: 8, draws: 0 }, meanRank: null }] } }, assets };
    const html = render(props);
    const data = /<div hidden="" id="acladder-data">([^<]*)<\/div>/.exec(html)?.[1];
    expect(data).toBeTruthy();
    expect(JSON.parse(data!.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))).toEqual(props);
    expect(html).toContain('Listed');
  });
});
