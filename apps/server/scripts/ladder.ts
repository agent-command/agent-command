/**
 * Ladder operator console (the official deploy has no dev-admin). Reads `DATABASE_URL` and, for voids,
 * `RESULTS_SIGNING_KEY`; never prints either.
 *
 *   node apps/server/scripts/ladder.ts flags                       open integrity flags
 *   node apps/server/scripts/ladder.ts void <matchId> [reason]     signed voided_review verdicts for a match
 *   node apps/server/scripts/ladder.ts dismiss <flagId>            close a flag without action
 *
 * A void appends signed verdict rows (never rewrites an entry); the server's ladder recomputes within a minute.
 */
import { fileURLToPath } from 'node:url';
import { openPostgresStorage } from 'playerthree/postgres';
import { createPlayerThreeHost } from 'playerthree/host';
import { effectiveVerdict, parseResultsSigner } from 'playerthree/results';
import { definition } from '@agent-command/game';

const [command, target, reasonArg] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !command || !['flags', 'void', 'dismiss'].includes(command)) {
  console.error('usage: ladder.ts flags | void <matchId> [reason] | dismiss <flagId>   (DATABASE_URL required)');
  process.exit(2);
}
const storage = await openPostgresStorage({ url, migrations: { scope: 'agent-command', dir: fileURLToPath(new URL('../migrations', import.meta.url)) } });
try {
  if (command === 'flags') {
    const rows = await storage.query<{ id: string; kind: string; subject: unknown; detail: unknown; created_at: Date }>('SELECT id, kind, subject, detail, created_at FROM ac_integrity_flags WHERE reviewed_at IS NULL ORDER BY created_at');
    for (const row of rows) console.log(`${row.id}  ${row.created_at.toISOString()}  ${row.kind}  ${JSON.stringify(row.subject)}  ${JSON.stringify(row.detail)}`);
    console.log(`${rows.length} open flag(s)`);
  } else if (command === 'dismiss') {
    if (!target) throw new Error('dismiss needs a flag id');
    await storage.query("UPDATE ac_integrity_flags SET reviewed_at = now(), decision = 'dismiss' WHERE id = $1", [target]);
    console.log(`dismissed ${target}`);
  } else {
    if (!target || !process.env.RESULTS_SIGNING_KEY) throw new Error('void needs a match id and RESULTS_SIGNING_KEY');
    const reason = reasonArg ?? 'review';
    const host = createPlayerThreeHost({ definition, commanderStore: storage.commanders(definition.manifest.id), commanderLog: { store: storage.commanderLog(definition.manifest.id), signer: parseResultsSigner(process.env.RESULTS_SIGNING_KEY) } });
    await host.ready;
    const entries = await host.commanderLog.match(target);
    if (!entries.length) throw new Error(`no commander log entries for match ${target}`);
    const rows = await host.commanderLog.verdicts();
    for (const { entry } of entries) {
      const current = effectiveVerdict(entry, rows);
      await host.commanderLog.amend(entry.entryId, { ...current, rated: false, weight: 0, reasons: [...new Set([...current.reasons, 'voided_review'])].sort() }, reason);
    }
    await storage.query(`UPDATE ac_integrity_flags SET reviewed_at = now(), decision = 'void' WHERE reviewed_at IS NULL AND subject->>'matchId' = $1`, [target]);
    console.log(`voided ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} of ${target}; the ladder recomputes within a minute`);
    host.dispose();
  }
} finally {
  await storage.close();
}
