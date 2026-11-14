/**
 * The one commander identity chip (AgentButton): Commanders screen, lobby slots, in-match rail, observer panes and
 * results all render occupants through `agentButton`, so a commander looks the same wherever it appears.
 * Identity is public text only: provider/model are self-reported and never verified; no credentials or refs.
 */
import type { ConnectionInfo } from '@playerthree/connect';
import type { EntrantCard, EntrantRow } from 'playerthree/arena';
import type { Opponent } from '@agent-command/game/contract';
import type { LobbyMember, LobbyOccupant, LobbyReadyState, PublicLobbyCard } from '@agent-command/game/lobby';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import type { RosterCommander } from './profile.ts';
import './agent-button.css';

export type AgentKind = 'human' | 'agent' | 'policy' | 'bot' | 'open' | 'closed' | 'none';
/** Live connection state; omitted wherever the viewer cannot know it (observer panes, results). */
export type AgentStatus = 'online' | 'offline';
export interface AgentIdentity {
  kind: AgentKind;
  name: string;
  /** Short secondary text: execution kind, bot level or policy version. */
  detail?: string;
  /** Self-reported provider / model badge. */
  model?: string;
  status?: AgentStatus;
  /** Tooltip-only provenance (harness, versions). */
  notes?: readonly string[];
}
export interface AgentButtonOptions {
  size?: 'small';
  className?: string;
  /** Renders a real button; without it the chip is static text. */
  onClick?: (event: MouseEvent) => void;
  pressed?: boolean;
  disabled?: boolean;
  /** Accessible name override when the chip acts for something larger than itself. */
  label?: string;
}

export const OPP_LABEL: Record<Opponent, string> = { idle: 'Idle', novice: 'Novice', standard: 'Standard', veteran: 'Veteran' };
const KIND_ICON: Record<AgentKind, IconName> = { human: 'human', agent: 'generic', policy: 'policy', bot: 'bot', open: 'none', closed: 'cancel', none: 'none' };
export const KIND_NAME: Record<AgentKind, string> = { human: 'Human', agent: 'Live commander', policy: 'Policy', bot: 'Bot', open: 'Open', closed: 'Closed', none: 'Hold' };
const STATUS_NAME: Record<AgentStatus, string> = { online: 'Connected', offline: 'Offline' };

/** The same identity as one line of text, for native options, statuses and accessible names. */
export function agentText(identity: AgentIdentity): string {
  return [identity.name, identity.detail, identity.model && `${identity.model} (self-reported)`, identity.status && STATUS_NAME[identity.status]].filter(Boolean).join(' · ');
}

export function agentButton(identity: AgentIdentity, options: AgentButtonOptions = {}): HTMLElement {
  const text = agentText(identity);
  const className = ['agent-button', options.size, options.className].filter(Boolean).join(' ');
  const parts = [
    icon(KIND_ICON[identity.kind], options.size ? 15 : 18),
    h('span', { class: 'agent-button-text' }, h('b', { class: 'agent-button-name' }, identity.name), identity.detail ? h('span', { class: 'agent-button-detail' }, identity.detail) : null),
    identity.model ? h('span', { class: 'agent-button-model' }, identity.model) : null,
    identity.status ? h('i', { class: 'agent-button-status', 'aria-hidden': 'true' }) : null,
  ];
  const attrs = {
    class: className, 'data-kind': identity.kind, 'data-status': identity.status,
    'data-tip': [text, ...(identity.notes ?? [])].join(' · '), 'aria-label': options.label ?? text,
  };
  if (!options.onClick) return h('span', attrs, ...parts);
  return h('button', { ...attrs, type: 'button', 'aria-pressed': options.pressed === undefined ? undefined : String(options.pressed), disabled: options.disabled, onclick: options.onClick as EventListener }, ...parts);
}

/** Chip plus visible provenance, for read-only panes (observer, results) where provenance must be readable at a glance. */
export function agentCard(identity: AgentIdentity): HTMLElement {
  return h('div', { class: 'agent-card' }, agentButton(identity), identity.notes?.length ? h('p', { class: 'agent-card-notes' }, identity.notes.join(' · ')) : null);
}

const model = (provider: string | null | undefined, name: string | null | undefined) => [provider, name].filter(Boolean).join(' / ') || undefined;

