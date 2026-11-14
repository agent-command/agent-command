/**
 * LLM exploit hunt (DESIGN §11.4). For each role in turn, an LLM commander (the player-side PlayerThree runner, on
 * the developer's key, hard USD budget) sits in the lobby of an in-process PlayerThree host served over a loopback
 * MCP endpoint — the same tools players get — and is told to find degenerate strategies: write a policy, practice
 * it against the veteran bots, iterate. Every deploy and practice result is captured; each role's final policy is
 * then re-played through the sweep harness against the bots in both orientations.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MCP_TOOL_NAMES } from 'playerthree';
import { createPlayerThreeHost } from 'playerthree/host';
import { createMcpRequestHandler } from 'playerthree/mcp';
import {
  Budget,
  connectSeat,
  createAnthropicProvider,
  createOpenAiProvider,
  llmTools,
  priceFor,
  runAgent,
  type RemoteSeat,
  type RunSummary,
  type ToolOutcome,
} from '@playerthree/runner';
import { definition, DEFAULT_TIME_CAP_TICKS, TICK_RATE, toTicks, type Opponent, type Plane } from '@agent-command/game';
import { probeMax } from './guardrails.ts';
import { aggregate, type SetStats } from './metrics.ts';
import { DEFAULT_WORKERS, runBalance } from './bench.ts';
import { layoutArmies, rotations, type RunSet } from './spec.ts';

export interface HuntOptions {
  label: string;
  maxUsd: number;
  roles: Plane[];
  maxTurns: number;
  evalSeeds: number;
  out: string;
  model?: string;
}

interface Deploy {
  turn: number;
  ok: boolean;
  version?: number;
  error?: string;
  code: string;
}

interface Practice {
  turn: number;
  /** policy version active when it ran (the agent may also practice an undeployed artifact) */
  version: number | null;
  opponent: string;
  allies?: string;
  seed?: number;
  ticks: number;
  outcome: string;
  /** game ticks played */
  played: number;
  /** the tested army's report stats (lobby practice seats it on the host's first army) */
  us?: Record<string, number>;
  /** every hostile army's report stats */
  them?: Record<string, number>[];
}

interface RoleHunt {
  role: Plane;
  /** why the agent stopped: `finished` = it ended its turn in the lobby (done), else the runner's stop reason */
  stop: 'finished' | RunSummary['reason'];
  summary: RunSummary;
  /** the agent's last words: its own summary of what it tried */
  closing: string;
  deploys: Deploy[];
  practices: Practice[];
  final?: { version: number; code: string; eval: SetStats[] };
}

export interface HuntResult {
  label: string;
  model: string;
  maxUsd: number;
  spentUsd: number;
  wallMs: number;
  roles: RoleHunt[];
}

const OWNER = 'balance-hunt';
const MAX_OUTPUT_TOKENS = 4000;
const PRACTICE_TICKS = toTicks(20 * 60);

