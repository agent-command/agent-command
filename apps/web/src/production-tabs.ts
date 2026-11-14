import { PLANES, QUEUE_ITEMS, STATS, UNIT_KINDS, UPGRADES, isUpgrade, upgradeEnabled, type Plane, type QueueItem, type Rules, type View } from '@agent-command/game/contract';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export type ProductionTabId = 'units' | 'structures' | 'research';
/** What a production tab offers: units, structures and research (a segment rebuild is offered on the fallen segment's note). */
export type ProductionItem = Exclude<QueueItem, 'rebuild'>;
export interface ProductionTab {
  id: ProductionTabId;
  label: string;
  items: readonly ProductionItem[];
}
const units = new Set<string>(UNIT_KINDS);
const tabIcons = { units: 'units', structures: 'structures', research: 'research' } satisfies Record<ProductionTabId, IconName>;
const ITEMS = QUEUE_ITEMS.filter((item): item is ProductionItem => item !== 'rebuild');
const tabs = new Map<Plane, readonly ProductionTab[]>(PLANES.map((plane): [Plane, ProductionTab[]] => [plane, ([
  { id: 'units', label: 'Units', items: ITEMS.filter((item) => units.has(item) && !isUpgrade(item) && STATS[item].plane === plane) },
  { id: 'structures', label: 'Structures', items: ITEMS.filter((item) => !units.has(item) && !isUpgrade(item) && STATS[item].plane === plane) },
  { id: 'research', label: 'Research', items: Object.values(UPGRADES).filter((upgrade) => upgrade.at === plane).map((upgrade) => upgrade.id) },
] satisfies ProductionTab[]).filter((tab) => tab.items.length)]));

export const productionTabs = (plane: Plane): readonly ProductionTab[] => tabs.get(plane)!;
/** Match toggles that switch an item off: the card never offers what `queue_add` would refuse as blocked. */
export const productionEnabled = (item: QueueItem, rules: Rules): boolean =>
  isUpgrade(item) ? upgradeEnabled(rules, item) : item === 'gunship' ? rules.sky.gunshipEnabled : item === 'storm_seeder' ? rules.sky.seederEnabled : item === 'mooring_tower' ? rules.surface.mooringEnabled : item === 'island_mortar' || item === 'ore_extractor' ? rules.sky.islandHardpoints > 0 : true;
export const PRODUCTION_TAB_HINT = 'Ctrl+[ / Ctrl+] · previous / next production tab';

/** Match-local memory: visiting another plane or selecting units never resets the last tab. */
export class ProductionTabState {
  private readonly selected = new Map<Plane, ProductionTabId>();

  get(plane: Plane): ProductionTab {
    const choices = productionTabs(plane);
    return choices.find((tab) => tab.id === this.selected.get(plane)) ?? choices[0]!;
  }

  select(plane: Plane, id: ProductionTabId): void {
    if (productionTabs(plane).some((tab) => tab.id === id)) this.selected.set(plane, id);
  }

  step(plane: Plane, direction: -1 | 1): void {
    const choices = productionTabs(plane);
    const index = choices.indexOf(this.get(plane));
    this.select(plane, choices[(index + direction + choices.length) % choices.length]!.id);
  }
}

export function productionTabCount(tab: ProductionTab, view: Pick<View, 'queue' | 'research'>): number {
  const items: readonly QueueItem[] = tab.items;
  let count = 0;
  for (const entry of view.queue) if (items.includes(entry.item)) count++;
  // Views normally include the research queue entry. Do not count that same upgrade twice.
  for (const id of view.research.inProgress) {
    if (tab.items.includes(id) && !view.queue.some((entry) => entry.item === id)) count++;
  }
  return count;
}

export function productionTabDirection(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): -1 | 1 | undefined {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined;
  if (event.code === 'BracketLeft' || event.key === '[') return -1;
  if (event.code === 'BracketRight' || event.key === ']') return 1;
  return undefined;
}

/** Stable tab buttons keep keyboard focus when queue badges change. The caller owns the item panel. */
export class ProductionTabs {
  readonly state = new ProductionTabState();
  readonly el = h('div', { class: 'production-nav' });
  private readonly list = h('div', { class: 'production-tabs', role: 'tablist', 'aria-label': 'Production categories' });
  private plane: Plane | undefined;
  /** How focus entered the tab list; a later game key must not turn pointer focus into tab navigation. */
  private pointerFocus = false;
  private readonly buttons = new Map<ProductionTabId, { button: HTMLElement; badge: HTMLElement }>();
  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    this.el.append(this.list);
    this.list.addEventListener('pointerdown', () => { this.pointerFocus = true; });
    this.list.addEventListener('focusout', (event) => {
      if (!(event.relatedTarget instanceof Node) || !this.list.contains(event.relatedTarget)) this.pointerFocus = false;
    });
    this.list.addEventListener('keydown', (event) => {
      // Mouse-focused tabs leave camera arrows/Home alone; keyboard focus retains tab navigation.
      if (!this.plane || this.pointerFocus) return;
      const choices = productionTabs(this.plane);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') this.state.step(this.plane, event.key === 'ArrowLeft' ? -1 : 1);
      else if (event.key === 'Home' || event.key === 'End') this.state.select(this.plane, choices[event.key === 'Home' ? 0 : choices.length - 1]!.id);
      else return;
      event.preventDefault();
      event.stopPropagation();
      this.changed();
      this.focus();
    });
  }

  update(plane: Plane, view: Pick<View, 'queue' | 'research'>): void {
    if (plane !== this.plane) {
      this.plane = plane;
      this.buttons.clear();
      this.list.replaceChildren(...productionTabs(plane).map((tab) => {
        const badge = h('span', { class: 'production-tab-count' });
        const button = h('button', {
          class: 'btn small production-tab', role: 'tab', id: `production-${plane}-${tab.id}`, 'aria-controls': 'production-items',
          'data-tip': `${tab.label} · ${PRODUCTION_TAB_HINT}`,
          onclick: () => { this.state.select(plane, tab.id); this.changed(); },
        }, icon(tabIcons[tab.id], 16), badge);
        this.buttons.set(tab.id, { button, badge });
        return button;
      }));
    }
    for (const tab of productionTabs(plane)) {
      const { button, badge } = this.buttons.get(tab.id)!;
      const selected = this.state.get(plane).id === tab.id;
      const count = productionTabCount(tab, view);
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-label', `${tab.label}${count ? `, ${count} queued or in progress` : ''}`);
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle('on', selected);
      badge.hidden = count === 0;
      badge.textContent = count ? String(count) : '';
    }
  }

  step(plane: Plane, direction: -1 | 1): void {
    this.pointerFocus = false;
    this.state.step(plane, direction);
    this.changed();
    this.focus();
  }

  private focus(): void {
    if (this.plane) this.buttons.get(this.state.get(this.plane).id)?.button.focus();
  }
}
