/**
 * Selection, camera/navigation and the DOM event boundary for plane tools.
 * tools/ owns order applicability, pointer gestures, previews and intents; catalog.ts owns labels,
 * hints and shortcuts. Text-entry controls own their keys; buttons retain native Space/Enter activation.
 */
import { PLANES, UNIT_KINDS, footprint, type ArmyId, type Entity, type Kind, type Plane, type Rules, type View } from '@agent-command/game/contract';
import { matchArmy } from './armies.ts';
import { isTextEntry, targetElement } from './dom.ts';
import { audioUi } from './audio/index.ts';
import { pointTip, type TipContent } from './tooltip.ts';
import { digCount } from './designate.ts';
import { commandFor, keyLabel, keyLayout, onKeyLayout, panFor, type KeyCommand } from './keymap.ts';
import type { Overlay } from './overlay.ts';
import { KIND_LABEL, NEED_LABEL, PLANE_NAME, RADIUS_TIP, depthsCellTip, signalTo } from './text.ts';
import { requestNeeds, requestTarget, signalsOn } from './signals.ts';
import { postTip } from './post-tip.ts';
import { islandTip, weatherTip } from './sky-panel.ts';
import { CURSOR, scrollCursor, type CanvasCursor } from './cursors.ts';
import { eligible, getTool, isFighter as armed, resolvePointer, round2, ToolSession, toolForCommand, unitIds, type Armed, type OrbitFormation, type ToolContext, type ToolPointer, type ToolSelection } from './tools/index.ts';
import { CARD_SLOTS, type ToolId } from './tools/catalog.ts';
import type { CardAction } from './command-card.ts';
import { contactFireCount } from './tools/contacts.ts';
import { resolveSmartAction, type SmartAction } from './tools/smart.ts';
import type { Track } from './world/entities.ts';
import type { World } from './world/world.ts';
import { ruleTables } from './unit-stats.ts';
import { weatherUnder, type WeatherKind } from './world/weather.ts';
import { TouchGesture } from './touch-camera.ts';

export type Intent = { kind: string } & Record<string, unknown>;

export interface ControlHost {
  view(): View | undefined;
  act(role: Plane, intents: Intent[]): Promise<boolean>;
  /** Authenticated access to an output-plane production lane, independent of its controller. */
  canQueue(role: Plane): boolean;
  toast(text: string, kind?: 'err' | 'ok'): void;
  goTo(p: Plane): void;
  jumpTo(p: Plane, x: number, y: number): void;
  toggleCommander(): void;
  /** Commander focus point picked on the map. */
  pickDirective(role: Plane, x: number, y: number): void;
  /** Selection / armed mode changed: re-render the command card. */
  changed(): void;
  /** Hint line under the top bar (empty = hidden). */
  hint(text: string): void;
  /** Enter pressed outside any text field (opens the owner→agent chat). */
  onChatKey?(): void;
  /** Alt+click on the map (no drag): a ping at tile coords on the focused plane, instead of an order. */
  onPing?(p: { plane: Plane; x: number; y: number }): void;
  /** The match rules (weather hover tips quote them); unknown until the first snapshot. */
  rules?(): Rules | undefined;
  /** Spectating: orders are refused, so no aimed scope opens (held peek still views). */
  readOnly?: boolean;
}

const IS_UNIT = new Set<string>(UNIT_KINDS);
/** The Request segment ranks below every order: on a full card it is the first to move under More. */
const REQUEST_RANK = 1;
const STANCE_LABEL = { aggressive: 'Aggressive', defensive: 'Defensive', hold: 'Hold position' } as const;
const STANCE_HINT = {
  aggressive: 'Stance: chase enemies within a leash.',
  defensive: 'Stance: chase briefly, then return.',
  hold: 'Stance: never move; fire only at what comes in range. Aircraft on hold also stay in storms and skip auto-intercepts.',
} as const;
const ORBIT_FORMATIONS = [
  { id: 'wedge', label: 'Wedge formation', description: 'Move selected Orbit ships in a wedge at the slowest ship’s speed.' },
  { id: 'line', label: 'Line formation', description: 'Move selected Orbit ships in a line at the slowest ship’s speed.' },
  { id: 'escort', label: 'Escort formation', description: 'Form around a selected ship, preferring a tug or solar array. The fleet moves at the slowest ship’s speed.' },
] as const;

