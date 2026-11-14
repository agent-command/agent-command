/** Owner-private named connections and authenticated lobby admissions. Credentials never enter URLs. */
import type { Opponent, Plane, MatchOptions, Report } from '@agent-command/game/contract';
import type { ConnectionInfo, ConsentRequestInfo, ConsentResult, PairingCode, PairingResult } from '@playerthree/connect';
import type { CommanderRef, LobbySummary } from '@agent-command/game/lobby';
import type { Approval, Mandate, PolicyStatus, Scope } from 'playerthree/control';
import type { PlayerConsoleTarget, PlayerStateWire } from '@playerthree/console';
import type { ObserverGrant } from 'playerthree/arena';
import { ApiError, apiError } from './api.ts';
import type { MatchTicket } from './net.ts';

/** Who takes a seat mid-match: a commander of mine, a bot (at the seat's level), or me. */
export type SeatOccupantChoice = { kind: 'commander'; ref: CommanderRef } | { kind: 'bot' } | { kind: 'human' };
const STORAGE_KEY = 'agent-command.profile';
export interface PlaneMandate extends Mandate {
  directive: { stance: string; focusX?: number; focusY?: number };
  limits?: { asteroidDrops?: boolean; collapses?: boolean };
}
export interface StoredProfile { id: string; secret: string }
export interface CommanderIdentity { provider?: string; model?: string; scaffoldVersion?: string }
export interface RosterCommander {
  id: string;
  name: string;
  kind: 'agent' | 'policy';
  roles: Plane[];
  isolation: { independentSessions: boolean };
  token: string;
  scopes: Scope[];
  mandate: PlaneMandate;
  metadata?: CommanderIdentity;
  policy: { activeByRole: Record<string, number | null>; versions: { version: number; role: Plane | null; runtime: string; createdAt: number; surfaceHash: string; hash?: string }[] };
  approvals: { role: Plane; approval: Approval }[];
  connected: boolean;
  lastSeenAt: number | null;
  seated: { match: string; roomId: string; team: string; roles: string[] } | null;
  readiness?: string;
  practicing: boolean;
  lastPractice: CommanderPractice | null;
}
/** The latest headless practice of this commander's active policy on one compatible plane. */
export interface CommanderPractice {
  at: number; role: Plane; opponent: Opponent; allies: Opponent; ticks: number; seed: number; version: number;
  outcome: 'win' | 'loss' | 'draw' | 'running'; report: Report | null;
}
export interface Roster {
  id: string;
  /** The host's agent-facing surface: a library version built against another one is stale until redeployed. */
  surfaceHash: string;
  commanders: RosterCommander[];
  chat: { at: number; from: 'owner' | 'agent'; commanderIds: string[]; tick: number; text: string; ping?: unknown }[];
}
/** `rollback` outcome: activated, waiting for approval, or refused with a closed policy error code (its probe failed). */
export type RollbackResult = { ok: true; version: number } | { ok: false; approval: { id: string; kind: string; version: number } } | { ok: false; error: string };
/** A built-in bot tier's registered `playerthree.policy/1` package (`GET /api/bots`). */
export interface BotPackage {
  level: Opponent; role: Plane; hash: string; bytes: number; runtime: string; license: string; author: string | null;
  /** Built for this server's game surface; otherwise matches play the bot's built-in code. */
  current: boolean;
}
export interface CommanderSetup {
  name: string; kind: 'agent' | 'policy'; roles: readonly Plane[];
  isolation: { independentSessions: boolean };
  metadata?: CommanderIdentity;
}
export interface CommanderPatch {
  name?: string; kind?: 'agent' | 'policy'; roles?: readonly Plane[];
  isolation?: { independentSessions: boolean }; metadata?: CommanderIdentity;
  scopes?: Scope[]; mandate?: Partial<PlaneMandate>;
}
export interface LobbyAdmission { roomId: string; token: string; expiresAt: number }
export interface LobbyAddress { code: string; roomId: string; visitorToken?: string }
export interface LobbyPlayerTicket extends MatchTicket { observer?: undefined; team: string; mode: 'pvp'; label: string }
export interface LobbyObserverTicket extends MatchTicket { observer: true; grant: ObserverGrant; readOnly: true; label: string }
export type LobbyMatchTicket = LobbyPlayerTicket | LobbyObserverTicket;
/** New expiries of the connected seats, extended in place (no rejoin). */
export interface LobbySeatRenewal { roomId: string; tickets: { role?: Plane; expiresAt: number }[] }
export interface LobbyJoinOptions { observer?: boolean; team?: string }
export interface LobbyCreate {
  mapId: string; layoutId: string; visibility: 'public' | 'private';
  preset: 'play' | 'host' | 'benchmark'; autoStart?: boolean; botLevel?: Opponent;
  mapSeed?: number; size?: number; rules?: MatchOptions; rulesPreset?: string;
  observerPolicy?: { minDelayMs: number };
}
export interface SeriesSetup {
  revision: number; seeds: number[]; maps: string[]; sideSwaps: boolean;
  speed: number; concurrency: number; maxTicks: number; maxWallMs: number; retries: number;
  retryOn: string[]; abortOn: string[]; schedule: 'paired'; resetAgentState: true;
}
export interface ArenaLimits {
  maxGames: number; maxConcurrency: number; maxLiveConcurrency: number; maxTicks: number; maxWallMs: number;
  maxAttemptBytes: number; maxBytes: number; maxOwnerBytes: number; maxActiveSeries: number;
  retentionMs: number; minPublicDelayMs: number;
}

