/**
 * Player settings gear (HUD top bar and lobby footer): a small popover with the "WASD camera" switch, "Dive effects"
 * and the audio mix. WASD is off by default: arrows and screen edges pan, A/S/D are attack-move/stop/deorbit. On:
 * W A S D pan too and those three commands move to Z/X/V (keymap.ts). Dive effects (on by default): the inked plane
 * transition (world/dive.ts); off keeps the plain camera dive, and reduced motion always crossfades. Audio: mute plus
 * master, music and effects volumes (audio/settings.ts). Stored in this browser.
 */
import { h } from './dom.ts';
import { keyLabel, keyLayout, onKeyLayout, setKeyLayout } from './keymap.ts';
import { icon, type IconName } from './icons.ts';
import { diveEffects, onDiveEffects, reducedMotion, setDiveEffects } from './motion.ts';
import { tip } from './tooltip.ts';
import { AUDIO_CHANNELS, audioMix, onAudioMix, setAudioMix, type AudioChannel } from './audio/settings.ts';

const CHANNEL: Record<AudioChannel, { label: string; icon: IconName; description: string }> = {
  master: { label: 'Master', icon: 'volume', description: 'Overall game volume.' },
  music: { label: 'Music', icon: 'music', description: 'Home theme, plane beds and the battle layer (more in the music player).' },
  sfx: { label: 'Effects', icon: 'sfx', description: 'Weapons, explosions, alerts, close-zoom activity, weather and interface sounds. Other planes sound muffled.' },
};

let nextSettingsId = 0;

export class SettingsMenu {
  readonly el: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly box: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly dive: HTMLInputElement;
  private readonly mute: HTMLInputElement;
  private readonly sliders = {} as Record<AudioChannel, HTMLInputElement>;
  private readonly cleanup: (() => void)[] = [];

  constructor(opts: { up?: boolean } = {}) {
    const id = `settings-${++nextSettingsId}`;
    this.box = h('input', { type: 'checkbox', onchange: () => setKeyLayout(this.box.checked ? 'wasd' : 'classic') });
    this.note = h('span', { class: 'small muted' }, icon('keyboard', 14), ' Keys');
    this.dive = h('input', { type: 'checkbox', onchange: () => setDiveEffects(this.dive.checked) });
    this.mute = h('input', { type: 'checkbox', onchange: () => setAudioMix({ muted: this.mute.checked }) });
    tip(this.mute, { title: 'Mute', description: 'Silence all game audio. Audio starts after your first click or key press.' });
    const rows = AUDIO_CHANNELS.map((c) => {
      const spec = CHANNEL[c];
      const slider = h('input', {
        type: 'range', min: '0', max: '100', step: '5', class: 'settings-slider', 'aria-label': `${spec.label} volume`,
        oninput: () => setAudioMix({ [c]: Number(slider.value) / 100 }),
      });
      this.sliders[c] = slider;
      return h('label', { class: 'settings-row settings-volume' }, icon(spec.icon, 14), h('span', {}, spec.label), slider);
    });
    this.pop = h('div', { id, class: `settings-pop${opts.up ? ' up' : ''}`, role: 'dialog', 'aria-label': 'Settings', hidden: true },
      h('b', { class: 'stamp' }, icon('settings', 16), ' Settings'), h('label', { class: 'settings-row' }, this.box, 'WASD camera'), this.note,
      h('label', { class: 'settings-row' }, this.dive, icon('overview', 14), 'Dive effects'),
      h('b', { class: 'stamp settings-audio' }, icon('volume', 16), ' Audio'), h('label', { class: 'settings-row' }, this.mute, icon('muted', 14), 'Mute'), ...rows);
    this.button = h('button', { class: 'btn ghost settings-btn', 'data-tip': 'Settings', 'aria-label': 'Settings', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': id, onclick: (e: Event) => (e.stopPropagation(), this.toggle()) }, icon('settings'));
    this.el = h('div', {
      class: 'settings',
      onclick: (e: Event) => e.stopPropagation(),
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key !== 'Escape' || this.pop.hidden) return;
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
      },
      onfocusout: (e: Event) => {
        if (!this.el.contains((e as FocusEvent).relatedTarget as Node | null)) this.close();
      },
    }, this.button, this.pop);
    const outside = () => this.close();
    window.addEventListener('click', outside);
    this.cleanup.push(() => window.removeEventListener('click', outside), onKeyLayout(() => this.render()), onDiveEffects(() => this.render()), onAudioMix(() => this.renderAudio()));
    this.renderAudio();
    this.render();
  }

  private toggle(): void {
    if (!this.pop.hidden) {
      this.close(true);
      return;
    }
    this.pop.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.box.focus();
  }

  private close(restoreFocus = false): void {
    this.pop.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.button.focus();
  }

  private render(): void {
    const wasd = keyLayout() === 'wasd';
    this.box.checked = wasd;
    const keys = wasd
      ? `W A S D and arrows pan · ${keyLabel('amove')} attack-move · ${keyLabel('stop')} stop · ${keyLabel('deorbit')} deorbit`
      : `Arrows and screen edges pan · ${keyLabel('amove')} attack-move · ${keyLabel('stop')} stop · ${keyLabel('deorbit')} deorbit`;
    tip(this.note, { title: 'Keyboard controls', description: keys });
    tip(this.box, { title: 'WASD camera', description: keys, status: wasd ? 'On' : 'Off' });
    const ink = diveEffects();
    this.dive.checked = ink;
    tip(this.dive, {
      title: 'Dive effects',
      description: reducedMotion()
        ? 'Speed lines, smear and a plane-colour wash when you change plane. Your system asks for reduced motion, so planes crossfade instead.'
        : 'Speed lines, smear and a plane-colour wash when you change plane. Off: the plain camera dive.',
      status: ink ? 'On' : 'Off',
    });
  }

  private renderAudio(): void {
    const mix = audioMix();
    this.mute.checked = mix.muted;
    for (const c of AUDIO_CHANNELS) {
      const pct = Math.round(mix[c] * 100);
      const slider = this.sliders[c];
      if (slider.value !== String(pct)) slider.value = String(pct);
      tip(slider, { title: `${CHANNEL[c].label} volume`, description: CHANNEL[c].description, status: mix.muted ? 'Muted' : `${pct}%` });
    }
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.el.remove();
  }
}
