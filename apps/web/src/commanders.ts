/**
 * Commanders screen, the "connect my agents" pre-step. Left: connect a harness in one line (one static MCP URL,
 * sign-in in the browser, no secrets to paste; the consent page picks or creates the named commander). Right: my
 * named commanders with live status and last practice; the picked one opens its kickoff prompt, mandate, policy,
 * practice and token fallback. Seats are assigned in game setup, never here. Credentials never enter DOM attributes.
 */
import './roster.css';
import './commander.css';
import { HARNESSES, MANDATE_PRESETS, harness, harnessSetup, kickoffPrompt, type ClientKind, type ConnectionInfo, type HarnessSetup, type PairingCode, type SetupText } from '@playerthree/connect';
import type { Approval, Scope } from 'playerthree/control';
import { POLICY_PACKAGE_MAX_BYTES } from 'playerthree/manifest';
import { OPPONENTS, PLANES, STANCES, type Opponent, type Plane, type Stance } from '@agent-command/game/contract';
import { MAPS } from '@agent-command/game/lobby';
import { PLANE_ACCENT, copyText, fmt, h } from './dom.ts';
import { icon } from './icons.ts';
import { ApiError } from './api.ts';
import type { AccountView, BotPackage, CommanderPractice, LadderCardState, PlaneMandate, ProfileApi, RollbackResult, Roster, RosterCommander } from './profile.ts';
import { duelMap, type TerrainChoice } from './terrain-choice.ts';
import { MapPicker } from './map-picker.ts';
import { MODE_LABEL, MODES, mandateMode } from './mandate.ts';
import { OPP_LABEL, rosterAgent, agentButton } from './agent-button.ts';
import { rosterChip } from './roster-dock.ts';
import { PLANE_BLURB, PLANE_NAME } from './text.ts';

export const STANCE_LABEL: Record<Stance, string> = { economy: 'Economy', defend: 'Defend', attack: 'Attack', expand: 'Expand', support: 'Support' };
/** The MCP server name players see in their harness. */
export const SERVER_NAME = 'agent-command';
const PRACTICE_LEVELS = OPPONENTS.filter((level) => level !== 'idle');
const OUTCOME_LABEL = { win: 'Win', loss: 'Loss', draw: 'Draw', running: 'Unfinished' } as const;
/** Orbit on top / first, Depths last: the planes' stacking order. */
const PLANE_ORDER = [...PLANES].reverse();
/** How often the screen checks for a new sign-in while one is awaited (ms). */
const SIGN_IN_POLL_MS = 2000;

export function mcpUrl(): string { return `${location.origin}/mcp`; }

/**
 * MCP server name for a browser sign-in. Each harness entry is one connection to one named commander, so a harness
 * that already holds a connection needs a second entry name (`agent-command-2`, …) instead of colliding.
 */
export function oauthServerName(kind: ClientKind, connections: readonly ConnectionInfo[]): string {
  const held = connections.filter((connection) => connection.client.kind === kind).length;
  return held ? `${SERVER_NAME}-${held + 1}` : SERVER_NAME;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export interface CommanderStatus { state: 'on' | 'idle' | 'off'; text: string }

/** Connected (a live call or active harness) / signed in but quiet / not connected, with when it was last seen. */
export function commanderStatus(commander: RosterCommander, connections: readonly ConnectionInfo[] = [], now = Date.now()): CommanderStatus {
  const held = connections.filter((connection) => connection.commander === commander.id);
  if (commander.connected || held.some((connection) => connection.active)) return { state: 'on', text: commander.seated ? 'Connected · in match' : 'Connected' };
  const seen = Math.max(commander.lastSeenAt ?? 0, ...held.map((connection) => connection.lastSeen ?? 0));
  if (held.length) return { state: 'idle', text: seen ? `Signed in · seen ${ago(seen, now)}` : 'Signed in' };
  return { state: 'off', text: seen ? `Seen ${ago(seen, now)}` : 'Not connected' };
}

export function seg<T extends string>(label: string, options: readonly T[], names: Record<string, string>, current: T | undefined, pick: (value: T) => void, disabled = false): HTMLElement {
  return h('div', { class: 'seg-ctl', role: 'group', 'aria-label': label }, ...options.map((option) => h('button', {
    type: 'button', class: option === current ? 'on' : '', 'aria-pressed': String(option === current), 'data-tip': `${label}: ${names[option] ?? option}`,
    disabled: disabled || undefined, onclick: () => option !== current && pick(option),
  }, names[option] ?? option)));
}

/** Who plays a plane, as far as the owner controls are concerned. */
export type PlaneDriver = 'agent' | 'bot' | 'human' | 'none';
export interface MandateControlOptions {
  /** Accessible-name prefix; defaults to the plane name. */
  name?: string;
  /** Stance steers bots in a match; the Commanders screen leaves it to the match. */
  stance?: boolean;
}

/**
 * Shared owner controls; only scopes + mandate are persisted. Only what applies to the driver is shown: Mode and
 * When away govern an agent; stance and house rules also steer the built-in bot (and policies that read them).
 */
export function mandateControls(plane: Plane, driver: PlaneDriver, scopes: readonly Scope[], mandate: PlaneMandate, change: (mandate: PlaneMandate, scopes?: Scope[]) => void, disabled = false, options: MandateControlOptions = {}): HTMLElement {
  const name = options.name ?? PLANE_NAME[plane];
  const stance = options.stance ?? true;
  const mode = mandateMode(scopes, mandate);
  const field = (label: string, control: HTMLElement) => h('div', { class: 'slot-stance' }, h('label', {}, label), control);
  const note = (label: string, text: string) => h('p', { class: 'mandate-note small muted', 'data-tip': text }, icon('info', 14), ` ${label}`);
  if (driver === 'human') return h('div', { class: 'mandate-controls' }, note('Manual', 'You fly this plane. Agent settings apply when an agent commands it.'));
  if (driver === 'none') return h('div', { class: 'mandate-controls' }, note('Idle', 'Nothing acts on this plane.'));
  const agent = driver === 'agent';
  return h('div', { class: 'mandate-controls' },
    agent ? field(mode === 'custom' ? 'Mode · Custom' : 'Mode', seg(`${name} mode`, MODES, MODE_LABEL, mode === 'custom' ? undefined : mode, (key) => {
      const preset = MANDATE_PRESETS[key];
      change({ ...mandate, autonomy: preset.autonomy }, [...preset.scopes]);
    }, disabled)) : null,
    agent ? field('When away', seg(`${name} when away`, ['policy', 'bot', 'hold'] as const, { policy: 'Policy', bot: 'Bot', hold: 'Hold' }, mandate.whenAbsent, (whenAbsent) => change({ ...mandate, whenAbsent }), disabled)) : null,
    h('fieldset', { class: 'mandate-limits', disabled: disabled || undefined },
      h('legend', { 'data-tip': 'Allow these actions for this commander.' }, 'House rules'),
      ...(['asteroidDrops', 'collapses'] as const).map((key) => h('label', {},
        h('input', { type: 'checkbox', checked: mandate.limits?.[key] !== false || undefined, 'aria-label': `${name} ${key === 'asteroidDrops' ? 'Asteroid drops' : 'Collapses'}`, onchange: (event: Event) => change({ ...mandate, limits: { ...mandate.limits, [key]: (event.target as HTMLInputElement).checked } }) }),
        key === 'asteroidDrops' ? 'Asteroid drops' : 'Collapses'))),
    stance ? field('Stance', seg(`${name} stance`, STANCES, STANCE_LABEL, mandate.directive.stance as (typeof STANCES)[number], (value) => change({ ...mandate, directive: { ...mandate.directive, stance: value } }), disabled)) : null,
    !agent && stance ? note('Bot rules', 'Stance and house rules steer the bot or policy playing this plane. Mode and When away apply when an agent commands it.') : null,
  );
}

export function approvalCard(approval: Approval | undefined, version: number | null | undefined, resolve: (approve: boolean) => void, disabled = false): HTMLElement | null {
  if (approval?.status !== 'pending') return null;
  const kind = { policyDeploy: 'Policy deploy', policyRollback: 'Policy rollback', publish: 'Publish policy' }[approval.kind];
  return h('section', { class: 'mandate-approval', 'aria-label': 'Pending approval' },
    h('b', { 'data-tip': 'The agent needs your approval before this policy change can take effect.' }, icon('alert', 16), ` ${kind} v${approval.version}`),
    h('span', { class: 'small muted' }, version == null ? 'No active policy version' : `Current policy v${version}`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', 'data-tip': `Approve ${kind.toLowerCase()} v${approval.version}`, disabled: disabled || undefined, onclick: () => resolve(true) }, icon('check', 14), ' Approve'),
      h('button', { type: 'button', class: 'btn small ghost', 'data-tip': `Reject ${kind.toLowerCase()} v${approval.version}`, disabled: disabled || undefined, onclick: () => resolve(false) }, icon('cancel', 14), ' Reject'),
    ),
  );
}

/** Where a setup text goes, in words, as the heading above its snippet. */
function pasteWhere(setup: SetupText, name: string): string {
  if (setup.language === 'sh') return `Run this in a terminal — ${name}`;
  if (setup.language === 'slash') return `In ${name}, run`;
  return `${setup.file ? `Add this to ${setup.file}` : "Add this to your client's MCP settings"} — ${name}`;
}

/** The same server as a config-file entry, folded under the primary one-liner. */
function alternativeSetup(setup: HarnessSetup, label: string): HTMLElement | null {
  const alt = setup.alternative;
  if (!alt) return null;
  return h('details', { class: 'cmd-alt' },
    h('summary', { 'data-tip': 'Edit the config file yourself instead' }, `Or add this to ${alt.file ?? "your client's MCP settings"}`),
    h('div', { class: 'snippet' }, h('pre', { tabindex: '0', 'aria-label': `${label} file entry` }, alt.text), copyButton(alt.text, 'Copy', `Copy the ${label} file entry`)));
}

/** A copy button that confirms in place. */
function copyButton(text: string, label: string, tip: string, done = 'Copied'): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'btn small', 'data-tip': tip, onclick: () => void copyText(text).then((ok) => { button.textContent = ok ? done : 'Copy failed'; }) }, label);
  return button;
}

