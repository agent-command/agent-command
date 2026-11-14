/** Closed HTTP input boundary. Game options are checked by the game's own rule schema. */
import type { MatchSpec, SeriesSpec } from 'playerthree/arena';
import { ARMIES, BOT_KNOBS, checkRules, COLOURS, DEFAULT_TIME_CAP_TICKS, MAX_ARMIES, OPPONENTS, PLANES, resolveBotOptions } from '@agent-command/game';
import { HttpError } from './http.ts';

export function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'bad_request');
  const out = value as Record<string, unknown>;
  if (Object.keys(out).some(key => !keys.includes(key)) || required.some(key => out[key] === undefined)) throw new HttpError(400, 'bad_request');
  return out;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new HttpError(400, 'bad_request');
  return value;
}
function text(value: unknown, max = 128): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new HttpError(400, 'bad_request');
}
function id(value: unknown): void { text(value); if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new HttpError(400, 'bad_request'); }
function num(value: unknown, min: number, max: number, integer = true): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || integer && !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, 'bad_request');
}
function bool(value: unknown): void { if (typeof value !== 'boolean') throw new HttpError(400, 'bad_request'); }
function one(value: unknown, choices: readonly unknown[]): void { if (!choices.includes(value)) throw new HttpError(400, 'bad_request'); }
function options(value: unknown): void { const checked = checkRules(value); if (!checked.ok) throw new HttpError(400, 'bad_rules', checked.error); }
/** The public bot options (BOT_KNOBS) only: `personality` is the featured playlist's, never an arena entrant's. */
function botOptions(value: unknown): void {
  try {
    if (value && typeof value === 'object' && Object.keys(value).some((key) => !Object.hasOwn(BOT_KNOBS, key))) throw new Error('not a public bot option');
    resolveBotOptions('standard', value);
  } catch { throw new HttpError(400, 'bad_bot_options'); }
}
function map(value: unknown): void {
  const m = object(value, ['id', 'identity', 'seed', 'layout']); id(m.id); if (m.identity !== '') text(m.identity, 256); id(m.layout); num(m.seed, 0, 0xffffffff);
}
function seat(value: unknown): void { const s = object(value, ['team', 'role']); one(s.team, ARMIES); one(s.role, PLANES); }
export function validateMatch(value: unknown): asserts value is MatchSpec {
  const s = object(value, ['format', 'version', 'game', 'gameVersion', 'surfaceHash', 'rulesHash', 'seed', 'map', 'options', 'sides', 'bindings', 'observerPolicy', 'rules']);
  one(s.format, ['playerthree.match']); one(s.version, [1]); id(s.game); text(s.gameVersion); text(s.surfaceHash); if (s.rulesHash !== '') text(s.rulesHash, 256); num(s.seed, 0, 0xffffffff); map(s.map); options(s.options);
  for (const side of list(s.sides, MAX_ARMIES)) {
    // A side is an army on its slot corner; its alliance is its colour (DESIGN §15.3).
    const sideSpec = object(side, ['id', 'spawnSlot', 'alliance', 'seats']); one(sideSpec.id, ARMIES); one(sideSpec.spawnSlot, ARMIES); one(sideSpec.alliance, COLOURS);
    for (const entry of list(sideSpec.seats, 4)) {
      const entrySpec = object(entry, ['role', 'occupant']); one(entrySpec.role, PLANES);
      const occupant = object(entrySpec.occupant, ['kind', 'ref', 'level', 'options'], ['kind']);
      if (occupant.kind === 'bot') { object(occupant, ['kind', 'level', 'options']); one(occupant.level, OPPONENTS); botOptions(occupant.options); }
      else if (occupant.kind === 'commander') {
        object(occupant, ['kind', 'ref']); const ref = object(occupant.ref, ['id', 'kind', 'version'], ['id', 'kind']); id(ref.id); one(ref.kind, ['agent', 'policy']);
        if (ref.version !== undefined) num(ref.version, 1, 1e9);
        if (ref.kind === 'policy' && ref.version === undefined) throw new HttpError(400, 'policy_version_required');
      } else if (occupant.kind === 'closed') object(occupant, ['kind']);
      else throw new HttpError(400, 'unsupported_occupant');
    }
  }
  for (const binding of list(s.bindings, MAX_ARMIES * PLANES.length)) { const b = object(binding, ['seat', 'entrantId']); seat(b.seat); id(b.entrantId); }
  const policy = object(s.observerPolicy, ['allowOmniscient', 'minDelayMs']); bool(policy.allowOmniscient); num(policy.minDelayMs, 0, 3600000);
  const rules = object(s.rules, ['ranked', 'coaching', 'practiceReasons']); bool(rules.ranked); one(rules.coaching, ['off']);
  if (!Array.isArray(rules.practiceReasons) || rules.practiceReasons.length > 32) throw new HttpError(400, 'bad_request');
  for (const reason of rules.practiceReasons) text(reason, 256);
}
export function parseSeries(value: unknown): SeriesSpec {
  const keys = ['format', 'version', 'game', 'gameVersion', 'surfaceHash', 'track', 'entrants', 'template', 'scenarios', 'permutations', 'repetitions', 'execution', 'budgets', 'rating', 'telemetry'];
  const s = object(value, [...keys, 'entrantSeats'], keys);
  one(s.format, ['playerthree.series']); one(s.version, [1]); id(s.game); text(s.gameVersion); text(s.surfaceHash); one(s.track, ['bots', 'policy', 'live']); validateMatch(s.template);
  for (const card of list(s.entrants, 8)) {
    const c = object(card, ['id', 'label', 'kind', 'aiPlayer', 'provider', 'model', 'selfReported', 'harness', 'scaffoldVersion', 'artifactHash', 'botVersion', 'botLevel', 'botOptions', 'stateResetSource'], ['id', 'label', 'kind', 'aiPlayer']);
    id(c.id); text(c.label, 96); one(c.kind, ['bot', 'agent', 'policy']); one(c.aiPlayer, [true]);
    for (const key of ['provider', 'model', 'scaffoldVersion', 'artifactHash', 'botVersion']) if (c[key] !== undefined) text(c[key], 128);
    if (c.selfReported !== undefined) one(c.selfReported, [true]);
    if (c.provider !== undefined || c.model !== undefined) one(c.selfReported, [true]);
    if (c.harness !== undefined) { const h = object(c.harness, ['label', 'verified']); text(h.label, 96); one(h.verified, [false]); }
    if (c.botLevel !== undefined) one(c.botLevel, OPPONENTS);
    if (c.botOptions !== undefined) botOptions(c.botOptions);
    if (c.stateResetSource !== undefined) one(c.stateResetSource, ['declared', 'not_applicable']);
  }
  if (s.entrantSeats !== undefined) {
    for (const lineup of list(s.entrantSeats, 8)) {
      const entry = object(lineup, ['entrantId', 'seats']); id(entry.entrantId);
      const template = s.template as MatchSpec;
      validateMatch({ ...template, sides: template.sides.map(side => ({ ...side, seats: entry.seats })) });
    }
  }
  for (const scenario of list(s.scenarios, 200)) { const sc = object(scenario, ['id', 'seed', 'map', 'options']); id(sc.id); num(sc.seed, 0, 0xffffffff); map(sc.map); options(sc.options); }
  for (const permutation of list(s.permutations, 200)) {
    const p = object(permutation, ['id', 'sideEntrants']); id(p.id);
    for (const side of list(p.sideEntrants, MAX_ARMIES)) { const b = object(side, ['team', 'entrantId']); one(b.team, ARMIES); id(b.entrantId); }
  }
  num(s.repetitions, 1, 200);
  const executionKeys = ['concurrency', 'speed', 'clock', 'maxTicks', 'maxWallMs', 'maxInfraRetries', 'state'];
  const e = object(s.execution, [...executionKeys, 'abortOn'], executionKeys);
  if (e.abortOn !== undefined && (!Array.isArray(e.abortOn) || e.abortOn.length > 1 || e.abortOn.some(reason => reason !== 'infrastructure'))) throw new HttpError(400, 'bad_request');
  num(e.concurrency, 1, 2); num(e.speed, 1, 20); one(e.clock, ['realtime', 'accelerated']); num(e.maxTicks, 1, DEFAULT_TIME_CAP_TICKS); num(e.maxWallMs, 1, 3600000); num(e.maxInfraRetries, 0, 1); one(e.state, ['reset_each_match']);
  if (s.track === 'live' && (e.concurrency !== 1 || e.clock !== 'realtime' || e.speed !== 1)) throw new HttpError(400, 'unsupported_live_clock');
  const b = object(s.budgets, ['maxTokens', 'maxCostUsd', 'maxTurns']);
  for (const key of ['maxTokens', 'maxTurns']) if (b[key] !== null) num(b[key], 1, 1e9);
  if (b.maxCostUsd !== null && (typeof b.maxCostUsd !== 'string' || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(b.maxCostUsd))) throw new HttpError(400, 'bad_request');
  const r = object(s.rating, ['algorithm', 'version', 'initial', 'k', 'scale', 'mu', 'sigma', 'beta', 'tau', 'drawProbability'], ['algorithm', 'version']); one(r.version, [1]);
  if (r.algorithm === 'elo') { object(r, ['algorithm', 'version', 'initial', 'k', 'scale']); num(r.initial, -1e6, 1e6, false); num(r.k, 0.001, 1e4, false); num(r.scale, 0.001, 1e6, false); }
  else if (r.algorithm === 'trueskill') { object(r, ['algorithm', 'version', 'mu', 'sigma', 'beta', 'tau', 'drawProbability']); num(r.mu, -1e6, 1e6, false); for (const key of ['sigma', 'beta', 'tau']) num(r[key], 0.000001, 1e6, false); num(r.drawProbability, 0, 0.99999, false); }
  else throw new HttpError(400, 'bad_request');
  const telemetry = object(s.telemetry, ['sampleEveryTicks', 'includeCommentary', 'commentaryConsents'], ['sampleEveryTicks', 'includeCommentary']); num(telemetry.sampleEveryTicks, 20, 1200); bool(telemetry.includeCommentary);
  if (telemetry.commentaryConsents !== undefined) {
    if (!Array.isArray(telemetry.commentaryConsents) || telemetry.commentaryConsents.length > 8) throw new HttpError(400, 'bad_request');
    for (const consent of telemetry.commentaryConsents) {
      const c = object(consent, ['entrantId', 'summaries', 'chat']); id(c.entrantId); bool(c.summaries); bool(c.chat);
    }
    if (new Set(telemetry.commentaryConsents.map(c => (c as Record<string, unknown>).entrantId)).size !== telemetry.commentaryConsents.length) throw new HttpError(400, 'bad_request');
  }
  return value as SeriesSpec;
}

export function revisionOf(url: URL, header?: string | string[]): number | undefined {
  const raw = url.searchParams.get('revision') ?? (Array.isArray(header) ? undefined : header);
  if (raw === null || raw === undefined) return undefined;
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > 2147483647) throw new HttpError(400, 'bad_revision');
  return Number(raw);
}
