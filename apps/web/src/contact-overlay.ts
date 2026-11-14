/** Main-camera, fog-safe weapon contacts. Geometry is shared with the contact picker, never a second scope. */
import { COLOURS, KINDS, PLANES, type Colour, type Kind, type Plane } from '@agent-command/game/contract';
import { PLANE_ACCENT } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { canTarget, contactFireCount, contactHeight, CONTACT_ICON_PX, createContactProjection, isContact, projectContact, weaponReach, type Contacts } from './tools/contacts.ts';
import { SIDE_HEX, colourOf, sideHex } from './world/common.ts';
import { PAPER, UNIT_PAINT } from './world/palette.ts';
import type { World } from './world/world.ts';

const GOLD = '#ffd21f';
const GREY = UNIT_PAINT.steel;
/** Raster tints: a valid contact in its army's colour (index = COLOURS order), then out of reach, then hovered. */
const COLORS = [...COLOURS.map((c) => SIDE_HEX[c]), GREY, GOLD] as const;
const GREY_TINT = COLOURS.length;
const GOLD_TINT = COLOURS.length + 1;
const DASH = [5, 3];
const NO_DASH: number[] = [];
const ICON_SCALE = 2;
const ICON_SIZE = 24;
const RANGE_STEPS = 64;
const CIRCLE = new Float64Array((RANGE_STEPS + 1) * 2);
for (let i = 0; i <= RANGE_STEPS; i++) {
  CIRCLE[i * 2] = Math.cos(i / RANGE_STEPS * Math.PI * 2);
  CIRCLE[i * 2 + 1] = Math.sin(i / RANGE_STEPS * Math.PI * 2);
}

/** One SVG decode per name, then three retained rasters; icon() and vector assets never run during drawing. */
function rasters(name: IconName, colors: readonly string[]): HTMLCanvasElement[] {
  const canvases = colors.map(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_SIZE * ICON_SCALE;
    return canvas;
  });
  const svg = icon(name, ICON_SIZE * ICON_SCALE);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('color', '#fff');
  const image = new Image();
  image.onload = () => {
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i]!;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = colors[i]!;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    image.onload = null;
  };
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  return canvases;
}

export class ContactOverlay {
  /** Rebuilt only from this frame's exposed entities; also suppresses redundant cross-plane chevrons. */
  readonly drawn = new Set<string>();
  private readonly projection = createContactProjection();
  private readonly kinds = new Map<Kind, HTMLCanvasElement[]>();
  private readonly planes = new Map<Plane, HTMLCanvasElement>();

  constructor() {
    for (const kind of KINDS) this.kinds.set(kind, rasters(kind, COLORS));
    for (const plane of PLANES) this.planes.set(plane, rasters(plane, [PLANE_ACCENT[plane]])[0]!);
  }

  clear(): void {
    this.drawn.clear();
  }

  draw(ctx: CanvasRenderingContext2D, world: World, contacts: Contacts): void {
    const view = world.view;
    if (!view || !contacts.active || contacts.source !== world.rig.focus || world.rig.diving) return;
    ctx.save();
    this.ranges(ctx, world, contacts);
    const projection = this.projection;
    for (const e of view.entities) {
      if (!isContact(contacts, view, e)) continue;
      const tr = world.entities.tracks.get(e.id);
      // Track visibility includes native-plane fading, so it must not gate contacts on the focused plane.
      if (!tr || !projectContact(world, contacts.source, tr, projection)) continue;
      this.drawn.add(e.id);
      const valid = contactFireCount(contacts, e, view) > 0;
      const hovered = contacts.hovered === e.id;
      const tint = valid ? (hovered ? GOLD_TINT : COLOURS.indexOf(colourOf(e.side) as Colour)) : GREY_TINT;
      const color = COLORS[tint]!;
      ctx.beginPath();
      if (projection.icon) {
        ctx.arc(projection.x, projection.y, CONTACT_ICON_PX / 2 + 3, 0, Math.PI * 2);
      } else {
        const quad = projection.quad;
        ctx.moveTo(quad[0]!, quad[1]!);
        for (let i = 1; i < 4; i++) ctx.lineTo(quad[i * 2]!, quad[i * 2 + 1]!);
        ctx.closePath();
      }
      ctx.fillStyle = projection.icon ? PAPER[contacts.source] : color;
      ctx.globalAlpha = projection.icon ? 0.94 : 0.1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash(DASH);
      ctx.strokeStyle = PAPER[contacts.source];
      ctx.lineWidth = hovered ? 5 : 4;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = hovered ? 2.5 : 1.75;
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      if (projection.icon) {
        const asset = this.kinds.get(e.kind)?.[tint];
        if (asset) ctx.drawImage(asset, projection.x - CONTACT_ICON_PX / 2, projection.y - CONTACT_ICON_PX / 2, CONTACT_ICON_PX, CONTACT_ICON_PX);
      }
      if (hovered) this.badge(ctx, contacts.source, e.plane, color);
    }
    ctx.restore();
  }

  private ranges(ctx: CanvasRenderingContext2D, world: World, contacts: Contacts): void {
    ctx.setLineDash(DASH);
    ctx.globalAlpha = 0.45;
    for (const e of contacts.units) {
      if (e.plane !== contacts.source || !world.selected.has(e.id)) continue;
      // One ring per unit: its reach into the first contact plane it can hit (a Lens reaches lensReach, not the beam range).
      let reachPlane: Plane | undefined;
      for (const plane of contacts.planes) if (canTarget(e, plane, world.view)) { reachPlane = plane; break; }
      if (!reachPlane) continue;
      const tr = world.entities.tracks.get(e.id);
      if (!tr) continue;
      const radius = weaponReach(e, world.view, reachPlane);
      if (radius <= 0) continue;
      ctx.beginPath();
      let visible = false;
      for (let i = 0; i <= RANGE_STEPS; i++) {
        const x = tr.rx + CIRCLE[i * 2]! * radius;
        const y = tr.ry + CIRCLE[i * 2 + 1]! * radius;
        const p = world.project(x - world.size / 2, contactHeight(contacts.source, x, y, world.layers.surface.field), y - world.size / 2);
        if (p.behind) { visible = false; continue; }
        if (visible) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
        visible = true;
      }
      ctx.strokeStyle = PAPER[contacts.source];
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = sideHex(world.army);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash(NO_DASH);
  }

  /** A plane glyph plus an unlabelled up/down cue: the input layer owns explanatory tooltip text. */
  private badge(ctx: CanvasRenderingContext2D, source: Plane, target: Plane, color: string): void {
    const projection = this.projection;
    let top = projection.y - CONTACT_ICON_PX / 2;
    if (!projection.icon) {
      top = Infinity;
      for (let i = 0; i < 4; i++) top = Math.min(top, projection.quad[i * 2 + 1]!);
    }
    const x = projection.x + 10;
    const y = top - 25;
    ctx.fillStyle = PAPER[source];
    ctx.fillRect(x, y, 34, 22);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.strokeRect(x + 0.5, y + 0.5, 33, 21);
    const asset = this.planes.get(target);
    if (asset) ctx.drawImage(asset, x + 2, y + 2, 18, 18);
    const direction = PLANES.indexOf(target) > PLANES.indexOf(source) ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x + 23, y + 11 - direction * 2);
    ctx.lineTo(x + 27, y + 11 + direction * 2);
    ctx.lineTo(x + 31, y + 11 - direction * 2);
    ctx.stroke();
  }
}
