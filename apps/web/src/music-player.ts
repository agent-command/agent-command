/**
 * Floating music player (home and matches): what plays (Auto: "‹plane› Surface · 2/3"), a tiny level meter,
 * play/pause, previous/next, Auto/Manual mode, the grouped Manual track list, music mute and volume. Docked top-right
 * under the HUD's top bar by default, where the match HUD's field column reserves its height (`--music-dock-h`);
 * draggable by its grip and collapsible to one icon, both remembered in this browser. Phones (`isPhone`) start
 * collapsed, docked in a corner that covers no interface, with 40 px tap targets. It only drives the audio engine's music API
 * (audio/index.ts `musicPlayer`) and the shared mix; it binds no keys, so game hotkeys stay intact.
 */
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { tip } from './tooltip.ts';
import { isPhone } from './mobile-banner.ts';
import { musicPlayer } from './audio/index.ts';
import { GROUPS, GROUP_TRACKS, TRACK_NAME, trackPlace, type GroupId, type TrackId } from './audio/music.ts';
import { audioMix, onAudioMix, setAudioMix } from './audio/settings.ts';
import './music-player.css';

const STORAGE_KEY = 'agent-command.music-player';
/** Root custom property: the docked player's height in CSS px (see `publishDock`). */
const DOCK_HEIGHT = '--music-dock-h';
const GROUP_NAME: Readonly<Record<GroupId, string>> = { home: 'Home', lobby: 'Lobby', orbit: 'Orbit', sky: 'Sky', surface: 'Surface', depths: 'Depths', battle: 'Battle' };
const ROMAN = ['I', 'II', 'III', 'IV'] as const;
/** Groups whose tracks show their names (Home I, War Room II) rather than "Orbit · 2/7". */
const NAMED: Readonly<Partial<Record<GroupId, true>>> = { home: true, lobby: true };
const GROUP_ICON: Readonly<Record<GroupId, IconName>> = { home: 'spire', lobby: 'queue', orbit: 'orbit', sky: 'sky', surface: 'surface', depths: 'depths', battle: 'enemy' };
const BARS = 4;
/** Seconds between meter samples (each bar shows one recent sample, so the bars walk). */
const SAMPLE_S = 0.09;
const MARGIN = 4;

export interface PlayerDock {
  /** Top-left in CSS px; absent: docked in the default corner. */
  x?: number;
  y?: number;
  collapsed: boolean;
}

export function loadDock(): PlayerDock {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const d = raw ? JSON.parse(raw) as Partial<PlayerDock> : {};
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    return ok(d.x) && ok(d.y) ? { x: d.x, y: d.y, collapsed: d.collapsed === true } : { collapsed: d.collapsed === true };
  } catch {
    return { collapsed: false };
  }
}

function saveDock(d: PlayerDock): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable: this session only */
  }
}

/** Keep a w×h box at (x, y) inside a vw×vh viewport. */
export function clampDock(x: number, y: number, w: number, hgt: number, vw: number, vh: number): { x: number; y: number } {
  return { x: Math.round(Math.min(Math.max(MARGIN, x), Math.max(MARGIN, vw - w - MARGIN))), y: Math.round(Math.min(Math.max(MARGIN, y), Math.max(MARGIN, vh - hgt - MARGIN))) };
}

/** Inset of the phone dock from the screen edge (CSS px). */
const PHONE_INSET = 8;

/**
 * The phone dock for a w×h icon: the first free spot among the four corners (bottom-left first), then up the left
 * edge and up the right edge in 24 px steps; bottom-left when nothing is free. `free` tests one page point.
 */
export function phoneSlot(w: number, hgt: number, vw: number, vh: number, free: (x: number, y: number) => boolean): { x: number; y: number } {
  const l = PHONE_INSET, r = Math.max(l, vw - w - PHONE_INSET), b = Math.max(l, vh - hgt - PHONE_INSET);
  const clear = (x: number, y: number): boolean =>
    free(x + 2, y + 2) && free(x + w - 2, y + 2) && free(x + 2, y + hgt - 2) && free(x + w - 2, y + hgt - 2) && free(x + w / 2, y + hgt / 2);
  for (const [x, y] of [[l, b], [l, l], [r, b], [r, l]] as const) if (clear(x, y)) return { x, y };
  for (const x of [l, r]) for (let y = b - 24; y > l; y -= 24) if (clear(x, y)) return { x, y };
  return { x: l, y: b };
}