/** Multi-select plane toggles (icons, names in tips); at least one stays on. */
function planeToggles(label: string, initial: readonly Plane[], change: (roles: Plane[]) => void, disabled = false): HTMLElement {
  const on = new Set(initial);
  return h('div', { class: 'seg-ctl cmd-planes', role: 'group', 'aria-label': label }, ...PLANE_ORDER.map((plane) => {
    const button = h('button', {
      type: 'button', class: on.has(plane) ? 'on' : '', 'aria-pressed': String(on.has(plane)), 'aria-label': PLANE_NAME[plane],
      'data-plane': plane, 'data-tip': `${PLANE_NAME[plane]} · ${PLANE_BLURB[plane]}`, style: `--accent:${PLANE_ACCENT[plane]}`, disabled: disabled || undefined,
      onclick: () => {
        if (on.has(plane)) { if (on.size === 1) return; on.delete(plane); } else on.add(plane);
        button.classList.toggle('on', on.has(plane));
        button.setAttribute('aria-pressed', String(on.has(plane)));
        change(PLANES.filter((role) => on.has(role)));
      },
    }, icon(plane, 15));
    return button;
  }));
}

function statusPill(commander: RosterCommander, connections: readonly ConnectionInfo[] | undefined): HTMLElement {
  const status = commanderStatus(commander, connections);
  return h('span', { class: 'cmd-status', 'data-state': status.state, 'data-commander-status': commander.id }, h('i', { 'aria-hidden': 'true' }), status.text);
}

function practiceLine(commander: RosterCommander): HTMLElement | null {
  if (commander.practicing) return h('span', { class: 'cmd-last' }, 'Practicing…');
  const last: CommanderPractice | null = commander.lastPractice;
  if (!last) return null;
  return h('span', { class: 'cmd-last', 'data-tip': `Last practice: ${PLANE_NAME[last.role] ?? last.role} · policy v${last.version} · ${fmt(last.ticks)} ticks` },
    h('b', { class: `out-${last.outcome}` }, OUTCOME_LABEL[last.outcome]), ` vs ${OPP_LABEL[last.opponent] ?? last.opponent} · ${ago(last.at)}`);
}

type Notice = { tone: 'ok' | 'warn' | 'error'; text: string };
const BYTES_PER_MB = 1_048_576;
const BYTES_PER_KB = 1024;
const STALE_TIP = 'Built for a different version of the game: redeploy it from its source before it can play.';

/** Import refusals in plain words, by the server's closed code (`not_json` is the browser's own parse check). */
export function importNotice(code: string, plane: Plane): Notice | undefined {
  const texts: Record<string, string> = {
    not_json: 'That file is not JSON. Choose a .policy.json file.',
    too_large: `That file is larger than a policy package can be (${POLICY_PACKAGE_MAX_BYTES / BYTES_PER_MB} MB).`,
    not_a_package: 'That file is not a policy package, or it is damaged.',
    wrong_game: 'That package was built for a different game.',
    tampered: 'That package was edited after it was exported: its checksum does not match, so it was refused.',
    wrong_plane: `That package is not for ${PLANE_NAME[plane]}.`,
    rebuild_failed: 'That package failed its check: its source does not build to the code it ships, so it was refused.',
  };
  const text = texts[code];
  return text === undefined ? undefined : { tone: 'error', text };
}

