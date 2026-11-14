// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayer, clampDock, loadDock, phoneSlot } from '../src/music-player.ts';
import { musicDeck } from '../src/audio/music.ts';
import { audioMix, resetAudioMixCache } from '../src/audio/settings.ts';
import { listener, setAudioScene, uiSoundFor } from '../src/audio/index.ts';

let player: MusicPlayer | undefined;
const btn = (label: RegExp): HTMLButtonElement => [...player!.el.querySelectorAll('button')].find((b) => label.test(b.getAttribute('aria-label') ?? ''))!;
const title = (): string => player!.el.querySelector('.mp-title')!.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  resetAudioMixCache();
  musicDeck.reload();
  setAudioScene('home');
  listener.plane = 'surface';
});
afterEach(() => {
  player?.dispose();
  player = undefined;
});

function mount(): MusicPlayer {
  player = new MusicPlayer();
  player.attach(document.body);
  return player;
}

describe('music player widget', () => {
  it('at home Auto shows Home II, and next moves to Home I and back', () => {
    mount();
    expect(title()).toBe('Home II');
    btn(/^Next track/).click();
    expect(title()).toBe('Home I');
    btn(/^Next track/).click();
    expect(title()).toBe('Home II');
    expect(musicDeck.state.mode).toBe('auto');
  });

  it('the lobby shows War Room I and II', () => {
    mount();
    setAudioScene('lobby');
    player!['renderTitle']();
    expect(title()).toBe('War Room I');
    btn(/^Next track/).click();
    expect(title()).toBe('War Room II');
  });

  it('the Manual list names the home themes Home I and Home II', () => {
    const p = mount();
    btn(/^Track list/).click();
    const home = p.el.querySelector('.mp-list-row')!;
    expect([...home.querySelectorAll('.mp-track')].map((b) => b.textContent)).toEqual(['I', 'II']);
    btn(/^Home II/).click();
    expect(musicDeck.state).toMatchObject({ mode: 'manual', track: 'home2', group: null });
    expect(title()).toBe('Home II');
  });

  it('Auto shows the plane and its variation; next/prev step the plane\'s beds, remembered per plane', () => {
    mount();
    setAudioScene('match');
    player!['renderTitle']();
    expect(title()).toBe('Surface · 1/7');
    btn(/^Next track/).click();
    expect(title()).toBe('Surface · 2/7');
    listener.plane = 'orbit';
    player!['renderTitle']();
    expect(title()).toBe('Orbit · 1/7');
    btn(/^Previous track/).click();
    expect(title()).toBe('Orbit · 7/7');
    expect(musicDeck.state.beds).toMatchObject({ surface: 1, orbit: 6 });
    expect(musicDeck.state.mode).toBe('auto');
  });

  it('Manual list: pick a track to pin it, or a group to play it as a playlist', () => {
    const p = mount();
    btn(/^Track list/).click();
    expect(p.el.querySelector<HTMLElement>('.mp-list')!.hidden).toBe(false);
    expect(p.el.querySelectorAll('.mp-list-row')).toHaveLength(7);
    btn(/^Depths 3/).click();
    expect(musicDeck.state).toMatchObject({ mode: 'manual', track: 'bed_depths_3', group: null });
    expect(title()).toBe('Depths · 3/7');
    expect(btn(/^Depths 3/).hasAttribute('aria-current')).toBe(true);
    btn(/^Play Battle as a playlist/).click();
    expect(musicDeck.state).toMatchObject({ mode: 'manual', track: 'battle_1', group: 'battle' });
    btn(/^Next track/).click();
    expect(musicDeck.state.track).toBe('battle_2');
    btn(/^Music mode/).click();
    expect(musicDeck.state.mode).toBe('auto');
  });

  it('play/pause, mute and volume through the shared deck and mix', () => {
    const p = mount();
    btn(/^Pause music/).click();
    expect(musicDeck.state.paused).toBe(true);
    btn(/^Play music/).click();
    expect(musicDeck.state.paused).toBe(false);
    btn(/^Mute music/).click();
    expect(audioMix().musicMuted).toBe(true);
    const slider = p.el.querySelector<HTMLInputElement>('.mp-volume')!;
    slider.value = '35';
    slider.dispatchEvent(new Event('input'));
    expect(audioMix()).toMatchObject({ music: 0.35, musicMuted: false });
  });

  it('collapses to one icon and remembers it', () => {
    const p = mount();
    btn(/^Collapse music player/).click();
    expect(p.el.classList.contains('collapsed')).toBe(true);
    expect(loadDock().collapsed).toBe(true);
    p.dispose();
    const again = mount();
    expect(again.el.classList.contains('collapsed')).toBe(true);
    // a click (no drag) on the icon opens it again
    const grip = again.el.querySelector<HTMLButtonElement>('.mp-grip')!;
    grip.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 }));
    grip.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: 11, clientY: 10 }));
    expect(again.el.classList.contains('collapsed')).toBe(false);
    expect(loadDock().collapsed).toBe(false);
  });

  it('drags by the grip and remembers the position', () => {
    const p = mount();
    const grip = p.el.querySelector<HTMLButtonElement>('.mp-grip')!;
    grip.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, button: 0, clientX: 100, clientY: 100 }));
    grip.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 160, clientY: 220 }));
    grip.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, button: 0, clientX: 160, clientY: 220 }));
    expect(p.el.classList.contains('placed')).toBe(true);
    const dock = loadDock();
    expect(dock.x).toBeTypeOf('number');
    expect(dock.y).toBeTypeOf('number');
  });

  it('publishes its docked height for the match HUD to reserve, and withdraws it once dragged or removed', () => {
    const root = document.documentElement.style;
    player = new MusicPlayer();
    Object.defineProperty(player.el, 'offsetHeight', { get: () => 68 });
    player.attach(document.body);
    expect(root.getPropertyValue('--music-dock-h')).toBe('68px');
    const grip = player.el.querySelector<HTMLButtonElement>('.mp-grip')!;
    grip.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, button: 0, clientX: 100, clientY: 100 }));
    grip.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 160, clientY: 220 }));
    expect(player.el.classList.contains('placed')).toBe(true);
    expect(root.getPropertyValue('--music-dock-h')).toBe('');
    grip.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, button: 0, clientX: 160, clientY: 220 }));
    // the saved position keeps it out of the dock on the next page
    player.dispose();
    player = mount();
    expect(root.getPropertyValue('--music-dock-h')).toBe('');
    localStorage.clear();
    player.dispose();
    player = mount();
    expect(root.getPropertyValue('--music-dock-h')).not.toBe('');
    player.dispose();
    player = undefined;
    expect(root.getPropertyValue('--music-dock-h')).toBe('');
  });

  it('keeps a dragged player inside the viewport', () => {
    expect(clampDock(-50, -20, 264, 64, 1280, 800)).toEqual({ x: 4, y: 4 });
    expect(clampDock(5000, 5000, 264, 64, 1280, 800)).toEqual({ x: 1012, y: 732 });
    expect(clampDock(300, 200, 264, 64, 1280, 800)).toEqual({ x: 300, y: 200 });
  });

  it('on phones starts collapsed, as a 40 px icon docked away from the interface', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      const p = mount();
      expect(p.el.classList.contains('phone')).toBe(true);
      expect(p.el.classList.contains('collapsed')).toBe(true);
      expect(p.el.classList.contains('placed')).toBe(true); // docked by the free-corner search
    } finally {
      vi.unstubAllGlobals();
    }
    // a desktop pointer keeps the saved (open) state
    expect(mount().el.classList.contains('collapsed')).toBe(false);
  });

  it('the phone dock takes the first free corner, then a free spot up the edges', () => {
    const vw = 390, vh = 844, s = 44;
    expect(phoneSlot(s, s, vw, vh, () => true)).toEqual({ x: 8, y: vh - s - 8 });
    // a bottom bar (y ≥ 700) and a top scoreboard (y ≤ 120) across the width: up the left edge above the bar
    const bars = (_x: number, y: number): boolean => y > 120 && y < 700;
    const slot = phoneSlot(s, s, vw, vh, bars);
    expect(slot.x).toBe(8);
    expect(slot.y + s).toBeLessThan(700);
    expect(slot.y).toBeGreaterThan(600);
    // a covered left half: the bottom-right corner
    expect(phoneSlot(s, s, vw, vh, (x) => x > vw / 2)).toEqual({ x: vw - s - 8, y: vh - s - 8 });
    // nothing free: bottom-left
    expect(phoneSlot(s, s, vw, vh, () => false)).toEqual({ x: 8, y: vh - s - 8 });
  });

  it('binds no keys', () => {
    mount();
    const before = structuredClone(musicDeck.state);
    for (const key of [' ', 'Enter', 'ArrowLeft', 'm', 'p', 'n']) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    expect(musicDeck.state).toEqual(before);
  });
});

describe('interface sounds: select vs confirm vs error', () => {
  const el = (html: string): Element => {
    document.body.innerHTML = html;
    return document.body.querySelector('[data-t]')!;
  };
  it('plain buttons, tabs and menu items select; committing buttons confirm', () => {
    expect(uiSoundFor(el('<button data-t>Lobby</button>'), false)).toBe('select');
    expect(uiSoundFor(el('<div role="tab" data-t>Units</div>'), false)).toBe('select');
    expect(uiSoundFor(el('<button class="btn primary"><svg data-t></svg></button>'), false)).toBe('confirm');
    expect(uiSoundFor(el('<button data-commit data-t>Build</button>'), false)).toBe('confirm');
  });
  it('a click that sent an order stays silent (its acknowledgement plays confirm or error); disabled and non-controls are silent', () => {
    expect(uiSoundFor(el('<button data-t>Tank</button>'), true)).toBeUndefined();
    expect(uiSoundFor(el('<button disabled data-t>Tank</button>'), false)).toBeUndefined();
    expect(uiSoundFor(el('<button aria-disabled="true" data-t>Tank</button>'), false)).toBeUndefined();
    expect(uiSoundFor(el('<canvas data-t></canvas>'), false)).toBeUndefined();
  });
});
