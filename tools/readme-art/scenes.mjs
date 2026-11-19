import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const Q = '?renderer=webgl&debug&quality=full';
const MAP = '&map=archipelago&mapSeed=5527&size=48';
const MIN = 20 * 60;

export async function run({ context, out, web, admin, log, errors, want }) {
  const newPage = async (label) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push({ label, message: e.message }));
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ label, console: m.text() }); });
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const shot = async (page, name) => {
    const t0 = Date.now();
    await page.screenshot({ path: join(out, `${name}.png`), timeout: 600000, animations: 'disabled' });
    const perf = await page.evaluate(() => { const p = window.__agentCommand?.world?.perf; return p && { fps: p.fps, frameMs: Math.round(p.frameMs) }; }).catch(() => undefined);
    log('shot', name, `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(perf));
  };
  const idle = (page) => page.waitForFunction(() => !document.querySelector('.prematch[aria-busy="true"]'), undefined, { timeout: 60000 });
  /** The build's version without its commit (no hashes in committed media). */
  const plainVersion = (page) => page.evaluate(() => { const v = document.querySelector('.home-version'); if (v) v.textContent = v.textContent.replace(/\s*·.*$/, ''); });

  async function joinGame(page, hash) {
    await page.goto(`${web}/${Q}#${hash}`);
    await page.waitForFunction(() => !!window.__agentCommand?.game()?.view && !document.documentElement.dataset.loading, undefined, { timeout: 300000 });
    await page.evaluate(() => document.fonts.ready);
  }
  /** Camera: plane, tile, distance (tiles of a 48 map), yaw/pitch (radians); `dive` holds a dive at that progress. */
  async function frame(page, { plane, x, y, dist, yaw, pitch }) {
    await page.evaluate(({ plane, x, y, dist, yaw, pitch }) => {
      const d = window.__agentCommand;
      const rig = d.world.rig;
      d.game()?.goTo?.(plane);
      rig.holdDive(1);
      if (x !== undefined) rig.lookAtTile(x, y);
      if (dist !== undefined) rig.dist = dist * d.world.size / 48;
      if (yaw !== undefined) rig.yaw = yaw;
      if (pitch !== undefined) rig.pitch = pitch;
    }, { plane, x, y, dist, yaw, pitch });
    await sleep(1500);
    await page.evaluate(() => window.__agentCommand.world.rig.holdDive(undefined));
  }
  async function god(roomId, plane) {
    return admin(`/${roomId}/god?detail=entities${plane ? `&plane=${plane}` : ''}`);
  }
  const near = (list, p) => list.slice().sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  const toward = (a, b, k) => ({ x: Math.round((a.x + (b.x - a.x) * k) * 2) / 2, y: Math.round((a.y + (b.y - a.y) * k) * 2) / 2 });

  /** A developed duel between built-in bots (every seat a bot), fast-forwarded to `minutes`, then paused. */
  async function developedMatch(minutes) {
    const match = await admin('', { mode: 'agents', opponent: 'veteran', seed: 5527, speed: 50, rules: { terrain: 'archipelago' } });
    for (;;) {
      const info = await admin(`/${match.roomId}`);
      if (info.tick >= minutes * MIN) break;
      if (Object.values(info.outcomes).some((o) => o && o !== 'running')) log('outcomes', JSON.stringify(info.outcomes));
      await sleep(1000);
    }
    await admin(`/${match.roomId}/speed`, { speed: 0 });
    await admin(`/${match.roomId}/cheat`, { op: 'give', army: 'nw', alloy: 900, energy: 350 });
    const g = await god(match.roomId);
    writeFileSync(join(out, `god-${match.roomId}.json`), JSON.stringify(g, null, 1));
    const spires = Object.fromEntries(g.entities.filter((e) => e.kind === 'spire' && e.plane === 'surface').map((e) => [e.side, e]));
    log('match', match.roomId, 'tick', g.tick, 'spires', JSON.stringify(spires));
    return { match, spires, centre: { x: 24, y: 24 } };
  }
  const cheat = (roomId, body) => admin(`/${roomId}/cheat`, body).then((r) => { log('cheat', JSON.stringify(body), r.ids?.length ?? '', r.error ?? ''); return r; }, (e) => { log('cheat failed', JSON.stringify(body), e.message); });
  const spawn = (roomId, army, kind, count, at, plane) => cheat(roomId, { op: 'spawn', army, kind, count, x: at.x, y: at.y, ...(plane ? { plane } : {}) });
  /** Run the paused match in real time for `ms`, then pause it on that moment for the (slow, software-rendered) capture. */
  async function battle(roomId, ms) {
    await admin(`/${roomId}/speed`, { speed: 1 });
    await sleep(ms);
    await admin(`/${roomId}/speed`, { speed: 0 });
  }
  /** `count` captures `ms` of real-time play apart, each on a paused moment: `${name}-1` … */
  async function burst(page, roomId, name, count, ms) {
    for (let i = 1; i <= count; i++) { await battle(roomId, ms); await shot(page, `${name}-${i}`); }
  }
  /** Two open-ground Surface spots `sep` tiles apart (on either diagonal), clear of structures and lodes, nearest `target`. */
  const openPair = (page, target, sep) => page.evaluate(({ target, sep }) => {
    const w = window.__agentCommand.world;
    const view = window.__agentCommand.game().view;
    const size = w.size;
    const codes = w.layers.surface.field.terrainCodes;
    const busy = [...w.entities.tracks.values()].map((t) => t.e).filter((e) => e.plane === 'surface' && !['tank', 'trooper', 'flak'].includes(e.kind)).concat(view.lodes ?? []);
    const open = (x, y) => x >= 0 && y >= 0 && x < size && y < size && (codes[y * size + x] === 0 || codes[y * size + x] === 3);
    const clear = (cx, cy, r) => {
      if (busy.some((e) => Math.hypot(e.x - cx, e.y - cy) < r + 2)) return false;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r && !open(x, y)) return false;
      return true;
    };
    const d = sep / Math.SQRT2;
    let best;
    for (const [ux, uy] of [[1, 1], [1, -1]]) for (let y = 4; y < size - 4; y += 0.5) for (let x = 4; x < size - 4; x += 0.5) {
      const a = { x, y }, b = { x: x + ux * d, y: y + uy * d }, m = { x: x + ux * d / 2, y: y + uy * d / 2 };
      if (!clear(a.x, a.y, 2) || !clear(b.x, b.y, 2) || !clear(m.x, m.y, 1.5)) continue;
      const s = Math.hypot(m.x - target.x, m.y - target.y);
      if (!best || s < best.s) best = { a, b, m, s };
    }
    return best;
  }, { target, sep });
  /** Hover screen points spiralling out from `from` until the armed build tool's ghost is valid; returns that point. */
  async function validGhost(page, from) {
    const points = [];
    for (let dy = -280; dy <= 200; dy += 60) for (let dx = -420; dx <= 420; dx += 60) points.push({ x: from.x + dx, y: from.y + dy });
    points.sort((p, q) => Math.hypot(p.x - from.x, p.y - from.y) - Math.hypot(q.x - from.x, q.y - from.y));
    for (const p of points.slice(0, 24)) {
      await page.mouse.move(p.x, p.y);
      const ok = await page.waitForFunction(() => {
        const pv = window.__agentCommand.game().overlay.preview;
        return pv?.footprint && !pv.footprint.reason && pv.footprint.cells.every((c) => c.valid);
      }, undefined, { timeout: 2500 }).then(() => true, () => false);
      if (ok) return p;
    }
    return undefined;
  }
  /** Screen position of a Surface tile in the current camera. */
  const screenOf = (page, tile) => page.evaluate(({ x, y }) => {
    const w = window.__agentCommand.world;
    const cam = w.rig.camera;
    cam.updateMatrixWorld();
    const mul = (e, p) => [0, 1, 2, 3].map((i) => e[i] * p[0] + e[4 + i] * p[1] + e[8 + i] * p[2] + e[12 + i] * p[3]);
    const c = mul(cam.projectionMatrix.elements, mul(cam.matrixWorldInverse.elements, [x - w.size / 2, 0.12, y - w.size / 2, 1]));
    return { x: Math.round((c[0] / c[3] + 1) / 2 * innerWidth), y: Math.round((1 - c[1] / c[3]) / 2 * innerHeight) };
  }, tile);

  // ------------------------------------------------------------------ menus
  if (want('menus')) {
    const page = await newPage('menus');
    await page.goto(`${web}/${Q}${MAP}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-lobby-action="play"]').waitFor({ timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(9000);
    await plainVersion(page);
    await shot(page, 'home');

    await page.locator('[data-lobby-action="commanders"]').click();
    const form = page.locator('form.named-commander-create');
    await form.waitFor({ timeout: 60000 });
    for (const [name, planes] of [['Claude Surface', ['surface']], ['Codex Depths', ['depths']], ['OpenCode Sky', ['sky', 'orbit']]]) {
      await form.locator('input[aria-label="Commander name"]').fill(name);
      for (const p of planes) if (await form.locator(`[data-plane="${p}"]`).getAttribute('aria-pressed') !== 'true') await form.locator(`[data-plane="${p}"]`).click();
      for (const p of ['surface', 'depths', 'sky', 'orbit']) if (!planes.includes(p) && await form.locator(`[data-plane="${p}"]`).getAttribute('aria-pressed') === 'true') await form.locator(`[data-plane="${p}"]`).click();
      await form.locator('button[type="submit"]').click();
      await page.getByText(name).first().waitFor({ timeout: 30000 });
      await sleep(1000);
    }
    await form.locator('input[aria-label="Commander name"]').fill('');
    await page.locator('button:has-text("Claude Code")').first().click();
    await page.mouse.move(1250, 1000);
    await sleep(4000);
    await shot(page, 'commanders');
    writeFileSync(join(out, 'commanders.html'), await page.content());

    await page.locator('[data-lobby-action="home"]').first().click();
    await page.locator('[data-lobby-action="create"]').waitFor();
    await page.locator('[data-lobby-action="create"]').click();
    await page.locator('.lobby-army[data-side="se"]').waitFor({ timeout: 60000 });
    await idle(page);
    await page.locator('.lobby-army[data-side="se"] select[data-occupant]').first().selectOption('bot');
    await idle(page);
    // The default battlefield (any other map counts as custom rules in a lobby).
    await page.locator('[data-map="ridges"]').first().click();
    await idle(page);
    try {
      await page.locator('[data-lobby-action="seat-mode-nw-planes"]').click();
      await idle(page);
      writeFileSync(join(out, 'create.html'), await page.content());
      const depths = page.locator('.lobby-army[data-side="nw"] select[data-occupant*="depths"]').first();
      const values = await depths.locator('option').evaluateAll((o) => o.map((x) => x.value));
      log('depths options', JSON.stringify(values));
      const codex = values.find((v) => v.startsWith('commander:'));
      if (codex) { await depths.selectOption(codex); await idle(page); }
      for (const role of ['sky', 'orbit']) { await page.locator(`.lobby-army[data-side="nw"] select[data-occupant*="${role}"]`).first().selectOption('bot'); await idle(page); }
    } catch (e) { log('per-plane setup failed', e.message); }
    await page.mouse.move(1500, 1000);
    await sleep(3000);
    await shot(page, 'create-game-bot');
    await page.close();
  }

  // ------------------------------------------------------------------ Surface: fight, command card, placement, console
  if (want('surface')) {
    const { match, spires, centre } = await developedMatch(9);
    const nw = spires.nw;
    const page = await newPage('surface');
    await joinGame(page, `r=${match.roomId}&t=${match.tokens.nw}`);
    // Two real armies on open ground in front of the NW base, in range of each other; the built-in bots command both.
    const pair = await openPair(page, toward(nw, centre, 0.5), 5);
    log('fight', JSON.stringify(pair));
    await frame(page, { plane: 'surface', x: pair.m.x, y: pair.m.y, dist: 16, pitch: 0.9 });
    for (const [kind, n] of [['tank', 6], ['trooper', 8], ['flak', 2]]) await spawn(match.roomId, 'nw', kind, n, pair.a);
    for (const [kind, n] of [['tank', 6], ['trooper', 8], ['flak', 2]]) await spawn(match.roomId, 'se', kind, n, pair.b);
    await battle(match.roomId, 1500);
    // Select our army there (a box select): the command card shows the selection, orders and production.
    await page.evaluate(() => {
      const g = window.__agentCommand.game();
      const sel = g.controls.selection.get('surface');
      sel.clear();
      for (const [id, t] of window.__agentCommand.world.entities.tracks) if (t.e.side === g.view.army && t.e.plane === 'surface' && ['tank', 'trooper', 'flak'].includes(t.e.kind)) sel.add(id);
      g.renderCard();
    });
    await burst(page, match.roomId, 'fight', 6, 1200);
    const card = await page.evaluate(() => document.querySelector('.card')?.getBoundingClientRect().toJSON());
    writeFileSync(join(out, 'card-rect.json'), JSON.stringify(card));
    log('card', JSON.stringify(card));

    // Placement: arm a Turret from the structures tab and hover until the ghost sits on valid ground inside the build
    // radius (place2), then over the Spire, where it turns red (place-red).
    await page.evaluate(() => { const g = window.__agentCommand.game(); g.controls.selection.get('surface').clear(); g.renderCard(); });
    const base = toward(nw, centre, 0.2);
    await frame(page, { plane: 'surface', x: base.x, y: base.y, dist: 22 });
    await page.locator('#production-surface-structures').click().catch((e) => log('structures tab', e.message));
    await page.locator('button[aria-label="Build Turret"]').click({ timeout: 30000 });
    await sleep(3000);
    const ghost = await validGhost(page, { x: 960, y: 470 });
    log('valid ghost at', JSON.stringify(ghost));
    await sleep(2500);
    await shot(page, 'place2');
    const spire = await screenOf(page, nw);
    await page.mouse.move(spire.x, spire.y - 30);
    await sleep(3000);
    await shot(page, 'place-red');
    await page.keyboard.press('Escape');

    // Agent console over the base.
    await frame(page, { plane: 'surface', x: base.x, y: base.y, dist: 26 });
    await page.locator('button[aria-label="Agent console"]').click();
    await sleep(4000);
    await shot(page, 'console');
    await page.close();
  }

  // ------------------------------------------------------------------ Depths, Sky, Orbit, the dive
  if (want('planes')) {
    const { match, spires, centre } = await developedMatch(9);
    const nw = spires.nw;
    const page = await newPage('planes');
    await joinGame(page, `r=${match.roomId}&t=${match.tokens.nw}`);
    // Depths: intruders in our tunnels.
    const dg = await god(match.roomId, 'depths');
    const diggers = dg.entities.filter((e) => e.side === 'nw' && e.kind === 'digger');
    const dig = near(diggers, toward(nw, centre, 0.35))[0] ?? toward(nw, centre, 0.3);
    log('depths focus', JSON.stringify(dig));
    await frame(page, { plane: 'depths', x: dig.x + 2, y: dig.y + 2, dist: 22 });
    await spawn(match.roomId, 'se', 'trooper', 4, { x: dig.x + 1, y: dig.y + 1 }, 'depths');
    await spawn(match.roomId, 'se', 'sapper', 2, { x: dig.x + 1.5, y: dig.y + 0.5 }, 'depths');
    await spawn(match.roomId, 'nw', 'warden', 2, { x: dig.x - 0.5, y: dig.y - 0.5 }, 'depths');
    await battle(match.roomId, 2000);
    await burst(page, match.roomId, 'depths', 4, 1500);
    // Sky: a dogfight around one of our drifting islands.
    const sg = await god(match.roomId, 'sky');
    const island = near(sg.entities.filter((e) => e.kind === 'island'), toward(nw, centre, 0.5))[0] ?? toward(nw, centre, 0.5);
    log('sky focus', JSON.stringify(island));
    await frame(page, { plane: 'sky', x: island.x, y: island.y, dist: 22 });
    await spawn(match.roomId, 'nw', 'interceptor', 5, { x: island.x - 3, y: island.y - 3 });
    await spawn(match.roomId, 'nw', 'bomber', 2, { x: island.x - 4, y: island.y - 2 });
    await spawn(match.roomId, 'se', 'interceptor', 5, { x: island.x + 3, y: island.y + 3 });
    await spawn(match.roomId, 'se', 'gunship', 2, { x: island.x + 4, y: island.y + 2 });
    await battle(match.roomId, 2000);
    await burst(page, match.roomId, 'sky', 4, 1500);
    // Orbit: our solar arrays toward the nearest asteroid, a tug by it, and fleets meeting in between.
    const og = await god(match.roomId, 'orbit');
    const solars = og.entities.filter((e) => e.side === 'nw' && e.kind === 'solar');
    const arrays = solars.length ? { x: solars.reduce((s, e) => s + e.x, 0) / solars.length, y: solars.reduce((s, e) => s + e.y, 0) / solars.length } : toward(nw, centre, 0.25);
    const rock = near(og.entities.filter((e) => e.kind === 'asteroid'), arrays)[0];
    const far = rock ? Math.hypot(rock.x - arrays.x, rock.y - arrays.y) : Infinity;
    const orbAt = far < 30 ? toward(arrays, rock, 0.5) : toward(arrays, centre, 0.3);
    log('orbit focus', JSON.stringify({ arrays, rock, far, orbAt }));
    await frame(page, { plane: 'orbit', x: orbAt.x, y: orbAt.y, dist: far < 30 ? Math.max(26, far * 1.15) : 26 });
    if (far < 30) await spawn(match.roomId, 'nw', 'tug', 1, toward(rock, arrays, 1.8 / far));
    else await spawn(match.roomId, 'nw', 'tug', 1, toward(arrays, orbAt, 0.6));
    await spawn(match.roomId, 'nw', 'lancer', 3, toward(arrays, orbAt, 0.7));
    await spawn(match.roomId, 'nw', 'skiff', 4, toward(arrays, orbAt, 0.85));
    await spawn(match.roomId, 'se', 'skiff', 4, toward(arrays, orbAt, 1.2));
    await spawn(match.roomId, 'se', 'lancer', 2, toward(arrays, orbAt, 1.3));
    await battle(match.roomId, 2000);
    await burst(page, match.roomId, 'orbit', 4, 1500);
    // The stack: the Surface at rest, zoomed out and tilted so the Depths slab shows below it.
    for (const pitch of [0.5, 0.62]) {
      await frame(page, { plane: 'surface', x: 24, y: 24, dist: 72, pitch });
      await sleep(2500);
      await shot(page, `stack-${Math.round(pitch * 100)}`);
    }
    await page.close();
  }

  // ------------------------------------------------------------------ Observer: a private all-bot lobby match, watched read-only
  if (want('observer')) {
    const page = await newPage('observer');
    await page.goto(`${web}/${Q}${MAP}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-lobby-action="create"]').waitFor({ timeout: 120000 });
    await page.locator('[data-lobby-action="create"]').click();
    await page.locator('.lobby-army[data-side="se"]').waitFor({ timeout: 60000 });
    await idle(page);
    await page.locator('[data-lobby-action="move-observer"]').click();
    await idle(page);
    for (const side of ['nw', 'se']) { await page.locator(`.lobby-army[data-side="${side}"] select[data-occupant]`).first().selectOption('bot'); await idle(page); }
    const before = new Set((await admin('')).matches.map((m) => m.roomId));
    await page.locator('[data-lobby-action="start-lobby"]').click();
    let roomId;
    for (let i = 0; i < 120 && !roomId; i++) { await sleep(500); roomId = (await admin('')).matches.find((m) => !before.has(m.roomId))?.roomId; }
    log('observer match', roomId);
    await admin(`/${roomId}/speed`, { speed: 50 });
    for (;;) { const info = await admin(`/${roomId}`); if (info.tick >= 9 * MIN) break; await sleep(500); }
    await admin(`/${roomId}/speed`, { speed: 0 });
    await page.waitForFunction(() => !!window.__agentCommand?.world?.view && !document.documentElement.dataset.loading, undefined, { timeout: 300000 });
    await page.evaluate(() => document.fonts.ready);
    // A clash in mid-field, framed on the Surface.
    const g = await god(roomId, 'surface');
    writeFileSync(join(out, `god-${roomId}.json`), JSON.stringify(g, null, 1));
    const sp = Object.fromEntries(g.entities.filter((e) => e.kind === 'spire').map((e) => [e.side, e]));
    const mid = toward(sp.nw, sp.se, 0.5);
    await frame(page, { plane: 'surface', x: mid.x, y: mid.y, dist: 26 });
    for (const [kind, n] of [['tank', 5], ['trooper', 5], ['flak', 2]]) await spawn(roomId, 'nw', kind, n, toward(sp.nw, sp.se, 0.42));
    for (const [kind, n] of [['tank', 5], ['trooper', 5], ['flak', 2]]) await spawn(roomId, 'se', kind, n, toward(sp.nw, sp.se, 0.58));
    await battle(roomId, 7000);
    await sleep(3000);
    writeFileSync(join(out, 'observer.html'), await page.content());
    await shot(page, 'observer2');
    await page.close();
  }
}