export class Controls {
  private readonly world: World;
  private readonly overlay: Overlay;
  private readonly host: ControlHost;
  armed: Armed | undefined;
  readonly selection = new Map<Plane, Set<string>>(PLANES.map((p) => [p, new Set<string>()]));
  private readonly groups: string[][] = Array.from({ length: 10 }, () => []);
  private lastGroup = { n: -1, t: 0 };
  private lastClick = { t: 0, id: '' };
  /** Active subgroup kind (Tab) for kind-specific abilities. */
  activeKind: Kind | undefined;
  /** The explicitly chosen Orbit formation; none = each ship its own size-scaled slot (the server default). */
  private orbitFormation: OrbitFormation | undefined;
  private idleCursor = 0;
  /** The canvas's cursor (Overlay.cursor): reset when the pointer leaves and when these controls are disposed. */
  private readonly cursor: CanvasCursor;
  private session: ToolSession;
  private readonly frameSelection: ToolSelection = { units: [], spire: false };
  private readonly cleanup: (() => void)[] = [];
  private peekHeld = false;
  private peekReverse = false;
  /** Weather hover tips per kind, rebuilt when the rules change (pointer moves reuse them). */
  private readonly weatherTips = new Map<WeatherKind, TipContent>();
  private weatherRules: Rules | undefined;
  /** The scorched-ground tip for `scorchRules` (rebuilt when the match rules change). */
  private scorchTip: TipContent | undefined;
  private scorchRules: Rules | undefined;
  /** Known lava-lake, lava-bridge and green-ore cell tips by cell code for `cellRules` (rebuilt when the rules change). */
  private readonly cellTips = new Map<number, TipContent | undefined>();
  private cellRules: Rules | undefined;
  private contactTip: { id: string; kind: Kind; plane: Plane; count: number; weapon?: Kind; content: TipContent } | undefined;
  /** Smart right-click hover tips by action label (pointer moves reuse them). */
  private readonly smartTips = new Map<string, TipContent>();
  /** The last canvas pointer, so modifier keys (Alt, Shift) re-resolve the hover without a pointer move. */
  private hoverPointer: ToolPointer | undefined;

  constructor(world: World, overlay: Overlay, host: ControlHost) {
    this.world = world;
    this.overlay = overlay;
    this.cursor = overlay.cursor;
    this.host = host;
    world.selected = this.selection.get(world.rig.focus)!;
    this.session = this.createSession('default');
    this.bind();
  }

  dispose(): void {
    this.clearContactTip();
    this.session.reset();
    for (const c of this.cleanup) c();
    // The canvas, rig and world outlive this session (the observer or the next match takes them): no command or
    // edge-scroll cursor and no edge or key pan may carry over, whether or not the pointer ever left the canvas.
    this.cursor.reset();
    const rig = this.world.rig;
    rig.edge.x = rig.edge.y = 0;
    rig.keys.clear();
  }

  /** Another army's view now (its own entity names, match-view.ts idSpace): selections and control groups name nothing in it. */
  forgetIds(): void {
    for (const s of this.selection.values()) s.clear();
    for (const g of this.groups) g.length = 0;
    this.lastClick = { t: 0, id: '' };
  }

  /** Called when the focused plane changes. */
  onPlane(p: Plane): void {
    this.clearContactTip();
    this.world.selected = this.selection.get(p)!;
    this.activeKind = undefined;
    if (this.armed && (!this.session.tool.followsPlane || !this.session.tool.planes.includes(p))) this.arm(undefined);
    else {
      this.session.reset();
      this.session = this.createSession(this.armed?.kind ?? 'default');
      this.session.enter();
      this.session.peek(this.peekHeld, this.peekReverse);
    }
    this.host.changed();
  }

  /**
   * The Sky's weather is drawn without outlines, so it names itself on hover: a tip at the pointer over a storm,
   * fog bank or wind lane (the public forecast only), unless the pointer is on an entity.
   */
  private weatherHover(x: number, y: number, overEntity: boolean): void {
    const view = this.host.view();
    const rules = this.host.rules?.();
    let kind: WeatherKind | undefined;
    if (view?.match && rules && !overEntity && !this.session.state.lens?.active && !this.session.state.contacts?.active && this.world.rig.focus === 'sky') {
      const p = this.world.groundPoint(x, y, 'sky');
      if (Number.isFinite(p.x)) kind = weatherUnder(view.weather, view.match, this.world.entities.renderTick, p.x, p.y, this.world.size);
    }
    if (!kind || !rules) return pointTip(undefined);
    if (rules !== this.weatherRules) {
      this.weatherTips.clear();
      this.weatherRules = rules;
    }
    let content = this.weatherTips.get(kind);
    if (!content) this.weatherTips.set(kind, (content = weatherTip(kind, rules)));
    pointTip(content, x, y);
  }

  /** Burning ground on the focused Surface names itself on hover (its zone, or the BURNING tag above it). */
  private scorchHover(x: number, y: number): boolean {
    const view = this.host.view();
    const rules = this.host.rules?.();
    if (!view?.scorches?.length || !rules || this.world.rig.focus !== 'surface' || this.session.state.lens?.active || this.session.state.contacts?.active) return false;
    const p = this.world.groundPoint(x, y, 'surface');
    if (!Number.isFinite(p.x)) return false;
    const tick = this.world.entities.renderTick;
    const over = view.scorches.some((s) => s.until > tick && (p.x - s.x) ** 2 + (p.y - s.y) ** 2 <= s.radius ** 2);
    if (!over) return false;
    if (rules !== this.scorchRules) {
      this.scorchRules = rules;
      this.scorchTip = { title: 'Scorched ground', description: `${rules.orbit.scorchDps} damage/s to all Surface units until it cools.` };
    }
    pointTip(this.scorchTip, x, y);
    return true;
  }

