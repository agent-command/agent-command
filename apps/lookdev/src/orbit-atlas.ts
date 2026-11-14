/** Orbit art study, deliberately isolated from simulation and the live client's renderer. */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DoubleSide, DynamicDrawUsage, InstancedMesh, Mesh, MeshBasicNodeMaterial, Object3D,
  PlaneGeometry, SRGBColorSpace,
} from 'three/webgpu';
import { attribute, color, float, mix, positionWorld, smoothstep, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cel } from './dirs/shared.ts';
import { clock, type Ctx, type V3 } from './kit.ts';

const BODY = '#dfd6ba', STEEL = '#9dacc0', IRON = '#39435e';
const TEAM = ['#3aa8ff', '#ff4f5e'];
const SUN_HALF = 0.67;
const SUN_ANGLE = -0.18;
const HEIGHT = 0.55;
type Kind = 'skiff' | 'lancer' | 'bastion' | 'solar' | 'tug' | 'interceptor';
type Ship = { kind: Kind; team: number; x: number; z: number; phase: number; index: number; mesh: InstancedMesh; scale: number };

/** One tapered block kit; +X is forward. Attributes survive merging into one draw per kind/team. */
function kit() {
  const parts: BufferGeometry[] = [];
  function part(g: BufferGeometry, paint: string, accent = 0) {
    const n = g.getAttribute('position').count, c = new Color(paint);
    const paints = new Float32Array(n * 3), accents = new Float32Array(n);
    for (let i = 0; i < n; i++) { c.toArray(paints, i * 3); accents[i] = accent; }
    g.setAttribute('paint', new BufferAttribute(paints, 3));
    g.setAttribute('accent', new BufferAttribute(accents, 1));
    parts.push(g);
  }
  function block(x: number, y: number, z: number, l: number, h: number, w: number, paint = BODY, accent = 0, taper = 1, yaw = 0) {
    const g = new BoxGeometry(l, h, w), p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getX(i) > 0) p.setZ(i, p.getZ(i) * taper);
    g.computeVertexNormals(); g.rotateY(yaw); g.translate(x, y, z); part(g, paint, accent);
  }
  function bus(x: number, y: number, z: number, radius: number, height: number, paint = BODY, accent = 0) {
    part(new CylinderGeometry(radius * 0.86, radius, height, 8).translate(x, y, z), paint, accent);
  }
  function finish() {
    const g = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    return g;
  }
  return { block, bus, finish };
}

function shipGeometry(kind: Kind): BufferGeometry {
  const k = kit();
  if (kind === 'skiff' || kind === 'interceptor') {
    // Fighter: dart; ascended Sky fighter keeps its broad delta, rather than becoming a frigate.
    const span = kind === 'interceptor' ? 1.05 : 0.64;
    k.block(0, 0, 0, 0.72, 0.15, 0.28, BODY, 0, 0.06);
    k.block(-0.12, -0.02, 0, 0.34, 0.07, span, STEEL, 0, 0.12);
    k.block(-0.02, 0.11, 0, 0.29, 0.07, 0.18, BODY, 1, 0.4);
    k.block(-0.28, 0.04, 0, 0.08, 0.21, 0.28, BODY, 1);
    k.block(-0.4, 0, 0, 0.12, 0.12, 0.18, IRON);
  } else if (kind === 'lancer') {
    k.block(-0.13, 0, 0, 1.1, 0.29, 0.43, BODY, 0, 0.6);
    k.block(0.66, 0.01, 0, 0.7, 0.09, 0.12, IRON);
    k.block(-0.2, 0.19, 0, 0.53, 0.09, 0.31, BODY, 1, 0.8);
    k.block(-0.55, 0, 0, 0.11, 0.31, 0.45, BODY, 1);
    k.block(-0.75, 0, 0, 0.23, 0.22, 0.34, IRON);
    k.block(-0.36, 0.3, 0, 0.19, 0.15, 0.18, STEEL);
  } else if (kind === 'bastion') {
    k.block(0, 0, 0, 1.04, 0.34, 0.94, BODY, 0, 0.65);
    k.block(-0.08, 0.23, 0, 0.51, 0.12, 0.66, BODY, 1);
    k.block(-0.45, 0.02, 0, 0.12, 0.36, 0.96, BODY, 1);
    for (const z of [-0.53, 0.53]) {
      k.bus(0.12, 0.22, z, 0.16, 0.15, STEEL);
      k.block(0.33, 0.28, z, 0.36, 0.07, 0.09, IRON);
    }
    k.block(-0.62, 0, 0, 0.2, 0.22, 0.56, IRON);
  } else if (kind === 'solar') {
    k.bus(0, 0, 0, 0.24, 0.26);
    k.block(0, 0, 0, 0.09, 0.09, 1.9, STEEL);
    for (const z of [-0.72, 0.72]) k.block(0, 0.01, z, 0.83, 0.07, 0.68, IRON);
    k.block(0, 0.18, 0, 0.29, 0.07, 0.27, BODY, 1);
    k.block(-0.22, 0.03, 0, 0.07, 0.29, 0.3, BODY, 1);
    // Raised panel ribs remain structural steel, not additional paint values.
    for (const z of [-0.72, 0.72]) k.block(0, 0.065, z, 0.07, 0.06, 0.68, STEEL);
  } else {
    k.block(0, 0, 0, 0.72, 0.29, 0.62, BODY, 0, 0.75);
    for (const z of [-0.38, 0.38]) k.block(-0.14, 0, z, 0.55, 0.19, 0.17, IRON);
    k.block(0.02, 0.2, 0, 0.33, 0.09, 0.43, BODY, 1);
    k.block(-0.27, 0.02, 0, 0.09, 0.31, 0.64, BODY, 1);
    k.block(-0.55, 0, 0, 0.36, 0.09, 0.08, STEEL);
  }
  return k.finish();
}