/** A roster commander; `connections` (owner-private) lights the dot for an active harness and names it in the tip. */
export function rosterAgent(commander: RosterCommander, connections: readonly ConnectionInfo[] = []): AgentIdentity {
  const held = connections.filter((connection) => connection.commander === commander.id);
  return {
    kind: commander.kind, name: commander.name,
    detail: commander.kind === 'policy' ? commander.roles.map((role) => `${role} v${commander.policy.activeByRole[role] ?? '—'}`).join(' · ') : 'Live',
    model: model(commander.metadata?.provider, commander.metadata?.model),
    status: commander.connected || held.some((connection) => connection.active) ? 'online' : 'offline',
    ...(held.length ? { notes: held.map((connection) => connection.client.name) } : {}),
  };
}

/** Frozen public entrant cards (observer frames) and result rows share one identity. */
export function entrantAgent(entrant: EntrantCard | EntrantRow): AgentIdentity {
  const harness = typeof entrant.harness === 'string' ? { label: entrant.harness, verified: 'harnessVerified' in entrant && entrant.harnessVerified } : entrant.harness;
  const version = entrant.scaffoldVersion ?? entrant.botVersion;
  const identity: AgentIdentity = {
    kind: entrant.kind, name: entrant.label,
    detail: entrant.kind === 'bot' ? (entrant.botLevel ? OPP_LABEL[entrant.botLevel as Opponent] ?? entrant.botLevel : 'Bot') : entrant.aiPlayer ? 'AI Player' : 'Human',
    model: model(entrant.provider, entrant.model),
  };
  const unreported = entrant.aiPlayer && entrant.kind !== 'bot' && !identity.model ? ['Model not reported'] : [];
  return { ...identity, notes: [...unreported, harness ? `${harness.label} · ${harness.verified ? 'verified' : 'not verified'}` : 'Harness not reported', version ? `Version ${version}` : 'Version not reported'] };
}

export interface OccupantContext {
  you: string;
  members: readonly LobbyMember[];
  roster: readonly RosterCommander[] | undefined;
  card?: PublicLobbyCard;
  ready?: LobbyReadyState;
}
/** A lobby seat as seen by this member: own commanders by roster identity, others by their public card only. */
export function occupantAgent(occupant: LobbyOccupant, context: OccupantContext): AgentIdentity {
  switch (occupant.kind) {
    case 'human': {
      const member = context.members.find((entry) => entry.id === occupant.memberId);
      return { kind: 'human', name: occupant.memberId === context.you ? 'You' : member?.label ?? 'Human', status: member ? member.connected ? 'online' : 'offline' : undefined };
    }
    case 'bot': return { kind: 'bot', name: 'Bot', detail: OPP_LABEL[occupant.level as Opponent] ?? occupant.level };
    case 'commander': {
      const own = occupant.ref && context.roster?.find((entry) => entry.id === occupant.ref!.id);
      if (own) return rosterAgent(own);
      const card = context.card;
      return {
        kind: card?.kind ?? 'agent', name: 'AI Player',
        detail: !card ? 'Commander' : card.mode === 'live' ? 'Live' : card.mode === 'policy' ? `Policy v${card.policy?.version ?? '—'}` : card.mode === 'bot' ? 'Bot fallback' : 'Held',
        status: context.ready === 'absent' ? 'offline' : undefined,
        notes: card?.harness ? [`${card.harness.label} · ${card.harness.verified ? 'verified' : 'not verified'}`] : undefined,
      };
    }
    case 'open': return { kind: 'open', name: 'Open' };
    default: return { kind: 'closed', name: 'Closed' };
  }
}

/** The exact in-match controller of one plane, named by its bound roster commander when this owner has one. */
export function controllerAgent(controller: string, bound: RosterCommander | undefined, active: boolean, policyVersion?: number): AgentIdentity {
  if (controller === 'agent') return { kind: 'agent', name: bound?.name ?? KIND_NAME.agent, model: bound ? model(bound.metadata?.provider, bound.metadata?.model) : undefined, status: active ? 'online' : 'offline' };
  if (controller === 'policy') return { kind: 'policy', name: bound?.name ?? KIND_NAME.policy, detail: policyVersion === undefined ? undefined : `v${policyVersion}` };
  if (controller === 'human') return { kind: 'human', name: 'You' };
  if (controller === 'bot') return { kind: 'bot', name: KIND_NAME.bot };
  return { kind: 'none', name: KIND_NAME.none };
}
