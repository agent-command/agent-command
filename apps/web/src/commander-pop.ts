/** In-match seat controls: "Who plays <Plane>" (hand a plane to me, a bot, hold, or one of my commanders), and steer its agent. */
import { HARNESSES, harnessSetup, type ClientKind } from '@playerthree/connect';
import type { Controller } from 'playerthree';
import type { PolicyStatus, Scope } from 'playerthree/control';
import { PLANES, type Plane } from '@agent-command/game/contract';
import { agentButton, controllerAgent, rosterAgent, type AgentIdentity } from './agent-button.ts';
import { SERVER_NAME, approvalCard, mandateControls, mcpUrl, seg } from './commanders.ts';
import { PLANE_ACCENT, PLANE_CHAPTER, copyText, h } from './dom.ts';
import { ApiError } from './api.ts';
import { CallError } from './net.ts';
import { ProfileApi, type PlaneMandate, type Roster, type RosterCommander, type SeatOccupantChoice } from './profile.ts';
import { COMMANDER_VALUE, commanderPicker } from './commander-picker.ts';
import { seatPicker, type SeatCard, type SeatCardStatus } from './seat-picker.ts';
import { PLANE_NAME } from './text.ts';

/** Plain-English reasons for the codes a seat change can fail with (lobby `/seat`, the owner control channel). */
const REASON: Record<string, string> = {
  agents_need_main: 'commanders can only join this match at the start (it runs on a game worker)',
  commander_busy: 'that commander is busy in another match or seat',
  busy: 'that commander is busy in another match or seat',
  commander_other_army: 'that commander already plays another army in this match (one army per commander)',
  isolated_sessions_required: 'that commander needs independent sessions to play here (set it in Commanders)',
  incompatible_commander: 'that commander is not set up for this plane',
  bad_policy_version: 'that policy version is gone; pick the commander again',
  release_required: 'another player holds that seat',
  forbidden: 'that seat is not yours to hand over',
  human_side_conflict: 'you already play another army in this match',
  observer_vision_held: 'you watched this match with full vision, so you cannot take control in it',
  eliminated: 'your army is out of the match',
  not_started: 'the match is not running',
  mode_unavailable: 'this match does not offer that controller',
  rate_limited: 'too many changes at once; try again in a moment',
  lobby_not_found: 'the match lobby is gone',
  disconnected: 'you are disconnected from the match',
  timeout: 'the server did not answer in time',
  network: 'the server could not be reached',
};
function reason(error: unknown): string {
  return REASON[error instanceof ApiError || error instanceof CallError ? error.code : 'network'] ?? 'the server refused it; try again';
}
/** A picker card plus what picking it does: the success toast's target and the failure toast's opening. */
type Choice = SeatCard & { to: string; missed: string; act(): Promise<void> };
/** A card shows its own light, never the chip's. */
const unlit = ({ status: _status, ...identity }: AgentIdentity): AgentIdentity => identity;

export interface SeatState {
  controller: string; agentActive: boolean; mandate: PlaneMandate; scopes: Scope[];
  commander?: boolean; commanderId?: string; policyVersion?: number;
}
export interface PopHost {
  quickPlay?: boolean; readOnly?: boolean; matchId?: string; team?: () => string | undefined;
  seat(plane: Plane): SeatState;
  setController(plane: Plane, controller: Controller): Promise<void>;
  setMandate(plane: Plane, mandate: PlaneMandate): Promise<void>;
  setScopes(plane: Plane, scopes: Scope[]): Promise<void>;
  resolveApproval(plane: Plane, id: string, approve: boolean): Promise<void>;
  policyStatus(plane: Plane): Promise<PolicyStatus | null>;
  mint(plane: Plane): Promise<string>;
  pickFocus(plane: Plane): void;
  toast(text: string, kind?: 'ok' | 'err'): void;
  /** Mid-match seat hand-over through the lobby (lobby matches only): a commander of mine, a bot, or me. */
  assign?(plane: Plane, occupant: SeatOccupantChoice): Promise<void>;
  /** False: this match runs on a game worker, so commanders cannot take its seats mid-match (`agents_need_main`). */
  agentHandOver?: boolean;
  changed(): void;
}

