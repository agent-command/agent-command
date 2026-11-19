import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let playerThree = resolve(root, '../player-three');
const option = args.indexOf('--playerthree');
if (option !== -1) {
  if (!args[option + 1]) throw new Error('--playerthree needs a checkout path');
  playerThree = resolve(args[option + 1]);
  args.splice(option, 2);
}
// An unlinked `railway up` from an agent harness silently creates a brand-new project, so the target must be explicit.
for (const flag of ['--project', '--environment', '--service']) {
  if (!args.includes(flag)) throw new Error(`deploy:railway needs ${flag} (see README "Deploy")`);
}
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8' }).trim();
for (const repo of [root, playerThree]) {
  if (git(repo, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error(`Commit tracked changes before deploying ${repo}`);
  }
}
const revisions = { agentCommand: git(root, 'rev-parse', 'HEAD'), playerThree: git(playerThree, 'rev-parse', 'HEAD') };
const context = mkdtempSync(join(tmpdir(), 'agent-command-release-'));
try {
  for (const [name, repo] of [['agent-command', root], ['player-three', playerThree]]) {
    const target = join(context, name);
    const archive = join(context, `${name}.tar`);
    mkdirSync(target);
    execFileSync('git', ['archive', '--format=tar', '--output', archive, 'HEAD'], { cwd: repo, stdio: 'inherit' });
    execFileSync('tar', ['-xf', archive, '-C', target], { stdio: 'inherit' });
    rmSync(archive);
  }
  copyFileSync(join(context, 'agent-command', 'Dockerfile'), join(context, 'Dockerfile'));
  writeFileSync(join(context, 'release.json'), `${JSON.stringify(revisions, null, 2)}\n`);
  console.log(`Releasing Agent Command ${revisions.agentCommand} + PlayerThree ${revisions.playerThree}`);
  execFileSync('railway', ['up', context, '--path-as-root', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      RAILWAY_CALLER: 'skill:use-railway@1.7.0',
      RAILWAY_AGENT_SESSION: process.env.RAILWAY_AGENT_SESSION || `agent-command-release-${Date.now()}`,
    },
  });
} finally {
  rmSync(context, { recursive: true, force: true });
}
