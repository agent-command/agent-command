/** Public pregame contract. No credentials, opaque profile IDs or private agent state belong in these DTOs. */
import type { Rules, RuleDiff } from '../rules/match-rules.ts';
import { COLOURS, type ArmyId, type Colour, type Plane, type TerrainPreset } from '../rules/vocabulary.ts';
import type { CommanderRef, SlotOccupant, ObserverGrant } from 'playerthree/arena';
import { mapDescriptor, type LobbyLayoutDescriptor } from '../maps/registry.ts';
export { MAPS, mapDescriptor as lobbyMap, registerMapDescriptor } from '../maps/registry.ts';
export type { LobbyLayoutDescriptor, LobbyMapDescriptor, LobbySpawnSlot } from '../maps/registry.ts';

/**
 * One army of a lobby: its corner (`id`, the army id), corner label and colour. `alliance` IS the army colour: armies
 * of one colour are allied (stage 2: every army its own colour) and the match's PlayerThree alliances are keyed by it.
 */
export interface LobbySide {
  id: ArmyId;
  label: string;
  alliance: Colour;
}

export type LobbyPhase = 'waiting' | 'preparing' | 'countdown' | 'started';
/**
 * WebSocket close codes of a match room the server takes away without a result: `restart` (the server process stops,
 * e.g. a dev restart), `update` (a deploy drain ran out of time), `closed` (the server closed the room, e.g. a failed
 * step). The server sends one before it declares any draw for its records, so a player is never shown that draw as an
 * outcome; the client says why instead and does not try to rejoin. Only an outcome from the match itself is a result.
 */
export const MATCH_CLOSE = { restart: 4101, update: 4102, closed: 4103 } as const;
export type MatchCloseReason = keyof typeof MATCH_CLOSE;
/** The reason a close code carries, if it is one of `MATCH_CLOSE`. */
export function matchCloseReason(code: number): MatchCloseReason | undefined {
  for (const reason of Object.keys(MATCH_CLOSE) as MatchCloseReason[]) if (MATCH_CLOSE[reason] === code) return reason;
  return undefined;
}
/**
 * Close code of a pregame or directory socket whose lobby service moved to another server (a cluster primary handed
 * over): the lobby itself lives on, so the client reconnects at once through a fresh admission. Outside Colyseus' own
 * codes (4000–4010), whose reconnect semantics differ.
 */
export const LOBBY_MOVED_CLOSE = 4110;
/** Seat readiness (agent seats: `absent` → `online` while its agent is connected → `ready` once it called game_ready). */
export type LobbyReadyState = 'ready' | 'online' | 'waiting' | 'absent' | 'stale_policy' | 'policy_failed' | 'consent_required';
export type { CommanderRef, SlotOccupant };
/** Private commander refs are included only in the owning member's snapshot. */
export type LobbyOccupant = Exclude<SlotOccupant, { kind: 'commander' }> |
  { kind: 'commander'; entrantId: string; ref?: CommanderRef };
export interface PublicLobbyCard {
  seat: { team: string; role: string };
  kind: 'agent' | 'policy';
  aiPlayer: true;
  mode: 'live' | 'policy' | 'bot' | 'held';
  harness?: { label: string; verified: boolean };
  policy?: { source: 'library' | 'pool'; version?: number; policyId?: string };
}
export interface LobbySeat {
  team: string;
  role: Plane;
  occupant: LobbyOccupant;
  ready: LobbyReadyState;
  card?: PublicLobbyCard;
}
export interface LobbyMember {
  id: string;
  label: string;
  seats: readonly { team: string; role: Plane }[];
  observer: boolean;
  connected: boolean;
  ready: boolean;
  leader: boolean;
}
export interface LobbySummary {
  code: string;
  purpose: 'play' | 'benchmark';
  mapId: string;
  layoutId: string;
  mode: string;
  visibility: 'public' | 'private';
  /** The host leaves the running game on Watch live (public lobbies only; a private game is never featured). */
  featured: boolean;
  phase: LobbyPhase;
  revision: number;
  mapSeed: number;
  size: number;
  rules: Rules;
  rulesHash: string;
  rulesDiff: readonly RuleDiff[];
  customRules: boolean;
  unrankedPractice: boolean;
  practiceReasons: string[];
  sides: readonly LobbySide[];
  observerPolicy: { allowOmniscient: boolean; minDelayMs: number };
  terrain: TerrainPreset;
  members: number;
  capacity: number;
  queuePosition?: number;
  estimatedWaitMs?: number;
  seats: LobbySeat[];
  agentsAllowed: true;
}
export interface LobbySnapshot extends LobbySummary {
  players: LobbyMember[];
  you: { memberId: string; observer: boolean; leader: boolean; grant?: ObserverGrant };
  countdownAt?: number;
  expiresAt: number;
}
export interface LobbyModeDescriptor {
  id: string;
  label: string;
  mapId: string;
  layoutId: string;
  supported: boolean;
  /** the layout's armies with their default colours (the k-th alliance COLOURS[k]) */
  sides: readonly LobbySide[];
  roles: readonly Plane[];
  playersPerSide: 1;
  symmetry: 'point' | 'quarter-turn';
  /** the map slots this layout plays on (generated maps: `map.params.slots`) */
  slots: 2 | 4;
}

export const lobbyLayout = (mapId: string, layoutId: string): LobbyLayoutDescriptor | undefined =>
  mapDescriptor(mapId)?.layouts.find((layout) => layout.id === layoutId);
export function lobbyMode(mapId: string, layoutId: string): LobbyModeDescriptor | undefined {
  const map = mapDescriptor(mapId);
  const layout = map?.layouts.find(entry => entry.id === layoutId);
  if (!map || !layout) return undefined;
  return {
    id: layout.mode, label: layout.label, mapId: map.id, layoutId: layout.id, supported: layout.supported,
    sides: map.slots.filter(slot => layout.alliances.some(alliance => alliance.slots.includes(slot.id))).map(slot => ({
      id: slot.id, label: slot.label, alliance: COLOURS[layout.alliances.findIndex(alliance => alliance.slots.includes(slot.id))]!,
    })),
    roles: map.roles, playersPerSide: 1, symmetry: layout.sides === 2 ? 'point' : 'quarter-turn', slots: layout.sides,
  };
}