/** Why an activation's test call failed, by `PolicyErrorCode`. */
const PROBE_FAILURE: Record<string, string> = {
  compile: 'its code does not compile', missing_export: 'it has no think function', bad_module: 'its module will not load',
  imports_not_allowed: 'it imports something policies cannot use', runtime_not_allowed: 'its runtime is not allowed here', too_large: 'it is too large',
  memory_limit: 'it used too much memory', timeout: 'it took too long', threw: 'it threw an error', bad_output: 'it returned invalid intents',
};

/** A refused activation, in words; an approval request shows as its own card instead. */
export function rollbackNotice(result: RollbackResult, version: number): Notice | undefined {
  if (result.ok || 'approval' in result) return undefined;
  return { tone: 'error', text: `v${version} failed its test run (${PROBE_FAILURE[result.error] ?? result.error}) and was not activated.` };
}

function saveFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Built-in bots by plane (stacking order) and level: the source to read, the package to download, fork or import. */
function botsSection(bots: readonly BotPackage[]): HTMLElement {
  return h('details', { class: 'cmd-bots-list' },
    h('summary', { 'data-tip': 'The bots you play against, as policy packages. Read the source, or download a package to fork it or import it into a commander.' }, icon('bot', 14), ' Built-in bots'),
    ...PLANE_ORDER.filter((plane) => bots.some((bot) => bot.role === plane)).map((plane) => h('div', { class: 'bot-plane', role: 'group', 'aria-label': `${PLANE_NAME[plane]} bots` },
      h('span', { class: 'bot-plane-name' }, icon(plane, 14), ` ${PLANE_NAME[plane]}`),
      ...bots.filter((bot) => bot.role === plane).map((bot) => {
        const name = `${OPP_LABEL[bot.level]} ${PLANE_NAME[plane]} bot`;
        const path = `/api/bots/${bot.level}/${bot.role}`;
        return h('span', { class: 'bot-pkg', 'data-bot': `${bot.level}-${bot.role}` },
          h('b', {}, OPP_LABEL[bot.level]),
          h('a', { class: 'btn small ghost', href: `${path}/source`, target: '_blank', rel: 'noopener', 'aria-label': `View ${name} source`, 'data-tip': 'View source' }, icon('policy', 14)),
          h('a', { class: 'btn small ghost', href: `${path}/package`, download: true, 'aria-label': `Download ${name} package`, 'data-tip': `Download package · ${fmt(Math.ceil(bot.bytes / BYTES_PER_KB))} KB · ${bot.license}` }, icon('download', 14)),
          bot.current ? null : h('span', { class: 'small muted', 'data-tip': 'Built for a different version of the game: matches play the bot’s built-in code instead.' }, 'Stale'));
      }))));
}

interface CardUi {
  plane?: Plane;
  practiceVs: Opponent;
  harness: ClientKind;
  confirm?: 'rotate' | 'remove';
  /** The last import or activation outcome on this commander's policy block. */
  notice?: Notice;
}

export class CommandersScreen {
  readonly el: HTMLElement;
  private readonly api: ProfileApi;
  private roster: Roster;
  /** Undefined while the server has no connections API (browser sign-in unavailable). */
  private connections: readonly ConnectionInfo[] | undefined;
  /** The shared public map selection practice runs on (the lobby's TerrainChoice). */
  private readonly terrain: TerrainChoice;
  private readonly mapPicker: MapPicker;
  private readonly onRoster: (roster: Roster) => void;
  private busy = false;
  private stopped = false;
  // 1 · connect
  private pick: ClientKind | undefined;
  private pickServer = SERVER_NAME;
  /** Each connection's sign-in time when the harness was picked (server clock, so no skew). */
  private known: Map<string, number> | undefined;
  private fresh: string | undefined;
  private pairing: PairingCode | undefined;
  private pairingPending = false;
  private pairingError = '';
  private pairingGeneration = 0;
  private watchTimer = 0;
  // 2 · commanders
  private selected: string | undefined;
  private readonly ui = new Map<string, CardUi>();
  /** Ladder cards and the GitHub account: undefined while loading, null where the server has no rated play / sign-in. */
  private ladder: Map<string, LadderCardState> | null | undefined;
  private account: AccountView | null | undefined;
  // DOM
  private readonly connectBox = h('div', { class: 'cmd-connect-flow' });
  private readonly list = h('ul', { class: 'cmd-roster', 'aria-label': 'My commanders' });
  private readonly detail = h('div', { class: 'cmd-detail' });
  private readonly error = h('p', { class: 'cmd-error', role: 'alert' });
  private readonly accountBox = h('div', { class: 'cmd-account' });
  /** Built-in bots' packages: hidden until the server lists at least one. */
  private readonly botsBox = h('section', { class: 'cmd-bots cmd-block', 'aria-label': 'Built-in bots', hidden: true });
  /** Render keys live here, never in DOM attributes: they include commander tokens. */
  private keys = { connect: '', list: '', detail: '' };

  constructor(api: ProfileApi, roster: Roster, onRoster: (roster: Roster) => void, terrain: TerrainChoice, connections?: readonly ConnectionInfo[]) {
    this.api = api; this.roster = roster; this.onRoster = onRoster; this.terrain = terrain; this.connections = connections;
    this.mapPicker = new MapPicker(terrain, duelMap);
    const step = (n: string, label: string, glyph: Parameters<typeof icon>[0], tip: string) =>
      h('div', { class: 'cmd-step' }, h('span', { class: 'cmd-step-n' }, n), h('div', {}, h('b', { 'data-tip': tip }, icon(glyph), ` ${label}`)));
    this.el = h('section', { class: 'commanders named-commanders', 'aria-label': 'Commanders' },
      h('div', { class: 'cmd-col cmd-col-connect' },
        step('1', 'Connect', 'commanders', 'Pick your harness, run its one line, then approve sign-in in your browser. No keys or tokens to copy.'),
        h('p', { class: 'cmd-profile small muted', 'data-tip': 'Keep this browser and address to retain your commanders.' }, `Profile ${api.profile.id} · ${location.origin}`),
        this.accountBox,
        this.connectBox),
      h('div', { class: 'cmd-col cmd-col-roster' },
        step('2', 'Commanders', 'token', 'Each sign-in becomes a named commander. Pick one to tune its mandate, policy and practice; seat it in game setup.'),
        this.list, this.createForm(), this.error, this.detail, this.botsBox));
    this.render();
    void this.loadLadder();
    void this.loadBots();
  }

  /** The bots list is optional per server: no packages (or no route) keeps the section hidden. */
  private async loadBots(): Promise<void> {
    const bots = await Promise.resolve().then(() => this.api.bots()).then(({ bots: list }) => list, () => []);
    if (this.stopped || !bots.length) return;
    this.botsBox.hidden = false;
    this.botsBox.replaceChildren(botsSection(bots));
  }