  /** A known Depths cell a map feature adds (lake, bridge, green ore) under the pointer: its tip, from team knowledge only. */
  private cellHover(x: number, y: number): boolean {
    const view = this.host.view();
    const rules = this.host.rules?.();
    if (!view || !rules || this.world.rig.focus !== 'depths' || this.session.state.lens?.active || this.session.state.contacts?.active) return false;
    const p = this.world.groundPoint(x, y, 'depths');
    const size = this.world.size;
    if (!Number.isFinite(p.x) || p.x < 0 || p.y < 0 || p.x >= size || p.y >= size) return false;
    if (rules !== this.cellRules) {
      this.cellRules = rules;
      this.cellTips.clear();
    }
    const code = view.depths[Math.floor(p.y) * size + Math.floor(p.x)] ?? 0;
    if (!this.cellTips.has(code)) this.cellTips.set(code, depthsCellTip(code, rules));
    const tip = this.cellTips.get(code);
    if (!tip) return false;
    pointTip(tip, x, y);
    return true;
  }

  // ---------------------------------------------------------------- selection
  private army(): ArmyId | undefined {
    return this.host.view()?.army;
  }

  selectedTracks(): Track[] {
    const focus = this.world.rig.focus;
    const out: Track[] = [];
    for (const id of this.world.selected) {
      const tr = this.world.entities.tracks.get(id);
      if (tr && tr.e.plane === focus) out.push(tr);
    }
    return out;
  }

  ownSelected(): Entity[] {
    const army = this.army();
    const out: Entity[] = [];
    for (const tr of this.selectedTracks()) if (tr.e.side === army && IS_UNIT.has(tr.e.kind)) out.push(tr.e);
    return out;
  }

  private ownSpireSelected(): boolean {
    const army = this.army();
    return this.selectedTracks().some((t) => t.e.kind === 'spire' && t.e.side === army);
  }

  private set(ids: Iterable<string>, add = false): void {
    const sel = this.world.selected;
    if (!add) sel.clear();
    for (const id of ids) sel.add(id);
    if (sel.size) audioUi('select');
    this.activeKind = undefined;
    this.host.changed();
  }

  /** `structures`: the drag box may pick structures, but only when it holds no units (standard RTS box priority), so a
   *  sweep across the Spire never drags a building into a move order. */
  selectWhere(pred: (t: Track, sx: number, sy: number) => boolean, onScreen = true, add = false, structures = false): void {
    const focus = this.world.rig.focus;
    const army = this.army();
    const units: string[] = [];
    const buildings: string[] = [];
    for (const tr of this.world.entities.tracks.values()) {
      const e = tr.e;
      const unit = IS_UNIT.has(e.kind);
      if (e.plane !== focus || e.side !== army || (!unit && !(structures && footprint(e.kind)))) continue;
      const p = this.world.project(tr.rx - this.world.size / 2, tr.wy + 0.3, tr.ry - this.world.size / 2);
      if (p.behind) continue;
      if (onScreen && (p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight)) continue;
      if (pred(tr, p.x, p.y)) (unit ? units : buildings).push(e.id);
    }
    this.set(units.length ? units : buildings, add);
  }

  private clickSelect(cx: number, cy: number, add: boolean, ctrl: boolean): void {
    const tr = this.world.pickEntity(cx, cy);
    const sel = this.world.selected;
    const now = performance.now();
    if (!tr) {
      if (!add) sel.clear();
      this.host.changed();
      return;
    }
    const own = tr.e.side === this.army();
    if (own && IS_UNIT.has(tr.e.kind) && (ctrl || (now - this.lastClick.t < 320 && this.lastClick.id === tr.e.id))) {
      // double-click / ctrl-click: every own unit of that kind on screen
      const kind = tr.e.kind;
      this.selectWhere((t) => t.e.kind === kind, true, add);
      return;
    }
    this.lastClick = { t: now, id: tr.e.id };
    if (!add || !own) sel.clear();
    if (add && sel.has(tr.e.id)) sel.delete(tr.e.id);
    else sel.add(tr.e.id);
    if (add) for (const id of sel) if (this.world.entities.tracks.get(id)?.e.side !== this.army()) sel.delete(id);
    if (sel.size) audioUi('select');
    this.activeKind = undefined;
    this.host.changed();
  }

  private group(n: number, mode: 'set' | 'add' | 'select'): void {
    const g = this.groups[n]!;
    if (mode === 'set' || mode === 'add') {
      const ids = this.ownSelected().map((e) => e.id);
      if (mode === 'set') g.length = 0;
      for (const id of ids) if (!g.includes(id)) g.push(id);
      audioUi('confirm');
      this.host.toast(`Group ${n}: ${g.length} units`, 'ok');
      return;
    }
    const alive = g.filter((id) => this.world.entities.tracks.has(id));
    g.length = 0;
    g.push(...alive);
    if (!alive.length) return;
    // a group lives on the plane where most of its units are
    const count: Record<Plane, number> = { depths: 0, surface: 0, sky: 0, orbit: 0 };
    let sx = 0;
    let sy = 0;
    for (const id of alive) {
      const e = this.world.entities.tracks.get(id)!.e;
      count[e.plane]++;
    }
    const plane = PLANES.reduce((a, b) => (count[b] > count[a] ? b : a));
    const ids = alive.filter((id) => this.world.entities.tracks.get(id)!.e.plane === plane);
    for (const id of ids) {
      const tr = this.world.entities.tracks.get(id)!;
      sx += tr.rx;
      sy += tr.ry;
    }
    const now = performance.now();
    const double = this.lastGroup.n === n && now - this.lastGroup.t < 350;
    this.lastGroup = { n, t: now };
    if (plane !== this.world.rig.focus) this.host.goTo(plane);
    const sel = this.selection.get(plane)!;
    sel.clear();
    for (const id of ids) sel.add(id);
    audioUi('select');
    this.activeKind = undefined;
    if (double) this.world.rig.lookAtTile(sx / ids.length, sy / ids.length);
    this.host.changed();
  }