/** Owner-only runtime evidence, not connection/readiness or a promise that emitted orders were accepted. */
function policyHealth(policy: PolicyStatus | null | undefined): { state: 'failed' | 'waiting' | 'ok' | 'unknown'; text: string } {
  if (policy === undefined) return { state: 'unknown', text: 'Policy status unavailable' };
  if (policy === null) return { state: 'waiting', text: 'No policy installed' };
  if (policy.activationError) return { state: 'failed', text: `Policy could not start · ${policy.activationError === 'stale_policy' ? 'selected version unavailable' : policy.activationError === 'needs_role_deploy' ? 'deploy a policy for this plane' : 'policy load failed'}` };
  if (policy.version === null) return { state: 'waiting', text: 'No policy installed' };
  if (policy.consecutiveFailures > 0) return { state: 'failed', text: `Policy failing · ${policy.consecutiveFailures} consecutive failures` };
  if (policy.successfulCalls === 0) return { state: 'waiting', text: 'No successful policy decisions yet' };
  return { state: 'ok', text: policy.errors + policy.timeouts > 0 ? 'Policy recovered · last decision succeeded' : 'Last policy decision succeeded' };
}

function policyHealthCard(policy: PolicyStatus | null | undefined): HTMLElement {
  const health = policyHealth(policy);
  return h('section', { class: 'policy-health', 'data-health': health.state, role: health.state === 'failed' ? 'alert' : 'status', 'aria-label': 'Policy runtime' },
    h('b', {}, health.text),
    policy && policy.version !== null ? h('p', {},
      `v${policy.version} · ${policy.calls} calls · ${policy.successfulCalls} successful decisions · ${policy.errors} errors · ${policy.timeouts} timeouts`,
      policy.successfulCalls === 0 ? h('strong', {}, ' · No successful decisions') : null,
      h('br'), `${policy.intentsEmitted} orders emitted (not necessarily accepted).`) : null,
    policy && policy.version !== null && policy.lastError ? h('p', { class: 'policy-error' },
      `${health.state === 'failed' ? 'Latest failure' : 'Previous failure'}: ${policy.lastError.code}${policy.lastError.message ? ` — ${policy.lastError.message}` : ''}`) : null);
}
export class CommanderSeats {
  readonly pop = h('div', { class: 'cmd-pop', role: 'dialog', 'aria-label': 'Plane commander', hidden: true });
  private readonly host: PopHost;
  private readonly profile: ProfileApi | undefined;
  private roster: Roster | undefined;
  private readonly policies = new Map<Plane, PolicyStatus | null>();
  private open: Plane | undefined;
  private busy = false;
  /** The picker card whose hand-over is in flight. */
  private pending: string | undefined;
  private timer: number | undefined;
  private stopped = false;
  private readonly minted: Partial<Record<Plane, string>> = {};
  private harness: ClientKind = 'claude-code';
  constructor(host: PopHost) {
    this.host = host; this.profile = host.quickPlay || host.readOnly ? undefined : ProfileApi.stored();
    this.pop.addEventListener('pointerdown', (event) => event.stopPropagation());
  }
  start(): () => void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        if (this.profile) {
          try { this.roster = await this.profile.roster(); }
          catch { /* A roster outage must not hide this match's private runtime status. */ }
        }
        await Promise.all(PLANES.filter((plane) => this.open === plane || this.policyPlaying(plane)).map((plane) => this.loadPolicy(plane)));
        this.host.changed();
        if (!this.stopped) this.render();
      } catch { /* Keep exact last-known binding through transient transport failures. */ }
      if (!this.stopped) this.timer = window.setTimeout(() => void tick(), 3000);
    };
    if (!this.host.readOnly) void tick();
    const outside = (event: PointerEvent) => { if (this.open && !(event.target instanceof Element && event.target.closest('.cmd-pop,.plane-chip,.cmd-open-btn'))) this.close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') this.close(); };
    addEventListener('pointerdown', outside); addEventListener('keydown', escape);
    return () => { this.stopped = true; window.clearTimeout(this.timer); removeEventListener('pointerdown', outside); removeEventListener('keydown', escape); this.pop.remove(); };
  }
  private policyPlaying(plane: Plane): boolean {
    const state = this.host.seat(plane);
    return state.controller === 'policy' || state.controller === 'agent' && !state.agentActive && state.mandate.whenAbsent === 'policy';
  }
  private bound(plane: Plane): RosterCommander | undefined {
    const state = this.host.seat(plane);
    return this.roster?.commanders.find((commander) => commander.id === state.commanderId || !state.commanderId && !!this.host.matchId && commander.seated?.roomId === this.host.matchId && commander.seated.team === this.host.team?.() && commander.seated.roles.includes(plane));
  }
  /** A private exact-seat target for the owner console, never a role-compatibility lookup. */
  commanderId(plane: Plane): string | undefined { return this.bound(plane)?.id; }
  railKey(): string { return JSON.stringify([this.roster?.commanders.map((commander) => [commander.id, commander.name, commander.connected, commander.seated]), [...this.policies]]); }
  chipFor(plane: Plane): HTMLElement {
    const state = this.host.seat(plane); const commander = this.bound(plane);
    const identity = controllerAgent(state.controller, commander, state.agentActive, state.policyVersion);
    const health = !this.host.readOnly && this.policyPlaying(plane) ? policyHealth(this.policies.get(plane)) : undefined;
    if (health) identity.detail = [identity.detail, health.text].filter(Boolean).join(' · ');
    const chip = agentButton(identity, { size: 'small', className: 'plane-chip', label: `${PLANE_NAME[plane]} commander: ${identity.name}${health ? ` · ${health.text}` : ''} — controls` });
    if (health) chip.dataset.health = health.state;
    chip.tabIndex = 0; chip.setAttribute('role', 'button'); chip.setAttribute('aria-haspopup', 'dialog');
    const activate = (event: Event) => { event.preventDefault(); event.stopPropagation(); this.toggle(plane); };
    chip.addEventListener('click', activate); chip.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { activate(event); this.focusPicker(); } });
    return chip;
  }
  toggle(plane: Plane): void {
    if (this.host.readOnly) { this.host.toast('Observing · read-only'); return; }
    if (this.open === plane) return this.close();
    this.open = plane; this.render();
    void this.loadPolicy(plane);
  }
  /** Opened from the keyboard: focus moves to the picker's current card. */
  focusPicker(): void { this.pop.querySelector<HTMLElement>('.seat-card[tabindex="0"]')?.focus(); }
  close(): void { this.open = undefined; this.render(); }
  refresh(): void { if (this.open) this.render(); }
  private async loadPolicy(plane: Plane): Promise<void> {
    if (this.host.readOnly) return;
    try {
      const commander = this.bound(plane); const seated = commander?.seated;
      // Agent seats have no human-seat socket. Read through the owner's exact live commander lease.
      const policy = this.profile && commander && seated && seated.roomId === this.host.matchId && seated.team === this.host.team?.() && seated.roles.includes(plane)
        ? await this.profile.policyStatus({ commander: commander.id, match: seated.match, team: seated.team, role: plane })
        : await this.host.policyStatus(plane);
      this.policies.set(plane, policy);
    }
    catch { this.policies.delete(plane); }
    if (!this.stopped) { this.host.changed(); if (this.open === plane) this.render(); }
  }
  /** One popover action at a time; a failure toasts a plain-English reason, never a raw code. */
  private async run(task: () => Promise<void>, failed = 'Commander controls', pending?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.pending = pending; this.render();
    try { await task(); }
    catch (error) { this.host.toast(`${failed}: ${reason(error)}.`, 'err'); }
    finally { this.busy = false; this.pending = undefined; if (!this.stopped) this.render(); }
  }
  private render(): void {
    const plane = this.open; this.pop.hidden = !plane;
    if (!plane) { this.pop.replaceChildren(); return; }
    const state = this.host.seat(plane); const commander = this.bound(plane); const policy = this.policies.get(plane);
    const approval = policy?.approval ?? commander?.approvals.find((entry) => entry.role === plane)?.approval;
    // Redraws (the roster poll, every action) keep keyboard focus on the same picker card.
    const active = document.activeElement;
    const focus = active instanceof HTMLElement && this.pop.contains(active) ? active.dataset.key : undefined;
    const body = h('div', {},
      h('header', {}, h('b', { class: 'section', style: `--accent:${PLANE_ACCENT[plane]}` }, PLANE_CHAPTER[plane].label), h('em', {}, PLANE_NAME[plane]), h('button', { class: 'pop-x', 'aria-label': 'Close commander controls', onclick: () => this.close() }, '×')),
      this.picker(plane, state, commander, policy, focus),
      policy?.version != null || this.policyPlaying(plane) ? policyHealthCard(policy) : null,
      mandateControls(plane, state.controller === 'agent' ? 'agent' : state.controller === 'human' || state.controller === 'none' ? state.controller : 'bot', state.scopes, state.mandate, (mandate, scopes) => void this.run(async () => { if (scopes) await this.host.setScopes(plane, scopes); await this.host.setMandate(plane, mandate); }), this.busy),
      approvalCard(approval, policy?.version ?? state.policyVersion, (approve) => void this.run(async () => { await this.host.resolveApproval(plane, approval!.id, approve); await this.loadPolicy(plane); }), this.busy),
      h('div', { class: 'row' }, h('button', { class: 'btn small', 'data-tip': 'Choose a focus tile on the current plane', onclick: () => { this.close(); this.host.pickFocus(plane); } }, 'Pick focus on map'),
        state.mandate.directive.focusX !== undefined ? h('button', { class: 'btn small ghost', onclick: () => void this.run(() => { const { focusX: _x, focusY: _y, ...directive } = state.mandate.directive; return this.host.setMandate(plane, { ...state.mandate, directive }); }) }, 'Clear focus') : null));
    if (!this.host.quickPlay) {
      const token = this.minted[plane];
      const setup = token ? harnessSetup(this.harness, { mcpUrl: mcpUrl(), serverName: `${SERVER_NAME}-${plane}`, token }) : undefined;
      body.append(h('details', { class: 'pop-advanced' }, h('summary', { 'data-tip': 'Short-lived capability for this exact seat only, never observer authority' }, 'Per-match connection'),
        token ? seg('Harness', HARNESSES.map((item) => item.kind), Object.fromEntries(HARNESSES.map((item) => [item.kind, item.name])), this.harness, (value) => { this.harness = value; this.render(); }) : null,
        token ? null : h('button', { class: 'btn small', disabled: this.busy, onclick: () => void this.run(async () => { this.minted[plane] = await this.host.mint(plane); }) }, 'Mint exact-seat token'),
        setup ? h('div', {}, h('pre', { tabindex: 0 }, setup.text), h('button', { class: 'btn small', onclick: () => void copyText(setup.text).then((ok) => this.host.toast(ok ? 'Private seat setup copied' : 'Could not copy setup', ok ? 'ok' : 'err')) }, 'Copy private setup'), h('p', { class: 'small muted' }, setup.then)) : null));
    }
    this.pop.replaceChildren(body);
    if (focus) this.focusPicker();
    const hud = this.pop.offsetParent?.getBoundingClientRect() ?? new DOMRect(); const anchor = document.querySelector(`.switcher .plane-btn[data-plane="${plane}"]`);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    this.pop.style.left = `${Math.max(8, Math.min(rect.right - hud.left + 14, window.innerWidth - hud.left - this.pop.offsetWidth - 8))}px`;
    this.pop.style.top = `${Math.max(8, Math.min(rect.top - hud.top - 6, window.innerHeight - hud.top - this.pop.offsetHeight - 8))}px`;
  }
  /** "Who plays <Plane>": me, a bot, hold, the seat's own agent or policy, then my other compatible commanders. */
  private picker(plane: Plane, state: SeatState, bound: RosterCommander | undefined, policy: PolicyStatus | null | undefined, focus: string | undefined): HTMLElement {
    const name = PLANE_NAME[plane]; const assign = this.host.assign; const team = this.host.team?.();
    // Lobby matches hand the seat itself over (a commander leaves it); elsewhere only its controller changes.
    const hand = (occupant: SeatOccupantChoice) => () => assign!(plane, occupant);
    const control = (controller: Controller) => () => this.host.setController(plane, controller);
    const own = (controller: string, now: string, then: string) => state.controller === controller ? now : then;
    const choices: Choice[] = [
      { key: 'human', identity: controllerAgent('human', undefined, false), status: 'ready', current: state.controller === 'human',
        hint: own('human', `You play ${name}`, assign && bound ? `Play ${name} yourself now; ${bound.name} leaves the seat` : `Play ${name} yourself now`),
        to: 'You', missed: `Couldn't give you ${name}`, act: assign ? hand({ kind: 'human' }) : control('human') },
      { key: 'bot', identity: controllerAgent('bot', undefined, false), status: 'ready', current: state.controller === 'bot',
        hint: own('bot', `A built-in bot plays ${name}`, `Hand ${name} to a built-in bot now`),
        to: 'Bot', missed: `Couldn't hand ${name} to a bot`, act: assign ? hand({ kind: 'bot' }) : control('bot') },
      { key: 'none', identity: controllerAgent('none', undefined, false), status: 'ready', current: state.controller === 'none',
        hint: own('none', `${name} is on hold: no one gives it orders`, `Hold ${name}: no one gives it orders until you pick again`),
        to: 'Hold', missed: `Couldn't hold ${name}`, act: control('none') },
    ];
    if (bound?.kind === 'agent' || state.controller === 'agent') {
      const who = bound?.name ?? 'The live agent';
      choices.push({
        key: bound ? `${COMMANDER_VALUE}${bound.id}` : 'agent', identity: unlit(bound?.kind === 'agent' ? rosterAgent(bound) : controllerAgent('agent', undefined, false)),
        status: state.agentActive ? 'ready' : 'offline', current: state.controller === 'agent',
        hint: own('agent', `${who} plays ${name}`, `Give ${name} back to ${who}: its agent plays again`),
        unavailable: state.agentActive || state.controller === 'agent' ? undefined : `${who} is offline: start its agent again to give it ${name} back.`,
        to: bound ? `${bound.name} (your commander)` : 'Live agent', missed: `Couldn't give ${name} back to ${who}`, act: control('agent'),
      });
    }
    const version = policy?.version ?? state.policyVersion;
    if (version !== undefined) {
      const who = bound ? `${bound.name}'s policy v${version}` : `Policy v${version}`;
      choices.push({
        key: 'policy', identity: { ...controllerAgent('policy', bound, false, version), detail: `Policy v${version}` }, status: policyHealth(policy).state === 'failed' ? 'failed' : policyHealth(policy).state === 'ok' ? 'ready' : 'waiting', current: state.controller === 'policy',
        hint: `${own('policy', `${who} plays ${name}`, `Run ${who} on ${name} now`)} · ${policyHealth(policy).text}`, to: who, missed: `Couldn't switch ${name} to ${who}`, act: control('policy'),
      });
    }
    let addCommander: string | undefined;
    if (assign) {
      const mine = commanderPicker(this.roster?.commanders.filter((commander) => commander.id !== bound?.id), [plane], undefined, this.busy);
      for (const commander of mine.commanders) {
        const ref = mine.ref(`${COMMANDER_VALUE}${commander.id}`)!;
        const status: SeatCardStatus = commander.kind === 'policy' ? commander.policy.activeByRole[plane] == null ? 'offline' : 'ready'
          : commander.seated?.roomId === this.host.matchId && commander.seated?.team === team ? 'ready' : commander.connected ? 'online' : 'offline';
        choices.push({
          key: `${COMMANDER_VALUE}${commander.id}`, identity: unlit(rosterAgent(commander)), status, current: false,
          hint: `Hand ${name} to ${commander.name} now: it gets its briefing and first observation`, unavailable: this.unavailable(commander, name, team),
          to: `${commander.name} (your commander)`, missed: `Couldn't hand ${name} to ${commander.name}`, act: hand({ kind: 'commander', ref }),
        });
      }
      if (!mine.commanders.length && !bound) addCommander = '?screen=commanders';
    }
    return seatPicker({
      plane, cards: choices, busy: this.busy, focus, ...(this.pending ? { pending: this.pending } : {}), ...(addCommander ? { addCommander } : {}),
      pick: (card) => {
        const choice = card as Choice;
        void this.run(async () => {
          await choice.act();
          // The roster's seat lights catch up at once rather than on the next poll.
          if (this.profile) this.roster = await this.profile.roster().catch(() => this.roster);
          this.host.changed();
          this.host.toast(`${name} → ${choice.to}`, 'ok');
        }, choice.missed, choice.key);
      },
    });
  }
  /** Why one of my commanders cannot take this seat now: the server would refuse it, or no one would play. */
  private unavailable(commander: RosterCommander, plane: string, team: string | undefined): string | undefined {
    if (this.host.agentHandOver === false) return `Commanders can only join this match at the start: it runs on a game worker. Seat ${commander.name} in the lobby before your next match.`;
    if (commander.kind === 'agent' && !commander.connected) return `${commander.name} is offline: start its agent (Commanders shows how), then hand it ${plane}.`;
    if (commander.kind === 'policy' && commander.policy.activeByRole[plane] == null) return `${commander.name} has no active policy for ${plane} yet: deploy one in Commanders.`;
    if (commander.seated && commander.seated.roomId !== this.host.matchId) return `${commander.name} is playing another match.`;
    if (commander.seated && commander.seated.team !== team) return `${commander.name} already plays another army in this match.`;
    return undefined;
  }
}
