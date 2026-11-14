/** Profile-authenticated series transport. PlayerThree owns scheduling, ratings, exports and durable results. */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createSeriesRunner, recoverSeriesRunner } from '@playerthree/bench/series';
import { jsonSeriesStore } from 'playerthree/host';
import type { ResultsSummary, SeriesAccess, SeriesLimits, SeriesSpec, SharePolicy, StoredSeries } from 'playerthree/arena';
import type { PostgresStorage } from 'playerthree/postgres';
import { DEFAULT_TIME_CAP_TICKS, manifest } from '@agent-command/game';
import sharp from 'sharp';
import type { ServerConfig } from './config.ts';
import { createArenaMatchHost, type ArenaAllocator } from './arena-host.ts';
import { object, parseSeries, revisionOf } from './arena-input.ts';
import { clientIp, HttpError, originAllowed, RateLimiter, readJson, sendJson } from './http.ts';
import type { LobbyService } from './lobby.ts';
import type { GameHost } from './room.ts';
import { lobbySeriesSpec } from './arena-lobby.ts';
import { replacePublicMetadata } from './seo.ts';
import { arenaSeedSource } from './arena-seeds.ts';

export interface ArenaServiceOptions {
  config: ServerConfig; host: GameHost; storage?: PostgresStorage;
  profileOf(req: IncomingMessage): string | undefined;
  open: ArenaAllocator; lobbies: LobbyService;
  limits?: Partial<SeriesLimits>;
  /** Commander-log queue of a series' matches (the gauntlet marks its own), else null. */
  logQueue?(seriesId: string): string | null;
}
const terminal: Readonly<Record<string, true>> = { completed: true, aborted: true, failed: true };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only local text is interpolated; no URLs, supplied SVG, HTML, fonts or external assets are accepted. */
export async function renderArenaShareImage(results: ResultsSummary): Promise<Buffer> {
  const text = (value: string, max = 84) => escapeHtml(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max));
  const title = results.tables.entrants.map(e => e.label).join(' vs ');
  const standings = results.tables.standings.slice(0, 4).map((row, index) => {
    const name = results.tables.entrants.find(e => e.entrantId === row.entrantId)?.label ?? row.entrantId;
    return `<text x="70" y="${270 + index * 62}" fill="#f1f5f9" font-size="30">${text(name, 42)} · ${row.wins}W ${row.losses}L ${row.draws}D</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#0b1220"/><rect x="0" y="0" width="1200" height="12" fill="#38bdf8"/><g font-family="sans-serif"><text x="70" y="95" font-size="30" fill="#38bdf8">AGENT COMMAND · ARENA</text><text x="70" y="170" font-size="40" fill="#fff">${text(title, 50)}</text><text x="70" y="220" font-size="26" fill="#94a3b8">${text(results.state.toUpperCase())} · ${results.tables.matches.filter(m => m.acceptedAttempt).length} games · ${text(results.spec.track)}</text>${standings}<text x="70" y="580" font-size="22" fill="#94a3b8">${results.spec.template.observerPolicy.minDelayMs > 0 ? `Delayed ${Math.ceil(results.spec.template.observerPolicy.minDelayMs / 1000)} s · ` : ''}Released results only · AI players · ${text(results.spec.rating.algorithm)}</text></g></svg>`;
  return sharp(Buffer.from(svg), { limitInputPixels: 1200 * 630 }).png().toBuffer();
}

export function createArenaService(options: ArenaServiceOptions) {
  const { config, profileOf } = options;
  const store = options.storage?.series(manifest.id) ?? (config.dataDir ? jsonSeriesStore(join(config.dataDir, 'series', manifest.id)) : undefined);
  const adapter = createArenaMatchHost(options.host, options.open, async (attemptId, entrantId, category) => {
    if (!store) return false;
    const record = await store.get(attemptId.split('_')[0]!);
    const consent = record?.commentaryConsents.find(entry => entry.entrantId === entrantId);
    return !!record && Date.parse(record.expiresAt) > Date.now() && !!consent && (category === 'summary' ? consent.summaries : consent.chat);
  }, arenaSeedSource(config.dataDir, config.arenaSeedKey), (seriesId) => options.logQueue?.(seriesId) ?? null);
  const limits: SeriesLimits = { maxGames: 200, maxConcurrency: 2, maxBytes: 2 * 1024 ** 3, maxChunkBytes: 1024 ** 2, maxAttemptBytes: 256 * 1024 ** 2, maxOwnerBytes: 4 * 1024 ** 3, maxActiveSeries: 2, maxWallMs: 3600000, retentionMs: 30 * 86400000, ...options.limits };
  const runner = store ? createSeriesRunner({ host: adapter.host, binder: adapter.binder, store, limits }) : undefined;
  const ready = runner && store ? recoverSeriesRunner(runner, store) : Promise.resolve();
  // A configured storage error is never replaced with an in-memory benchmark.
  void ready.catch(() => {});
  const limiter = new RateLimiter(120, 60000);
  const exportLimiter = new RateLimiter(12, 60000);
  const createLimiter = new RateLimiter(6, 60000);
  const streamCounts = new Map<string, number>();
  const responses = new Set<ServerResponse>();
  const prune = store ? setInterval(() => { void store.prune(Date.now()).catch(() => {}); }, 60000) : undefined;
  prune?.unref();
  let closed = false;

  async function owned(owner: string, id: string): Promise<StoredSeries> {
    const record = await store!.get(id);
    if (!record || record.owner !== owner || Date.parse(record.expiresAt) <= Date.now()) throw new HttpError(404, 'not_found');
    return record;
  }
  async function authorize(access: SeriesAccess): Promise<StoredSeries> {
    if (access.kind === 'owner') return owned(access.owner, access.seriesId);
    const share = await store!.resolveShare(createHash('sha256').update(access.token).digest('hex'));
    if (!share || share.revokedAt || Date.parse(share.policy.expiresAt) <= Date.now() || share.policy.notBefore > Date.now()) throw new HttpError(404, 'not_found');
    return owned(share.owner, share.seriesId);
  }
  function delivery(res: ServerResponse, result: ResultsSummary) {
    const delayMs = result.spec.template.observerPolicy.minDelayMs;
    res.setHeader('X-Arena-Delay-Ms', String(delayMs));
    res.setHeader('X-Arena-Playback', terminal[result.state] ? 'ended' : result.tables.matches.length === 0 && delayMs > 0 ? 'buffering' : 'playing');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  async function write(res: ServerResponse, bytes: Uint8Array | string) {
    if (res.destroyed || res.writableEnded) return false;
    if (!res.write(bytes)) {
      await Promise.race([once(res, 'drain'), once(res, 'close')]);
      if (res.destroyed) return false;
    }
    return true;
  }
  async function stream<T>(res: ServerResponse, ip: string, source: AsyncIterable<T>, access: SeriesAccess, encode: (value: T) => string, initial = ': connected\n\n') {
    if ((streamCounts.get(ip) ?? 0) >= 4) throw new HttpError(429, 'stream_capacity');
    streamCounts.set(ip, (streamCounts.get(ip) ?? 0) + 1);
    responses.add(res);
    const stop = Promise.withResolvers<void>();
    const onClose = () => stop.resolve(); res.once('close', onClose);
    const iterator = source[Symbol.asyncIterator]();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    await write(res, initial);
    const heartbeat = setInterval(() => { if (!res.destroyed && res.writableLength < 64 * 1024) res.write(': keepalive\n\n'); }, 15000);
    // Observer frames stream at the tick rate: a share/ownership lookup per frame would hit storage 20 times a second
    // per viewer. Authorization is renewed at most once a second, so revocation still ends delivery within a second.
    let authorizedAt = Date.now();
    const revocation = setInterval(() => { void authorize(access).then(() => { authorizedAt = Date.now(); }, () => { stop.resolve(); res.end(); }); }, 1000);
    try {
      while (!closed && !res.destroyed) {
        const next = await Promise.race([iterator.next(), stop.promise.then(() => undefined)]);
        if (!next || next.done) break;
        if (Date.now() - authorizedAt >= 1000) { await authorize(access); authorizedAt = Date.now(); }
        if (res.writableLength > 256 * 1024 || !await write(res, encode(next.value))) break;
      }
    } finally {
      clearInterval(heartbeat); clearInterval(revocation); res.off('close', onClose); responses.delete(res);
      const count = (streamCounts.get(ip) ?? 1) - 1; if (count) streamCounts.set(ip, count); else streamCounts.delete(ip);
      void iterator.return?.().catch(() => {}); res.end();
    }
  }
  async function sharePolicy(record: StoredSeries, body: unknown): Promise<SharePolicy> {
    const b = object(body, ['commentary', 'expiresAt'], ['commentary']);
    if (typeof b.commentary !== 'boolean') throw new HttpError(400, 'bad_request');
    const expiry = b.expiresAt ?? record.expiresAt;
    if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now() || Date.parse(expiry) > Date.parse(record.expiresAt)) throw new HttpError(400, 'bad_expiry');
    const consents = record.commentaryConsents ?? [];
    const consentedEntrants = consents.filter(c => c.summaries || c.chat).map(c => c.entrantId);
    if (b.commentary && !consentedEntrants.length) throw new HttpError(403, 'commentary_consent_required');
    return { commentary: b.commentary, expiresAt: new Date(expiry).toISOString(), notBefore: 0, consentedEntrants };
  }
  async function page(result: ResultsSummary, token: string) {
    const base = `/arena/share/${token}`;
    const origin = config.publicUrl?.origin ?? '';
    const title = result.tables.entrants.map(e => e.label).join(' vs ');
    const description = `${result.state} · ${result.tables.matches.filter(m => m.acceptedAttempt).length} games · ${result.spec.track} · ${result.spec.rating.algorithm}`;
    const table = result.tables.standings.map(row => `<tr><td>${escapeHtml(result.tables.entrants.find(e => e.entrantId === row.entrantId)?.label ?? row.entrantId)}</td><td>${row.wins}</td><td>${row.losses}</td><td>${row.draws}</td><td>${row.rating ?? row.mu ?? 'Not reported'}</td></tr>`).join('');
    const imageAlt = escapeHtml(`Agent Command arena standings: ${title}`);
    const metadata = `<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${escapeHtml(origin + base + '/image.png')}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${imageAlt}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(origin + base + '/image.png')}"><meta name="twitter:image:alt" content="${imageAlt}">`;
    const delay = result.spec.template.observerPolicy.minDelayMs;
    const nonce = randomBytes(18).toString('base64');
    const fallback = `<noscript><style nonce="${nonce}">html,body{height:auto;overflow:auto}#loading,#app{display:none}main{max-width:60rem;margin:2rem auto;padding:1rem}a{color:#ffd21f}th,td{padding:.5rem;text-align:left}</style><main aria-label="Shared arena results"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><p>${delay ? `Delayed ${Math.ceil(delay / 1000)} s · ` : ''}Released results only · AI players</p><table><thead><tr><th>Entrant</th><th>Wins</th><th>Losses</th><th>Draws</th><th>Rating</th></tr></thead><tbody>${table}</tbody></table><p><a href="${base}/export.json">Download JSON</a> · <a href="${base}/export.csv">Download CSV tables</a></p><p>Revocation cannot recall downloaded copies or social-platform caches.</p></main></noscript>`;
    let shell: string;
    try { shell = await readFile(join(config.webDist, 'index.html'), 'utf8'); }
    catch (error) {
      if (process.env.NODE_ENV === 'production' || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      shell = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
    }
    // Only trusted local build/source markup is reused; no caller-supplied URLs or raw provider JSON.
    const html = replacePublicMetadata(shell, `<title>${escapeHtml(title)} · Arena</title><meta name="description" content="${escapeHtml(description)}">${metadata}`)
      .replace(/(src|href)="\.\//g, '$1="/').replace(/<style>/g, `<style nonce="${nonce}">`)
      .replace('</body>', () => `${fallback}</body>`);
    return { html, nonce };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const ownerRoute = /^\/api\/arena\/series(?:\/([A-Za-z0-9_-]{1,64})(?:\/(.*))?)?$/.exec(path);
    const publicRoute = /^\/arena\/share\/([A-Za-z0-9_-]{32})(?:\/(.*))?$/.exec(path);
    const lobbyRoute = /^\/api\/lobbies\/([A-Za-z0-9_-]{1,64})\/series$/.exec(path);
    if (path.startsWith('/arena/share/') && !publicRoute) throw new HttpError(404, 'not_found');
    if (!ownerRoute && !publicRoute && !lobbyRoute && path !== '/api/arena/limits') return false;
    if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (!runner || !store) throw new HttpError(503, 'series_storage_unconfigured');
    if (closed) throw new HttpError(503, 'server_updating');
    await ready;
    const ip = clientIp(req, config); const retry = limiter.take(ip);
    if (retry) { sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) }); return true; }
    const url = new URL(req.url ?? path, 'http://arena.invalid');
    if ([...url.searchParams.keys()].some(key => !['revision', 'perspective', 'after'].includes(key))) throw new HttpError(400, 'bad_request');
    const owner = publicRoute ? undefined : profileOf(req);
    if (!publicRoute && !owner) throw new HttpError(401, 'bad_profile');
    if (path === '/api/arena/limits') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' }); return true; }
      sendJson(res, 200, { ...limits, maxLiveConcurrency: 1, maxTicks: DEFAULT_TIME_CAP_TICKS, minPublicDelayMs: 180000 }); return true;
    }
    if (lobbyRoute || ownerRoute && !ownerRoute[1]) {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); return true; }
      const rate = createLimiter.take(owner!); if (rate) throw new HttpError(429, 'rate_limited');
      const body = await readJson(req, 256 * 1024);
      const spec = lobbyRoute ? lobbySeriesSpec(options.lobbies, owner!, lobbyRoute[1]!, body, options.host) : parseSeries(body);
      for (const consent of spec.telemetry.commentaryConsents ?? []) if (consent.summaries || consent.chat) assertEntrantOwner(spec, owner!, consent.entrantId, options.host);
      const created = await runner.create(owner!, spec);
      if (lobbyRoute) { await runner.start(owner!, created.id); sendJson(res, 201, { seriesId: created.id }); }
      else sendJson(res, 201, created);
      return true;
    }
    const id = ownerRoute?.[1];
    const action = publicRoute ? publicRoute[2] ?? '' : ownerRoute![2] ?? '';
    const access: SeriesAccess = publicRoute ? { kind: 'share', token: publicRoute[1]! } : { kind: 'owner', owner: owner!, seriesId: id! };
    const record = await authorize(access);
    if (!publicRoute && action === 'commentary/consent' && req.method === 'GET') {
      const consents = record.spec.entrants.flatMap(entrant => {
        try { assertEntrantOwner(record.spec, owner!, entrant.id, options.host); }
        catch { return []; }
        return [{ entrantId: entrant.id, ...(record.commentaryConsents.find(entry => entry.entrantId === entrant.id) ?? { summaries: false, chat: false }) }];
      });
      sendJson(res, 200, { consents }); return true;
    }
    if (!publicRoute && ['start', 'abort', 'share', 'share/preview', 'share/revoke', 'commentary/consent'].includes(action)) {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); return true; }
      const body = await readJson(req, 4096);
      if (action === 'share' || action === 'share/preview') {
        const policy = await sharePolicy(record, body);
        if (action === 'share/preview') { sendJson(res, 200, await runner.previewShare(owner!, id!, policy)); return true; }
        const created = await runner.createShare(owner!, id!, policy);
        sendJson(res, 201, { ...created, url: `${config.publicUrl?.origin ?? ''}/arena/share/${created.token}`, disclosure: 'Revocation cannot recall downloaded copies or social-platform caches.' }); return true;
      }
      if (action === 'commentary/consent') {
        const b = object(body, ['entrantId', 'summaries', 'chat']);
        if (typeof b.entrantId !== 'string' || typeof b.summaries !== 'boolean' || typeof b.chat !== 'boolean') throw new HttpError(400, 'bad_request');
        assertEntrantOwner(record.spec, owner!, b.entrantId, options.host);
        await runner.setCommentaryConsent(owner!, id!, b.entrantId, { summaries: b.summaries, chat: b.chat });
        res.writeHead(204).end(); return true;
      }
      object(body, []);
      if (action === 'start') await runner.start(owner!, id!);
      else if (action === 'abort') await runner.abort(owner!, id!);
      else await runner.revokeShare(owner!, id!);
      res.writeHead(204).end(); return true;
    }
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' }); return true; }
    const revision = revisionOf(url);
    const result = await runner.results(access, revision);
    delivery(res, result);
    if (action === '' && !publicRoute || action === 'data' && publicRoute) { sendJson(res, 200, result, { 'Cache-Control': 'private, no-store' }); return true; }
    if (action === 'events') {
      const after = revisionOf(url, req.headers['last-event-id']);
      await stream(res, ip, runner.updates(access, after), access, update => `id: ${update.revision}\ndata: ${JSON.stringify(update)}\n\n`); return true;
    }
    if (action === 'export.json' || action === 'export.csv') {
      if (exportLimiter.take(`${ip}:${record.id}`)) throw new HttpError(429, 'rate_limited');
      const format = action === 'export.json' ? 'json' : 'csv';
      res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'application/zip', 'Content-Disposition': `attachment; filename="arena-results.${format === 'json' ? 'json' : 'zip'}"` });
      for await (const bytes of runner.export(access, format, revision)) { await authorize(access); if (!await write(res, bytes)) break; }
      res.end(); return true;
    }
    const artifact = /^artifacts\/([A-Za-z0-9_-]{1,128})$/.exec(action);
    if (artifact) {
      if (exportLimiter.take(`${ip}:${record.id}`)) throw new HttpError(429, 'rate_limited');
      // Artifact refs are bounded series metadata; the summary's raw tables may be sampled.
      const ref = record.artifacts.find(item => item.id === artifact[1] && item.availability === 'available');
      if (!ref || access.kind === 'share' && (ref.releaseAt ?? Infinity) > Date.now()) throw new HttpError(404, 'not_found');
      const bytes = await store.getArtifact(record.id, ref.id); if (!bytes) throw new HttpError(404, 'not_found');
      await authorize(access);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="arena-replay.json"', 'Content-Length': bytes.byteLength }); res.end(bytes); return true;
    }
    const observer = /^matches\/([A-Za-z0-9_.:-]{1,160})\/observer(?:\/(events))?$/.exec(action);
    if (observer) {
      const matchId = observer[1]!;
      const attempt = record.attempts.find(row => row.matchId === matchId);
      const active = result.activeMatches.find(row => row.matchId === matchId);
      const released = attempt && (access.kind === 'owner' || attempt.releaseAt <= Date.now());
      if (!active && !released || !adapter.hasMatch(matchId)) throw new HttpError(404, 'not_found');
      const matchSpec = active?.spec ?? attempt?.spec ?? record.spec.template;
      const teams = matchSpec.sides.map(side => side.id);
      const policy = matchSpec.observerPolicy;
      const perspective = url.searchParams.get('perspective') ?? (policy.allowOmniscient ? 'all' : teams[0]!);
      if (!(teams.includes(perspective) || perspective === 'all' && policy.allowOmniscient)) throw new HttpError(400, 'bad_perspective');
      const grant = perspective === 'all' ? { kind: 'omniscient' as const, teams, delayMs: policy.minDelayMs } : { kind: 'team' as const, team: perspective, delayMs: policy.minDelayMs };
      if (!observer[2]) { sendJson(res, 200, { grant }); return true; }
      const afterRaw = url.searchParams.get('after');
      if (afterRaw !== null && !/^\d{1,10}$/.test(afterRaw)) throw new HttpError(400, 'bad_cursor');
      const frames = adapter.host.observe(matchId, grant, afterRaw === null ? undefined : Number(afterRaw));
      const spec = matchSpec;
      const agentCards = spec.bindings.flatMap(binding => {
        const card = record.spec.entrants.find(entrant => entrant.id === binding.entrantId);
        return card && (grant.kind === 'omniscient' || binding.seat.team === grant.team) ? [{ team: binding.seat.team, role: binding.seat.role, card }] : [];
      });
      const disclosed = (async function* () {
        // Frames arrive at the tick rate: share revocation is rechecked at most once a second, not per frame.
        let includeCommentary = true;
        let checkedAt = Number.NEGATIVE_INFINITY;
        for await (const frame of frames) {
          if (access.kind === 'share' && Date.now() - checkedAt >= 1000) {
            const share = await store.resolveShare(createHash('sha256').update(access.token).digest('hex'));
            includeCommentary = !!share && !share.revokedAt && share.policy.commentary;
            checkedAt = Date.now();
          }
          // Identity is static for the match: it rides on keyframes only; deltas stay small.
          yield { op: 'observer' as const, state: 'ready' as const, grant, frame: { ...frame, commentary: includeCommentary ? frame.commentary : [], ...(frame.world !== undefined ? { agentCards } : {}) } };
        }
      })();
      await stream(res, ip, disclosed, access, message => `id: ${message.frame.sequence}\ndata: ${JSON.stringify(message)}\n\n`, `data: ${JSON.stringify({ op: 'observer', state: grant.delayMs > 0 ? 'buffering' : 'ready', grant })}\n\n`); return true;
    }
    if (publicRoute && action === 'image.png') {
      if (exportLimiter.take(`${ip}:${record.id}`)) throw new HttpError(429, 'rate_limited');
      const png = await renderArenaShareImage(result); await authorize(access);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png); return true;
    }
    if (publicRoute && action === '') {
      const rendered = await page(result, publicRoute[1]!);
      await authorize(access);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); res.end(rendered.html); return true;
    }
    throw new HttpError(404, 'not_found');
  }
  return { handle: async (req: IncomingMessage, res: ServerResponse, path: string) => {
    try { return await handle(req, res, path); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      if (error instanceof HttpError) throw error;
      // SDK/store errors carry closed classifications; never echo provider/SQL payloads or token-bearing URLs.
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code === 'not_found' || error instanceof Error && /not found/i.test(error.message)) throw new HttpError(404, 'not_found');
      if (['quota', 'capacity', 'limit', 'conflict', 'busy'].some(key => code.includes(key))) throw new HttpError(409, 'series_capacity');
      if (error instanceof Error && /invalid|unsupported|mismatch|missing|require|open seats|incomplete|empty schedule/i.test(error.message)) throw new HttpError(400, 'bad_series');
      throw new HttpError(503, 'series_unavailable');
    }
  },
  /** Programmatic series for in-process services (the gauntlet): the same runner, admission and storage. */
  series: runner ? {
    create: (owner: string, spec: SeriesSpec) => ready.then(() => runner.create(owner, spec)),
    start: (owner: string, id: string) => runner.start(owner, id),
    results: (owner: string, id: string) => runner.results({ kind: 'owner', owner, seriesId: id }),
  } : undefined,
  async close() {
    closed = true; clearInterval(prune); limiter.close(); exportLimiter.close(); createLimiter.close();
    for (const response of responses) response.end();
    if (runner && store) for (const record of await store.recoverable(Date.now())) if (!terminal[record.state]) await runner.abort(record.owner, record.id);
    await adapter.close();
  } };
}

function assertEntrantOwner(spec: SeriesSpec, owner: string, entrantId: string, host: GameHost): void {
  if (!spec.entrants.some(e => e.id === entrantId)) throw new HttpError(404, 'not_found');
  const lineup = spec.entrantSeats?.find(entry => entry.entrantId === entrantId)?.seats ??
    spec.template.bindings.filter(b => b.entrantId === entrantId).flatMap(binding => {
      const entry = spec.template.sides.find(s => s.id === binding.seat.team)?.seats.find(s => s.role === binding.seat.role);
      return entry ? [entry] : [];
    });
  if (!lineup.length || lineup.some(entry => entry.occupant.kind !== 'commander' || !host.commanders.roster(owner).some(c => entry.occupant.kind === 'commander' && c.id === entry.occupant.ref.id))) throw new HttpError(403, 'entrant_not_owned');
}
