/**
 * The battlefield picker shared by every match-entry screen: map cards with a layout thumbnail, an S/M/L size switch
 * and the public seed (re-roll, copy link). Built once and kept in sync with TerrainChoice, so typing a seed never
 * loses focus while the backdrop re-previews live.
 */
import { MAP_SIZES, SURFACE, type MatchOptions } from '@agent-command/game/contract';
import { MAPS, type LobbyMapDescriptor } from '@agent-command/game/lobby';
import { copyText, h } from './dom.ts';
import { icon } from './icons.ts';
import { thumbnailMaps } from './preview-client.ts';
import type { PreviewMap } from './preview-map.ts';
import { tip } from './tooltip.ts';
import { mapChoiceUrl, type TerrainChoice } from './terrain-choice.ts';
import './map-picker.css';

/** Size classes in MAP_SIZES order (small, medium, large). */
const SIZE_LABEL = Object.fromEntries(MAP_SIZES.map((size, i) => [size, 'SML'[i]!])) as Record<number, string>;
/** Recipe thumbnails of generated maps use one fixed seed: a stable silhouette of the layout style. */
const THUMB_SEED = 1;
/** Surface palette (SURFACE codes), dark-theme map ink. */
const THUMB_RGB: Record<number, [number, number, number]> = {
  [SURFACE.ground]: [74, 52, 30], [SURFACE.cliff]: [24, 14, 8], [SURFACE.forest]: [52, 86, 40], [SURFACE.high]: [128, 96, 58],
  [SURFACE.ford]: [70, 120, 130], [SURFACE.fault]: [170, 60, 34], [SURFACE.water]: [36, 78, 120],
  [SURFACE.highForest]: [82, 108, 50], [SURFACE.highFord]: [100, 142, 140], [SURFACE.highFault]: [198, 96, 48], [SURFACE.highWater]: [58, 100, 142],
};

const generated = (map: LobbyMapDescriptor): boolean => map.tags.includes('generated');
const sizeName = (size: number): string => `${SIZE_LABEL[size] ?? ''} ${size} × ${size}`.trim();

/** Paints a preview map at one pixel per tile (cards and the room's live battlefield preview). */
export function paintMap(canvas: HTMLCanvasElement, map: PreviewMap): void {
  canvas.width = map.size;
  canvas.height = map.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(map.size, map.size);
  for (let c = 0; c < map.terrain.length; c++) {
    const [r, g, b] = THUMB_RGB[map.terrain[c]!] ?? THUMB_RGB[SURFACE.ground]!;
    image.data.set([r, g, b, 255], c * 4);
  }
  for (const l of map.lodes) image.data.set(l.rich ? [255, 214, 64, 255] : [230, 170, 60, 255], (l.y * map.size + l.x) * 4);
  ctx.putImageData(image, 0, 0);
}

export class MapPicker {
  readonly el: HTMLElement;
  private readonly terrain: TerrainChoice;
  /** Which catalogue maps get a card (Create Game: every playable map; commander practice: duel maps). */
  private readonly offered: (map: LobbyMapDescriptor) => boolean;
  private readonly cards = new Map<string, { button: HTMLButtonElement; canvas: HTMLCanvasElement; key: string }>();
  private readonly sizes = new Map<number, HTMLButtonElement>();
  private readonly seedBox: HTMLElement;
  private readonly seed: HTMLInputElement;
  private readonly cardGrid: HTMLElement;
  private seedTimer = 0;
  private readonly unsubscribe: () => void;

