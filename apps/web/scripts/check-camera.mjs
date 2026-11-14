// Real paused match, real renderer and live HUD. No fabricated panel or entity geometry. Run in the isolated environment
// described in check-layout.mjs. All four planes at several desktop sizes, after the chapter banner clears: the
// rendered Spire lies wholly inside the measured HUD-safe rectangle, and camera focus never moves HUD bounds.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const web = process.env.AC_LAYOUT_URL ?? 'http://127.0.0.1:5173';
const server = process.env.AC_LAYOUT_SERVER_URL ?? 'http://127.0.0.1:2567';
const token = process.env.AC_DEV_ADMIN_TOKEN;
assert(token, 'AC_DEV_ADMIN_TOKEN is required for the isolated audit server');
const out = process.env.AC_LAYOUT_OUTPUT ?? '/tmp/ac-camera';
async function admin(path, body) {
  const response = await fetch(`${server}/dev/matches${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(response.ok, `dev-admin ${path}: ${response.status}`);
  return response.json();
}
await mkdir(out, { recursive: true });
const match = await admin('', { mode: 'pvp', seed: 42, speed: 0 });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
});
const reports = [];
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(`${web}/?renderer=webgl&debug#r=${match.roomId}&t=${match.tokens.nw}`);
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.view);
  await page.evaluate(() => document.fonts.ready);
  // Native pointer focus must not take camera keys away from the match.
  await page.evaluate(async () => {
    const { setKeyLayout } = await import('/src/keymap.ts');
    setKeyLayout('wasd');
  });
  const hudButton = page.locator('#production-surface-units');
  await hudButton.click();
  const pointerFocus = await hudButton.evaluate((button) => ({
    focused: document.activeElement === button,
    outline: getComputedStyle(button).outlineStyle,
  }));
  assert(pointerFocus.focused, 'HUD click must exercise real native button focus');
  assert.equal(pointerFocus.outline, 'none', 'mouse-focused HUD button has no focus ring');
  for (const key of ['w', 'ArrowRight']) {
    const before = await page.evaluate(() => {
      const rig = window.__agentCommand.world.rig;
      return { x: rig.tx, y: rig.tz };
    });
    await page.keyboard.down(key);
    await page.waitForFunction(({ x, y }) => {
      const rig = window.__agentCommand.world.rig;
      return Math.hypot(rig.tx - x, rig.tz - y) > 0.05;
    }, before);
    await page.keyboard.up(key);
    assert.equal(await hudButton.getAttribute('aria-selected'), 'true', `${key}: mouse-focused tab does not capture camera input`);
  }
  await hudButton.evaluate((button) => {
    button.dataset.smokeActivations = '0';
    button.addEventListener('click', () => { button.dataset.smokeActivations = String(Number(button.dataset.smokeActivations) + 1); });
  });
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  assert.equal(await hudButton.getAttribute('data-smoke-activations'), '2', 'Space and Enter retain native button activation');
  await page.keyboard.press('Tab');
  const keyboardFocus = await page.evaluate(() => ({
    visible: document.activeElement.matches(':focus-visible'),
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  assert(keyboardFocus.visible && keyboardFocus.outline !== 'none', 'keyboard users retain a visible focus ring');
  for (const [width, height] of [[1920, 1080], [1600, 900], [1280, 800], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    for (const plane of ['surface', 'depths', 'sky', 'orbit']) {
      await page.evaluate((plane) => {
        const { world, game } = window.__agentCommand;
        game().goTo(plane);
        world.rig.holdDive(1);
        world.rig.centerOn(0, game().view.match.armies.find(a => a.id === 'nw').spireAt);
      }, plane);
      await page.waitForTimeout(400);
      // The transient chapter banner intentionally crosses the world during a plane dive.
      await page.locator('.plane-banner').evaluate(async (banner) => {
        await Promise.all(banner.getAnimations().map((animation) => animation.finished));
      });
      const measured = await page.evaluate((plane) => {
        const Vector3 = window.__agentCommand.world.rig.camera.position.constructor;
        const { world } = window.__agentCommand;
        const rig = world.rig;
        const area = rig.safeArea;
        const panelBoxes = () => [...document.querySelectorAll('.topbar, .card, .journal-col, .field-col')].map((el) => el.getBoundingClientRect().toJSON());
        const before = panelBoxes();
        // Camera-only changes cannot move any HUD track, including after a focus jump.
        rig.lookAtTile(32, 32);
        rig.update(performance.now(), 0, 0);
        const after = panelBoxes();
        rig.centerOn(0, window.__agentCommand.game().view.match.armies.find(a => a.id === 'nw').spireAt);
        rig.update(performance.now(), 0, 0);
        rig.camera.updateMatrixWorld();
        const body = world.entities.spires.root.getObjectByName(`spire-nw-${plane}`);
        if (!body?.visible) throw new Error('own Spire not rendered');
        const point = new Vector3();
        const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
        body.traverseVisible(mesh => {
          if (!mesh.isMesh) return;
          const positions = mesh.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).project(rig.camera);
            const x = (point.x + 1) * innerWidth / 2;
            const y = (1 - point.y) * innerHeight / 2;
            bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
            bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
          }
        });
        return { area, bounds, before, after };
      }, plane);
      const label = `${width}x${height}-${plane}`;
      reports.push({ label, ...measured });
      await page.screenshot({ path: join(out, `${label}.png`) });
      assert.deepEqual(measured.before, measured.after, `${label}: camera focus shifted HUD layout`);
      const { area, bounds } = measured;
      assert(bounds.left >= area.left && bounds.right <= area.right && bounds.top >= area.top && bounds.bottom <= area.bottom,
        `${label}: Spire outside clear world rectangle: ${JSON.stringify({ area, bounds })}`);
    }
  }
} finally {
  await browser.close();
  await admin(`/${match.roomId}/end`, {});
  await writeFile(join(out, 'camera.json'), JSON.stringify(reports, null, 2));
}
console.log(`${reports.length} camera views: entire Spire inside HUD-safe area; no layout shift. Screenshots/report: ${out}`);