  /** Rated play is optional per server: a 404 hides the ladder and account blocks. */
  private async loadLadder(): Promise<void> {
    const [cards, account] = await Promise.allSettled([Promise.resolve().then(() => this.api.ladderCards()), Promise.resolve().then(() => this.api.account())]);
    if (this.stopped) return;
    this.ladder = cards.status === 'fulfilled' ? new Map(cards.value.cards.map((card) => [card.commanderId, card])) : null;
    this.account = account.status === 'fulfilled' ? account.value : null;
    this.render();
  }

  /** New roster and (when the server has them) connections from the lobby poll; undefined keeps the last list. */
  update(roster: Roster, connections: readonly ConnectionInfo[] | undefined = this.connections): void {
    this.roster = roster; this.connections = connections; this.render();
  }

  dispose(): void {
    this.stopped = true;
    this.pairingGeneration++;
    window.clearTimeout(this.watchTimer);
    this.mapPicker.dispose();
  }

  private async run(task: () => Promise<Roster>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error.textContent = ''; this.render();
    try {
      const roster = await task();
      if (this.connections) this.connections = await this.api.connections().catch(() => this.connections);
      if (!this.stopped) { this.roster = roster; this.onRoster(roster); }
    } catch (error) {
      if (!this.stopped) {
        const code = error instanceof ApiError ? error.code : 'network';
        this.error.textContent = code === 'no_policy' ? 'Deploy a policy first (your agent does that with policy_deploy).' : code === 'busy' ? 'Busy · try again in a moment.' : code === 'network' ? 'Could not reach your commanders.' : `Commander request failed (${code}).`;
      }
    } finally { this.busy = false; if (!this.stopped) this.render(); }
  }

  private render(): void {
    const connections = this.connections ?? [];
    // A new connection, or an existing one signed in again (same harness entry: the server reuses it).
    if (this.known && !this.fresh) this.fresh = connections.find((connection) => this.known!.get(connection.id) !== connection.authorizedAt)?.id;
    if (this.pairing && this.pairing.expiresAt <= Date.now()) this.pairing = undefined;
    const commanders = this.roster.commanders;
    if (!commanders.some((commander) => commander.id === this.selected)) this.selected = commanders[0]?.id;
    this.renderConnect();
    this.renderAccount();
    const listKey = JSON.stringify([commanders.map((commander) => [rosterAgent(commander, this.connections), commanderStatus(commander, this.connections).text, practiceLine(commander)?.textContent]), this.selected]);
    if (listKey !== this.keys.list) {
      this.keys.list = listKey;
      this.list.replaceChildren(...(commanders.length
        ? commanders.map((commander) => h('li', { class: `cmd-row${commander.id === this.selected ? ' on' : ''}`, 'data-commander-row': commander.id },
          rosterChip(commander, this.connections, { selected: commander.id === this.selected, onPick: (picked) => { this.selected = picked.id; this.render(); } }),
          statusPill(commander, this.connections), practiceLine(commander)))
        : [h('li', { class: 'cmd-row muted' }, 'None yet. Connect a harness, or add one below.')]));
    }
    const commander = commanders.find((entry) => entry.id === this.selected);
    const held = connections.filter((connection) => connection.commander === commander?.id).map((connection) => [connection.id, connection.client, connection.active]);
    const detailKey = JSON.stringify([commander, held, commander && this.ladder?.get(commander.id), this.ladder === null, commander && this.cardUi(commander.id), commander && commanderStatus(commander, this.connections).text, commander && practiceLine(commander)?.textContent, this.busy, this.connections !== undefined]);
    if (detailKey !== this.keys.detail) {
      this.keys.detail = detailKey;
      this.detail.replaceChildren(...(commander ? this.card(commander) : []));
    }
  }

  /** GitHub sign-in for rated play (D2): login and eligibility only. */
  private renderAccount(): void {
    const a = this.account;
    if (!a) { this.accountBox.replaceChildren(); return; }
    this.accountBox.replaceChildren(a.linked
      ? h('p', { class: 'small', 'data-tip': a.eligible ? 'Rated play unlocked.' : 'Rated play opens once your GitHub account is 30 days old.' }, icon('commanders', 14), ` GitHub ${a.login} · ${a.eligible ? 'rated play on' : `rated from ${new Date(a.eligibleAt ?? 0).toLocaleDateString()}`}`)
      : h('button', { type: 'button', class: 'btn small', 'data-tip': 'Link a GitHub account (at least 30 days old) to join the rated queue.', onclick: () => void this.api.linkGithub().then(({ url }) => location.assign(url)).catch(() => { this.error.textContent = 'GitHub sign-in is unavailable.'; }) }, 'Link GitHub for rated play'));
  }

  /** Opt-in public card (D5) and the ladder chip: points ± band, provisional, link. */
  private ladderBlock(commander: RosterCommander): HTMLElement | null {
    if (!this.ladder) return null;
    const card = this.ladder.get(commander.id);
    const open = card?.public ?? false;
    const set = (nextPublic: boolean, disclose: boolean) => void this.api.setLadderCard(commander.id, nextPublic, disclose)
      .then(({ cards }) => { this.ladder = new Map(cards.map((entry) => [entry.commanderId, entry])); this.render(); })
      .catch(() => { this.error.textContent = 'Could not update the public card.'; });
    const chip = card?.chip;
    return h('section', { class: 'cmd-block cmd-ladder' },
      h('div', { class: 'cmd-section', 'data-tip': 'Rated results are always recorded; the public card and leaderboard listing are your choice.' }, icon('research', 14), ' Ladder'),
      chip ? h('p', {}, h('b', { 'data-tip': 'Ladder points = 40 × (μ − 3σ); band μ ± 2σ.' }, `${chip.points} pts`), ` ±${Math.round((chip.band[1] - chip.band[0]) / 2)} · ${chip.pool}`,
        chip.provisional ? h('span', { class: 'small muted', 'data-tip': 'Fewer than 10 rated games, fewer than 5 distinct opponents or σ ≥ 3' }, ' · Provisional') : null,
        card?.public ? h('a', { href: card.href, target: '_blank', rel: 'noopener' }, ' · Card ↗') : null) : h('p', { class: 'small muted' }, 'No rated games yet.'),
      h('label', { class: 'cmd-check small', 'data-tip': 'Show this commander’s card and leaderboard entry. Opponents see your name only when this is on.' },
        h('input', { type: 'checkbox', checked: open || undefined, onchange: (event: Event) => set((event.target as HTMLInputElement).checked, card?.discloseModel ?? false) }), ' Public card'),
      h('label', { class: 'cmd-check small', 'data-tip': 'Also show the self-reported provider, model and usage. Self-reported, never verified.' },
        h('input', { type: 'checkbox', checked: card?.discloseModel || undefined, disabled: !open || undefined, onchange: (event: Event) => set(true, (event.target as HTMLInputElement).checked) }), ' Disclose model'));
  }

