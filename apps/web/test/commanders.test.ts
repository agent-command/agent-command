// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESSES, MANDATE_PRESETS, harnessSetup, kickoffPrompt, type ConnectionInfo } from '@playerthree/connect';
import { ApiError } from '../src/api.ts';
import { CommandersScreen, SERVER_NAME, commanderStatus, mcpUrl, oauthServerName } from '../src/commanders.ts';
import type { TerrainChoice } from '../src/terrain-choice.ts';
import { ProfileApi, type Roster, type RosterCommander } from '../src/profile.ts';
const profile = { id: 'a'.repeat(16), secret: 'b'.repeat(43) };
/** A well-formed commander token (32 url-safe chars), so token setups render. */
const token = (id: string) => `private${id}`.padEnd(32, '0');
function commander(id: string, name: string, patch: Partial<RosterCommander> = {}): RosterCommander {
  return { id, name, kind: 'agent', roles: ['surface'], isolation: { independentSessions: true }, token: token(id), scopes: [...MANDATE_PRESETS.autonomous.scopes],
    mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } }, metadata: { provider: 'Provider', model: 'Model' },
    policy: { activeByRole: { surface: null }, versions: [] }, approvals: [], connected: false, lastSeenAt: null, seated: null, practicing: false, lastPractice: null, ...patch };
}
function connection(id: string, commanderId: string, patch: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return { id, commander: commanderId, client: { name: 'Claude Code', kind: 'claude-code' }, roles: ['surface'], active: false, lastSeen: null, createdAt: 1, authorizedAt: 1, ...patch };
}
let screen: CommandersScreen;
const SURFACE = 'a'.repeat(64);
const roster: Roster = { id: profile.id, surfaceHash: SURFACE, commanders: [commander('one', 'DeepSeek'), commander('two', 'OpenAI')], chat: [] };
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
  localStorage.setItem('agent-command.profile', JSON.stringify(profile));
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  vi.spyOn(ProfileApi.prototype, 'connections').mockResolvedValue([]);
  vi.spyOn(ProfileApi.prototype, 'bots').mockResolvedValue({ bots: [] });
});
afterEach(() => { screen?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });
// Map-card thumbnails generate in a worker; these tests only need the cards themselves.
vi.mock('../src/preview-client.ts', () => ({ thumbnailMaps: { get: () => new Promise(() => {}) } }));
const picked = vi.fn();
const practiceMap = { getMap: () => ({ mapId: 'crossfire', mapSeed: 0, size: 48 }), options: () => ({ map: { name: 'crossfire' } }), set: picked, setSeed: () => {}, setSize: () => {}, onChange: () => () => {} } as unknown as TerrainChoice;
function mount(connections?: readonly ConnectionInfo[], r: Roster = roster): void { screen = new CommandersScreen(ProfileApi.stored()!, r, vi.fn(), practiceMap, connections); document.body.append(screen.el); }
function submit(form: Element): void { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = (text: string, root: ParentNode = screen.el) => [...root.querySelectorAll('button')].find((element) => element.textContent?.trim() === text)!;
const tile = (kind: string) => screen.el.querySelector<HTMLButtonElement>(`.harness-btn[data-kind="${kind}"]`)!;
const select = (id: string) => screen.el.querySelector<HTMLButtonElement>(`.cmd-row [data-commander-id="${id}"]`)!.click();
const detail = () => screen.el.querySelector<HTMLElement>('[data-commander-detail]')!;

describe('connect in one line', () => {
  it('offers every browser sign-in harness as an icon tile, nothing preselected', () => {
    mount([]);
    const tiles = [...screen.el.querySelectorAll<HTMLButtonElement>('.harness-row .harness-btn')];
    expect(tiles.map((element) => element.dataset.kind)).toEqual(HARNESSES.filter((entry) => entry.kind !== 'claude-api').map((entry) => entry.kind));
    for (const element of tiles) { expect(element.querySelector('svg')).not.toBeNull(); expect(element.getAttribute('aria-pressed')).toBe('false'); expect(element.dataset.tip).toBeTruthy(); }
    expect(screen.el.querySelector('.harness-setup:not(details)')).toBeNull();
    expect(screen.el.querySelector('[title]')).toBeNull();
  });
  it('shows exactly the harnessSetup one-liner for the picked harness, with Copy that confirms in place', async () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    mount([]);
    for (const entry of HARNESSES.filter((item) => item.kind !== 'claude-api')) {
      tile(entry.kind).click();
      const setup = harnessSetup(entry.kind, { mcpUrl: mcpUrl(), serverName: SERVER_NAME })!;
      expect(tile(entry.kind).getAttribute('aria-pressed')).toBe('true');
      expect(screen.el.querySelector(`pre[aria-label="${entry.name} setup"]`)?.textContent).toBe(setup.text);
      expect(screen.el.querySelector('.harness-setup .then')?.textContent).toContain(setup.then);
    }
    tile('codex').click();
    const copy = screen.el.querySelector<HTMLButtonElement>('.harness-setup:not(details) .snippet .btn')!;
    copy.click(); await flush();
    expect(writeText).toHaveBeenCalledWith(harnessSetup('codex', { mcpUrl: mcpUrl(), serverName: SERVER_NAME })!.text);
    expect(copy.textContent).toBe('Copied');
    expect(screen.el.querySelector('.harness-setup a[href="https://developers.openai.com/codex/mcp"]')?.textContent).toContain('Docs');
  });
  it('mints a pairing code on pick, copies it and can mint a new one', async () => {
    const pairing = vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValueOnce({ code: 'ABC234', expiresAt: Date.now() + 100000 }).mockResolvedValueOnce({ code: 'XYZ789', expiresAt: Date.now() + 100000 });
    mount([]);
    tile('claude-code').click(); await flush();
    expect(pairing).toHaveBeenCalledTimes(1);
    expect(screen.el.querySelector('[aria-label="Pairing code"]')?.textContent).toBe('ABC234');
    expect(screen.el.textContent).toContain('Never share your profile secret.');
    button('Copy code').click(); await flush();
    expect(writeText).toHaveBeenCalledWith('ABC234'); expect(button('Code copied')).toBeTruthy();
    button('New code').click(); await flush();
    expect(screen.el.querySelector('[aria-label="Pairing code"]')?.textContent).toBe('XYZ789');
  });
  it('reports a pairing failure inline', async () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockRejectedValue(new TypeError('offline'));
    mount([]);
    tile('claude-code').click(); await flush();
    expect(screen.el.querySelector('.cmd-pairing .cmd-error')?.textContent).toBe('Could not reach the server to create a pairing code.');
  });
  it('waits for sign-in, then shows the signed-in commander chip and its kickoff prompt', async () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    const old = connection('c-old', 'two', { client: { name: 'Codex', kind: 'codex' } });
    mount([old]);
    tile('claude-code').click(); await flush();
    expect(screen.el.querySelector('.cmd-wait')?.textContent).toBe('Awaiting sign-in');
    screen.update(roster, [old, connection('c-new', 'one', { active: true, authorizedAt: 50 })]);
    const status = screen.el.querySelector('.cmd-wait.ok')!;
    expect(status.textContent).toContain('Signed in:'); expect(status.querySelector('.agent-button')?.getAttribute('aria-label')).toContain('DeepSeek');
    expect(status.querySelector('.agent-button')?.getAttribute('data-status')).toBe('online');
    expect(screen.el.querySelector('.cmd-pairing')).toBeNull();
    const prompt = kickoffPrompt({ gameTitle: 'Agent Command', roles: ['surface'], mandate: roster.commanders[0]!.mandate });
    expect(screen.el.querySelector('.harness-setup:not(details) [aria-label="DeepSeek kickoff prompt"]')?.textContent).toBe(prompt);
    button('Copy prompt', screen.el.querySelector('.harness-setup:not(details)')!).click(); await flush();
    expect(writeText).toHaveBeenCalledWith(prompt);
  });
  it('treats a re-consent of an existing connection as the new sign-in', () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    mount([connection('c1', 'one')]);
    tile('claude-code').click();
    screen.update(roster, [connection('c1', 'one', { authorizedAt: 99 })]);
    expect(screen.el.querySelector('.cmd-wait.ok')?.textContent).toContain('Signed in:');
  });
  it('names a second entry when the harness already holds a connection', () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    const held = [connection('c1', 'one')];
    expect(oauthServerName('claude-code', held)).toBe('agent-command-2'); expect(oauthServerName('codex', held)).toBe(SERVER_NAME);
    mount(held);
    tile('claude-code').click();
    expect(screen.el.querySelector('pre[aria-label="Claude Code setup"]')?.textContent).toBe(harnessSetup('claude-code', { mcpUrl: mcpUrl(), serverName: 'agent-command-2' })!.text);
  });
  it('offers OpenCode and Pi as terminal one-liners with their icons', () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    mount([]);
    for (const [kind, name] of [['opencode', 'OpenCode'], ['pi', 'Pi']] as const) {
      expect(tile(kind).querySelector('svg.icon')?.childElementCount).toBeGreaterThan(0);
      tile(kind).click();
      expect(screen.el.querySelector('.harness-setup:not(details) .cmd-section')?.textContent).toBe(`Run this in a terminal — ${name}`);
      expect(screen.el.querySelector(`pre[aria-label="${name} setup"]`)?.textContent).toBe(harnessSetup(kind, { mcpUrl: mcpUrl(), serverName: SERVER_NAME })!.text);
      expect(screen.el.querySelector('.harness-setup .cmd-alt')).toBeNull();
    }
    expect(tile('pi').dataset.tip).not.toMatch(/oh-my-pi/i);
  });
  it('sets up oh-my-pi with its in-session /mcp quick-add, the mcp.json entry folded beneath, and the next free name', async () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    const held = [connection('c1', 'one', { client: { name: 'oh-my-pi', kind: 'oh-my-pi' } })];
    mount(held);
    expect(tile('oh-my-pi').querySelector('svg.icon')?.childElementCount).toBeGreaterThan(0);
    expect(tile('oh-my-pi').dataset.tip).toContain('auto-imports your Claude Code and Cursor MCP configs');
    tile('oh-my-pi').click();
    const setup = harnessSetup('oh-my-pi', { mcpUrl: mcpUrl(), serverName: 'agent-command-2' })!;
    expect(screen.el.querySelector('.harness-setup:not(details) .cmd-section')?.textContent).toBe('In oh-my-pi, run');
    expect(screen.el.querySelector('pre[aria-label="oh-my-pi setup"]')?.textContent).toBe(setup.text);
    expect(setup.text).toContain('/mcp add agent-command-2 --scope user --url');
    const alt = screen.el.querySelector<HTMLDetailsElement>('.harness-setup .cmd-alt')!;
    expect(alt.querySelector('summary')?.textContent).toBe('Or add this to ~/.omp/agent/mcp.json');
    expect(alt.querySelector('pre')?.textContent).toBe(setup.alternative!.text);
    button('Copy', alt).click(); await flush();
    expect(writeText).toHaveBeenCalledWith(setup.alternative!.text);
    expect(screen.el.querySelector('.harness-setup a[href="https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md"]')).not.toBeNull();
  });
  it('falls back to token setup when the server has no browser sign-in', () => {
    const pairing = vi.spyOn(ProfileApi.prototype, 'pairingCode');
    mount(undefined);
    tile('claude-code').click();
    expect(screen.el.querySelector('.cmd-wait.off')?.textContent).toContain('Token setup only');
    expect(pairing).not.toHaveBeenCalled();
  });
});

