/**
 * Surface forward posts (DESIGN §4.2 Outposts): home posts near each Spire and contested points, hold zones on the
 * shared capture rule (planes/capture.ts). A held post gives its owner vision (sim/vision.ts), a build radius
 * (rules/stats.ts; contested points their own, by default none) and a capped healing pool; holding a contested point
 * scores the last time-cap tiebreak (sim/tick.ts). Posts yield no income and are never damaged. The holder is public;
 * capture progress follows the island fog rule (agent/present.ts).
 */
import { TICK_RATE } from '../rules/contract.ts';
import { matchPosts } from '../maps/posts.ts';
import type { MapPost } from '../maps/types.ts';
import { HOLD_ZONE_HP } from '../sim/constants.ts';
import type { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { type Army, isArmy, NEUTRAL } from '../util/teams.ts';
import { CAPTURE_DONE, holders } from './capture.ts';

export class ForwardPosts {
  /**
   * Place the match's posts (rules.surface.postsEnabled; maps/posts.ts matchPosts: the document's, else the recipe's),
   * in army order then the contested points. With homePostsOwned each army starts holding its home posts.
   */
  spawnPosts(this: Sim, posts: readonly MapPost[], home: { readonly x: number; readonly y: number }): void {
    if (!this.econ.postsEnabled) return;
    const slots = this.allArmies.map((a) => this.armySlot[a]!);
    // Posts take no neutral creation serial: asteroids keep their orbit blocks of `sides` serials (a centre point is a
    // single post), and posts are tracked by `posts`, never by serial.
    const serial = this.seqs[NEUTRAL]!;
    for (const p of matchPosts({ posts, terrain: this.terrain, size: this.size }, this.mapDocument.sides, home, this.rules.map, slots)) {
      const e = this.add('post', NEUTRAL, 'surface', p.x, p.y);
      e.hp = e.maxHp = HOLD_ZONE_HP;
      e.state = 'idle';
      const army = p.kind === 'home' ? slots.indexOf(p.slot!) : -1;
      if (army >= 0 && this.econ.homePostsOwned) this.setSide(e, army);
      this.posts.push(e);
      this.postHome.push(army);
    }
    this.seqs[NEUTRAL] = serial;
    this.postHealShare = new Float64Array(this.posts.length);
  }

  /** Capture, then healing. Every Surface unit holds a post it stands near (in transit between planes it does not). */
  updatePosts(this: Sim): void {
    if (this.posts.length === 0) return;
    const r2 = this.econ.postCaptureRadius * this.econ.postCaptureRadius;
    for (let i = 0; i < this.posts.length; i++) {
      const post = this.posts[i]!;
      const contested = this.postHome[i]! < 0;
      if (isArmy(post.side)) {
        const stats = this.armies[post.side]!.stats;
        stats.postTicks++;
        if (contested) stats.pointTicks++;
      }
      const needed = contested ? this.econ.contestedCaptureTicks : this.econ.postCaptureTicks;
      holders.fill(0);
      let anyone = false;
      for (const u of this.ents) {
        if (!u.unit || u.dead || u.hp <= 0 || u.plane !== 'surface' || u.transitKind || !isArmy(u.side)) continue;
        const dx = u.x - post.x;
        const dy = u.y - post.y;
        if (dx * dx + dy * dy > r2) continue;
        holders[u.side]!++;
        anyone = true;
      }
      const holder = anyone ? this.zoneClaimant(post) : NEUTRAL;
      if (this.advanceCapture(post, holder, anyone, needed) === CAPTURE_DONE) this.capturePost(post, holder as Army);
      this.settleCapture(post, holder, anyone, needed, 'idle');
    }
    this.healAtPosts();
  }

  /**
   * Each held post splits a pool of postHealPool HP/s evenly among the wounded live Surface units of its holder's
   * alliance within postHealRadius, at most postHealRate HP/s each; a unit several posts cover takes the largest share
   * (never their sum). Shares come from counts alone, so the result never depends on unit or post order.
   */
  healAtPosts(this: Sim): void {
    if (this.econ.postHealPool <= 0 || this.econ.postHealRate <= 0) return;
    const r2 = this.econ.postHealRadius * this.econ.postHealRadius;
    const share = this.postHealShare;
    for (let i = 0; i < this.posts.length; i++) {
      const post = this.posts[i]!;
      share[i] = 0;
      if (!isArmy(post.side)) continue;
      let wounded = 0;
      for (const u of this.ents) {
        if (!this.healable(u) || this.hostile(post.side, u.side)) continue;
        const dx = u.x - post.x;
        const dy = u.y - post.y;
        if (dx * dx + dy * dy <= r2) wounded++;
      }
      if (wounded) share[i] = Math.min(this.econ.postHealRate, this.econ.postHealPool / wounded) / TICK_RATE;
    }
    for (const u of this.ents) {
      if (!this.healable(u)) continue;
      let step = 0;
      for (let i = 0; i < this.posts.length; i++) {
        const post = this.posts[i]!;
        if (share[i]! <= step || this.hostile(post.side, u.side)) continue;
        const dx = u.x - post.x;
        const dy = u.y - post.y;
        if (dx * dx + dy * dy <= r2) step = share[i]!;
      }
      if (step > 0) u.hp = Math.min(u.maxHp, u.hp + step);
    }
  }

  /** A live, wounded army Surface unit on the ground (not between planes): what a post heals. */
  healable(this: Sim, u: Ent): boolean {
    return u.unit && !u.dead && u.hp > 0 && u.hp < u.maxHp && u.plane === 'surface' && !u.transitKind && isArmy(u.side);
  }

  /**
   * `army` takes `post`. The previous holder hears post_lost. Safety reset (DESIGN §4.2 Outposts, not a feature): a
   * Surface rally it had set within postHealRadius falls back to its default, so reinforcements stop walking into the
   * captor.
   */
  capturePost(this: Sim, post: Ent, army: Army): void {
    const prev = post.side;
    if (isArmy(prev)) {
      const t = this.armies[prev]!;
      const rally = t.rally.surface;
      const dx = rally.x - post.x;
      const dy = rally.y - post.y;
      if (dx * dx + dy * dy <= this.econ.postHealRadius * this.econ.postHealRadius) t.rally.surface = this.defaultRally(prev, 'surface');
      this.emit([prev], 'post_lost', 'surface', post.x, post.y, 'post', army);
    }
    this.takeZone(post, army);
    this.armies[army]!.stats.postsCaptured++;
    this.emit([army], 'post_captured', 'surface', post.x, post.y, 'post', army);
  }
}