  private cardUi(id: string): CardUi {
    let ui = this.ui.get(id);
    if (!ui) this.ui.set(id, ui = { practiceVs: 'standard', harness: this.pick && this.pick !== 'generic' ? this.pick : 'claude-code' });
    return ui;
  }

  // ---------------------------------------------------------------- 1 · connect

  private renderConnect(): void {
    const fresh = this.connections?.find((connection) => connection.id === this.fresh);
    const freshCommander = fresh && this.roster.commanders.find((commander) => commander.id === fresh.commander);
    const key = JSON.stringify([this.pick, this.pickServer, this.connections !== undefined, this.pairing, this.pairingPending, this.pairingError, fresh && [fresh.id, fresh.active, fresh.roles], freshCommander && [rosterAgent(freshCommander, this.connections), freshCommander.roles, freshCommander.mandate]]);
    if (key === this.keys.connect) return;
    this.keys.connect = key;
    const row = h('div', { class: 'harness-row', role: 'group', 'aria-label': 'Agent harness' },
      ...HARNESSES.filter((entry) => entry.kind !== 'claude-api').map((entry) => h('button', {
        type: 'button', class: `harness-btn${entry.kind === this.pick ? ' on' : ''}`, 'aria-pressed': String(entry.kind === this.pick), 'data-kind': entry.kind, 'data-tip': entry.blurb,
        onclick: () => this.choose(entry.kind),
      }, icon(entry.kind, 30), h('b', {}, entry.name))));
    if (!this.pick) { this.connectBox.replaceChildren(row); return; }
    const chosen = harness(this.pick);
    const setup = harnessSetup(this.pick, { mcpUrl: mcpUrl(), serverName: this.pickServer });
    if (!setup) { this.connectBox.replaceChildren(row, h('p', { class: 'muted' }, 'This page is not served over http(s); open the game from its web address.')); return; }
    const signedIn = this.connections !== undefined;
    const status = !signedIn
      ? h('div', { class: 'cmd-wait off', 'data-tip': 'Browser sign-in is unavailable on this server. Use a commander’s Token setup instead.' }, icon('info', 16), 'Token setup only')
      : fresh
        ? h('div', { class: 'cmd-wait ok', role: 'status' }, h('span', {}, 'Signed in:'),
          freshCommander ? agentButton(rosterAgent(freshCommander, this.connections), { size: 'small' }) : h('span', {}, fresh.client.name),
          h('span', { class: 'muted' }, fresh.roles.map((role) => PLANE_NAME[role as Plane] ?? role).join(', ')))
        : h('div', { class: 'cmd-wait', role: 'status', 'data-tip': 'Approve sign-in in the browser tab your harness opens, then name or pick its commander.' }, h('i', { class: 'pulse' }), 'Awaiting sign-in');
    this.connectBox.replaceChildren(row, h('div', { class: 'harness-setup' },
      h('div', { class: 'cmd-section' }, pasteWhere(setup, chosen.name)),
      h('div', { class: 'snippet' }, h('pre', { tabindex: '0', 'aria-label': `${chosen.name} setup` }, setup.text), copyButton(setup.text, 'Copy', `Copy the ${chosen.name} setup`)),
      h('p', { class: 'then' }, setup.then, chosen.docsUrl ? h('a', { href: chosen.docsUrl, target: '_blank', rel: 'noopener noreferrer' }, ' Docs ↗') : null),
      alternativeSetup(setup, chosen.name),
      status,
      freshCommander ? this.kickoff(freshCommander, true) : null,
      !fresh && signedIn ? this.pairingBox() : null));
  }

  private pairingBox(): HTMLElement {
    return h('div', { class: 'cmd-pairing' },
      h('b', { 'data-tip': 'Use this single-use code on the consent page if sign-in opened in another browser or game address. You can also copy that sign-in link into this game browser.' }, icon('invite', 16), ' Pair browser'),
      h('p', { class: 'small muted' }, 'Never share your profile secret.'),
      this.pairing
        ? h('div', { class: 'snippet' }, h('code', { 'aria-label': 'Pairing code' }, this.pairing.code), copyButton(this.pairing.code, 'Copy code', 'Copy the single-use pairing code', 'Code copied'))
        : h('span', { class: 'small muted' }, this.pairingPending ? 'Creating pairing code…' : 'No active pairing code.'),
      this.pairing ? h('p', { class: 'small muted', 'data-tip': 'Keep this tab open; the sign-in appears here automatically.' }, `Expires ${new Date(this.pairing.expiresAt).toLocaleTimeString()}`) : null,
      this.pairingError ? h('p', { class: 'cmd-error', role: 'alert' }, this.pairingError) : null,
      h('button', { type: 'button', class: 'btn small ghost', 'data-tip': 'Create a new single-use pairing code for this profile.', disabled: this.pairingPending || undefined, onclick: () => void this.mintPairing() }, 'New code'));
  }

  private choose(kind: ClientKind): void {
    this.pick = kind;
    this.pickServer = oauthServerName(kind, this.connections ?? []);
    // Any connection that appears or signs in again from now on is the one this player is setting up.
    this.known = new Map((this.connections ?? []).map((connection) => [connection.id, connection.authorizedAt]));
    this.fresh = undefined;
    this.render();
    if (this.connections) { void this.mintPairing(); this.watch(); }
  }

  /** Until the sign-in lands, look for it here too, so the status goes live whatever the lobby polls. */
  private watch(): void {
    window.clearTimeout(this.watchTimer);
    this.watchTimer = window.setTimeout(async () => {
      if (this.stopped || this.fresh || !this.known) return;
      try {
        this.connections = await this.api.connections();
        const fresh = this.connections.find((connection) => this.known!.get(connection.id) !== connection.authorizedAt);
        // The consent page may have just created this commander.
        if (fresh && !this.roster.commanders.some((commander) => commander.id === fresh.commander)) { this.roster = await this.api.roster(); this.onRoster(this.roster); }
        if (fresh) this.selected = fresh.commander;
        if (!this.stopped) this.render();
      } catch { /* Keep waiting through transient failures. */ }
      if (!this.stopped && !this.fresh) this.watch();
    }, SIGN_IN_POLL_MS);
  }

  private async mintPairing(): Promise<void> {
    const generation = ++this.pairingGeneration;
    this.pairingPending = true; this.pairingError = '';
    this.render();
    try {
      const code = await this.api.pairingCode();
      if (generation === this.pairingGeneration) this.pairing = code;
    } catch (error) {
      if (generation === this.pairingGeneration) this.pairingError = error instanceof ApiError ? `Could not create a pairing code (${error.code}).` : 'Could not reach the server to create a pairing code.';
    } finally {
      if (generation === this.pairingGeneration) { this.pairingPending = false; this.render(); }
    }
  }