function load(): StoredProfile | undefined {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) return undefined;
  let raw: Partial<StoredProfile> | null;
  try { raw = JSON.parse(text) as Partial<StoredProfile> | null; }
  catch { throw new Error('The saved profile is unreadable. It has been preserved; do not clear browser storage to reconnect.'); }
  if (raw && typeof raw.id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(raw.id) && typeof raw.secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw.secret)) return { id: raw.id, secret: raw.secret };
  throw new Error('The saved profile credentials are invalid. They have been preserved rather than replaced.');
}

export async function profileCall<T>(path: string, init: { method?: string; body?: unknown; secret?: string; visitorToken?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.secret) headers.authorization = `Bearer ${init.secret}`;
  else if (init.visitorToken) headers.authorization = `Visitor ${init.visitorToken}`;
  const res = await fetch(path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  if (!res.ok) throw await apiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export class ProfileApi {
  readonly profile: StoredProfile;
  private constructor(profile: StoredProfile) { this.profile = profile; }
  static async open(): Promise<{ api: ProfileApi; roster: Roster; created: boolean }> {
    const api = ProfileApi.stored();
    if (api) return { api, roster: await api.roster(), created: false };
    return { ...(await ProfileApi.create()), created: true };
  }
  static async create(): Promise<{ api: ProfileApi; roster: Roster }> {
    const profile = await profileCall<StoredProfile>('/api/profile', { body: {} });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    const api = new ProfileApi(profile);
    return { api, roster: await api.roster() };
  }
  static stored(): ProfileApi | undefined { const profile = load(); return profile ? new ProfileApi(profile) : undefined; }
  /** The server answered `bad_profile` (its data was reset): set the saved credentials aside, never delete them, so the
   *  next profile action creates a fresh one instead of failing forever. */
  static retire(): void {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text === null) return;
    localStorage.setItem(`${STORAGE_KEY}.unrecognized.${Date.now()}`, text);
    localStorage.removeItem(STORAGE_KEY);
  }
  private call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> { return profileCall(path, { ...init, secret: this.profile.secret }); }
  pairingCode(): Promise<PairingCode> { return this.call('/api/profile/pairing', { body: {} }); }
  roster(): Promise<Roster> { return this.call('/api/profile'); }
  async policyStatus(target: PlayerConsoleTarget): Promise<PolicyStatus | null> {
    const state = await this.call<PlayerStateWire>(`/playerthree/player/state?${new URLSearchParams({ ...target })}`);
    const policy = state.policies[target.role];
    if (policy === undefined) throw new Error('The selected seat returned no policy status');
    return policy;
  }
  createCommander(setup: CommanderSetup): Promise<Roster> { return this.call('/api/profile/commanders', { body: setup }); }
  update(id: string, patch: CommanderPatch): Promise<Roster> { return this.call(`/api/profile/commanders/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); }
  deleteCommander(id: string): Promise<Roster> { return this.call(`/api/profile/commanders/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  resolveApproval(commanderId: string, id: string, approve: boolean): Promise<Roster> { return this.call(`/api/profile/commanders/${encodeURIComponent(commanderId)}/approvals/${encodeURIComponent(id)}`, { body: { approve } }); }
  rotate(id: string): Promise<Roster> { return this.call(`/api/profile/commanders/${encodeURIComponent(id)}/rotate`, { body: {} }); }
  practice(id: string, role: Plane, opponent: Opponent, rules: MatchOptions): Promise<Roster> { return this.call(`/api/profile/commanders/${encodeURIComponent(id)}/practice`, { body: { role, opponent, rules } }); }
  rollback(id: string, role: Plane, version: number): Promise<{ result: RollbackResult; roster: Roster }> { return this.call(`/api/profile/commanders/${encodeURIComponent(id)}/rollback`, { body: { role, version } }); }
  /** One library version as its `playerthree.policy/1` file, named by the server (`<commander>-<role>-v<N>.policy.json`). */
  async exportPackage(id: string, version: number): Promise<{ fileName: string; blob: Blob }> {
    const res = await fetch(`/api/profile/commanders/${encodeURIComponent(id)}/versions/${version}/package`, { headers: { authorization: `Bearer ${this.profile.secret}` } });
    if (!res.ok) throw await apiError(res);
    const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    if (!fileName) throw new ApiError('bad_response');
    return { fileName, blob: await res.blob() };
  }
  /** Add a package as a new, inactive version on `role`; refusals are closed codes (`not_a_package`, `wrong_game`, `tampered`, `wrong_plane`, `rebuild_failed`). */
  importPackage(id: string, role: Plane, pkg: unknown): Promise<{ result: { version: number; stale: boolean }; roster: Roster }> { return this.call(`/api/profile/commanders/${encodeURIComponent(id)}/import`, { body: { role, package: pkg } }); }
  /** The built-in bots' packages (public; empty while the game registers none). */
  bots(): Promise<{ bots: BotPackage[] }> { return profileCall('/api/bots'); }
  tell(commanderIds: string[] | 'all', text: string, ping?: unknown): Promise<Roster> { return this.call('/api/profile/tell', { body: { commanderIds, text, ...(ping !== undefined ? { ping } : {}) } }); }
  connections(): Promise<ConnectionInfo[]> { return this.call('/api/profile/connections'); }
  async revokeConnection(id: string): Promise<void> { await this.call(`/api/profile/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  answerConsent(id: string, commander: string, roles: readonly Plane[], approve: boolean): Promise<ConsentResult> { return this.call(`/api/connect/${encodeURIComponent(id)}`, { body: { commander, roles, approve } }); }
  createLobby(setup: LobbyCreate): Promise<LobbyAddress> { return createLobby(setup, this.profile.secret); }
  joinLobby(code: string, options?: LobbyJoinOptions): Promise<LobbyAddress> { return this.call('/api/lobbies/join', { body: { code, ...options } }); }
  claimLobby(code: string, visitorToken: string, revision: number): Promise<LobbyAddress> { return this.call(`/api/lobbies/${encodeURIComponent(code)}/claim-owner`, { body: { visitorToken, revision } }); }
  connectLobby(code: string): Promise<LobbyAdmission> { return this.call(`/api/lobbies/${encodeURIComponent(code)}/connect`, { body: {} }); }
  startSeries(code: string, setup: SeriesSetup): Promise<{ seriesId: string }> { return this.call(`/api/lobbies/${encodeURIComponent(code)}/series`, { body: setup }); }
  arenaLimits(): Promise<ArenaLimits> { return this.call('/api/arena/limits'); }
  /** GitHub sign-in state (absent on servers without sign-in: the call fails 404). */
  account(): Promise<AccountView> { return this.call('/api/account'); }
  /** Start GitHub sign-in: the browser then navigates to the returned authorize URL. */
  linkGithub(): Promise<{ url: string }> { return this.call('/api/auth/github/start', { body: {} }); }
  /** Opt-in public cards and ladder chips of this roster (rated servers only). */
  ladderCards(): Promise<{ cards: LadderCardState[] }> { return this.call('/api/ladder/cards'); }
  setLadderCard(commanderId: string, open: boolean, discloseModel: boolean): Promise<{ cards: LadderCardState[] }> { return this.call('/api/ladder/cards', { body: { commanderId, public: open, discloseModel } }); }
}

export interface AccountView { linked: boolean; login: string | null; eligible: boolean; eligibleAt: number | null; provider: 'github' }
export interface LadderCardState {
  commanderId: string; publicId: string; public: boolean; discloseModel: boolean; href: string;
  chip: { pool: string; points: number; band: [number, number]; provisional: boolean } | null;
}

export function createLobby(setup: LobbyCreate, secret?: string): Promise<LobbyAddress> { return profileCall('/api/lobbies', { body: setup, ...(secret ? { secret } : {}) }); }
export function publicLobbies(): Promise<{ lobbies: LobbySummary[] }> { return profileCall('/api/lobbies'); }
export function publicDirectoryAdmission(): Promise<LobbyAdmission> { return profileCall('/api/lobbies/directory/connect', { body: {} }); }
export function consentInfo(id: string): Promise<ConsentRequestInfo> { return profileCall(`/api/connect/${encodeURIComponent(id)}`); }
export function pairConsent(id: string, code: string): Promise<PairingResult> { return profileCall(`/api/connect/${encodeURIComponent(id)}/pair`, { body: { code } }); }
export function answerPairedConsent(id: string, commander: string, roles: readonly Plane[], approve: boolean, pairingToken: string): Promise<ConsentResult> { return profileCall(`/api/connect/${encodeURIComponent(id)}`, { body: { commander, roles, approve, pairingToken } }); }
export function parseLobbyCode(value: string): string | undefined {
  const trimmed = value.trim();
  const fragment = trimmed.includes('#') ? trimmed.slice(trimmed.indexOf('#') + 1) : trimmed.replace(/^#/, '');
  const code = fragment.includes('=') ? new URLSearchParams(fragment).get('l') : fragment;
  return code && /^[A-Za-z0-9_-]{6,32}$/.test(code) ? code : undefined;
}
