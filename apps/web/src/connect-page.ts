/** Consent selects one named commander; pairing never saves or replaces an owner credential. */
import './roster.css';
import './commander.css';
import './connect-page.css';
import { PLANES, type Plane } from '@agent-command/game/contract';
import { harness, isClientKind, type ConnectionInfo, type ConsentCommander, type ConsentRequestInfo } from '@playerthree/connect';
import { PLANE_ACCENT, PLANE_CHAPTER, copyText, h } from './dom.ts';
import { icon } from './icons.ts';
import { ApiError } from './api.ts';
import { ProfileApi, answerPairedConsent, consentInfo, pairConsent, type Roster } from './profile.ts';
import { PLANE_BLURB, PLANE_NAME } from './text.ts';
import { MODE_LABEL, mandateMode } from './mandate.ts';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const UNSAFE_SCHEME = /^(javascript|data|vbscript|file|blob):/i;
const ERR: Record<string, string> = {
  unknown_request: 'This sign-in expired or was already answered. Start it again from your harness.',
  invalid: 'The server rejected that answer. Check the commander, compatible planes or pairing code.',
  bad_code: 'That pairing code is invalid, expired or already used. Get a new code in your original game’s Commanders screen.',
  bad_profile: 'This server does not recognize the saved profile. Its credentials have been preserved. Use the original game address or a pairing code; start fresh only if you want a separate profile.',
  forbidden_origin: 'This game address is not allowed by the server. Open the exact sign-in URL supplied by your harness; do not change its hostname, scheme or port. Pair there with your original game profile.',
  rate_limited: 'Too many attempts — wait a minute and try again.',
  network: 'Could not reach the game server.',
};
function errorText(e: unknown): string {
  return e instanceof ApiError ? ERR[e.code] ?? `Sign-in failed (${e.code}).` : e instanceof Error ? e.message : ERR.network!;
}

type Identity = { api: ProfileApi; hint: string } | { pairingToken: string; hint: string };
type Asking = {
  kind: 'ask'; req: ConsentRequestInfo; identity?: Identity; commanders: readonly ConsentCommander[];
  commander: string; picked: Set<Plane>; sending: boolean; error: string;
};
type State =
  | { kind: 'loading' }
  | Asking
  | { kind: 'done'; approved: boolean; name: string; paired: boolean }
  | { kind: 'error'; text: string };

export class ConnectPage {
  readonly el: HTMLElement;
  private readonly card = h('div', { class: 'consent-card', role: 'main' });
  private id = '';
  private state: State = { kind: 'loading' };
  private code = '';
  private copied = false;
  private freshConfirm = false;
  private newName = '';

