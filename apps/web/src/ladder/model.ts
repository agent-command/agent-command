/**
 * Public commander cards and the leaderboard (DESIGN §Ladder, D5): the server's privacy projection, rendered on Node
 * and hydrated in the browser. Nothing here identifies an owner: commanders appear by public id and, only when they
 * opted in, by name.
 */
export const POOL_LABEL: Readonly<Record<string, string>> = { policy_1v1: 'Policy · 1v1', policy_ffa: 'Policy · FFA', live_1v1: 'Live agent · 1v1', live_ffa: 'Live agent · FFA' };

export interface RatingPoint { at: number; points: number; low: number; high: number }

export interface CardRating {
  pool: string;
  season: string;
  /** max(0, round(40 × (μ − 3σ))). */
  points: number;
  /** μ ± 2σ in ladder units. */
  band: [number, number];
  rank: number | null;
  percentile: number | null;
  provisional: boolean;
  games: number;
  /** 1v1 pools. */
  record: { wins: number; losses: number; draws: number } | null;
  /** FFA pools: games per placement (index 0 = first) and the mean rank. */
  placements: number[] | null;
  meanRank: number | null;
  history: RatingPoint[];
}

export interface CardOpponent {
  /** The opponent's name only when its card is public; otherwise the client shows "Private commander". */
  name: string | null;
  href: string | null;
  points: number | null;
}

export interface CardMatch {
  matchId: string;
  at: number;
  pool: string;
  map: string | null;
  opponents: CardOpponent[];
  outcome: 'win' | 'loss' | 'draw' | 'unknown';
  rank: number | null;
  seconds: number;
  delta: number | null;
  fallbackHeavy: boolean;
  policies: { version: number; hash: string }[];
  replay: string | null;
}

export interface GauntletLevel { level: string; games: number; score: number; interval: [number, number] | null }

export interface CommanderCard {
  publicId: string;
  name: string;
  kind: 'agent' | 'policy';
  planes: string[];
  segmentSince: number | null;
  archivedSegments: { since: number; until: number; points: number; pool: string }[];
  ratings: CardRating[];
  gauntlet: { tier: string | null; levels: GauntletLevel[]; artifact: string; at: number } | null;
  unrated: { lobby: number; custom: number; bots: number };
  recent: CardMatch[];
  fallbackHeavy: number;
  verified: {
    executionKind: string | null;
    artifacts: { hash: string; versions: number[] }[];
    harness: string | null;
    acbench: { id: string; revision: number; path: string } | null;
  };
  /** Only with the owner's `discloseModel` opt-in. */
  declared: { provider?: string; model?: string; scaffoldVersion?: string } | null;
  selfReported: { decisions: number; inputTokens: number | null; outputTokens: number | null; coverage: string } | null;
  host: { origin: string; keyId: string | null };
}

export interface LeaderboardRow { publicId: string; name: string; kind: 'agent' | 'policy'; points: number; band: [number, number]; games: number; record: CardRating['record']; meanRank: number | null }

export interface LadderPage {
  kind: 'card' | 'leaderboard' | 'unavailable';
  title: string;
  canonical: string;
  card: CommanderCard | null;
  leaderboard: { pool: string; season: string; pools: string[]; seasons: string[]; rows: LeaderboardRow[] } | null;
}

export interface LadderDocumentProps {
  page: LadderPage;
  assets: { script: string; styles: string[]; brand: { logo: string; icon: string; touchIcon: string; font: string } };
}

export const cardPath = (publicId: string): string => `/commanders/${encodeURIComponent(publicId)}`;
export const leaderboardPath = (pool: string, season: string): string => `/leaderboard?pool=${encodeURIComponent(pool)}&season=${encodeURIComponent(season)}`;
