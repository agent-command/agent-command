/** Forward posts and contested points on the client: tooltip, model (torn flag tagged for tint and flutter), ground bed, labels and the report row. */
import { describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { DEFAULT_RULES, SURFACE, type Entity } from '@agent-command/game/contract';
import { ICONS } from '../src/icons.ts';
import { postTip } from '../src/post-tip.ts';
import { ALERT_LABEL, ALERT_TEXT, KIND_LABEL, eventText } from '../src/text.ts';
import { PART, RIG, STATE_VISUALS, model } from '../src/world/models.ts';
import { BED_VERTS, PostBeds } from '../src/world/post-beds.ts';
import { TerrainField } from '../src/world/terrain.ts';
import { buildPreviewView } from '../src/preview-map.ts';

const game = createGame({ seed: 5 });
const view = game.view('nw');
const post = view.entities.find((e) => e.kind === 'post')!;
const point = view.entities.find((e) => e.kind === 'post' && view.match!.posts.some((p) => p.id === e.id && p.kind === 'contested'))!;

describe('forward posts on the client', () => {
  it('every army sees the public posts of matchData in its view', () => {
    // Two armies' home posts, then the centre and one flank pair.
    expect(view.match!.posts.length).toBe(DEFAULT_RULES.map.postCount * 2 + 3);
    for (const p of view.match!.posts) expect(view.entities.some((e) => e.id === p.id && e.kind === 'post')).toBe(true);
  });

  it('the lobby preview shows the same posts a match on that map places (public data only)', () => {
    const preview = buildPreviewView({});
    const match = createGame({ seed: 0 }).view('nw').match!;
    expect(preview.match!.posts.map((p) => [p.x, p.y, p.kind, p.home])).toEqual(match.posts.map((p) => [p.x, p.y, p.kind, p.home]));
    expect(preview.entities.filter((e) => e.kind === 'post').map((e) => e.side)).toEqual(createGame({ seed: 0 }).view('nw').entities.filter((e) => e.kind === 'post').map((e) => e.side));
  });

  it('tooltip names the kind, the holder, the capture and what holding it gives', () => {
    const home = postTip(post, view, DEFAULT_RULES);
    expect(home.title).toBe('Home post · held by yours');
    expect(home.description).toContain(`${DEFAULT_RULES.surface.postBuildRadius}-tile build radius`);
    expect(home.description).toContain(`${DEFAULT_RULES.surface.postHealPool} HP/s shared, at most ${DEFAULT_RULES.surface.postHealRate} HP/s each`);
    const neutral = postTip(point, view, DEFAULT_RULES);
    expect(neutral.title).toBe('Contested point · held by nobody');
    expect(neutral.description).toContain(`${DEFAULT_RULES.surface.contestedCaptureTime}s uncontested`);
    expect(neutral.description).toContain('no build radius');
    expect(neutral.description).toContain('time cap');
    const mine: Entity = { ...point, side: 'nw' };
    expect(postTip(mine, view, DEFAULT_RULES).title).toBe('Contested point · held by yours');
    const taken: Entity = { ...point, side: 'nw', state: 'capturing', progress: 0.4 };
    expect(postTip(taken, view, DEFAULT_RULES).description).toContain('Being captured: 40%.');
    const fought: Entity = { ...point, state: 'contested' };
    expect(postTip(fought, view, DEFAULT_RULES).description).toContain('Contested');
    // Posts are about vision, building forward and healing; the rally reset on loss is a quiet safety, not a benefit.
    expect(neutral.description).not.toMatch(/rally/i);
  });

  it('the model is a team-tinted torn flag that flutters and lowers with the capture', () => {
    const geo = model('post');
    const part = geo.getAttribute('part');
    const accent = geo.getAttribute('accent');
    let cloth = 0;
    for (let i = 0; i < part.count; i++) {
      if (part.getX(i) !== PART.cloth) continue;
      cloth++;
      expect(accent.getX(i)).toBe(1);
    }
    expect(cloth).toBeGreaterThan(0);
    expect(RIG.post.wave).toBeDefined();
    expect(STATE_VISUALS.post?.channels.fill).toEqual({ source: 'progress' });
  });

  it('the mound sinks below the ground its post stands on', () => {
    const geo = model('post');
    geo.computeBoundingBox();
    expect(geo.boundingBox!.min.y).toBeLessThan(-0.15);
  });

  it('the ground bed follows the terrain and stays on its post\'s level, plateau edges included', () => {
    const size = DEFAULT_RULES.map.size;
    const field = new TerrainField(size);
    const codes = new Uint8Array(size * size).fill(SURFACE.ground);
    // A plateau from x = 20 eastward; one post on it at its western edge, one on open ground.
    for (let y = 0; y < size; y++) for (let x = 20; x < size; x++) codes[y * size + x] = SURFACE.high;
    field.setHeights(codes, new Map());
    const beds = new PostBeds(size);
    const posts = [{ x: 20.5, y: 10.5 }, { x: 8.5, y: 30.5 }];
    beds.set(posts);
    expect(beds.mesh.visible).toBe(false);
    beds.seat(field.groundAt);
    expect(beds.mesh.visible).toBe(true);
    const pos = beds.mesh.geometry.getAttribute('position');
    const keep = beds.mesh.geometry.getAttribute('keep');
    expect(pos.count).toBe(posts.length * BED_VERTS);
    let off = 0;
    for (let p = 0; p < posts.length; p++) {
      const o = p * BED_VERTS;
      // Centre vertex: on its own ground, full bed.
      expect(keep.getX(o)).toBe(1);
      expect(pos.getY(o)).toBeGreaterThan(field.groundAt(posts[p]!.x, posts[p]!.y));
      for (let v = o; v < o + BED_VERTS; v++) {
        const x = pos.getX(v) + size / 2, y = pos.getZ(v) + size / 2;
        expect(pos.getY(v)).toBeGreaterThan(field.groundAt(x, y));
        // Never painted down the cliff: a vertex well below its plateau post keeps no bed.
        if (field.groundAt(posts[p]!.x, posts[p]!.y) - field.groundAt(x, y) > 0.4) {
          expect(keep.getX(v)).toBe(0);
          off++;
        }
      }
    }
    expect(off).toBeGreaterThan(0);
  });

  it('labels, icons and feed lines exist for the kind, its events and its alert', () => {
    expect(KIND_LABEL.post).toBe('Forward post');
    expect(ICONS.post).toBeDefined();
    expect(ICONS.post_captured).toBeDefined();
    expect(ICONS.post_lost).toBeDefined();
    expect(ALERT_LABEL.post_contested).toBe('Post');
    expect(ALERT_TEXT.post_contested).toContain('forward post');
    const ev = { kind: 'post_lost', tick: 1, plane: 'surface', x: 1, y: 1, side: 'se' } as const;
    expect(eventText(ev, 'nw', view.match!)).toEqual({ text: 'Forward post lost', sev: 'bad' });
    const centre = { kind: 'post_captured', tick: 1, plane: 'surface', x: point.x, y: point.y, side: 'nw' } as const;
    expect(eventText(centre, 'nw', view.match!)).toEqual({ text: 'Contested point captured', sev: 'good' });
  });
});