/** Whether a page point shows no interface: only the battlefield canvas, the home backdrop or the page itself. */
function freeAt(px: number, py: number): boolean {
  const hit = document.elementFromPoint(px, py);
  return !hit || hit === document.body || hit === document.documentElement || hit.id === 'app' || hit instanceof HTMLCanvasElement || hit.classList.contains('backdrop-poster');
}

function button(name: IconName, label: string, onclick: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: 'mp-btn', 'aria-label': label, onclick: (e: Event) => (e.stopPropagation(), onclick()) }, icon(name, 15));
}

export class MusicPlayer {
  readonly el: HTMLElement;
  private readonly trackName: HTMLElement;
  private readonly trackIcon: HTMLElement;
  private readonly meter: HTMLCanvasElement;
  private readonly ink: CanvasRenderingContext2D | null;
  private readonly grip: HTMLButtonElement;
  private readonly fold: HTMLButtonElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly modeBtn: HTMLButtonElement;
  private readonly listBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly volume: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly trackBtns = new Map<TrackId, HTMLButtonElement>();
  private readonly groupBtns = new Map<GroupId, HTMLButtonElement>();
  private dock: PlayerDock;
  private readonly phone: boolean;
  private slotQueued = false;
  /** Last rendered track / where / focus / mode, so the per-frame check compares strings without rebuilding. */
  private shown = '';
  private frameId = 0;
  private sampleT = 0;
  private lastT = 0;
  private readonly samples = new Float32Array(BARS);
  private readonly bars = new Float32Array(BARS);
  private head = 0;
  private barColor = '#f5c518';
  private drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | undefined;
  private readonly cleanup: (() => void)[] = [];