  constructor(requestId: string | null) {
    document.title = 'Sign in an agent — Agent Command';
    this.el = h('div', { class: 'consent-page' }, this.card);
    this.render();
    if (!requestId || !REQUEST_ID.test(requestId)) {
      this.state = { kind: 'error', text: 'This sign-in link is incomplete. Start the sign-in again from your harness.' };
      this.render();
      return;
    }
    this.id = requestId;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const req = await consentInfo(this.id);
      this.state = { kind: 'ask', req, commanders: [], commander: '', picked: new Set(), sending: false, error: '' };
      try {
        const api = ProfileApi.stored();
        if (api) await this.useProfile(api);
      } catch (e) {
        if (this.state.kind === 'ask') this.state.error = errorText(e);
      }
    } catch (e) {
      this.state = { kind: 'error', text: errorText(e) };
    }
    this.render();
  }

  private async useProfile(api: ProfileApi): Promise<void> {
    const s = this.state;
    if (s.kind !== 'ask') return;
    const [roster, connections] = await Promise.all([api.roster(), api.connections()]);
    s.identity = { api, hint: `Profile ${api.profile.id} · ${location.origin}` };
    s.commanders = this.commanders(roster, connections);
    this.select('');
  }
  private commanders(roster: Roster, connections: readonly ConnectionInfo[]): ConsentCommander[] {
    return roster.commanders.map((commander) => {
      const held = connections.find((connection) => connection.commander === commander.id);
      return {
        id: commander.id, name: commander.name, kind: commander.kind, roles: commander.roles,
        isolation: commander.isolation, metadata: commander.metadata,
        scopes: commander.scopes, mandate: commander.mandate,
        holder: held ? { name: held.client.name, kind: held.client.kind } : null,
      };
    });
  }

  private selected(s: Asking): ConsentCommander | undefined { return s.commanders.find((commander) => commander.id === s.commander); }
  private compatible(s: Asking, commander: ConsentCommander): Plane[] { return PLANES.filter((role) => s.req.roles.includes(role) && commander.roles.includes(role)); }
  private select(id: string): void {
    const s = this.state;
    if (s.kind !== 'ask') return;
    s.commander = id;
    const commander = this.selected(s);
    s.picked = new Set(commander ? this.compatible(s, commander) : []);
  }

  private async identify(fresh: boolean): Promise<void> {
    const s = this.state;
    if (s.kind !== 'ask' || s.sending) return;
    s.sending = true;
    s.error = '';
    this.render();
    try {
      if (fresh) await this.useProfile((await ProfileApi.create()).api);
      else {
        const result = await pairConsent(this.id, this.code.trim());
        s.identity = { pairingToken: result.pairingToken, hint: 'Your original game profile · paired for this sign-in only' };
        s.commanders = result.commanders;
        this.code = '';
        this.select('');
      }
      this.freshConfirm = false;
    } catch (e) {
      s.error = errorText(e);
    }
    s.sending = false;
    this.render();
  }

  private async createCommander(): Promise<void> {
    const s = this.state;
    if (s.kind !== 'ask' || s.sending || !s.identity || !('api' in s.identity) || !this.newName.trim()) return;
    const roles = PLANES.filter((role) => s.req.roles.includes(role));
    if (!roles.length) return;
    const api = s.identity.api;
    const previous = new Set(s.commanders.map((commander) => commander.id));
    s.sending = true;
    s.error = '';
    this.render();
    try {
      const roster = await api.createCommander({ name: this.newName.trim(), kind: 'agent', roles, isolation: { independentSessions: false } });
      // A new roster ID, never a client name or role, identifies the explicit new connection.
      const created = roster.commanders.filter((commander) => !previous.has(commander.id));
      s.commanders = this.commanders(roster, await api.connections());
      this.select(created.length === 1 ? created[0]!.id : '');
      this.newName = '';
    } catch (e) {
      s.error = errorText(e);
    }
    s.sending = false;
    this.render();
  }

  private async answer(approve: boolean): Promise<void> {
    const s = this.state;
    if (s.kind !== 'ask' || s.sending || !s.identity) return;
    const commander = this.selected(s);
    const roles = commander ? this.compatible(s, commander).filter((role) => s.picked.has(role)) : [];
    if (approve && (!commander || !roles.length)) return;
    s.sending = true;
    s.error = '';
    this.render();
    try {
      const paired = 'pairingToken' in s.identity;
      const { redirect } = 'api' in s.identity
        ? await s.identity.api.answerConsent(this.id, s.commander, approve ? roles : [], approve)
        : await answerPairedConsent(this.id, s.commander, approve ? roles : [], approve, s.identity.pairingToken);
      this.state = { kind: 'done', approved: approve, name: s.req.client.name, paired };
      this.render();
      if (typeof redirect === 'string' && !UNSAFE_SCHEME.test(redirect.trim())) location.assign(redirect);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unknown_request') this.state = { kind: 'error', text: errorText(e) };
      else { s.sending = false; s.error = errorText(e); }
      this.render();
    }
  }

  private recovery(s: Asking): HTMLElement {
    const input = h('input', {
      type: 'text', value: this.code, placeholder: 'Pairing code', 'aria-label': 'Pairing code', autocomplete: 'off', spellcheck: 'false',
      disabled: s.sending || undefined, oninput: (e: Event) => { this.code = (e.target as HTMLInputElement).value; },
    });
    const fresh = h('button', { class: 'btn', disabled: !this.freshConfirm || s.sending || undefined, onclick: () => void this.identify(true) }, 'Create a separate profile');
    return h('div', { class: 'consent-recovery' },
      h('b', {}, s.identity ? 'Not your game profile?' : 'Choose your game profile'),
      h('p', { class: 'small muted' }, 'Profiles belong to a browser and exact game address (scheme, hostname and port). This tab may use a different browser, localhost instead of 127.0.0.1, or a different port.'),
      h('button', { class: 'btn small', disabled: s.sending || undefined, onclick: () => void copyText(location.href).then((ok) => { this.copied = ok; this.render(); }) }, this.copied ? 'Link copied' : 'Copy sign-in link'),
      h('p', { class: 'small' }, 'Open this same link in the browser and address where you play. Or copy a pairing code from that game’s Commanders screen and enter it here. The code grants only this sign-in, not your owner credential.'),
      h('form', { class: 'consent-pair', onsubmit: (e: Event) => { e.preventDefault(); void this.identify(false); } }, input, h('button', { class: 'btn', type: 'submit', disabled: s.sending || undefined }, 'Use pairing code')),
      h('details', {}, h('summary', {}, 'Start fresh instead'),
        h('p', { class: 'small' }, 'Creates a separate profile in this browser. It will not connect the agent to your original game or move any existing commanders. This replaces this browser’s saved profile.'),
        h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: this.freshConfirm || undefined, disabled: s.sending || undefined, onchange: (e: Event) => { this.freshConfirm = (e.target as HTMLInputElement).checked; fresh.disabled = !this.freshConfirm || s.sending; } }), ' I want a separate, new profile'),
        fresh,
      ),
    );
  }

  private commanderPicker(s: Asking): HTMLElement {
    const select = h('select', { id: 'consent-commander', disabled: s.sending || undefined, onchange: (event: Event) => { this.select((event.target as HTMLSelectElement).value); this.render(); } },
      h('option', { value: '' }, 'Choose a named commander'),
      ...s.commanders.map((commander) => h('option', { value: commander.id, disabled: !this.compatible(s, commander).length || undefined }, commander.name)));
    // Selectedness comes from state, not option attributes, so a re-render always shows the chosen (or newly created) entry.
    select.value = s.commander;
    const commander = this.selected(s);
    const metadata = commander?.metadata;
    return h('section', { class: 'consent-connection', 'aria-label': 'Named connection' },
      h('label', { for: 'consent-commander' }, 'Connect as'), select,
      commander ? h('p', { class: 'small muted', role: 'status' }, `${commander.kind === 'policy' ? 'Policy' : 'Live connection'} · Mode: ${MODE_LABEL[mandateMode(commander.scopes, commander.mandate)]}`, commander.holder ? ` · Currently connected to ${commander.holder.name}. This consent authorizes this selected commander only.` : ' · No harness connected.') : null,
      commander ? h('p', { class: 'small consent-model', 'data-tip': 'Owner-authored identity metadata, not verified by the harness domain. No API keys or provider credentials are requested.' }, icon('info', 14), metadata?.provider || metadata?.model ? ` ${[metadata.provider, metadata.model].filter(Boolean).join(' / ')} · self-reported` : ' Provider / model not reported', metadata?.scaffoldVersion ? ` · scaffold ${metadata.scaffoldVersion} (self-reported)` : '') : null,
      s.identity && 'api' in s.identity ? h('form', { class: 'consent-create', onsubmit: (event: Event) => { event.preventDefault(); void this.createCommander(); } },
        h('label', { for: 'consent-new-name' }, 'Or create a new named connection'),
        h('input', { id: 'consent-new-name', type: 'text', value: this.newName, required: true, maxlength: 64, placeholder: 'Commander name', disabled: s.sending || undefined, oninput: (event: Event) => { this.newName = (event.target as HTMLInputElement).value; } }),
        h('button', { class: 'btn', type: 'submit', disabled: s.sending || undefined }, icon('commanders', 16), ' Create connection'),
        h('p', { class: 'small muted' }, 'Creates a separate roster entry compatible with the requested planes. Review its plane toggles below, then explicitly allow. No team is assigned; choose seats later in a lobby.'),
      ) : h('p', { class: 'small muted' }, 'Need another connection? Open this same sign-in link in your original game browser to create one there. Pairing cannot create or edit your roster.'),
    );
  }

  private render(): void {
    const s = this.state;
    const kicker = h('div', { class: 'kicker' }, 'AGENT COMMAND · SIGN IN AN AGENT');
    if (s.kind === 'loading') return void this.card.replaceChildren(kicker, h('p', { class: 'muted', role: 'status' }, 'Loading the sign-in…'));
    if (s.kind === 'error') return void this.card.replaceChildren(kicker, h('h1', {}, 'Sign-in unavailable'), h('p', { role: 'alert' }, s.text), h('a', { class: 'btn', href: '/' }, 'Open Agent Command'));
    if (s.kind === 'done') return void this.card.replaceChildren(kicker, h('h1', { role: 'status' }, s.approved ? 'Allowed' : 'Denied'), h('p', {}, s.approved ? `Returning you to ${s.name}… Your original game will update automatically.` : `${s.name} was not given a connection. You can close this tab.`), h('p', { class: 'small muted' }, s.paired ? 'Return to your original game browser. No profile credential was saved in this browser.' : 'You can return to your game tab.'));
    const c = s.req.client;
    const kind = isClientKind(c.kind) ? c.kind : 'generic';
    const who = h('div', { class: 'consent-who' }, h('span', { class: 'consent-glyph' }, icon(kind, 46)), h('div', {}, h('h1', {}, c.name), h('div', { class: 'muted' }, harness(kind).name, ' · ', c.domain ? h('span', { class: 'verified' }, `verified by ${c.domain}`) : h('span', { class: 'unverified' }, 'unverified name — allow only if you just started this sign-in'))));
    const commander = this.selected(s);
    const compatible = commander ? this.compatible(s, commander) : [];
    const planes = h('div', { class: 'consent-planes', role: 'group', 'aria-label': 'Compatible planes this connection may command' }, ...PLANES.filter((p) => s.req.roles.includes(p)).reverse().map((p) => {
      const on = s.picked.has(p);
      const allowed = compatible.includes(p);
      return h('button', { type: 'button', class: `consent-plane${on ? ' on' : ''}`, style: `--accent:${PLANE_ACCENT[p]}`, 'data-plane': p, 'aria-pressed': String(on), 'data-tip': allowed ? PLANE_BLURB[p] : 'Not compatible with this named commander', disabled: s.sending || !allowed || undefined, onclick: () => { if (on) s.picked.delete(p); else s.picked.add(p); this.render(); } },
        h('span', { class: 'switch', 'aria-hidden': 'true' }, h('i')), h('span', { class: 'section' }, PLANE_CHAPTER[p].label), h('em', {}, PLANE_NAME[p]),
        !allowed ? h('span', { class: 'consent-mode small' }, 'Not compatible') : null);
    }));
    const n = compatible.filter((role) => s.picked.has(role)).length;
    const parts: (HTMLElement | null)[] = [kicker, who,
      h('p', { class: 'consent-identity small' }, s.identity?.hint ?? `No usable game profile in this browser at ${location.origin}. Nothing has been created.`),
      s.identity ? this.commanderPicker(s) : null,
      commander ? h('p', { class: 'consent-ask' }, `Allow ${c.name} to command ${commander.name}? Pick compatible planes:`) : null,
      commander ? planes : null,
      s.identity ? h('p', { class: 'consent-note muted small' }, 'It gets typed, fogged game data and your messages for the granted planes only — never your profile secret, another commander’s private data or observer vision. Provider/model labels are self-reported, not credentials. Revoke this connection any time on the Commanders screen.') : null,
      h('p', { class: 'consent-return small' }, 'Your browser then returns to ', h('b', {}, s.req.redirect.host), s.req.redirect.loopback ? ' — a program on this computer.' : '.'),
      s.error ? h('div', { class: 'cmd-error', role: 'alert' }, s.error) : null,
      s.identity ? h('div', { class: 'consent-actions' }, h('button', { class: 'btn big ghost', disabled: s.sending || undefined, onclick: () => void this.answer(false) }, 'Deny'), h('button', { class: 'btn big primary', disabled: s.sending || n === 0 || undefined, onclick: () => void this.answer(true) }, s.sending ? 'Sending…' : !commander ? 'Choose a commander' : n === 0 ? 'Pick a plane' : `Allow ${n} plane${n > 1 ? 's' : ''}`)) : null,
      s.identity && 'pairingToken' in s.identity ? h('button', { class: 'btn small', disabled: s.sending || undefined, onclick: () => void copyText(location.href).then((ok) => { this.copied = ok; this.render(); }) }, this.copied ? 'Link copied' : 'Copy sign-in link') : this.recovery(s),
    ];
    this.card.replaceChildren(...parts.filter((node): node is HTMLElement => node !== null));
  }
}