  /** Cycle through idle own units on the focused plane. */
  private nextIdle(): void {
    const focus = this.world.rig.focus;
    const army = this.army();
    const idle: Track[] = [];
    for (const tr of this.world.entities.tracks.values())
      if (tr.e.plane === focus && tr.e.side === army && IS_UNIT.has(tr.e.kind) && tr.e.state === 'idle') idle.push(tr);
    if (!idle.length) return this.host.toast(`No idle units on ${PLANE_NAME[focus]}`, 'ok');
    const tr = idle[this.idleCursor++ % idle.length]!;
    this.set([tr.e.id]);
    this.world.rig.lookAtTile(tr.rx, tr.ry);
  }

  private cycleSubgroup(): void {
    const kinds: Kind[] = [];
    for (const e of this.ownSelected()) if (!kinds.includes(e.kind)) kinds.push(e.kind);
    if (kinds.length < 2) return;
    const i = this.activeKind ? kinds.indexOf(this.activeKind) : -1;
    this.activeKind = kinds[(i + 1) % kinds.length];
    this.host.changed();
  }

  // ---------------------------------------------------------------- tools
  private toolSelection(out: ToolSelection = { units: [], spire: false }): ToolSelection {
    out.units.length = 0;
    out.spire = false;
    out.activeKind = this.activeKind;
    out.formation = this.orbitFormation;
    const army = this.army();
    const focus = this.world.rig.focus;
    for (const id of this.world.selected) {
      const e = this.world.entities.tracks.get(id)?.e;
      if (!e || e.side !== army || e.plane !== focus) continue;
      // The Spire is armed but never a unit: it gets its structure card (rally, scan), not move/stop/patrol.
      if (e.kind === 'spire') out.spire = true;
      else if (IS_UNIT.has(e.kind) || armed(e) || e.kind === 'mooring_tower') out.units.push(e);
    }
    return out;
  }

  private toolContext(mode = this.armed): Omit<ToolContext, 'state'> {
    return {
      world: this.world, overlay: this.overlay, host: this.host, mode,
      selection: this.toolSelection(),
      select: (x, y, add, ctrl) => this.clickSelect(x, y, add, ctrl),
      box: (x0, y0, x1, y1, add) => this.selectWhere((tr, x, y) => footprint(tr.e.kind)
        ? this.world.footprintInBox(tr, x0, y0, x1, y1)
        : x >= x0 && x <= x1 && y >= y0 && y <= y1, false, add, true),
      cancel: () => { if (this.armed === mode) this.arm(undefined); },
    };
  }

  private createSession(id: ToolId, mode = this.armed): ToolSession {
    const context = this.toolContext(mode);
    return new ToolSession(getTool(id), () => {
      this.toolSelection(context.selection);
      return context;
    });
  }