  constructor() {
    this.dock = loadDock();
    // phones start collapsed to the icon, docked in a free corner (see `phoneSlot`)
    this.phone = isPhone();
    if (this.phone) this.dock.collapsed = true;
    this.trackIcon = h('span', { class: 'mp-track-icon', 'aria-hidden': 'true' });
    this.trackName = h('span', { class: 'mp-title', 'aria-live': 'polite' });
    this.meter = h('canvas', { class: 'mp-meter', width: 40, height: 28, 'aria-hidden': 'true' });
    this.ink = this.meter.getContext('2d');
    this.grip = h('button', {
      type: 'button', class: 'mp-btn mp-grip', 'aria-label': 'Music player: drag to move',
      onpointerdown: (e: Event) => this.down(e as PointerEvent), onpointermove: (e: Event) => this.move(e as PointerEvent),
      onpointerup: (e: Event) => this.up(e as PointerEvent), onpointercancel: () => (this.drag = undefined),
      onclick: (e: Event) => e.stopPropagation(),
    }, icon('music', 16));
    this.fold = tip(button('fold', 'Collapse music player', () => this.setCollapsed(true)), 'Collapse');
    this.prevBtn = button('music_prev', 'Previous track', () => musicPlayer.prev());
    this.nextBtn = button('music_next', 'Next track', () => musicPlayer.next());
    this.playBtn = button('music_pause', 'Pause music', () => (musicPlayer.paused() ? musicPlayer.play() : musicPlayer.pause()));
    this.modeBtn = button('music_auto', 'Music mode', () => musicPlayer.setMode(musicPlayer.mode() === 'auto' ? 'manual' : 'auto'));
    this.listBtn = button('music_list', 'Track list', () => this.toggleList());
    this.listBtn.setAttribute('aria-expanded', 'false');
    tip(this.listBtn, { title: 'Tracks', description: 'Pick a track to pin it, or a group to play it as a playlist (Manual).' });
    this.muteBtn = button('volume', 'Mute music', () => setAudioMix({ musicMuted: !audioMix().musicMuted }));
    this.volume = h('input', {
      type: 'range', min: '0', max: '100', step: '5', class: 'mp-volume', 'aria-label': 'Music volume',
      oninput: () => setAudioMix({ music: Number(this.volume.value) / 100, musicMuted: false }),
    });
    this.list = h('div', { class: 'mp-list', role: 'group', 'aria-label': 'Tracks', hidden: true }, ...GROUPS.map((g) => this.groupRow(g)));
    this.el = h('section', { class: this.phone ? 'music-player phone' : 'music-player', role: 'region', 'aria-label': 'Music player', onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'mp-row' }, this.grip, this.meter, this.trackIcon, this.trackName, this.listBtn, this.fold),
      h('div', { class: 'mp-row mp-controls' }, this.prevBtn, this.playBtn, this.nextBtn, h('span', { class: 'mp-sep' }), this.modeBtn, h('span', { class: 'mp-sep' }), this.muteBtn, this.volume),
      this.list);
    this.cleanup.push(musicPlayer.onChange(() => (this.render(), this.queueSlot())), onAudioMix(() => this.renderMix()));
    const resize = (): void => this.place();
    addEventListener('resize', resize);
    const visible = (): void => this.animate();
    document.addEventListener('visibilitychange', visible);
    this.cleanup.push(() => removeEventListener('resize', resize), () => document.removeEventListener('visibilitychange', visible));
    this.render();
    this.renderMix();
  }

  /** One group of the Manual list: the group (plays it as a playlist) and its numbered tracks (pin one). */
  private groupRow(group: GroupId): HTMLElement {
    const tracks: readonly TrackId[] = GROUP_TRACKS[group];
    const name = GROUP_NAME[group];
    const all = h('button', { type: 'button', class: 'mp-btn mp-group', 'aria-label': tracks.length > 1 ? `Play ${name} as a playlist` : `Play ${name}`, onclick: (e: Event) => (e.stopPropagation(), musicPlayer.playGroup(group)) }, icon(GROUP_ICON[group], 14), h('span', {}, name));
    tip(all, { title: name, description: tracks.length > 1 ? 'Play this group in turn (Manual).' : 'Play this track (Manual).' });
    this.groupBtns.set(group, all);
    const items = tracks.length > 1 ? tracks.map((t, i) => {
      // the home and lobby tracks are named (Home I, War Room II); beds and battle tracks are numbered
      const mark = NAMED[group] ? ROMAN[i]! : String(i + 1);
      const b = h('button', { type: 'button', class: 'mp-btn mp-track', 'aria-label': `${name} ${mark}: ${TRACK_NAME[t]}`, onclick: (e: Event) => (e.stopPropagation(), musicPlayer.pin(t)) }, mark);
      tip(b, { title: TRACK_NAME[t], description: 'Pin this track (Manual).' });
      this.trackBtns.set(t, b);
      return b;
    }) : [];
    if (tracks.length === 1) this.trackBtns.set(tracks[0]!, all);
    return h('div', { class: 'mp-list-row' }, all, ...items);
  }

  private toggleList(open = this.list.hidden): void {
    this.list.hidden = !open;
    this.listBtn.setAttribute('aria-expanded', String(open));
    this.listBtn.setAttribute('aria-pressed', String(open));
    this.place();
  }

  /** Add to the page and apply the saved dock (position needs layout). */
  attach(parent: HTMLElement): void {
    parent.append(this.el);
    // collapsing, the track list and phone wrapping change the docked height; layouts under the dock follow it
    const sizes = new ResizeObserver(() => this.publishDock());
    sizes.observe(this.el);
    this.cleanup.push(() => {
      sizes.disconnect();
      document.documentElement.style.removeProperty(DOCK_HEIGHT);
    });
    this.applyDock();
    if (this.phone) {
      // screens come and go (Home, a match HUD, the observer): find a free corner again when they do
      const watch = new MutationObserver(() => this.queueSlot());
      watch.observe(parent, { childList: true });
      const app = document.getElementById('app');
      if (app && app !== parent) watch.observe(app, { childList: true });
      this.cleanup.push(() => watch.disconnect());
    }
  }

  /** Phones: re-dock on the next frame and once more after the new screen has settled (fonts, panels). */
  private queueSlot(): void {
    if (!this.phone || this.slotQueued || this.dock.x !== undefined) return;
    this.slotQueued = true;
    requestAnimationFrame(() => {
      this.slotQueued = false;
      this.place();
      setTimeout(() => this.place(), 600);
    });
  }

  // ---------------------------------------------------------------- state → DOM

  private render(): void {
    const paused = musicPlayer.paused();
    const auto = musicPlayer.mode() === 'auto';
    this.playBtn.replaceChildren(icon(paused ? 'music_play' : 'music_pause', 15));
    this.playBtn.setAttribute('aria-label', paused ? 'Play music' : 'Pause music');
    tip(this.playBtn, paused ? 'Play' : 'Pause');
    this.modeBtn.replaceChildren(icon(auto ? 'music_auto' : 'music_manual', 15));
    this.modeBtn.setAttribute('aria-pressed', String(!auto));
    tip(this.modeBtn, { title: auto ? 'Auto' : 'Manual', description: auto ? 'Follows the plane you watch, with the battle layer near fights. Click for Manual.' : 'Plays the picked track or group; plane switches and battles don\'t change it. Click for Auto.' });
    const step = auto ? 'Auto: the current plane\'s next bed variation (remembered per plane).' : 'Manual: the next track in the playing group, or in the whole list.';
    tip(this.prevBtn, { title: 'Previous', description: step.replace('next', 'previous') });
    tip(this.nextBtn, { title: 'Next', description: step });
    this.el.classList.toggle('paused', paused);
    const group = musicPlayer.group();
    for (const [g, b] of this.groupBtns) b.setAttribute('aria-pressed', String(!auto && group === g && GROUP_TRACKS[g].length > 1));
    this.shown = '';
    this.renderTitle();
  }

  /** Auto shows the plane (or Battle) with "n/3"; Manual the pinned track or playing group. Cheap when unchanged. */
  private renderTitle(): void {
    const now = musicPlayer.current();
    const key = `${now}|${musicPlayer.mode()}|${musicPlayer.group()}|${musicPlayer.paused()}`;
    if (key === this.shown) return;
    this.shown = key;
    const place = now ? trackPlace(now) : undefined;
    const label = !now || !place ? '—' : NAMED[place.group] ? TRACK_NAME[now] : place.of > 1 ? `${GROUP_NAME[place.group]} · ${place.n}/${place.of}` : GROUP_NAME[place.group];
    this.trackIcon.replaceChildren(icon(place ? GROUP_ICON[place.group] : 'music', 14));
    this.trackName.textContent = label;
    const auto = musicPlayer.mode() === 'auto';
    const group = musicPlayer.group();
    const status = musicPlayer.paused() ? 'Paused' : auto ? 'Auto' : group && GROUP_TRACKS[group].length > 1 ? `Manual · ${GROUP_NAME[group]} playlist` : 'Manual · pinned';
    tip(this.trackName, { title: now ? TRACK_NAME[now] : 'No music here', status });
    tip(this.grip, { title: now ? TRACK_NAME[now] : 'Music', description: this.dock.collapsed ? 'Click to open the music player; drag to move.' : 'Drag to move.' });
    for (const [t, b] of this.trackBtns) {
      if (t === now) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  }

  private renderMix(): void {
    const mix = audioMix();
    const muted = mix.musicMuted;
    const pct = Math.round(mix.music * 100);
    if (this.volume.value !== String(pct)) this.volume.value = String(pct);
    this.muteBtn.replaceChildren(icon(muted ? 'muted' : 'volume', 15));
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music');
    tip(this.muteBtn, muted ? 'Unmute music' : 'Mute music');
    tip(this.volume, { title: 'Music volume', status: muted ? 'Muted' : `${pct}%` });
    this.el.classList.toggle('muted', muted);
  }

  // ---------------------------------------------------------------- dock, collapse, drag

  private setCollapsed(collapsed: boolean): void {
    this.dock.collapsed = collapsed;
    saveDock(this.dock);
    this.applyDock();
    (collapsed ? this.grip : this.fold).focus();
  }

  private applyDock(): void {
    this.el.classList.toggle('collapsed', this.dock.collapsed);
    this.grip.setAttribute('aria-expanded', String(!this.dock.collapsed));
    this.grip.setAttribute('aria-label', this.dock.collapsed ? 'Open music player (drag to move)' : 'Music player: drag to move');
    this.shown = '';
    this.renderTitle();
    this.place();
    this.animate();
  }

  /** Apply the saved position, clamped to the viewport (absent: CSS default corner; phones: a free corner). */
  private place(): void {
    this.position();
    this.publishDock();
  }

  /**
   * `--music-dock-h` on the root: the player's height while it sits in its default dock, so layouts under the dock
   * (the match HUD's field column) reserve that space; unset while dragged away (`.placed`) or hidden (loading).
   */
  private publishDock(): void {
    const root = document.documentElement.style;
    if (this.el.isConnected && !this.el.classList.contains('placed') && this.el.getClientRects().length) root.setProperty(DOCK_HEIGHT, `${this.el.offsetHeight}px`);
    else root.removeProperty(DOCK_HEIGHT);
  }

  private position(): void {
    const { x, y } = this.dock;
    if ((x === undefined || y === undefined) && this.phone && this.el.isConnected) {
      this.placePhone();
      return;
    }
    if (x === undefined || y === undefined) {
      this.el.style.left = this.el.style.top = '';
      this.el.classList.remove('placed');
      return;
    }
    const r = this.el.getBoundingClientRect();
    const c = clampDock(x, y, r.width, r.height, innerWidth, innerHeight);
    this.el.classList.add('placed');
    this.el.style.left = `${c.x}px`;
    this.el.style.top = `${c.y}px`;
  }

  /**
   * Phones: dock the icon in the first corner (then the first spot up the left, then the right edge) where it covers
   * no interface: only the battlefield canvas, the backdrop or the page itself shows through there. The open player
   * grows from that spot into the screen.
   */
  private placePhone(): void {
    const vw = innerWidth, vh = innerHeight;
    const was = this.dock.collapsed;
    this.el.classList.add('collapsed');
    const icon = this.el.getBoundingClientRect();
    this.el.classList.toggle('collapsed', was);
    // hidden for the hit tests, so they see what lies under the player
    const visibility = this.el.style.visibility;
    this.el.style.visibility = 'hidden';
    const slot = phoneSlot(icon.width, icon.height, vw, vh, freeAt);
    this.el.style.visibility = visibility;
    this.el.classList.add('placed');
    if (was) {
      this.el.style.left = `${slot.x}px`;
      this.el.style.top = `${slot.y}px`;
      return;
    }
    const r = this.el.getBoundingClientRect();
    const left = slot.x + icon.width / 2 < vw / 2;
    const low = slot.y + icon.height / 2 > vh / 2;
    const c = clampDock(left ? slot.x : slot.x + icon.width - r.width, low ? slot.y + icon.height - r.height : slot.y, r.width, r.height, vw, vh);
    this.el.style.left = `${c.x}px`;
    this.el.style.top = `${c.y}px`;
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const r = this.el.getBoundingClientRect();
    this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    this.grip.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && dx * dx + dy * dy < 16) return;
    d.moved = true;
    this.dock.x = d.ox + dx;
    this.dock.y = d.oy + dy;
    this.place();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = undefined;
    if (d.moved) {
      const r = this.el.getBoundingClientRect();
      this.dock.x = r.left;
      this.dock.y = r.top;
      saveDock(this.dock);
    } else if (this.dock.collapsed) this.setCollapsed(false);
  }

  // ---------------------------------------------------------------- meter (allocation-free per frame)

  private animate(): void {
    const run = !this.dock.collapsed && !document.hidden && this.el.isConnected;
    if (run && !this.frameId) {
      this.barColor = getComputedStyle(this.el).getPropertyValue('--mp-bar').trim() || this.barColor;
      this.lastT = performance.now();
      this.frameId = requestAnimationFrame(this.tick);
    } else if (!run && this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
  }

  private readonly tick = (t: number): void => {
    this.frameId = 0;
    if (this.dock.collapsed || document.hidden || !this.el.isConnected) return;
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;
    this.sampleT += dt;
    if (this.sampleT >= SAMPLE_S) {
      this.sampleT = 0;
      this.head = (this.head + 1) % BARS;
      this.samples[this.head] = musicPlayer.level();
    }
    this.draw(dt);
    this.renderTitle();
    this.frameId = requestAnimationFrame(this.tick);
  };

  private draw(dt: number): void {
    const g = this.ink;
    if (!g) return;
    const w = this.meter.width, hgt = this.meter.height;
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = this.barColor;
    const bw = w / BARS;
    for (let i = 0; i < BARS; i++) {
      const target = this.samples[(this.head + 1 + i) % BARS]!;
      const b = this.bars[i]! + (target - this.bars[i]!) * Math.min(1, dt * 14);
      this.bars[i] = b;
      const bh = Math.max(2, b * hgt);
      g.fillRect(i * bw + 2, hgt - bh, bw - 4, bh);
    }
  }

  dispose(): void {
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    for (const c of this.cleanup) c();
    this.el.remove();
  }
}

let mounted: MusicPlayer | undefined;

/** The one floating player of this page (home and matches share it). */
export function mountMusicPlayer(parent: HTMLElement = document.body): MusicPlayer {
  if (!mounted) {
    mounted = new MusicPlayer();
    mounted.attach(parent);
  }
  return mounted;
}
