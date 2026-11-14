/**
 * Series results page for a PlayerThree arena series (owner or unlisted share view): standings, per-agent accounting,
 * matches/artifacts, commentary disclosure and share links. Shows only server-released data; an older revision never
 * replaces a newer one, and the results stream reconnects to the same authorized revision.
 */
import type { MetricRow, ResultsSummary } from 'playerthree/arena';
import type { ObserverGrant } from 'playerthree/protocol';
import { arenaRequest, downloadArena, downloadArenaArtifact, streamArena, type ArenaAccess, type ArenaDelivery } from './arena-net.ts';
import { availableReplays, chartPoints, duration } from './arena-present.ts';
import { agentCard, entrantAgent } from './agent-button.ts';
import { copyText, fmt, h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import './arena.css';

export interface SeriesObserverSelection { access: ArenaAccess; matchId: string; grant: ObserverGrant; label: string }
export interface ArenaResultsOptions { access: ArenaAccess; onExit(): void; onObserve?(selection: SeriesObserverSelection): void }
export interface ArenaResultsPanel { dispose(): void }

function button(label: string, symbol: IconName, action: () => void): HTMLButtonElement {
  return h('button', { class: 'btn small', 'data-tip': label, 'aria-label': label, onclick: action }, icon(symbol, 16), label);
}
function table(headings: string[], rows: (string | number | Node)[][]): HTMLElement {
  return h('div', { class: 'arena-table-scroll' }, h('table', { class: 'arena-table' }, h('thead', {}, h('tr', {}, ...headings.map((heading) => h('th', { scope: 'col' }, heading)))), h('tbody', {}, ...rows.map((row) => h('tr', {}, ...row.map((cell) => h('td', {}, cell)))))));
}
const number = (value: number | null | undefined, digits = 0) => value == null ? 'Not reported' : fmt(value, digits);
const percent = (value: number | null) => value == null ? '—' : `${fmt(value * 100, 1)}%`;

function chart(label: string, rows: readonly MetricRow[]): HTMLElement {
  const figure = h('figure', { class: 'arena-chart' }, h('figcaption', {}, label));
  if (!rows.length) { figure.append(h('p', { class: 'muted' }, 'No recorded samples.')); return figure; }
  const groups = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const key = `${row.matchId} · ${row.team ?? row.scope}${row.role ? ` / ${row.role}` : ''} · ${row.metric} (${row.unit})`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const select = h('select', { 'aria-label': `${label} series`, 'data-tip': 'Select a recorded match, side and metric' });
  for (const key of groups.keys()) select.append(h('option', { value: key }, key));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 300 100'); svg.setAttribute('role', 'img');
  const polyline = document.createElementNS(svg.namespaceURI, 'polyline');
  polyline.setAttribute('fill', 'none'); polyline.setAttribute('stroke', 'currentColor'); polyline.setAttribute('stroke-width', '2'); svg.append(polyline);
  const summary = h('p', { class: 'muted' });
  const draw = () => {
    const points = [...groups.get(select.value)!].sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
    polyline.setAttribute('points', chartPoints(points)); svg.setAttribute('aria-label', `${select.value}, ${points.length} samples`);
    summary.textContent = `${points.length} samples · ticks ${points[0]!.tick}–${points.at(-1)!.tick} · min ${number(Math.min(...points.map((point) => point.value)), 2)} · max ${number(Math.max(...points.map((point) => point.value)), 2)}`;
  };
  select.addEventListener('change', draw); figure.append(select, svg, summary); draw(); return figure;
}

function bars(label: string, values: Map<string, number>): HTMLElement {
  const max = Math.max(1, ...values.values());
  return h('section', { class: 'arena-chart' }, h('h3', {}, label), values.size ? h('div', {}, ...[...values].map(([key, value]) => h('div', { class: 'arena-bar' }, h('span', {}, key), h('meter', { min: 0, max, value, 'aria-label': key }), h('b', {}, number(value))))) : h('p', { class: 'muted' }, 'No recorded samples.'));
}

function resultsBody(result: ResultsSummary, access: ArenaAccess, fail: (error: unknown) => void): HTMLElement {
  const t = result.tables;
  const names = new Map(t.entrants.map((entrant) => [entrant.entrantId, entrant.label]));
  const accepted = t.matches.filter((match) => match.acceptedAttempt && (match.status === 'finished' || match.status === 'forfeit'));
  const causes = new Map<string, number>();
  for (const row of t.causes) {
    const key = `${row.attackerTeam ?? 'Unattributed'} / ${row.attackerRole ?? 'unknown plane'} → ${row.victimTeam} / ${row.victimRole} · ${row.cause}`;
    causes.set(key, (causes.get(key) ?? 0) + row.count);
  }
  const intents = new Map<string, number>(); for (const row of t.intents) intents.set(`${row.team} / ${row.role} · ${row.source} · ${row.code}`, (intents.get(`${row.team} / ${row.role} · ${row.source} · ${row.code}`) ?? 0) + row.submitted);
  const rating = result.spec.rating.algorithm;
  const standings = table(['Entrant', 'W', 'L', 'D', 'Games', 'Win rate / seed-block interval', 'Score rate / seed-block interval', rating === 'elo' ? 'Elo (series-local)' : 'TrueSkill μ / σ / conservative', 'Status', 'Mean simulated / wall'], t.standings.map((row) => [
    names.get(row.entrantId) ?? row.entrantId, row.wins, row.losses, row.draws, row.games,
    `${percent(row.winRate)}${row.confidence.winRate ? ` [${row.confidence.winRate.map(percent).join(' – ')}]` : ' · interval not available'}`,
    `${percent(row.scoreRate)}${row.confidence.scoreRate ? ` [${row.confidence.scoreRate.map(percent).join(' – ')}]` : ' · interval not available'}`,
    rating === 'elo' ? number(row.rating, 1) : `${number(row.mu, 2)} / ${number(row.sigma, 2)} / ${number(row.conservativeRating, 2)}`,
    row.provisional ? 'Provisional' : 'Established', `${duration(row.averageSimulatedMs)} / ${duration(row.averageWallMs)}`,
  ]));
  const uncertainty = h('div', {}, ...t.standings.map((row) => h('p', { class: 'muted' }, `${names.get(row.entrantId) ?? row.entrantId}: ${row.confidence.method}/${row.confidence.version} · ${percent(row.confidence.level)} level · ${row.confidence.blocks} scenario/seed blocks · ${row.confidence.replicates} replicates · seed ${row.confidence.seed} · ${row.confidence.independent ? 'independent resets' : 'non-independent trials'} · rating ${row.ratingImplementation}${row.ratingParameters.algorithm === 'trueskill' ? ` · conservative μ−${row.ratingParameters.conservativeMultiplier}σ` : ' · Elo has no posterior σ; intervals describe win / score rates'}`)));
  const cards = t.entrants.map((entrant) => {
    const seats = t.seats.filter((seat) => seat.entrantId === entrant.entrantId);
    const latency = result.summaries.latency.filter((summary) => summary.entrantId === entrant.entrantId);
    const usage = result.summaries.usage.filter((summary) => summary.entrantId === entrant.entrantId);
    return h('article', { class: 'arena-agent', 'aria-label': entrant.label }, agentCard(entrantAgent(entrant)),
      table(['Seat', 'Accepted / submitted / rejected', 'Command APM'], seats.map((seat) => [`${seat.matchId} · ${seat.team} / ${seat.role}`, `${number(seat.acceptedIntents)} / ${number(seat.submittedIntents)} / ${number(seat.rejectedIntents)}`, number(seat.commandApm, 1)])),
      h('div', {}, ...(latency.length ? latency.map((summary) => h('p', {}, `${summary.source === 'host_gap' ? 'Host inter-call gap (not think time)' : `${summary.source} decision latency`}: ${number(summary.p50Ms, 1)} ms p50 / ${number(summary.p95Ms, 1)} ms p95 · n=${summary.samples} · ${summary.method}`)) : [h('p', {}, 'Think latency: Not reported')])),
      usage.length ? table(['Phase / source', 'Samples / coverage', 'Input / output tokens', 'Cache read / write', 'Reported cost subtotal'], usage.map((summary) => [`${summary.phase} / ${summary.reporter ?? 'Not reported'}`, `${summary.samples} / ${summary.coverage}`, `${number(summary.inputTokens)} / ${number(summary.outputTokens)}`, `${number(summary.cacheReadTokens)} / ${number(summary.cacheWriteTokens)}`, summary.costAmount === null ? 'Not reported' : `${summary.costAmount} ${summary.currency ?? 'currency not reported'}`])) : h('p', {}, 'Tokens: Not reported · Cost: Not reported'),
      h('p', { class: 'muted' }, 'Coverage and provenance are reported per phase/source. Authoring, inference and failed attempts remain separate. Partial reporting is not a full bill; unknown is not zero.'));
  });
  const replays = availableReplays(result);
  const sampled = Object.entries(result.sampling.tables).filter(([, entry]) => entry.method !== 'complete');
  const samplingNote = sampled.length ? h('p', { class: 'arena-sampling', role: 'note' }, icon('info', 16),
    `Live view shows sampled rows (limit ${fmt(result.sampling.limit)} per table): ${sampled.map(([key, entry]) => `${key} ${fmt(entry.included)} of ${fmt(entry.rows)}${entry.method === 'stride_per_series' ? ' evenly spaced per series' : ' in canonical order'}`).join(' · ')}. Totals, ratings, latency and usage are exact. Download JSON or CSV for every recorded row.`) : null;
  const rules = result.spec.template;
  return h('div', { class: 'arena-results-body' },
    h('section', { class: 'arena-panel' }, h('h2', {}, 'Standings'), h('p', { class: 'muted' }, `${accepted.length}/${t.schedule.length} accepted games · ${t.matches.length} attempts · recorded mean lengths shown per entrant`), standings, uncertainty, h('p', { class: 'muted' }, `${rating} v${result.spec.rating.version} · ${JSON.stringify(result.spec.rating)} · win rate excludes aborted/infrastructure attempts; draws remain separate. Provisional series-local ratings are descriptive, not a global ladder.`)),
    ...(samplingNote ? [samplingNote] : []),
    h('section', { class: 'arena-grid' }, chart('Economy over time (side stocks, income, spending, refunds)', t.metrics.filter((row) => /alloy|energy|income|spend|refund/.test(row.metric) && !/army|structure/.test(row.metric))), chart('Army / structures replacement value (alloy and energy separate)', t.metrics.filter((row) => /army|structure|production/.test(row.metric))), bars('Losses by recorded cause', causes), bars('Submitted intents by source / acknowledgement code', intents)),
    h('section', { class: 'arena-panel' }, h('h2', {}, 'Per-agent accounting'), h('p', { class: 'muted' }, 'Economy belongs to the side, not each agent. Host call gaps are not model think time. Attributions preserve unknown/environmental causes.'), h('div', { class: 'arena-agent-grid' }, ...cards)),
    h('section', { class: 'arena-panel' }, h('h2', {}, 'Matches and artifacts'), table(['Match / attempt', 'Status', 'Simulated', 'Wall', 'Reason'], t.matches.map((match) => [`${match.matchId} / ${match.attemptNumber}`, `${match.status}${match.acceptedAttempt ? ' · accepted' : ''}`, duration(match.simulatedMs), duration(match.wallMs), match.terminalReason])), replays.length ? h('div', { class: 'arena-actions' }, ...replays.map((artifact) => button(`Raw timeline replay · ${artifact.matchId ?? artifact.id}`, 'queue', () => { void downloadArenaArtifact(access, artifact.id).catch(fail); }))) : h('p', { class: 'muted' }, `Replay unavailable${t.artifacts.length ? ` · ${[...new Set(t.artifacts.map((artifact) => artifact.availability))].join(', ')}` : ' · not recorded'}`)),
    h('details', { class: 'arena-panel' }, h('summary', { 'data-tip': 'Inspect frozen reproducibility data and full resolved game rules' }, icon('settings', 16), 'Frozen specs, full resolved rules and comparison identity'), h('p', {}, rules.rules.ranked ? 'Ranked rules' : `Custom / unranked · ${rules.rules.practiceReasons.join(', ') || 'practice'}`), h('p', {}, `Rules SHA-256: ${rules.rulesHash}`), h('p', {}, `Comparison: ${result.comparisonHash}`), h('pre', {}, JSON.stringify(result.spec, null, 2))),
    h('section', { class: 'arena-panel' }, h('h2', {}, 'Recording and retention'), h('p', {}, `${result.completeness.rawComplete ? 'Recorded dataset complete' : 'Partial recorded dataset'} · ${result.completeness.missing.join(', ') || 'No missing tables reported'}`), h('p', {}, `Expires ${result.retention.expiresAt} · ${number(result.retention.bytes)} / ${number(result.retention.maxBytes)} bytes`), table(['Recorded table', 'Rows', 'Shown here', 'Bytes'], Object.entries(result.accounting.tables).map(([key, value]) => [key, value.rows, result.sampling.tables[key as keyof typeof result.sampling.tables]?.included ?? value.rows, value.bytes]))));
}

export function mountArenaResults(root: HTMLElement, options: ArenaResultsOptions): ArenaResultsPanel {
  const abort = new AbortController();
  const shell = h('main', { class: 'arena-results', 'aria-label': 'Series results' });
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, 'Loading authorized results…');
  const releasePolicy = h('p', { class: 'arena-release-policy' }, options.access.kind === 'share' ? 'Unlisted read-only · awaiting authorized release policy' : 'Private owner view');
  const ranking = h('span', { class: 'arena-rules-badge' });
  const rulesIdentity = h('code', { class: 'arena-rules-identity' });
  const content = h('div'); const actions = h('div', { class: 'arena-actions' });
  shell.append(h('header', { class: 'arena-panel arena-results-header' }, h('h1', {}, icon('chart', 24), 'Series results'), ranking, button('Back to lobby', 'leave', options.onExit), status, releasePolicy, rulesIdentity, actions), content); root.append(shell);
  let result: ResultsSummary | undefined;
  let delivery: ArenaDelivery | undefined;
  const delivered = (metadata: ArenaDelivery) => {
    delivery = metadata;
    releasePolicy.textContent = `${metadata.delayMs ? `Delayed ${Math.ceil(metadata.delayMs / 1000)} s` : 'Authorized zero-delay'} · ${metadata.playback === 'buffering' ? 'Buffering' : metadata.playback === 'ended' ? 'Ended · released playback complete' : 'Released playback · continues until the released end'} · all channels use the same server release clock`;
  };
  const fail = (error: unknown) => { if (!abort.signal.aborted) status.textContent = error instanceof Error ? error.message : 'Arena request failed.'; };
  const run = (action: () => Promise<unknown>) => { void action().catch(fail); };
  const consent = () => {
    const state = h('p', { role: 'status' }, 'Loading your entrants’ disclosure permissions…');
    const entries = h('div');
    const dialog = h('dialog', { class: 'arena-share', 'aria-label': 'Agent commentary disclosure' }, h('h2', {}, 'Your agents’ voluntary disclosure'), h('p', {}, 'World vision and commentary are separate permissions. Default is off. Only your own agents’ emitted summaries and game chat may be disclosed; this never requests prompts, private owner messages or chain-of-thought. Withdrawal stops subsequent delivery and revokes commentary shares. Previously downloaded or cached copies cannot be recalled.'), state, entries, button('Close disclosure', 'cancel', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove()); shell.append(dialog); dialog.showModal();
    void (async () => {
      try {
        const answer = await arenaRequest<{ consents: { entrantId: string; summaries: boolean; chat: boolean }[] }>(options.access, '/commentary/consent', undefined, abort.signal);
        if (!dialog.isConnected) return;
        state.textContent = answer.consents.length ? 'Choose each category independently. Organizers cannot consent for another owner.' : 'No agents controlled by your profile in this series.';
        for (const entry of answer.consents) {
          const summaries = h('input', { type: 'checkbox', checked: entry.summaries, 'data-tip': 'Allow this entrant’s explicitly emitted summaries to authorized observers' });
          const chat = h('input', { type: 'checkbox', checked: entry.chat, 'data-tip': 'Allow this entrant’s explicitly emitted game chat to authorized observers' });
          const label = result?.tables.entrants.find((entrant) => entrant.entrantId === entry.entrantId)?.label ?? entry.entrantId;
          const save = button(`Save disclosure · ${label}`, 'check', () => {
            save.disabled = true;
            void arenaRequest(options.access, '/commentary/consent', { entrantId: entry.entrantId, summaries: summaries.checked, chat: chat.checked }, abort.signal).then(() => { state.textContent = 'Disclosure saved. Withdrawal revokes existing commentary shares; create a new preview before publishing again.'; }).catch((error: unknown) => { state.textContent = error instanceof Error ? error.message : 'Disclosure could not be saved.'; }).finally(() => { save.disabled = false; });
          });
          entries.append(h('section', { class: 'arena-comment' }, h('h3', {}, label), h('label', {}, summaries, icon('info', 14), 'Agent-emitted summaries'), h('label', {}, chat, icon('chat', 14), 'Agent-emitted game chat'), save));
        }
      } catch (error) { state.textContent = error instanceof Error ? error.message : 'Disclosure permissions unavailable.'; }
    })();
  };
  const share = () => {
    const commentary = h('input', { type: 'checkbox', 'aria-label': 'Include consented agent commentary', 'data-tip': 'Second consent layer: only independently owner-consented summaries and chat may be published' });
    const expires = h('input', { type: 'datetime-local', 'aria-label': 'Share expiry', 'data-tip': 'Public link expiry in your local time zone' });
    const initialExpiry = new Date(Math.min(Date.parse(result!.retention.expiresAt), Date.now() + 7 * 86400000));
    expires.value = new Date(initialExpiry.getTime() - initialExpiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    let previewPolicy: { commentary: boolean; expiresAt: string } | undefined;
    const preview = h('div'); const publish = button('Publish this preview', 'invite', () => run(async () => {
      if (!previewPolicy) throw new Error('Preview the selected disclosure policy before publishing.');
      publish.disabled = true;
      const answer = await arenaRequest<{ url: string }>(options.access, '/share', previewPolicy);
      preview.replaceChildren(h('p', {}, 'Unlisted read-only link. Anyone with this link may download its projection; it is not an ACBench publication.'), h('a', { href: answer.url, rel: 'noopener' }, answer.url), button('Copy share link', 'invite', () => run(async () => { if (!await copyText(answer.url)) throw new Error('Could not copy link.'); })));
      publish.disabled = true;
    })); publish.disabled = true;
    const resetPreview = () => { previewPolicy = undefined; publish.disabled = true; preview.replaceChildren(); };
    commentary.addEventListener('change', resetPreview); expires.addEventListener('change', resetPreview);
    const dialog = h('dialog', { class: 'arena-share', 'aria-label': 'Share result preview' }, h('h2', {}, 'Publish an opt-in, revocable result'), h('p', {}, 'Default: commentary off. Only each owner’s expressly disclosed summaries and game chat can be included. Downloaded or cached copies cannot be recalled.'), h('label', {}, commentary, 'Include consented agent commentary'), h('label', {}, 'Expiry', expires), button('Preview public projection', 'spectate', () => run(async () => {
      const policy = { commentary: commentary.checked, expiresAt: new Date(expires.value).toISOString() };
      const projected = await arenaRequest<ResultsSummary>(options.access, '/share/preview', policy);
      if (policy.commentary !== commentary.checked || policy.expiresAt !== new Date(expires.value).toISOString() || !dialog.isConnected) return;
      previewPolicy = policy;
      preview.replaceChildren(h('p', {}, projected.disclosure.commentary ? 'Only consented commentary included.' : 'Commentary excluded.'), h('pre', {}, JSON.stringify(projected, null, 2))); publish.disabled = false;
    })), preview, publish, button('Close preview', 'cancel', () => { dialog.close(); dialog.remove(); }));
    shell.append(dialog); dialog.showModal();
  };
  const render = (incoming: ResultsSummary) => {
    if (abort.signal.aborted || result && incoming.revision < result.revision) return;
    result = incoming;
    ranking.textContent = incoming.spec.template.rules.ranked ? 'Ranked' : `Custom / unranked · ${incoming.spec.template.rules.practiceReasons.join(', ') || 'practice'}`;
    rulesIdentity.textContent = `Resolved rules SHA-256 · ${incoming.spec.template.rulesHash}`;
    const released = delivery ? `${delivery.delayMs ? `Delayed ${Math.ceil(delivery.delayMs / 1000)} s` : 'Authorized zero-delay'} · ${delivery.playback === 'buffering' ? 'Buffering' : delivery.playback === 'ended' ? 'Ended · released playback complete' : 'Released playback · catching up on delayed footage'} · all channels use the same server release clock` : 'Server-released results · all channels share the release watermark';
    status.textContent = `${incoming.state} · revision ${incoming.revision} · ${incoming.tables.matches.filter((match) => match.acceptedAttempt).length}/${incoming.tables.schedule.length} games · ${incoming.disclosure.audience === 'shared' ? `Unlisted read-only · ${released}` : 'Private owner view · live committed updates'}`;
    content.replaceChildren(resultsBody(incoming, options.access, fail));
    const active = h('section', { class: 'arena-panel arena-active-matches', 'aria-label': 'Active series matches' }, h('h2', {}, icon('spectate'), 'Watch the series'));
    if (!incoming.activeMatches.length) active.append(h('p', { class: 'muted' }, 'No active matches released to this viewer.'));
    for (const match of incoming.activeMatches) {
      const label = `${match.spec.map.id} · seed ${match.spec.seed} · attempt ${match.attemptNumber}`;
      const watch = button(`Watch · ${label}`, 'spectate', () => run(async () => {
        watch.disabled = true;
        try {
          const admission = await arenaRequest<{ grant: ObserverGrant }>(options.access, `/matches/${encodeURIComponent(match.matchId)}/observer`, undefined, abort.signal);
          if (!abort.signal.aborted) options.onObserve?.({ access: options.access, matchId: match.matchId, grant: admission.grant, label });
        } finally { watch.disabled = false; }
      }));
      watch.disabled = !options.onObserve;
      active.append(h('article', { class: 'arena-agent' }, h('h3', {}, label), h('p', { class: 'muted' }, `Trial ${match.trialId} · ${match.matchId} · read-only server-authorized observation`), watch));
    }
    content.prepend(active);
    actions.replaceChildren(button('Download JSON', 'queue', () => run(() => downloadArena(options.access, 'json', incoming.revision))), button('CSV tables ZIP', 'queue', () => run(() => downloadArena(options.access, 'csv', incoming.revision))));
    if (options.access.kind === 'owner') actions.append(button('Agent disclosure', 'chat', consent), button('Share / preview', 'invite', share), button('Revoke all share links', 'cancel', () => run(async () => { await arenaRequest(options.access, '/share/revoke', {}); status.textContent = 'Share links revoked. Previously downloaded copies cannot be recalled.'; })));
  };
  void (async () => {
    try {
      render(await arenaRequest<ResultsSummary>(options.access, '', undefined, abort.signal, delivered));
      while (!abort.signal.aborted) {
        try { await streamArena(options.access, result!.revision, abort.signal, render, delivered); }
        catch (error) { if (abort.signal.aborted) return; fail(error); }
        if (abort.signal.aborted) return;
        status.textContent = 'Results stream disconnected · reconnecting to the same authorized revision…';
        const pause = Promise.withResolvers<void>();
        const timer = setTimeout(pause.resolve, 2000);
        const interrupted = () => { clearTimeout(timer); pause.resolve(); };
        abort.signal.addEventListener('abort', interrupted, { once: true });
        await pause.promise;
        abort.signal.removeEventListener('abort', interrupted);
      }
    } catch (error) { fail(error); }
  })();
  return { dispose() { abort.abort(); shell.remove(); } };
}