describe('my commanders', () => {
  it('lists every commander with a status chip, without seats, teams or tooltips via title', () => {
    mount([]); expect(screen.el.querySelectorAll('[data-commander-id]')).toHaveLength(2);
    expect(screen.el.textContent).toContain('DeepSeek'); expect(screen.el.textContent).toContain('OpenAI');
    expect(screen.el.textContent).not.toContain('Assign planes'); expect(screen.el.querySelector('[data-team]')).toBeNull(); expect(screen.el.querySelector('[title]')).toBeNull();
    expect(screen.el.querySelector('[data-commander-row="one"] [data-commander-status="one"]')?.textContent).toBe('Not connected');
  });
  it('shows connected, signed-in and last-seen status per commander', () => {
    const now = 10 * 60_000;
    expect(commanderStatus(commander('a', 'A'), [], now)).toEqual({ state: 'off', text: 'Not connected' });
    expect(commanderStatus(commander('a', 'A', { lastSeenAt: now - 5 * 60_000 }), [], now)).toEqual({ state: 'off', text: 'Seen 5 min ago' });
    expect(commanderStatus(commander('a', 'A'), [connection('c', 'a', { lastSeen: now - 2 * 60_000 })], now)).toEqual({ state: 'idle', text: 'Signed in · seen 2 min ago' });
    expect(commanderStatus(commander('a', 'A'), [connection('c', 'a', { active: true })], now)).toEqual({ state: 'on', text: 'Connected' });
    expect(commanderStatus(commander('a', 'A', { connected: true, seated: { match: 'm', roomId: 'r', team: 'nw', roles: ['surface'] } }), [], now).text).toBe('Connected · in match');
    mount([connection('c', 'two', { active: true })]);
    expect(screen.el.querySelector('[data-commander-status="two"]')?.getAttribute('data-state')).toBe('on');
    expect(screen.el.querySelector('.cmd-row [data-commander-id="two"]')?.getAttribute('data-status')).toBe('online');
    expect(screen.el.querySelector('.cmd-row [data-commander-id="one"]')?.getAttribute('data-status')).toBe('offline');
  });
  it('shows the last practice result in the roster row', () => {
    mount([], { ...roster, commanders: [commander('one', 'DeepSeek', { lastPractice: { at: Date.now(), role: 'surface', opponent: 'veteran', allies: 'standard', ticks: 1200, seed: 1, version: 2, outcome: 'win', report: null } })] });
    expect(screen.el.querySelector('[data-commander-row="one"] .cmd-last')?.textContent).toBe('Win vs Veteran · just now');
  });
  it('drags commander chips by id only', () => {
    mount([]);
    const chip = screen.el.querySelector<HTMLElement>('.cmd-row [data-commander-id="one"]')!;
    expect(chip.draggable).toBe(true);
    expect(chip.outerHTML).not.toContain(token('one'));
  });
  it('creates another compatible commander without changing existing entries', async () => {
    const create = vi.spyOn(ProfileApi.prototype, 'createCommander').mockResolvedValue(roster); mount([]);
    screen.el.querySelector<HTMLInputElement>('[aria-label="Commander name"]')!.value = 'Claude';
    screen.el.querySelector<HTMLInputElement>('[aria-label="Self-reported provider"]')!.value = 'Anthropic';
    screen.el.querySelector<HTMLButtonElement>('[aria-label="New commander planes"] [data-plane="orbit"]')!.click();
    submit(screen.el.querySelector('.named-commander-create')!); await Promise.resolve();
    expect(create).toHaveBeenCalledWith({ name: 'Claude', kind: 'agent', roles: ['surface', 'orbit'], isolation: { independentSessions: false }, metadata: { provider: 'Anthropic' } });
  });
  it('saves identity to the stable commander ID, not a role endpoint', async () => {
    const update = vi.spyOn(ProfileApi.prototype, 'update').mockResolvedValue(roster); mount([]);
    select('two');
    detail().querySelector<HTMLInputElement>('[aria-label="OpenAI model"]')!.value = 'New Model'; submit(detail().querySelector('.named-commander-metadata')!); await Promise.resolve();
    expect(update).toHaveBeenCalledWith('two', { metadata: { provider: 'Provider', model: 'New Model' } });
  });
  it('applies mandate presets as scopes and autonomy, leaving stance to the match', async () => {
    const update = vi.spyOn(ProfileApi.prototype, 'update').mockResolvedValue(roster); mount([]);
    expect(detail().querySelector('[aria-label="DeepSeek stance"]')).toBeNull();
    button('Advisor', detail().querySelector('[aria-label="DeepSeek mode"]')!).click(); await Promise.resolve();
    expect(update).toHaveBeenCalledWith('one', { mandate: { ...roster.commanders[0]!.mandate, autonomy: 'supervised' }, scopes: [...MANDATE_PRESETS.advisor.scopes] });
  });
  it('copies a commander kickoff prompt from its detail', async () => {
    mount([]);
    button('Copy prompt', detail()).click(); await flush();
    expect(writeText).toHaveBeenCalledWith(kickoffPrompt({ gameTitle: 'Agent Command', roles: ['surface'], mandate: roster.commanders[0]!.mandate }));
  });
  it('rolls back to an older policy version and resolves publish approvals', async () => {
    const versions = [{ version: 1, role: 'surface' as const, runtime: 'js', createdAt: 1, surfaceHash: SURFACE }, { version: 2, role: 'surface' as const, runtime: 'js', createdAt: 2, surfaceHash: SURFACE }];
    const pending: Roster = { ...roster, commanders: [commander('one', 'DeepSeek', { policy: { activeByRole: { surface: 2 }, versions }, approvals: [{ role: 'surface', approval: { id: 'ap', kind: 'publish', version: 2, status: 'pending' } }] })] };
    const rollback = vi.spyOn(ProfileApi.prototype, 'rollback').mockResolvedValue({ result: { ok: true, version: 1 }, roster: pending });
    const resolve = vi.spyOn(ProfileApi.prototype, 'resolveApproval').mockResolvedValue(pending);
    mount([], pending);
    expect(detail().querySelector('.ver.on')?.textContent).toBe('v2');
    detail().querySelector<HTMLButtonElement>('button.ver')!.click(); await Promise.resolve();
    expect(rollback).toHaveBeenCalledWith('one', 'surface', 1);
    await flush();
    expect(detail().textContent).toContain('Publish policy v2');
    button('Approve', detail()).click(); await Promise.resolve();
    expect(resolve).toHaveBeenCalledWith('one', 'ap', true);
  });
  it('keeps the token fallback in a disclosure, with an inline rotate confirmation', async () => {
    const rotate = vi.spyOn(ProfileApi.prototype, 'rotate').mockResolvedValue(roster); mount([]);
    const box = detail().querySelector<HTMLDetailsElement>('details.cmd-token')!;
    expect(box.querySelector('pre')?.textContent).toBe(harnessSetup('claude-code', { mcpUrl: mcpUrl(), serverName: `${SERVER_NAME}-one`, token: token('one') })!.text);
    box.querySelector<HTMLButtonElement>('[aria-label="Codex"]')!.click();
    expect(detail().querySelector('details.cmd-token pre')?.textContent).toBe(harnessSetup('codex', { mcpUrl: mcpUrl(), serverName: `${SERVER_NAME}-one`, token: token('one') })!.text);
    button('Rotate token', detail()).click(); button('Rotate', detail()).click(); await Promise.resolve();
    expect(rotate).toHaveBeenCalledWith('one');
  });
  it('does not put private roster credentials into DOM attributes or the sign-in setup', () => {
    vi.spyOn(ProfileApi.prototype, 'pairingCode').mockResolvedValue({ code: 'ABC234', expiresAt: Date.now() + 100000 });
    mount([]); tile('claude-code').click();
    expect(screen.el.querySelector('[data-key]')).toBeNull();
    expect(screen.el.querySelector('.harness-setup:not(details)')?.textContent).not.toContain(token('one'));
    for (const element of screen.el.querySelectorAll('*')) for (const attribute of element.attributes) expect(attribute.value).not.toContain(token('one'));
  });
  it('practises every commander on one shared battlefield picker, not per-card map buttons', () => {
    mount([]); expect(screen.el.querySelectorAll('.map-picker')).toHaveLength(1);
    expect(screen.el.querySelector('[data-practice] [aria-label="Practice map"]')).toBeNull();
    screen.el.querySelector<HTMLButtonElement>('.cmd-practice-map [data-map="rivers"]')!.click(); expect(picked).toHaveBeenCalledWith('rivers');
  });
});