  private pointer(e: PointerEvent): ToolPointer {
    return { x: e.clientX, y: e.clientY, button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
  }

  private clearContactTip(): void {
    this.contactTip = undefined;
    pointTip(undefined);
  }

  private contactTrack(): Track | undefined {
    const contacts = this.session.state.contacts;
    return contacts?.active && contacts.source === this.world.rig.focus && contacts.hovered
      ? this.world.entities.tracks.get(contacts.hovered) : undefined;
  }

  private contactHover(): string {
    this.world.hovered = undefined;
    const contacts = this.session.state.contacts;
    const pointer = this.session.state.pointer;
    const track = this.contactTrack();
    if (!contacts || !pointer || !track) {
      this.clearContactTip();
      return CURSOR.invalid;
    }
    const count = contactFireCount(contacts, track.e, this.host.view());
    let weapon: Kind | undefined = contacts.units[0]?.kind;
    for (const e of contacts.units) if (e.kind !== weapon) { weapon = undefined; break; }
    const cached = this.contactTip;
    if (!cached || cached.id !== track.e.id || cached.kind !== track.e.kind || cached.plane !== track.e.plane || cached.count !== count || cached.weapon !== weapon) {
      const label = weapon ? KIND_LABEL[weapon].toLowerCase() : 'weapon';
      const noun = label === 'flak' ? `flak weapon${count === 1 ? '' : 's'}` : `${label}${count === 1 ? '' : 's'}`;
      this.contactTip = {
        id: track.e.id, kind: track.e.kind, plane: track.e.plane, count, weapon,
        content: { title: `${KIND_LABEL[track.e.kind]} · ${PLANE_NAME[track.e.plane]} · ${count} ${noun} can fire` },
      };
    }
    pointTip(this.contactTip!.content, pointer.x, pointer.y);
    return count ? CURSOR.attack : CURSOR.invalid;
  }

  private toolCursor(): string {
    if (this.armed?.kind === 'lensAttack') {
      const track = this.contactTrack();
      const contacts = this.session.state.contacts;
      return track && contacts && contactFireCount(contacts, track.e, this.host.view()) ? CURSOR.attack : CURSOR.invalid;
    }
    return this.peekHeld && !this.armed ? CURSOR.precise : this.session.tool.cursor;
  }

  /**
   * Smart right-click preview at the pointer: the action the unarmed right-click would issue (tools/smart.ts), null
   * when the selection has nothing to do there, undefined when it does not apply (no selection, a tool armed, peek
   * held, or Ctrl+right-click Depths verbs).
   */
  private smartHover(selection: ToolSelection, p: ToolPointer, tile: { x: number; y: number } | undefined, track: Track | undefined): SmartAction | null | undefined {
    const view = this.host.view();
    const focus = this.world.rig.focus;
    if (this.armed || this.peekHeld || !view || (!selection.units.length && !selection.spire)) return undefined;
    if (!p.altKey && (p.ctrlKey || p.metaKey) && focus === 'depths' && selection.units.length) return undefined;
    return resolveSmartAction(selection, { plane: focus, tile, entity: track?.e.id }, view, p) ?? null;
  }

  private smartTip(label: string): TipContent {
    let content = this.smartTips.get(label);
    if (!content) this.smartTips.set(label, (content = { title: label }));
    return content;
  }

  /** Hover feedback for the pointer: highlight, cursor and tip (smart action, island, weather or contact). */
  private hover(p: ToolPointer): void {
    const rig = this.world.rig;
    this.hoverPointer = p;
    let want = this.peekHeld && !this.armed ? CURSOR.precise : this.session.tool.cursor;
    if (this.session.capturesDrag) {
      this.cursor.set(want);
      return;
    }
    const targetingContacts = this.armed?.kind === 'lensAttack';
    const context = targetingContacts ? undefined : { ...this.toolContext(), state: this.session.state };
    const picked = context && resolvePointer(context, p, { entity: true });
    const hov = picked ? picked.track : this.contactTrack();
    const smart = context && picked ? this.smartHover(context.selection, p, picked.tile, hov) : undefined;
    const own = hov && hov.e.side === this.army();
    if (targetingContacts) want = this.contactHover();
    else {
      this.world.hovered = hov?.e.id;
      const view = this.host.view();
      const rules = this.host.rules?.();
      // A build ghost the radius refuses says why at the pointer; other tips yield to it.
      const refused = this.armed?.kind === 'build' ? this.overlay.preview?.footprint?.reason : null;
      if (refused) pointTip(RADIUS_TIP[refused], p.x, p.y);
      else if (smart && smart.id !== 'move') pointTip(this.smartTip(smart.label), p.x, p.y);
      else if (hov?.e.kind === 'island' && view && rules) pointTip(islandTip(hov.e, view, rules), p.x, p.y);
      else if (hov?.e.kind === 'post' && view && rules) pointTip(postTip(hov.e, view, rules), p.x, p.y);
      // burning ground on the Surface, a lake / bridge / green-ore cell in the Depths (a lava bridge's deck is its
      // cell), else the Sky's weather (each clears the tip when the pointer is not over it)
      else if ((hov && hov.e.kind !== 'lava_bridge') || !(this.scorchHover(p.x, p.y) || this.cellHover(p.x, p.y))) this.weatherHover(p.x, p.y, !!hov);
    }
    // Over an own unit a plain move keeps the select cursor: a left-click there selects it.
    if (smart !== undefined) want = !smart ? CURSOR.invalid : smart.id === 'move' && own && IS_UNIT.has(hov.e.kind) ? CURSOR.select : smart.cursor;
    else if (!this.armed && own && want === CURSOR.pointer) want = CURSOR.select;
    this.world.pointAt(p.x, p.y, !!this.armed);
    const m = 14;
    rig.edge.x = p.x < m ? -1 : p.x > innerWidth - m ? 1 : 0;
    rig.edge.y = p.y < m ? -1 : p.y > innerHeight - m ? 1 : 0;
    // Explicit aiming retains its cursor at the screen edges.
    if ((rig.edge.x || rig.edge.y) && !this.session.state.lens?.active && !targetingContacts) want = scrollCursor(rig.edge.x, rig.edge.y);
    this.cursor.set(want);
  }

  /** The same registry entry handles hotkeys, command cards and public action callbacks. */
  private command(id: string, shiftKey = false): void {
    const tool = toolForCommand(id);
    if (!tool || !eligible(tool, this.world.rig.focus, this.toolSelection(), this.host.view())) return;
    const readiness = tool.readiness?.(this.toolSelection(), this.host.view());
    if (readiness && !readiness.enabled) { this.host.toast(readiness.status); return; }
    if (!tool.immediate) {
      // Parameterized modes are armed explicitly by their owning UI.
      if (tool.id !== 'build' && tool.id !== 'pick' && tool.id !== 'request' && tool.id !== 'default') this.arm({ kind: tool.id } as Armed);
      return;
    }
    this.createSession(tool.id).click({ x: 0, y: 0, button: 0, shiftKey, altKey: false, ctrlKey: false, metaKey: false });
  }

  stop(): void { this.command('stop'); }
  mine(queue = false): void { this.command('mine', queue); }
  transfer(queue = false): void { this.command('transfer', queue); }

  stance(stance: 'aggressive' | 'defensive' | 'hold'): void {
    const own = this.ownSelected().filter(armed);
    if (own.length) void this.host.act(this.world.rig.focus, [{ kind: 'stance', units: unitIds(own), stance }]);
  }

  arm(a: Armed | undefined): void {
    const tool = getTool(a?.kind ?? 'default');
    if (a && !eligible(tool, this.world.rig.focus, this.toolSelection(), this.host.view())) return;
    if (a && (a.kind === 'build' || a.kind === 'relay' || a.kind === 'bulkhead' || a.kind === 'geothermal')) {
      const rules = this.host.rules?.();
      const plane = a.kind === 'build' ? rules && ruleTables(rules).stats[a.structure].plane : a.kind === 'relay' ? 'sky' : 'depths';
      if (!plane || !this.host.canQueue(plane)) return;
    }
    this.clearContactTip();
    const pointer = this.session.state.pointer;
    this.session.reset();
    this.armed = this.armed && a && JSON.stringify(this.armed) === JSON.stringify(a) ? undefined : a;
    this.session = this.createSession(this.armed?.kind ?? 'default');
    this.session.enter();
    this.session.peek(this.peekHeld, this.peekReverse);
    if (this.armed?.kind === 'lensAttack' || this.session.tool.aim || this.peekHeld) this.session.preview(pointer);
    if (this.armed?.kind === 'lensAttack') this.contactHover();
    else if (this.session.state.lens?.active) pointTip(undefined);
    this.cursor.set(this.toolCursor());
    this.host.hint(this.armed ? `${this.session.tool.hint}${this.session.tool.persistent ? '' : ' · Shift queues · Esc cancels'}` : '');
    this.host.changed();
  }

  // ---------------------------------------------------------------- command card
  /** The selection's orders for the command card: commands and abilities in card order (CARD_SLOTS), stances and formations as segments. */
  cardActions(): CardAction[] {
    const own = this.toolSelection().units;
    const focus = this.world.rig.focus;
    if (this.activeKind && !own.some((e) => e.kind === this.activeKind)) this.activeKind = undefined;
    const stances = new Set(own.filter(armed).map((e) => e.stance ?? 'aggressive'));
    const ak = this.armed?.kind ?? '';
    const layout = keyLayout();
    const view = this.host.view();
    const selection: ToolSelection = { units: own, spire: this.ownSpireSelected(), activeKind: this.activeKind };
    const actions: CardAction[] = [];
    for (const [id, slot] of Object.entries(CARD_SLOTS) as [ToolId, NonNullable<(typeof CARD_SLOTS)[ToolId]>][]) {
      const tool = getTool(id);
      if (id === 'patrol' && focus === 'orbit' && own.length > 1) for (const formation of ORBIT_FORMATIONS) actions.push({
        id: `formation:${formation.id}`, group: 'commands', rank: 4, icon: `formation_${formation.id}`, label: formation.label,
        on: this.orbitFormation === formation.id, segment: { id: 'formation', label: 'Orbit formation' },
        tip: { title: formation.label, description: formation.description },
        // Clicking the active formation clears it again (each ship its own slot).
        run: () => { this.orbitFormation = this.orbitFormation === formation.id ? undefined : formation.id; this.host.changed(); },
      });
      if (!eligible(tool, focus, selection, view) || !tool.card?.(selection, view)) continue;
      const readiness = tool.readiness?.(selection, view);
      const queueLocked = (id === 'build' || id === 'relay' || id === 'bulkhead' || id === 'geothermal')
        && !this.host.canQueue(id === 'relay' ? 'sky' : id === 'bulkhead' || id === 'geothermal' ? 'depths' : focus);
      const hotkey = tool.hotkey ? keyLabel(id as KeyCommand, layout) : undefined;
      if (id === 'hold') {
        // Hold is the third stance: one segment, one hotkey, no second Hold button.
        for (const stance of ['aggressive', 'defensive', 'hold'] as const) actions.push({
          id: stance === 'hold' ? 'hold' : `stance:${stance}`, group: 'commands', rank: slot.rank, icon: stance, label: STANCE_LABEL[stance],
          on: stances.size === 1 && stances.has(stance), segment: { id: 'stance', label: 'Stance' },
          ...(stance === 'hold' ? { hotkey } : {}),
          tip: { title: STANCE_LABEL[stance], description: STANCE_HINT[stance], ...(stance === 'hold' && hotkey ? { hotkey } : {}) },
          run: () => this.stance(stance),
        });
        continue;
      }
      const tags = id === 'designate' && view ? digCount(view.designations, this.world.size) : undefined;
      const label = readiness?.label ?? tool.label;
      actions.push({
        id, group: slot.group, rank: slot.rank, icon: id, label, on: ak === id,
        disabled: queueLocked || (readiness ? !readiness.enabled : false),
        ...(hotkey ? { hotkey } : {}),
        ...(tags !== undefined ? { badge: String(tags) } : {}),
        ...(readiness ? { cost: readiness.cost, ...(readiness.cooldown ? { cooldown: readiness.cooldown } : {}) } : {}),
        tip: {
          title: label, description: readiness?.description || tool.hint,
          status: queueLocked ? 'Read-only lane: no acting credential' : readiness?.status ?? (tags !== undefined ? `${tags}/${view?.match?.rules.depths.designateMax ?? '—'} shared dig tags · brighter gold is urgent` : undefined),
          ...(hotkey ? { hotkey } : {}), ...(readiness && (readiness.cost.alloy || readiness.cost.energy) ? { cost: readiness.cost } : {}),
        },
        run: () => this.command(id),
      });
    }
    // Team support requests: one button per need a teammate answers, armed like Scan (the map click places it).
    if (signalsOn(view?.match)) for (const need of requestNeeds(focus)) {
      const to = requestTarget(focus, need)!;
      actions.push({
        id: `request:${need}`, group: 'commands', rank: REQUEST_RANK, icon: `need_${need}`, label: NEED_LABEL[need],
        on: this.armed?.kind === 'request' && this.armed.need === need, segment: { id: 'request', label: 'Request support' },
        tip: { title: `Request ${NEED_LABEL[need].toLowerCase()} · ${signalTo(to)}`, description: 'Click the map where you need it' },
        run: () => this.arm({ kind: 'request', need }),
      });
    }
    return actions;
  }

  // ---------------------------------------------------------------- input
  private bind(): void {
    const canvas = this.overlay.canvas;
    const rig = this.world.rig;
    let down: { button: number; session: ToolSession } | undefined;
    let rotating: { x: number; y: number } | undefined;
    /** Alt+left press: a click pings, a drag rotates the camera. */
    let altPress: { x: number; y: number } | undefined;
    const touch = new TouchGesture();
    const on = <K extends keyof WindowEventMap>(target: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      // Touch never box-selects or right-drags: fingers move the camera and a tap clicks (`touch-camera.ts`).
      if (e.pointerType === 'touch') {
        touch.down(e.pointerId, e.clientX, e.clientY);
        return;
      }
      if (e.button === 0 && this.session.capturesDrag) {
        down = { button: e.button, session: this.session };
        this.session.start(this.pointer(e));
        e.preventDefault();
        return;
      }
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        rotating = { x: e.clientX, y: e.clientY };
        altPress = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
        e.preventDefault();
        return;
      }
      down = { button: e.button, session: this.session };
      if (e.button === 0 || (e.button === 2 && !this.armed)) this.session.start(this.pointer(e));
    });
    on(canvas, 'pointermove', (e) => {
      if (e.pointerType === 'touch') {
        touch.move(e.pointerId, e.clientX, e.clientY, rig, this.world.viewport);
        return;
      }
      if (rotating) {
        rig.rotate(e.clientX - rotating.x, e.clientY - rotating.y);
        rotating = { x: e.clientX, y: e.clientY };
        return;
      }
      const p = this.pointer(e);
      this.session.move(p);
      this.hover(p);
    });
    on(canvas, 'pointerleave', () => {
      this.hoverPointer = undefined;
      rig.edge.x = rig.edge.y = 0;
      this.world.pointAway();
      this.clearContactTip();
      this.session.leave();
      // Off the canvas (onto the HUD, the loader, another session's UI) no game cursor stays armed on it: the next
      // pointermove sets the current one again.
      this.cursor.reset();
    });
    on(canvas, 'pointerup', (e) => {
      if (e.pointerType === 'touch') {
        if (!touch.up(e.pointerId)) return;
        const p = this.pointer(e);
        this.session.start(p);
        this.session.end(p);
        return;
      }
      if (rotating) {
        rotating = undefined;
        const a = altPress;
        altPress = undefined;
        if (a && Math.hypot(e.clientX - a.x, e.clientY - a.y) < 5 && this.host.onPing) {
          const { tile } = resolvePointer({ ...this.toolContext(), state: this.session.state }, this.pointer(e));
          if (tile) this.host.onPing({ plane: this.world.rig.focus, x: round2(tile.x, this.world.size), y: round2(tile.y, this.world.size) });
        }
        return;
      }
      const d = down;
      down = undefined;
      if (!d || d.session !== this.session) return;
      if (d.button === 2) {
        if (this.peekHeld || this.armed) {
          this.peekHeld = false;
          this.session.peek(false);
          this.arm(undefined);
        }
        else this.session.end(this.pointer(e));
        return;
      }
      if (d.button === 0) this.session.end(this.pointer(e));
    });
    const cancelPointer = () => {
      down = rotating = altPress = undefined;
      touch.reset();
      this.session.reset();
      this.clearContactTip();
      rig.edge.x = rig.edge.y = 0;
    };
    on(canvas, 'pointercancel', cancelPointer);
    // Normal pointerup releases capture too; only an interrupted gesture should reset an armed tool.
    on(canvas, 'lostpointercapture', () => { if (down || rotating || altPress) cancelPointer(); });
    on(canvas, 'wheel', (e) => {
      e.preventDefault();
      rig.zoom(e.deltaY);
    }, { passive: false });
    // Alt (plain move) and Ctrl (Depths verbs) change what the hovered right-click would do.
    const rehover = (e: KeyboardEvent) => {
      if (this.hoverPointer) this.hover({ ...this.hoverPointer, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
    };

    on(window, 'keydown', (e) => {
      const tgt = e.target;
      if (isTextEntry(tgt)) return;
      // Do not turn keyboard button activation into chat/home, including icon descendants.
      if ((e.key === ' ' || e.key === 'Enter') && targetElement(tgt)?.closest('button, [role="button"]')) return;
      // Tab still moves through focused HUD controls; on the map it cycles unit subgroups.
      if (e.key === 'Tab' && targetElement(tgt)?.closest('button, [role="button"], a[href], summary, [tabindex]')) return;
      this.session.modifiers(e);
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') rehover(e);
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const layout = keyLayout();
      const cmd = commandFor(k, layout);
      if (this.peekHeld && e.shiftKey !== this.peekReverse) {
        this.peekReverse = e.shiftKey;
        this.session.peek(true, this.peekReverse);
      }
      if (cmd === 'peek' && !ctrl && !e.altKey) {
        if (e.repeat) return;
        e.preventDefault();
        this.peekHeld = true;
        this.peekReverse = e.shiftKey;
        this.session.peek(true, this.peekReverse);
        pointTip(undefined);
        this.cursor.set(this.toolCursor());
        return;
      }
      // planes
      const fk = /^f([1-4])$/.exec(k);
      if (fk) {
        e.preventDefault();
        return this.host.goTo(PLANES[Number(fk[1]) - 1]!);
      }
      const idx = PLANES.indexOf(rig.focus);
      if (cmd === 'diveDown' && !ctrl) return this.host.goTo(PLANES[Math.max(0, idx - 1)]!);
      if (cmd === 'diveUp' && !ctrl) return this.host.goTo(PLANES[Math.min(3, idx + 1)]!);
      // control groups (e.code so Shift+digit works on every layout)
      const digit = /^Digit([0-9])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        return this.group(Number(digit[1]), ctrl ? 'set' : e.shiftKey ? 'add' : 'select');
      }
      if (k === 'escape') {
        const wasPeeking = this.peekHeld;
        this.peekHeld = false;
        this.session.peek(false);
        this.cursor.set(this.toolCursor());
        cancelPointer();
        if (this.armed) this.arm(undefined);
        else if (!wasPeeking) {
          this.world.selected.clear();
          this.host.changed();
        }
        return;
      }
      if (k === 'tab') {
        e.preventDefault();
        return this.cycleSubgroup();
      }
      if (k === '`') return this.host.toggleCommander();
      if (k === 'enter' && this.host.onChatKey) {
        e.preventDefault();
        return this.host.onChatKey();
      }
      if (k === ' ' || k === 'home') {
        e.preventDefault();
        const v = this.host.view();
        if (!v) return;
        const p = matchArmy(v.match!, v.army).spireAt;
        return rig.lookAtTile(p.x, p.y);
      }
      if (ctrl && k === 'a') {
        e.preventDefault();
        return this.selectWhere((t) => armed(t.e), false);
      }
      if (ctrl) return;
      const pan = panFor(k, layout);
      if (pan) {
        e.preventDefault();
        rig.keys.add(pan);
        return;
      }
      if (cmd === 'idle') return this.nextIdle();
      if (cmd && (cmd !== 'lensAttack' || !e.repeat) && (!e.repeat || !toolForCommand(cmd)?.persistent)) this.command(cmd, e.shiftKey);
    });
    on(window, 'keyup', (e) => {
      if (commandFor(e.key.toLowerCase(), keyLayout()) === 'peek') this.peekHeld = false;
      this.peekReverse = e.shiftKey;
      this.session.peek(this.peekHeld, this.peekReverse);
      this.cursor.set(this.toolCursor());
      this.session.modifiers(e);
      rehover(e);
      const pan = panFor(e.key.toLowerCase(), keyLayout());
      if (pan) rig.keys.delete(pan);
    });
    on(window, 'focusin', (e) => {
      if (isTextEntry(e.target)) rig.keys.clear();
    });
    on(window, 'blur', () => {
      rig.keys.clear();
      this.peekHeld = false;
      this.session.peek(false);
      cancelPointer();
    });
    // A layout switch while a key is held must not leave the camera drifting; the ability buttons relabel.
    const off = onKeyLayout(() => {
      rig.keys.clear();
      this.peekHeld = false;
      this.session.peek(false);
      this.host.changed();
    });
    this.cleanup.push(off);
  }

  /** Per-frame: drop dead units from selections and groups. */
  frame(): void {
    for (const id of this.world.selected) if (!this.world.entities.tracks.has(id)) this.world.selected.delete(id);
    if (this.armed && !eligible(this.session.tool, this.world.rig.focus, this.toolSelection(this.frameSelection), this.host.view())) this.arm(undefined);
    this.session.frame();
    if (this.armed?.kind === 'lensAttack') this.cursor.set(this.contactHover());
  }
}