  // ---------------------------------------------------------------- 2 · commanders

  private createForm(): HTMLElement {
    const name = h('input', { type: 'text', required: true, maxlength: 64, placeholder: 'Name, e.g. DeepSeek Surface', 'aria-label': 'Commander name' });
    const kind = h('select', { 'aria-label': 'Commander execution kind' }, h('option', { value: 'agent' }, 'Live connection'), h('option', { value: 'policy' }, 'Versioned policy'));
    const provider = h('input', { type: 'text', maxlength: 64, 'aria-label': 'Self-reported provider', placeholder: 'Provider' });
    const model = h('input', { type: 'text', maxlength: 80, 'aria-label': 'Self-reported model', placeholder: 'Model' });
    const independent = h('input', { type: 'checkbox', 'aria-label': 'Harness supports independent isolated sessions' });
    let roles: Plane[] = ['surface'];
    return h('form', { class: 'named-commander-create', onsubmit: (event: Event) => {
      event.preventDefault();
      if (!name.value.trim()) return;
      void this.run(() => this.api.createCommander({ name: name.value.trim(), kind: kind.value as 'agent' | 'policy', roles, isolation: { independentSessions: independent.checked }, metadata: { ...(provider.value.trim() ? { provider: provider.value.trim() } : {}), ...(model.value.trim() ? { model: model.value.trim() } : {}) } }));
    } },
    h('div', { class: 'row' }, name, planeToggles('New commander planes', roles, (next) => { roles = next; }),
      h('button', { class: 'btn small primary', type: 'submit', 'aria-label': 'Add commander', 'data-tip': 'Add a named commander without signing in yet' }, icon('commanders', 14), ' Add')),
    h('details', { class: 'cmd-advanced' }, h('summary', { 'aria-label': 'New commander advanced', 'data-tip': 'Execution, self-reported identity and isolation' }, h('b', {}, 'Advanced')),
      h('div', { class: 'cmd-fields' },
        h('label', {}, 'Execution', kind), h('label', { 'data-tip': 'Self-reported, never verified' }, 'Provider', provider), h('label', { 'data-tip': 'Self-reported, never verified' }, 'Model', model),
        h('label', { class: 'cmd-check', 'data-tip': 'Declared, not externally verified. Opposing seats require isolated harness sessions.' }, independent, ' Independent sessions'))));
  }

  private card(commander: RosterCommander): Node[] {
    const ui = this.cardUi(commander.id);
    const plane = ui.plane && commander.roles.includes(ui.plane) ? ui.plane : commander.roles[0];
    const held = this.connections?.filter((connection) => connection.commander === commander.id);
    const readiness = commander.readiness ?? (commander.seated ? 'Execution lease in use' : commander.connected || commander.kind === 'policy' && commander.roles.some((role) => commander.policy.activeByRole[role] != null) ? 'Ready for a seat' : 'Connection required');
    return [h('article', { class: 'cmd-card', style: `--accent:${PLANE_ACCENT[commander.roles[0] ?? 'surface']}`, 'data-commander-detail': commander.id },
      h('header', {},
        h('div', {}, agentButton(rosterAgent(commander, this.connections)), h('span', { class: 'small muted' }, `${commander.roles.map((role) => PLANE_NAME[role]).join(' · ')} · ${readiness}`)),
        statusPill(commander, this.connections)),
      ...(held === undefined ? [h('p', { class: 'small muted' }, 'Harness connection details unavailable.')]
        : held.map((connection) => h('div', { class: 'cmd-conn' },
          icon(connection.client.kind, 16),
          h('span', { 'data-tip': connection.client.domain ? `Verified by ${connection.client.domain}` : 'Unverified harness identity' }, `${connection.client.name} · ${connection.active ? 'Active now' : connection.lastSeen ? `Seen ${ago(connection.lastSeen)}` : 'Signed in'}`),
          h('button', { type: 'button', class: 'btn small ghost', disabled: this.busy || undefined, 'data-tip': 'Revoke only this connection', onclick: () => void this.run(async () => { await this.api.revokeConnection(connection.id); return this.api.roster(); }) }, 'Revoke')))),
      commander.kind === 'agent' ? this.kickoff(commander, false) : null,
      h('section', { class: 'cmd-block' },
        h('div', { class: 'cmd-section', 'data-tip': 'What this commander may do on its own. Presets: Autonomous, Policy author, Advisor.' }, icon('settings', 14), ' Mandate'),
        mandateControls(plane ?? 'surface', commander.kind === 'agent' ? 'agent' : 'bot', commander.scopes, commander.mandate, (mandate, scopes) => void this.run(() => this.api.update(commander.id, { mandate, ...(scopes ? { scopes } : {}) })), this.busy, { name: commander.name, stance: false })),
      commander.roles.length > 1 ? h('div', { class: 'slot-stance' }, h('label', { 'data-tip': 'Plane for policy activation and practice' }, 'Plane'),
        seg(`${commander.name} plane`, commander.roles, PLANE_NAME, plane, (value) => { ui.plane = value; this.render(); }, this.busy)) : null,
      this.policies(commander, plane),
      this.practice(commander, ui, plane),
      this.ladderBlock(commander),
      this.tokenSetup(commander, ui),
      this.advanced(commander, ui))];
  }

  private kickoff(commander: RosterCommander, open: boolean): HTMLElement {
    const prompt = kickoffPrompt({ gameTitle: 'Agent Command', roles: commander.roles, mandate: commander.mandate });
    return h('details', { class: 'mandate-kickoff', open: open || undefined },
      h('summary', { 'data-tip': 'Paste this into your signed-in harness to start this commander.' }, icon('console', 14), ' Kickoff prompt'),
      h('div', { class: 'snippet' }, h('pre', { tabindex: '0', 'aria-label': `${commander.name} kickoff prompt` }, prompt), copyButton(prompt, 'Copy prompt', `Copy the ${commander.name} kickoff prompt`)));
  }