function daylight(x: number, z: number): boolean {
  const along = x * Math.cos(SUN_ANGLE) + z * Math.sin(SUN_ANGLE);
  const across = -x * Math.sin(SUN_ANGLE) + z * Math.cos(SUN_ANGLE);
  return Math.abs(across) < Math.abs(along) * Math.tan(SUN_HALF);
}

function hullMaterial(team: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const p = positionWorld;
  const along = p.x.mul(Math.cos(SUN_ANGLE)).add(p.z.mul(Math.sin(SUN_ANGLE)));
  const across = p.x.mul(-Math.sin(SUN_ANGLE)).add(p.z.mul(Math.cos(SUN_ANGLE)));
  const light = smoothstep(-0.35, 0.35, along.abs().mul(Math.tan(SUN_HALF)).sub(across.abs()));
  const paint = mix(attribute('paint', 'vec3'), color(TEAM[team]!), attribute('accent', 'float'));
  // Night is desaturated and dimmed, not made transparent or culled. This is not server fog.
  const shaded = cel(paint as V3, '#777099');
  m.colorNode = mix(shaded.mul(color('#7b83bb')).mul(0.72), shaded, light);
  return m;
}

/** Texture is painted once. No per-frame canvas work, random sampling or texture uploads. */
function chartTexture(): CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2048;
  const c = canvas.getContext('2d')!;
  const size = 2048, u = size / 48;
  c.fillStyle = '#171e3a'; c.fillRect(0, 0, size, size);
  let seed = 1709;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  // Small translucent pigment blooms accumulate unevenly instead of a photographic space backdrop.
  for (let i = 0; i < 270; i++) {
    const x = rand() * size, y = 950 + Math.sin(x / 390) * 460 + (rand() - 0.5) * 560;
    const r = 50 + rand() * 230, g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, i % 3 === 0 ? 'rgba(127,83,140,.035)' : 'rgba(71,133,161,.03)');
    g.addColorStop(0.7, 'rgba(96,104,152,.015)'); g.addColorStop(1, 'rgba(96,104,152,0)');
    c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  c.save(); c.translate(size / 2, size / 2);
  for (let side = 0; side < 2; side++) {
    const angle = SUN_ANGLE + side * Math.PI;
    c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, size, angle - SUN_HALF, angle + SUN_HALF); c.closePath();
    c.fillStyle = 'rgba(214,190,124,.065)'; c.fill();
    c.strokeStyle = 'rgba(226,199,130,.55)'; c.lineWidth = 1.8; c.setLineDash([11, 8]);
    for (const a of [angle - SUN_HALF, angle + SUN_HALF]) {
      c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * size, Math.sin(a) * size); c.stroke();
    }
  }
  c.restore(); c.setLineDash([]);
  for (let i = 0; i <= 48; i++) {
    c.strokeStyle = i % 4 === 0 ? 'rgba(164,182,210,.15)' : 'rgba(164,182,210,.045)';
    c.lineWidth = 1; c.beginPath(); c.moveTo(i * u, 0); c.lineTo(i * u, size); c.moveTo(0, i * u); c.lineTo(size, i * u); c.stroke();
  }
  for (let i = 0; i < 115; i++) {
    const x = rand() * size, y = rand() * size;
    if (i % 7 === 0) {
      c.strokeStyle = 'rgba(184,201,221,.15)'; c.beginPath(); c.moveTo(x, y);
      c.lineTo(x + 30 + rand() * 80, y - 30 - rand() * 90); c.lineTo(x + 140, y - 40); c.stroke();
    }
    c.fillStyle = i % 5 === 0 ? '#a3b3c9' : '#5c708e';
    c.fillRect(x, y, i % 5 === 0 ? 3 : 1.5, i % 5 === 0 ? 3 : 1.5);
  }
  // Paper fibres stay subordinate to silhouettes.
  for (let i = 0; i < 13000; i++) {
    c.fillStyle = i % 2 ? 'rgba(227,221,198,.025)' : 'rgba(0,0,0,.035)';
    c.fillRect(rand() * size, rand() * size, 1, 1 + rand() * 5);
  }
  c.font = '18px monospace'; c.fillStyle = '#7a8aa4';
  for (let i = 4; i < 48; i += 4) { c.fillText(String(i).padStart(2, '0'), i * u + 7, 35); c.fillText(String(i).padStart(2, '0'), 12, i * u); }
  const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