describe('policy packages', () => {
  const version = (n: number, surfaceHash = SURFACE) => ({ version: n, role: 'surface' as const, runtime: 'js', createdAt: n, surfaceHash });
  /** DeepSeek on Surface: v1 current, v2 from another game surface, v3 active. */
  const library: Roster = { ...roster, commanders: [commander('one', 'DeepSeek', { kind: 'policy', policy: { activeByRole: { surface: 3 }, versions: [version(1), version(2, 'f'.repeat(64)), version(3)] } })] };
  const fileInput = () => detail().querySelector<HTMLInputElement>('input[type="file"]')!;
  async function choose(text: string): Promise<void> {
    Object.defineProperty(fileInput(), 'files', { value: [new File([text], 'pkg.policy.json', { type: 'application/json' })], configurable: true });
    fileInput().dispatchEvent(new Event('change'));
    for (let i = 0; i < 5; i++) await flush();
  }
  const notice = () => detail().querySelector<HTMLElement>('.cmd-notice');

  it('offers a download per version and marks stale versions instead of offering a rollback', () => {
    mount([], library);
    expect([...detail().querySelectorAll('.ver-dl')].map((el) => el.getAttribute('aria-label'))).toEqual(['Download v3 package', 'Download v2 package', 'Download v1 package']);
    for (const el of detail().querySelectorAll<HTMLElement>('.ver-dl')) { expect(el.querySelector('svg')).not.toBeNull(); expect(el.dataset.tip).toBeTruthy(); }
    const stale = detail().querySelector<HTMLElement>('[data-version="2"] .ver')!;
    expect(stale.tagName).toBe('SPAN'); expect(stale.classList.contains('stale')).toBe(true); expect(stale.dataset.tip).toContain('redeploy');
    expect(detail().querySelector('[data-version="1"] button.ver')).not.toBeNull();
    expect(detail().querySelector('[data-version="3"] .ver.on')).not.toBeNull();
    expect(screen.el.querySelector('[title]')).toBeNull();
  });
  it('saves the server-named package file, and says so when the download fails', async () => {
    const exported = vi.spyOn(ProfileApi.prototype, 'exportPackage').mockResolvedValueOnce({ fileName: 'deepseek-surface-v1.policy.json', blob: new Blob(['{}']) }).mockRejectedValueOnce(new ApiError('not_found'));
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pkg'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    mount([], library);
    detail().querySelector<HTMLButtonElement>('[aria-label="Download v1 package"]')!.click(); await flush();
    expect(exported).toHaveBeenCalledWith('one', 1);
    expect(saved).toEqual(['deepseek-surface-v1.policy.json']);
    detail().querySelector<HTMLButtonElement>('[aria-label="Download v3 package"]')!.click(); await flush();
    expect(screen.el.querySelector('.cmd-error')?.textContent).toBe('Could not download v3.');
  });
  it('imports through a labelled file input and states each outcome in plain words', async () => {
    const imported = vi.spyOn(ProfileApi.prototype, 'importPackage');
    mount([], library);
    expect(fileInput().getAttribute('aria-label')).toBe('Import a policy package into DeepSeek on Surface');
    expect(fileInput().closest('label')?.textContent?.trim()).toBe('Import package');
    expect(fileInput().accept).toBe('.json,application/json');

    imported.mockResolvedValueOnce({ result: { version: 4, stale: false }, roster: library });
    await choose('{"format":"playerthree.policy/1"}');
    expect(imported).toHaveBeenLastCalledWith('one', 'surface', { format: 'playerthree.policy/1' });
    expect(notice()?.className).toBe('cmd-notice ok'); expect(notice()?.textContent).toBe('Imported as v4. Pick v4 to make it active.');

    imported.mockResolvedValueOnce({ result: { version: 5, stale: true }, roster: library });
    await choose('{}');
    expect(notice()?.className).toBe('cmd-notice warn'); expect(notice()?.textContent).toContain('built for a different version of the game');

    for (const [code, words] of [['tampered', 'edited after it was exported'], ['wrong_game', 'different game'], ['wrong_plane', 'not for Surface'], ['rebuild_failed', 'failed its check'], ['not_a_package', 'not a policy package']] as const) {
      imported.mockRejectedValueOnce(new ApiError(code));
      await choose('{}');
      expect(notice()?.className).toBe('cmd-notice error'); expect(notice()?.textContent).toContain(words);
    }
    expect(screen.el.querySelector('.cmd-error')?.textContent).toBe('');

    imported.mockClear();
    await choose('not json');
    expect(imported).not.toHaveBeenCalled();
    expect(notice()?.textContent).toBe('That file is not JSON. Choose a .policy.json file.');
  });
  it('says why an activation failed its test run', async () => {
    vi.spyOn(ProfileApi.prototype, 'rollback').mockResolvedValue({ result: { ok: false, error: 'timeout' }, roster: library });
    mount([], library);
    detail().querySelector<HTMLButtonElement>('[data-version="1"] button.ver')!.click(); await flush(); await flush();
    expect(notice()?.textContent).toBe('v1 failed its test run (it took too long) and was not activated.');
  });
  it('hides the built-in bots section until the server lists packages', async () => {
    mount([]); await flush();
    expect(screen.el.querySelector<HTMLElement>('.cmd-bots')!.hidden).toBe(true);
  });
  it('lists built-in bots per plane with a source link and a package download each', async () => {
    const bot = (level: 'novice' | 'veteran', role: 'surface' | 'orbit', current = true) => ({ level, role, hash: 'c'.repeat(64), bytes: 270_000, runtime: 'js', license: 'AGPL-3.0-only', author: 'Agent Command', current });
    vi.spyOn(ProfileApi.prototype, 'bots').mockResolvedValue({ bots: [bot('novice', 'surface'), bot('veteran', 'surface'), bot('novice', 'orbit', false)] });
    mount([]); await flush();
    const section = screen.el.querySelector<HTMLElement>('.cmd-bots')!;
    expect(section.hidden).toBe(false);
    expect([...section.querySelectorAll('.bot-plane')].map((el) => el.getAttribute('aria-label'))).toEqual(['Orbit bots', 'Surface bots']);
    const source = section.querySelector<HTMLAnchorElement>('[aria-label="View Veteran Surface bot source"]')!;
    expect(source.getAttribute('href')).toBe('/api/bots/veteran/surface/source'); expect(source.target).toBe('_blank');
    const download = section.querySelector<HTMLAnchorElement>('[aria-label="Download Novice Orbit bot package"]')!;
    expect(download.getAttribute('href')).toBe('/api/bots/novice/orbit/package'); expect(download.hasAttribute('download')).toBe(true);
    expect(download.dataset.tip).toBe('Download package · 264 KB · AGPL-3.0-only');
    expect(section.querySelector('[data-bot="novice-orbit"]')?.textContent).toContain('Stale');
    expect(section.querySelector('[data-bot="novice-surface"]')?.textContent).not.toContain('Stale');
  });
});