  private policies(commander: RosterCommander, plane: Plane | undefined): HTMLElement {
    const notice = this.cardUi(commander.id).notice;
    const activeVersion = plane ? commander.policy.activeByRole[plane] ?? null : null;
    const versions = commander.policy.versions.filter((version) => version.role === plane);
    const active = versions.find((version) => version.version === activeVersion);
    const approvals = commander.approvals.map((pending) => approvalCard(pending.approval, commander.policy.activeByRole[pending.role] ?? null, (approve) => void this.run(() => this.api.resolveApproval(commander.id, pending.approval.id, approve)), this.busy));
    const file = h('input', {
      type: 'file', accept: '.json,application/json', class: 'cmd-file', disabled: this.busy || !plane || undefined,
      'aria-label': `Import a policy package into ${commander.name}${plane ? ` on ${PLANE_NAME[plane]}` : ''}`,
      onchange: (event: Event) => {
        const input = event.target as HTMLInputElement;
        const picked = input.files?.[0];
        input.value = '';
        if (picked && plane) void this.importFile(commander.id, plane, picked);
      },
    });
    return h('section', { class: 'cmd-library cmd-block' },
      h('div', { class: 'cmd-section', 'data-tip': 'Your agent saves immutable versions with policy_deploy; the active one plays while it is away.' }, icon('policy', 14), ' Policy'),
      active ? h('div', { 'data-tip': 'Plays from tick 0 of your next match.' }, h('b', {}, `Active v${active.version}`), h('span', { class: 'muted' }, ` · ${active.runtime}`),
        active.surfaceHash !== this.roster.surfaceHash ? h('span', { class: 'ver-stale', 'data-tip': STALE_TIP }, ' · Stale') : null)
        : h('div', { class: 'muted' }, activeVersion === null ? 'No policy for this plane' : `Active v${activeVersion}`),
      commander.policy.versions.some((version) => version.role === null) ? h('p', { class: 'small muted' }, 'Older policy versions have no recorded plane. Redeploy each intended plane; they will not run on another plane automatically.') : null,
      versions.length ? h('div', { class: 'versions', role: 'group', 'aria-label': `${commander.name} policy versions` },
        ...[...versions].reverse().map((version) => {
          const when = `${new Date(version.createdAt).toLocaleString()}${version.hash ? ` · ${version.hash}` : ''}`;
          const stale = version.surfaceHash !== this.roster.surfaceHash;
          const chip = version.version === activeVersion
            ? h('span', { class: `ver on${stale ? ' stale' : ''}`, 'data-tip': `Active · ${when}${stale ? ` · ${STALE_TIP}` : ''}` }, `v${version.version}`)
            : stale
              ? h('span', { class: 'ver stale', 'data-tip': `${STALE_TIP} (${when})` }, `v${version.version}`)
              : h('button', { type: 'button', class: 'ver', 'data-tip': `Roll back to v${version.version}${plane ? ` on ${PLANE_NAME[plane]}` : ''} (${when})`, disabled: this.busy || !plane || undefined,
                onclick: () => void this.activate(commander.id, plane!, version.version) }, `v${version.version}`);
          return h('span', { class: 'ver-item', 'data-version': version.version }, chip,
            h('button', { type: 'button', class: 'ver-dl', 'aria-label': `Download v${version.version} package`, 'data-tip': `Download v${version.version} as a policy package`, onclick: () => void this.download(commander.id, version.version) }, icon('download', 14)));
        })) : null,
      h('div', { class: 'row' },
        h('label', { class: `btn small cmd-import${this.busy || !plane ? ' off' : ''}`, 'data-tip': plane ? `Add a downloaded policy package as a new ${PLANE_NAME[plane]} version. It stays inactive until you pick it.` : 'Choose a plane first.' },
          icon('upload', 14), ' Import package', file)),
      notice ? h('p', { class: `cmd-notice ${notice.tone}`, role: 'status' }, notice.text) : null,
      ...approvals.map((approval, at) => approval ? h('div', {}, h('span', { class: 'small muted' }, PLANE_NAME[commander.approvals[at]!.role]), approval) : null));
  }

  /** Roll back to (activate) a version; a failed test run says why in the policy block. */
  private activate(commanderId: string, plane: Plane, version: number): Promise<void> {
    const ui = this.cardUi(commanderId);
    return this.run(async () => {
      const { result, roster } = await this.api.rollback(commanderId, plane, version);
      ui.notice = rollbackNotice(result, version);
      return roster;
    });
  }

  private async download(commanderId: string, version: number): Promise<void> {
    try {
      const { fileName, blob } = await this.api.exportPackage(commanderId, version);
      saveFile(fileName, blob);
    } catch {
      if (!this.stopped) this.error.textContent = `Could not download v${version}.`;
    }
  }

  /** Upload a package file as a new, inactive version on `plane`; every refusal is shown in plain words. */
  private async importFile(commanderId: string, plane: Plane, file: File): Promise<void> {
    const ui = this.cardUi(commanderId);
    const refuse = (code: string): void => { ui.notice = importNotice(code, plane); this.render(); };
    if (file.size > POLICY_PACKAGE_MAX_BYTES) return refuse('too_large');
    let pkg: unknown;
    try { pkg = JSON.parse(await file.text()); } catch { return refuse('not_json'); }
    await this.run(async () => {
      try {
        const { result, roster } = await this.api.importPackage(commanderId, plane, pkg);
        ui.notice = result.stale
          ? { tone: 'warn', text: `Imported as v${result.version}, but it was built for a different version of the game. Redeploy it from its source before it can play.` }
          : { tone: 'ok', text: `Imported as v${result.version}. Pick v${result.version} to make it active.` };
        return roster;
      } catch (error) {
        const refusal = error instanceof ApiError ? importNotice(error.code, plane) : undefined;
        if (!refusal) throw error;
        ui.notice = refusal;
        return this.roster;
      }
    });
  }

  /** Headless fast-forward run of the active policy on one compatible plane, on the shared practice battlefield. */
  private practice(commander: RosterCommander, ui: CardUi, plane: Plane | undefined): HTMLElement {
    const vs = ui.practiceVs;
    const active = plane ? commander.policy.activeByRole[plane] ?? null : null;
    const can = plane !== undefined && active !== null && !commander.practicing && !this.busy;
    const box = h('section', { class: 'cmd-practice cmd-block', 'data-practice': commander.id },
      h('div', { class: 'cmd-section', 'data-tip': 'Run the active policy headless at fast-forward against built-in bots.' }, icon('research', 14), ' Practice'),
      h('div', { class: 'row' },
        seg('Practice opponent', PRACTICE_LEVELS, OPP_LABEL, vs, (level) => { ui.practiceVs = level; this.render(); }, this.busy),
        h('button', {
          type: 'button', class: 'btn small primary', disabled: !can || undefined,
          'data-tip': can ? `Practice vs ${OPP_LABEL[vs]}` : commander.practicing ? 'A practice match is running.' : active === null ? 'Deploy a policy for this plane before practicing.' : !plane ? 'Choose a compatible plane first.' : 'A roster change is in progress.',
          onclick: () => {
            // Practice runs the C2 duel of the battlefield's options; a four-army-only map has none.
            if (!MAPS.some((map) => map.id === this.terrain.getMap().mapId && duelMap(map))) { this.error.textContent = 'Practice plays a 1v1: choose a duel battlefield below.'; return; }
            void this.run(() => this.api.practice(commander.id, plane!, vs, this.terrain.options()));
          },
        }, commander.practicing ? 'Practicing…' : 'Practice')));
    const last = commander.lastPractice;
    if (last) {
      // Practice plays the host's default duel with the commander's seat on the first army.
      const us = last.report?.armies[0]?.stats, them = last.report?.armies[1]?.stats;
      const line = (label: string, ours: number, theirs: number) => h('span', {}, `${label} `, h('b', {}, fmt(ours)), ` vs ${fmt(theirs)}`);
      box.append(h('div', { class: 'practice-report' },
        h('div', {}, h('b', { class: `out-${last.outcome}` }, OUTCOME_LABEL[last.outcome]), ` · ${PLANE_NAME[last.role] ?? last.role} vs ${OPP_LABEL[last.opponent] ?? last.opponent} · v${last.version} · ${fmt(last.ticks)} ticks · ${ago(last.at)}`),
        us && them ? h('div', { class: 'stats' },
          line('Alloy', us.alloyMined, them.alloyMined),
          line('Energy', us.energyDelivered, them.energyDelivered),
          line('Kills', us.kills, them.kills),
          line('Lost', us.unitsLost, them.unitsLost),
          line('Spire dmg', us.spireDamageDealt, them.spireDamageDealt)) : null));
    } else if (active === null) box.append(h('div', { class: 'muted small' }, 'Deploy a policy for this plane to practice.'));
    box.append(h('details', { class: 'cmd-practice-map' }, h('summary', { 'data-tip': 'Every commander practises on this map, seed and size' }, icon('map', 14), ' Battlefield'), this.mapPicker.el));
    return box;
  }