function brief(role: Plane, instructions: string | undefined): string {
  return [
    `You are a balance tester (red team) for the designers of Agent Command, an RTS. You drive the ${role.toUpperCase()} commander through tools, in the lobby: there is no live match.`,
    `Goal: find DEGENERATE strategies — a policy for the ${role} plane that beats the strongest built-in opponent ("veteran") far more often than a balanced plan should. Look for cheap, one-dimensional or rule-abusing plans: rushes, spamming one unit or structure, a mechanic with no counter, a blind spot of the bots. Your teammates on the other planes are built-in bots of the same level as the opponent.`,
    'Method:',
    `1. Call ${MCP_TOOL_NAMES.briefing} once, then read the strategy skill and the starter for your plane, policies/<plane>.js (${MCP_TOOL_NAMES.skill}).`,
    `2. Write a JS policy (think(obs) returns intents) that pushes ONE idea hard, and start it with log('strategy: <one line>'). Deploy it with ${MCP_TOOL_NAMES.policyDeploy} and check the probe.`,
    `3. ${MCP_TOOL_NAMES.practice} against "veteran" with ticks ${PRACTICE_TICKS} on 2–3 different seeds; read outcome and report (spireDamageDealt, kills, unitsLost).`,
    '4. Sharpen what wins; after two failures switch to a different idea. Keep your best policy deployed at the end.',
    'When an exploit wins repeatedly, or after three ideas, stop: answer with a short paragraph (no tool call) naming each idea, its record, and why the best one works.',
    'You have a hard budget: be concise and never re-read large outputs.',
    instructions ? `Server instructions:\n${instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);

/** Record the agent's deploys and practice runs as they pass through; end the run when it idles in the lobby. */
function instrument(seat: RemoteSeat, role: Pick<RoleHunt, 'deploys' | 'practices'>, turns: () => number, abort: AbortController): RemoteSeat {
  let active: number | null = null;
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    // A wait that would block in the lobby means the agent is done (the runner waits there when the model idles).
    if (name === MCP_TOOL_NAMES.wait && (num(args['seconds']) ?? 0) > 0) {
      abort.abort();
      return seat.call(name, { seconds: 0 });
    }
    const r = await seat.call(name, args);
    const out = obj(r.structured);
    if (name === MCP_TOOL_NAMES.policyDeploy) {
      const version = num(out?.['version']);
      const error = obj(out?.['error']);
      if (!r.isError && version !== undefined) active = version;
      role.deploys.push({
        turn: turns(),
        ok: !r.isError && out?.['ok'] === true,
        ...(version !== undefined ? { version } : {}),
        ...(error ? { error: String(error['code']) } : r.isError ? { error: 'rejected' } : {}),
        code: typeof args['code'] === 'string' ? args['code'] : '',
      });
    } else if (name === MCP_TOOL_NAMES.policyRollback && !r.isError) {
      active = num(out?.['version']) ?? active;
    } else if (name === MCP_TOOL_NAMES.practice && !r.isError && out) {
      const report = obj(out['report']);
      role.practices.push({
        turn: turns(),
        version: obj(args['artifact']) ? null : active,
        opponent: String(args['opponent']),
        ...(typeof args['allies'] === 'string' ? { allies: args['allies'] } : {}),
        ...(num(args['seed']) !== undefined ? { seed: num(args['seed'])! } : {}),
        ticks: num(args['ticks']) ?? 0,
        outcome: String(out['outcome']),
        played: num(out['ticks']) ?? 0,
        ...practiceStats(report),
      });
    }
    return r;
  };
  return { ...seat, call };
}

/** Hunts practise duels: the host's match armies, the tested seat on the first (PlayerThree lobby practice). */
const HUNT_ARMIES = layoutArmies('duel');

/** Split a practice report's per-army rows into the tested army and its hostiles. */
function practiceStats(report: Record<string, unknown> | undefined): Pick<Practice, 'us' | 'them'> {
  const rows = Array.isArray(report?.['armies']) ? (report['armies'] as unknown[]).map(obj).filter((row) => row !== undefined) : [];
  const stats = (row: Record<string, unknown>): Record<string, number> => obj(row['stats']) as Record<string, number>;
  const us = rows.find((row) => row['army'] === HUNT_ARMIES[0]);
  return us ? { us: stats(us), them: rows.filter((row) => row !== us).map(stats) } : {};
}

/** Re-play a policy (on its seat, bots elsewhere) against bots of each level, both orientations. */
async function evaluatePolicy(role: Plane, version: number, code: string, seeds: number): Promise<SetStats[]> {
  const levels: Opponent[] = ['standard', 'veteran'];
  const sets: RunSet[] = levels.map((level) => ({
    key: `hunt-${role}-v${version}-${level}`,
    kind: 'probe',
    title: `${role} v${version} vs ${level}`,
    entrants: [{ level, probe: `hunt-${role}-v${version}`, policies: { [role]: code } }, { level }],
    layout: 'duel',
    seeds: Array.from({ length: seeds }, (_, i) => 3001 + i),
    permutations: rotations(HUNT_ARMIES.length),
  }));
  const results = await runBalance(sets, DEFAULT_TIME_CAP_TICKS + 1, DEFAULT_WORKERS,
    fileURLToPath(new URL(`../../../bench-results/hunt-${role}-v${version}`, import.meta.url)));
  const matches = results.matches;
  return sets.map((s) => aggregate(s, matches.filter((m) => m.set === s.key)));
}

export async function runHunt(o: HuntOptions): Promise<HuntResult> {
  const openaiKey = process.env['OPENAI_API_KEY'];
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const model = o.model ?? (openaiKey ? 'gpt-5-mini' : anthropicKey ? 'claude-haiku-5-5' : undefined);
  if (!model) throw new Error('set OPENAI_API_KEY or ANTHROPIC_API_KEY');
  const anthropic = model.startsWith('claude');
  const apiKey = anthropic ? anthropicKey : openaiKey;
  if (!apiKey) throw new Error(`${anthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is not set`);
  const price = priceFor(model);
  if (!price) throw new Error(`no built-in price for ${model}: the budget could not be enforced`);

  const t0 = performance.now();
  const host = createPlayerThreeHost({ definition, teams: HUNT_ARMIES });
  const mcp = createMcpRequestHandler(host, {});
  const server = createServer((req, res) => void mcp(req, res));
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  await host.commanders.ready;

  const result: HuntResult = {
    label: o.label,
    model,
    maxUsd: o.maxUsd,
    spentUsd: 0,
    wallMs: 0,
    roles: [],
  };
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  try {
    for (const [i, role] of o.roles.entries()) {
      const share = (o.maxUsd - result.spentUsd) / (o.roles.length - i);
      log(`hunt: ${role} with ${model}, budget $${share.toFixed(3)}`);
      const commander = host.commanders.create(OWNER, { name: `hunt ${role}`, kind: 'policy', roles: [role], isolation: { independentSessions: true } });
      const seat = await connectSeat({ url, token: host.commanders.token(OWNER, commander.id), clientName: 'agent-command-balance' });
      const captured: Pick<RoleHunt, 'deploys' | 'practices'> = { deploys: [], practices: [] };
      let closing = '';
      const abort = new AbortController();
      const budget = new Budget(share, price);
      const opts = { model, apiKey, system: brief(role, seat.instructions), tools: llmTools(seat), maxOutputTokens: MAX_OUTPUT_TOKENS };
      const provider = anthropic ? createAnthropicProvider(opts) : createOpenAiProvider(opts);
      let turns = 0;
      const turn = provider.turn.bind(provider);
      provider.turn = async (signal) => {
        const t = await turn(signal);
        turns++;
        if (t.text) closing = t.text;
        return t;
      };
      let summary: RunSummary;
      try {
        summary = await runAgent({
          seat: instrument(seat, captured, () => turns, abort),
          provider,
          budget,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxTurns: o.maxTurns,
          log: (line) => log(`  ${role}: ${line}`),
          signal: abort.signal,
        });
      } finally {
        await seat.close();
      }
      const stop = abort.signal.aborted && summary.reason === 'aborted' ? 'finished' : summary.reason;
      const hunt: RoleHunt = { role, stop, summary, closing, ...captured };
      result.spentUsd += summary.spentUsd;
      const active = host.commanders.roster(OWNER).find((c) => c.id === commander.id)?.policy.activeByRole[role] ?? null;
      const deployed = hunt.deploys.find((d) => d.ok && d.version === active);
      if (active !== null && deployed) {
        log(`hunt: ${role} final policy v${active}: re-playing ${o.evalSeeds * 4} matches`);
        hunt.final = { version: active, code: deployed.code, eval: await evaluatePolicy(role, active, deployed.code, o.evalSeeds) };
      }
      result.roles.push(hunt);
    }
  } finally {
    await mcp.close();
    server.close();
    host.dispose();
  }
  result.wallMs = Math.round(performance.now() - t0);
  mkdirSync(o.out, { recursive: true });
  writeFileSync(`${o.out}/${o.label}.json`, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(`${o.out}/${o.label}.md`, huntMarkdown(result));
  log(`hunt: wrote ${o.out}/${o.label}.md and .json; spent $${result.spentUsd.toFixed(4)} of $${o.maxUsd.toFixed(2)}`);
  return result;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export function huntMarkdown(r: HuntResult): string {
  const out: string[] = [];
  out.push(`# Exploit hunt: ${r.label}`);
  out.push('');
  out.push(
    `${r.model} · spent $${r.spentUsd.toFixed(4)} of $${r.maxUsd.toFixed(2)} · ${(r.wallMs / 60000).toFixed(1)} min wall.`,
  );
  out.push('');
  out.push(
    'One LLM commander per role in the PlayerThree lobby (loopback MCP, the player tool surface), told to find degenerate strategies by writing policies and practising them against the veteran bots. ' +
      `Each role's final deployed policy is then re-played through the sweep harness (its seat only; bots of the same level elsewhere) in both orientations. A final policy above ${pct(probeMax('duel'))} against its own level is a finding.`,
  );
  out.push('');
  out.push('| role | stop | turns | tool calls | spent | deploys (ok) | practices (W/L/D) | final | vs standard | vs veteran |');
  out.push('|---|---|---:|---:|---:|---:|---|---|---|---|');
  for (const h of r.roles) {
    const w = h.practices.filter((p) => p.outcome === 'win').length;
    const l = h.practices.filter((p) => p.outcome === 'loss').length;
    const d = h.practices.length - w - l;
    const ev = (level: string): string => {
      const s = h.final?.eval.find((e) => e.entrants[1]!.level === level);
      return s ? `${pct(s.aRate.p)} [${pct(s.aRate.lo)}–${pct(s.aRate.hi)}] of ${s.n}${s.aRate.p > probeMax(s.layout) ? ' **finding**' : ''}` : '–';
    };
    out.push(
      `| ${h.role} | ${h.stop} | ${h.summary.turns} | ${h.summary.toolCalls} | $${h.summary.spentUsd.toFixed(4)} | ${h.deploys.length} (${h.deploys.filter((x) => x.ok).length}) | ${w}/${l}/${d} | ${h.final ? `v${h.final.version}` : '–'} | ${ev('standard')} | ${ev('veteran')} |`,
    );
  }
  out.push('');
  for (const h of r.roles) {
    out.push(`## ${h.role}`);
    out.push('');
    if (h.closing) {
      out.push("Agent's closing words (LLM-authored):");
      out.push('');
      for (const line of h.closing.trim().split('\n')) out.push(`> ${line}`);
      out.push('');
    }
    if (h.practices.length) {
      out.push('| turn | policy | vs | seed | outcome | minutes | Spire dmg dealt | kills | units lost |');
      out.push('|---:|---|---|---:|---|---:|---:|---:|---:|');
      for (const p of h.practices) {
        out.push(
          `| ${p.turn} | ${p.version === null ? 'inline' : `v${p.version}`} | ${p.opponent} | ${p.seed ?? '–'} | ${p.outcome} | ${(p.played / TICK_RATE / 60).toFixed(1)} | ${p.us?.['spireDamageDealt'] ?? '–'} | ${p.us?.['kills'] ?? '–'} | ${p.us?.['unitsLost'] ?? '–'} |`,
        );
      }
      out.push('');
    } else out.push('No practice runs.\n');
    for (const d of h.deploys) {
      out.push(`<details><summary>turn ${d.turn}: deploy ${d.ok ? `v${d.version}` : `failed (${d.error ?? 'error'})`}${h.final?.version === d.version && d.ok ? ' — final' : ''}</summary>`);
      out.push('');
      out.push('```js');
      out.push(d.code.trimEnd());
      out.push('```');
      out.push('');
      out.push('</details>');
      out.push('');
    }
  }
  return out.join('\n');
}
