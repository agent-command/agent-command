// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchOptions } from '@agent-command/game/contract';
import { MAPS } from '@agent-command/game/lobby';
import { CommandersScreen } from '../src/commanders.ts';
import { duelMap, type TerrainChoice } from '../src/terrain-choice.ts';
import { ProfileApi, type Roster, type RosterCommander } from '../src/profile.ts';

const profile = { id: 'a'.repeat(16), secret: 'b'.repeat(43) };
let screen: CommandersScreen | undefined;
afterEach(() => { screen?.dispose(); screen = undefined; localStorage.clear(); vi.restoreAllMocks(); });
// Map-card thumbnails generate in a worker; these tests only need the cards themselves.
vi.mock('../src/preview-client.ts', () => ({ thumbnailMaps: { get: () => new Promise(() => {}) } }));

function panel(mapId: string, active: number | null = 1, skyActive: number | null = active === null ? null : active + 1) {
  localStorage.setItem('agent-command.profile', JSON.stringify(profile));
  const options: MatchOptions = { map: { name: mapId } };
  const terrain = { getMap: () => ({ mapId, mapSeed: 0, size: 48 }), options: () => options, set: vi.fn(), setSeed: vi.fn(), setSize: vi.fn(), onChange: () => () => {} };
  const commander: RosterCommander = {
    id: 'deepseek', name: 'DeepSeek', kind: 'policy', roles: ['surface', 'sky'], isolation: { independentSessions: true }, token: 'private-token', scopes: [],
    mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } },
    policy: { activeByRole: { surface: active, sky: skyActive }, versions: [] }, approvals: [], connected: false, lastSeenAt: null, seated: null, practicing: false, lastPractice: null,
  };
  const roster: Roster = { id: profile.id, surfaceHash: 'a'.repeat(64), commanders: [commander], chat: [] };
  const practice = vi.spyOn(ProfileApi.prototype, 'practice').mockResolvedValue(roster);
  screen = new CommandersScreen(ProfileApi.stored()!, roster, vi.fn(), terrain as unknown as TerrainChoice);
  return { el: screen.el.querySelector<HTMLElement>('[data-practice="deepseek"]')!, picker: screen.el.querySelector<HTMLElement>('.cmd-practice-map')!, terrain, practice, options };
}

describe('named commander practice map selection', () => {
  it('selects authored map identity rather than its shared terrain recipe', () => {
    const h = panel('crossfire');
    const buttons = [...h.picker.querySelectorAll<HTMLButtonElement>('[aria-label="Map"] [data-map]')];
    expect(buttons.map((button) => button.dataset.map)).toEqual(MAPS.filter(duelMap).map((map) => map.id));
    expect(buttons.filter((button) => button.getAttribute('aria-checked') === 'true').map((button) => button.dataset.map)).toEqual(['crossfire']);
    const twin = buttons.find((button) => button.dataset.map === 'twin_fords')!;
    expect(twin.getAttribute('data-tip')).toContain(MAPS.find((map) => map.id === 'twin_fords')!.identity);
    twin.click();
    expect(h.terrain.set).toHaveBeenCalledExactlyOnceWith('twin_fords');
    expect(buttons.some((button) => button.dataset.map === 'four_corners')).toBe(false);
  });

  it('submits the commander ID, chosen compatible plane and full selected map options', async () => {
    const h = panel('crossfire');
    [...screen!.el.querySelectorAll<HTMLButtonElement>('[aria-label="DeepSeek plane"] button')].find((button) => button.textContent === 'Sky')!.click();
    screen!.el.querySelector<HTMLButtonElement>('[data-practice="deepseek"] button.primary')!.click();
    await vi.waitFor(() => expect(h.practice).toHaveBeenCalledExactlyOnceWith('deepseek', 'sky', 'standard', h.options));
  });

  it('requires an active policy before practicing', () => {
    const h = panel('crossfire', null);
    expect(h.el.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('does not practice another plane’s active policy when the selected plane has none', () => {
    const h = panel('crossfire', 1, null);
    expect(h.el.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(false);
    [...screen!.el.querySelectorAll<HTMLButtonElement>('[aria-label="DeepSeek plane"] button')].find((button) => button.textContent === 'Sky')!.click();
    expect(screen!.el.querySelector<HTMLButtonElement>('[data-practice="deepseek"] button.primary')!.disabled).toBe(true);
    expect(h.practice).not.toHaveBeenCalled();
  });
});