  constructor(terrain: TerrainChoice, offered: (map: LobbyMapDescriptor) => boolean) {
    this.terrain = terrain;
    this.offered = offered;
    this.cardGrid = h('div', { class: 'mp-cards', role: 'radiogroup', 'aria-label': 'Map' });
    const sizeCtl = h('div', { class: 'seg-ctl mp-size', role: 'radiogroup', 'aria-label': 'Map size' },
      ...MAP_SIZES.map((size) => {
        const button = h('button', { type: 'button', role: 'radio', 'data-size': size, onclick: () => this.pickSize(size) },
          h('b', {}, SIZE_LABEL[size] ?? ''), h('span', {}, String(size)));
        this.sizes.set(size, button);
        return button;
      }));
    this.seed = h('input', {
      class: 'mp-seed-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 10, autocomplete: 'off', spellcheck: false,
      'aria-label': 'Public map seed',
      oninput: () => this.seedTyped(),
      onchange: () => this.seedCommit(),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === 'Enter') this.seedCommit(); },
    });
    tip(this.seed, 'Public map seed: the same seed and size always generate the same map');
    const dice = tip(h('button', { class: 'mp-icon', type: 'button', 'aria-label': 'Re-roll seed', onclick: () => this.terrain.setSeed(crypto.getRandomValues(new Uint32Array(1))[0]!) }, icon('dice', 16)),
      'Re-roll: a new random map of this style');
    this.seedBox = h('div', { class: 'mp-seed' }, h('span', { class: 'mp-seed-label', 'aria-hidden': 'true' }, '#'), this.seed, dice);
    const copy = tip(h('button', { class: 'mp-icon', type: 'button', 'aria-label': 'Copy map link', onclick: () => void this.copyLink(copy) }, icon('copy', 16)),
      'Copy map link: map, seed and size only, no match credentials');
    this.el = h('div', { class: 'map-picker' },
      this.cardGrid,
      h('div', { class: 'mp-row' }, sizeCtl, this.seedBox, copy));
    this.buildCards();
    this.sync();
    this.unsubscribe = terrain.onChange(() => this.sync());
  }

  dispose(): void {
    clearTimeout(this.seedTimer);
    this.unsubscribe();
  }

  private buildCards(): void {
    const maps = MAPS.filter(this.offered);
    this.cardGrid.replaceChildren(...maps.map((map) => {
      const canvas = h('canvas', { class: 'mp-thumb', width: 1, height: 1, 'aria-hidden': 'true' });
      const button = h('button', { class: 'mp-card', type: 'button', role: 'radio', 'data-map': map.id, onclick: () => { this.terrain.set(map.id); button.focus(); } },
        canvas,
        h('span', { class: 'mp-text' },
          h('b', {}, map.label),
          h('span', { class: 'mp-identity' }, map.identity)),
        h('span', { class: 'mp-badges', 'aria-hidden': 'true' },
          ...(generated(map) ? [icon('dice', 12)] : []),
          ...MAP_SIZES.map((size) => h('i', { class: map.sizes.includes(size) ? '' : 'off' }, SIZE_LABEL[size] ?? ''))));
      tip(button, `${map.label}: ${map.identity}`);
      this.cards.set(map.id, { button, canvas, key: '' });
      return button;
    }));
  }

  /**
   * A card's thumbnail: the map's own layout (classic) or its recipe at one fixed seed. It never depends on the
   * selection, so choosing a card only changes its frame, never its picture (the backdrop shows the live choice).
   */
  private thumbOptions(map: LobbyMapDescriptor): MatchOptions {
    return generated(map)
      ? { terrain: map.terrain, map: { seed: THUMB_SEED, params: { size: map.size } } }
      : { terrain: map.terrain, map: { name: map.id } };
  }

  private sync(): void {
    const choice = this.terrain.getMap();
    const selected = MAPS.find((map) => map.id === choice.mapId);
    if (this.cards.size !== MAPS.filter(this.offered).length) this.buildCards();
    for (const map of MAPS) {
      const card = this.cards.get(map.id);
      if (!card) continue;
      const on = map.id === choice.mapId;
      card.button.classList.toggle('on', on);
      card.button.setAttribute('aria-checked', String(on));
      card.button.tabIndex = on || (!selected && map === MAPS[0]) ? 0 : -1;
      const options = this.thumbOptions(map);
      const key = JSON.stringify(options);
      if (card.key === key) continue;
      card.key = key;
      thumbnailMaps.get(options).then((preview) => { if (card.key === key) paintMap(card.canvas, preview); }, () => { /* unavailable saved map: no thumbnail */ });
    }
    for (const [size, button] of this.sizes) {
      const supported = !!selected?.sizes.includes(size);
      const on = size === choice.size;
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
      button.setAttribute('aria-disabled', String(!supported));
      tip(button, supported ? `${sizeName(size)} tiles`
        : `${selected?.label ?? 'This map'} is authored at ${selected?.sizes.map(sizeName).join(', ') ?? 'another size'} only`);
    }
    const seeded = !!selected && generated(selected);
    this.seedBox.hidden = !seeded;
    if (document.activeElement !== this.seed) this.seed.value = String(choice.mapSeed);
  }

  private pickSize(size: number): void {
    const selected = MAPS.find((map) => map.id === this.terrain.getMap().mapId);
    if (selected?.sizes.includes(size)) this.terrain.setSize(size);
  }

  /** Live preview while typing: a valid seed applies after a short pause. */
  private seedTyped(): void {
    this.seed.value = this.seed.value.replace(/\D/g, '');
    clearTimeout(this.seedTimer);
    this.seedTimer = window.setTimeout(() => this.seedCommit(), 300);
  }

  private seedCommit(): void {
    clearTimeout(this.seedTimer);
    const seed = Number(this.seed.value);
    if (this.seed.value !== '' && Number.isSafeInteger(seed) && seed <= 0xffffffff) this.terrain.setSeed(seed);
    else this.seed.value = String(this.terrain.getMap().mapSeed);
  }

  private async copyLink(button: HTMLButtonElement): Promise<void> {
    const ok = await copyText(mapChoiceUrl(this.terrain.getMap()));
    button.classList.toggle('copied', ok);
    button.replaceChildren(icon(ok ? 'check' : 'copy', 16));
    setTimeout(() => { button.classList.remove('copied'); button.replaceChildren(icon('copy', 16)); }, 1400);
  }
}