function flatMaterial(hex: string, opacity = 1): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({ color: hex, transparent: opacity < 1, opacity, depthWrite: opacity === 1, side: DoubleSide });
}

export function assembleAtlas(ctx: Ctx) {
  const root = ctx.roots.orbit; ctx.scene.add(root);
  ctx.scene.backgroundNode = color('#171e3a');
  const chart = new Mesh(new PlaneGeometry(48, 48).rotateX(-Math.PI / 2), new MeshBasicNodeMaterial({ map: chartTexture() }));
  chart.position.y = -0.65; root.add(chart);
  const scratch = new Object3D(); scratch.rotation.order = 'YXZ';
  const strokeGeo = new BoxGeometry(1, 1, 1);
  function pool(geometry: BufferGeometry, material: MeshBasicNodeMaterial, count: number, dynamic = false) {
    const mesh = new InstancedMesh(geometry, material, count);
    if (dynamic) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Scene is bounded to a single 48-tile chart; dynamic pools cannot use their first frame's bounds.
    mesh.frustumCulled = false; root.add(mesh); return mesh;
  }
  function place(mesh: InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, bank = 0) {
    scratch.position.set(x, y, z); scratch.rotation.set(bank, yaw, 0); scratch.scale.set(sx, sy, sz);
    scratch.updateMatrix(); mesh.setMatrixAt(i, scratch.matrix);
  }
  function stroke(mesh: InstancedMesh, i: number, x: number, z: number, tx: number, tz: number, y: number, width: number) {
    const dx = tx - x, dz = tz - z;
    place(mesh, i, (x + tx) / 2, y, (z + tz) / 2, Math.hypot(dx, dz), width, width, -Math.atan2(dz, dx));
  }

  const ships: Ship[] = [], triangles: Record<string, number> = {};
  const kinds: Kind[] = ['skiff', 'lancer', 'bastion', 'solar', 'tug', 'interceptor'];
  for (const kind of kinds) {
    const g = shipGeometry(kind); triangles[kind] = g.index!.count / 3;
    for (let team = 0; team < 2; team++) {
      const count = kind === 'skiff' ? 7 : kind === 'lancer' || kind === 'solar' ? 2 : 1;
      const mesh = pool(g, hullMaterial(team), count, true), side = team ? 1 : -1;
      for (let index = 0; index < count; index++) {
        let x = side * 5, z = 0;
        if (kind === 'skiff') { x = side * (2.1 + (index % 3) * 0.8); z = -2.6 + Math.floor(index / 3) * 1.05 + team * 0.6; }
        if (kind === 'lancer') { x = side * (5.7 + index * 0.3); z = -1.4 + index * 3.1; }
        if (kind === 'bastion') { x = side * 4.4; z = 3.2; }
        if (kind === 'solar') { x = side * (9.6 + index * 1.7); z = 0.3 + index * 1.5; }
        if (kind === 'tug') { x = side * 8.2; z = 5.1; }
        if (kind === 'interceptor') { x = side * 1.5; z = -6.2; }
        ships.push({ kind, team, x, z, phase: index * 0.8 + team * 1.3, index, mesh, scale: kind === 'skiff' ? 1.05 : kind === 'interceptor' ? 1.2 : 1.35 });
      }
    }
  }
  const stationKit = kit();
  stationKit.bus(0, 0.15, 0, 0.9, 0.5);
  stationKit.bus(0, 0.65, 0, 0.6, 0.5, STEEL);
  stationKit.bus(0, 1.1, 0, 0.35, 0.5, BODY, 1);
  for (let i = 0; i < 10; i++) {
    const a = i * Math.PI / 5;
    stationKit.block(Math.cos(a) * 1.65, 0.13, Math.sin(a) * 1.65, 1.03, 0.16, 0.19, i % 5 === 0 ? BODY : STEEL, i % 5 === 0 ? 1 : 0, 1, Math.PI / 2 - a);
  }
  stationKit.block(0, 0, 0, 3.3, 0.12, 0.16, IRON);
  stationKit.block(0, 0, 0, 0.16, 0.12, 3.3, IRON);
  const stationG = stationKit.finish(); triangles.station = stationG.index!.count / 3;
  const station = pool(stationG, hullMaterial(0), 1); place(station, 0, -10, 0.3, -5.1, 1.4, 1.4, 1.4);

  const wreckKit = kit();
  wreckKit.bus(0, 0, 0, 0.72, 0.35, IRON);
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI / 5;
    wreckKit.block(Math.cos(a) * 1.45, i % 2 * 0.2, Math.sin(a) * 1.45, 0.94, 0.18, 0.28, STEEL, 0, 0.75, Math.PI / 2 - a);
  }
  wreckKit.block(-0.6, 0.35, 0, 1.1, 0.18, 0.3, BODY);
  const wreck = pool(wreckKit.finish(), hullMaterial(0), 1); place(wreck, 0, 4, 0.1, -8.2, 1.3, 1.3, 1.3, 0.3, 0.18);

  const rockKit = kit(); rockKit.bus(0, 0, 0, 0.7, 0.7, '#a69b97');
  rockKit.block(-0.1, 0.33, 0.12, 0.7, 0.22, 0.65, '#716a80', 0, 0.6, 0.6);
  const rockG = rockKit.finish(), rocks = pool(rockG, hullMaterial(0), 24);
  for (let i = 0; i < 24; i++) {
    const a = i * 2.39996, r = 0.5 + Math.sqrt(i) * 0.72;
    const s = 0.32 + (i % 5) * 0.13;
    place(rocks, i, 1 + Math.cos(a) * r, 0.05 + i % 3 * 0.16, 8.4 + Math.sin(a) * r * 0.6, s, s * 0.8, s, a, i * 0.2);
  }
  const cargo = pool(rockG, hullMaterial(0), 2, true);
  const debrisKit = kit(); debrisKit.block(0, 0, 0, 0.65, 0.1, 0.24, STEEL, 0, 0.2);
  const debris = pool(debrisKit.finish(), hullMaterial(0), 32);
  for (let i = 0; i < 32; i++) {
    const a = i * 2.39996, s = 0.28 + (i % 4) * 0.19;
    place(debris, i, 9 + Math.cos(a) * Math.sqrt(i) * 0.65, i % 4 * 0.13, -6.7 + Math.sin(a) * Math.sqrt(i) * 0.34, s, s, s, a, a);
  }

  const trail = pool(strokeGeo, flatMaterial('#ffc782', 0.48), ships.length * 18, true);
  const engineMaterial = flatMaterial('#ffd59b');
  engineMaterial.colorNode = color('#ffd59b').mul(2.5);
  const engines = pool(strokeGeo, engineMaterial, ships.length, true);
  const tethers = pool(strokeGeo, flatMaterial('#c1b996', 0.8), 2, true);
  const beam = pool(strokeGeo, flatMaterial('#b4eaff'), 1, true);
  const beamHalo = pool(strokeGeo, flatMaterial('#64b9df', 0.2), 1, true);
  const pd = pool(strokeGeo, flatMaterial('#ffe4a4'), 6, true);
  const ringMat = flatMaterial('#9bb7d5', 0.35);
  const radius = uv().sub(0.5).length().mul(2);
  ringMat.opacityNode = smoothstep(0.94, 0.96, radius).mul(float(1).sub(smoothstep(0.975, 1, radius))).mul(0.4);
  const ringGeo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const sensors = pool(ringGeo, ringMat, 4, true);
  const shieldMat = flatMaterial('#a4ddff', 0.7);
  shieldMat.opacityNode = smoothstep(0.82, 0.88, radius).mul(float(1).sub(smoothstep(0.94, 1, radius)))
    .mul(clock.mul(19).add(uv().x.mul(24)).sin().mul(0.16).add(0.84)).mul(0.75);
  const shields = pool(ringGeo, shieldMat, 2, true);
  const dabs = TEAM.map(hex => {
    const m = flatMaterial(hex, 0.3);
    m.opacityNode = float(1).sub(smoothstep(0.15, 1, radius)).mul(0.22);
    return pool(ringGeo, m, ships.filter(s => s.team === TEAM.indexOf(hex)).length, true);
  });

  // Scratch numeric state is reused for trajectories and wake samples: no per-frame objects/arrays.
  const pose = new Float64Array(4), previous = new Float64Array(4), beamSource = new Float64Array(2), beamTarget = new Float64Array(2);
  function at(s: Ship, t: number, out: Float64Array) {
    const mobile = s.kind !== 'solar', fighter = s.kind === 'skiff' || s.kind === 'interceptor';
    const a = t * (fighter ? 0.62 : 0.22) + s.phase;
    const amp = mobile ? fighter ? 0.7 : 0.24 : 0;
    out[0] = s.x + Math.sin(a) * amp;
    out[1] = s.z + Math.cos(a * 0.8) * amp;
    out[2] = (s.team ? Math.PI : 0) + Math.cos(a) * (fighter ? 0.3 : 0.07);
    out[3] = mobile ? Math.sin(a) * (fighter ? 0.3 : 0.08) : 0;
  }
  const dynamicPools = [trail, engines, tethers, cargo, beam, beamHalo, pd, sensors, shields, ...dabs,
    ...ships.filter(s => s.index === 0).map(s => s.mesh)];
  let lastTime = Number.NaN;
  function update(t: number) {
    if (t === lastTime) return;
    lastTime = t;
    let trails = 0, engineCount = 0, tugCount = 0, sensorCount = 0, shieldCount = 0, blue = 0, red = 0;
    const phase = ((t % 4) + 4) % 4;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i]!; at(s, t, pose);
      const x = pose[0]!, z = pose[1]!, yaw = pose[2]!, bank = pose[3]!;
      place(s.mesh, s.index, x, HEIGHT, z, s.scale, s.scale, s.scale, yaw, bank);
      place(dabs[s.team]!, s.team ? red++ : blue++, x, -0.48, z, s.scale * 0.7, 1, s.scale * 0.5, yaw);
      if (s.kind !== 'solar') {
        const rear = (s.kind === 'lancer' ? 0.85 : s.kind === 'bastion' ? 0.68 : 0.43) * s.scale;
        const ex = x - Math.cos(yaw) * rear, ez = z + Math.sin(yaw) * rear;
        place(engines, engineCount++, ex, HEIGHT, ez, 0.18, 0.09, 0.12, yaw);
        let px = ex, pz = ez;
        for (let j = 0; j < 18; j++) {
          const age = (j + 1) * 0.055; at(s, t - age, previous);
          // Exhaust persists behind previous positions, so bends encode turn history rather than facing alone.
          const tx = previous[0]! - Math.cos(previous[2]!) * (rear + age * 1.75);
          const tz = previous[1]! + Math.sin(previous[2]!) * (rear + age * 1.75);
          stroke(trail, trails++, px, pz, tx, tz, HEIGHT, 0.045 * (1 - j / 19)); px = tx; pz = tz;
        }
      }
      if (s.kind === 'tug') {
        const rx = x - Math.cos(yaw) * 2, rz = z + Math.sin(yaw) * 2;
        stroke(tethers, tugCount, x - Math.cos(yaw) * 0.7, z + Math.sin(yaw) * 0.7, rx, rz, HEIGHT, 0.025);
        place(cargo, tugCount++, rx, HEIGHT, rz, 0.65, 0.65, 0.65, 0.6);
      }
      if (s.kind === 'bastion' || s.kind === 'interceptor') {
        const r = daylight(x, z) ? 3.3 : 1.65;
        place(sensors, sensorCount++, x, -0.4, z, r, 1, r);
      }
      if (s.kind === 'lancer' && s.team === 0 && s.index === 1) {
        beamSource[0] = x + Math.cos(yaw) * 1.36; beamSource[1] = z - Math.sin(yaw) * 1.36;
      }
      if (s.kind === 'bastion' && s.team === 1) {
        beamTarget[0] = x; beamTarget[1] = z;
        if (phase >= 1.1 && phase < 2.1) {
          const pulse = 1 + (phase - 1.1) * 0.3;
          place(shields, shieldCount++, x, HEIGHT + 0.2, z, 1.2 * pulse, 1, 0.95 * pulse, yaw);
          place(shields, shieldCount++, x, HEIGHT + 0.24, z, 1.35 * pulse, 1, 1.05 * pulse, yaw + 0.1);
        }
      }
    }
    const firing = phase >= 1 && phase < 1.65;
    beam.count = beamHalo.count = firing ? 1 : 0;
    if (firing) {
      stroke(beam, 0, beamSource[0]!, beamSource[1]!, beamTarget[0]! - 1.1, beamTarget[1]!, HEIGHT + 0.12, 0.045);
      stroke(beamHalo, 0, beamSource[0]!, beamSource[1]!, beamTarget[0]! - 1.1, beamTarget[1]!, HEIGHT + 0.12, 0.14);
    }
    pd.count = phase >= 0.7 && phase < 2.7 ? 6 : 0;
    for (let i = 0; i < pd.count; i++) {
      const a = t * 2.6 + i * 0.7, k = (t * 2 + i * 0.17) % 1;
      const x = beamTarget[0]! - 0.3 - k * 2.4, z = beamTarget[1]! - 0.5 - k * (1.8 + Math.sin(a) * 0.3);
      stroke(pd, i, x, z, x - 0.25, z - 0.19, HEIGHT + 0.15, 0.025);
    }
    trail.count = trails; engines.count = engineCount; shields.count = shieldCount;
    for (const m of dynamicPools) m.instanceMatrix.needsUpdate = true;
  }
  const plaque = document.createElement('aside');
  plaque.style.cssText = 'position:fixed;left:28px;top:24px;color:#e5dcc4;font:12px/1.5 monospace;letter-spacing:.12em;pointer-events:none';
  plaque.innerHTML = '<span style="color:#8eabc7">FIELD JOURNAL / PLATE IV</span><br><strong style="font:30px Georgia;letter-spacing:.03em">The High Ground</strong><br>ORBIT · NAVIGATOR’S STAR ATLAS';
  const key = document.createElement('aside');
  key.style.cssText = 'position:fixed;left:28px;bottom:22px;right:28px;color:#bdc7d6;font:11px/1.65 monospace;pointer-events:none;border-top:1px solid #566780;padding-top:10px';
  key.innerHTML = '<span style="color:#e3ca92">DASHED GOLD — DAY / NIGHT TERMINATOR</span> &nbsp; · &nbsp; CIRCLES — SENSORS: DAY 3.3 / NIGHT 1.65<br>SKIFF / DART &nbsp; LANCER / NEEDLE &nbsp; BASTION / BROAD SHIELD &nbsp; SOLAR / PANELS &nbsp; TUG / GRAPPLE &nbsp; ASCENT / DELTA';
  if (new URLSearchParams(location.search).get('labels') !== '0') document.body.append(plaque, key);
  update(0);
  return { update, triangles, ships: ships.length };
}