  /** The persistent commander token: the bearer fallback for harnesses without browser sign-in. */
  private tokenSetup(commander: RosterCommander, ui: CardUi): HTMLElement {
    const setup = harnessSetup(ui.harness, { mcpUrl: mcpUrl(), serverName: `${SERVER_NAME}-${commander.id}`, token: commander.token });
    return h('details', { class: 'harness-setup cmd-token' },
      h('summary', { 'data-tip': 'For harnesses without browser sign-in. Private: never share it or show it on stream.' }, icon('token', 14), ' Token setup'),
      h('div', { class: 'seg-ctl cmd-glyphs', role: 'group', 'aria-label': `${commander.name} token harness` }, ...HARNESSES.map((entry) => h('button', {
        type: 'button', class: entry.kind === ui.harness ? 'on' : '', 'aria-pressed': String(entry.kind === ui.harness), 'aria-label': entry.name, 'data-tip': `${entry.name} · ${entry.blurb}`,
        onclick: () => { if (entry.kind !== ui.harness) { ui.harness = entry.kind; this.render(); } },
      }, icon(entry.kind, 18)))),
      setup
        ? h('div', { class: 'cmd-fields' },
          h('div', { class: 'cmd-section' }, pasteWhere(setup, harness(ui.harness).name)),
          setup.text ? h('div', { class: 'snippet' }, h('pre', { tabindex: '0', 'aria-label': `${commander.name} token setup` }, setup.text), copyButton(setup.text, 'Copy', 'Copy the private token setup')) : null,
          h('p', { class: 'then' }, setup.then),
          alternativeSetup(setup, `${commander.name} token`))
        : h('p', { class: 'muted' }, 'Open the game over HTTP(S) to connect a harness.'),
      ui.confirm === 'rotate'
        ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Old token stops working.'),
          h('button', { type: 'button', class: 'btn small danger', disabled: this.busy || undefined, onclick: () => { ui.confirm = undefined; void this.run(() => this.api.rotate(commander.id)); } }, 'Rotate'),
          h('button', { type: 'button', class: 'btn small ghost', onclick: () => { ui.confirm = undefined; this.render(); } }, 'Cancel'))
        : h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small ghost', disabled: this.busy || undefined, 'data-tip': 'Disconnect token sessions and issue a new token', onclick: () => { ui.confirm = 'rotate'; this.render(); } }, 'Rotate token')));
  }

  private advanced(commander: RosterCommander, ui: CardUi): HTMLElement {
    const name = h('input', { value: commander.name, maxlength: 64, required: true, 'aria-label': `Rename ${commander.name}` });
    const provider = h('input', { value: commander.metadata?.provider ?? '', maxlength: 64, placeholder: 'Provider', 'aria-label': `${commander.name} provider` });
    const model = h('input', { value: commander.metadata?.model ?? '', maxlength: 80, placeholder: 'Model', 'aria-label': `${commander.name} model` });
    return h('details', { class: 'cmd-advanced' }, h('summary', { 'data-tip': 'Name, planes, self-reported identity, isolation, remove' }, h('b', {}, 'Advanced')),
      h('form', { class: 'named-commander-metadata cmd-fields', onsubmit: (event: Event) => {
        event.preventDefault();
        const next = name.value.trim();
        void this.run(() => this.api.update(commander.id, { ...(next && next !== commander.name ? { name: next } : {}), metadata: { ...commander.metadata, provider: provider.value.trim(), model: model.value.trim() } }));
      } },
      h('label', {}, 'Name', name), h('label', { 'data-tip': 'Self-reported, never verified' }, 'Provider', provider), h('label', { 'data-tip': 'Self-reported, never verified' }, 'Model', model),
      h('button', { type: 'submit', class: 'btn small', disabled: this.busy || undefined }, 'Save')),
      h('div', { class: 'slot-stance' }, h('label', {}, 'Planes'), planeToggles(`${commander.name} planes`, commander.roles, (roles) => void this.run(() => this.api.update(commander.id, { roles })), this.busy)),
      h('label', { class: 'cmd-check small', 'data-tip': 'A harness declaration, not independently verified. Opposing seats require isolated sessions.' },
        h('input', { type: 'checkbox', checked: commander.isolation.independentSessions || undefined, disabled: this.busy || !!commander.seated || undefined, onchange: (event: Event) => void this.run(() => this.api.update(commander.id, { isolation: { independentSessions: (event.target as HTMLInputElement).checked } })) }),
        ' Independent sessions'),
      ui.confirm === 'remove'
        ? h('div', { class: 'row' }, h('span', { class: 'muted' }, `Remove ${commander.name}?`),
          h('button', { type: 'button', class: 'btn small danger', disabled: this.busy || undefined, onclick: () => { ui.confirm = undefined; void this.run(() => this.api.deleteCommander(commander.id)); } }, 'Remove'),
          h('button', { type: 'button', class: 'btn small ghost', onclick: () => { ui.confirm = undefined; this.render(); } }, 'Cancel'))
        : h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small ghost', disabled: this.busy || !!commander.seated || undefined, 'data-tip': commander.seated ? 'Seated in a match' : 'Remove this commander and its connections', onclick: () => { ui.confirm = 'remove'; this.render(); } }, 'Remove commander')));
  }
}
