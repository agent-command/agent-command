#!/usr/bin/env node
/**
 * Public-release lint: tracked files carry no calendar dates, relative dates, commit or pull-request references,
 * branch names, pre-release wording, dated file names or media timestamps. The public repository is one commit,
 * so nothing in it may say when or over what period the work was done.
 *
 *   node scripts/check-public.mjs              tracked files in the working tree
 *   node scripts/check-public.mjs --ref <ref>  the tree of <ref> (what scripts/public-snapshot.sh commits)
 *   node scripts/check-public.mjs --summary    counts per rule only
 *
 * Exits 1 on any finding. ALLOW is the whole allowlist; keep it small and give every entry a reason. An entry that
 * no longer matches anything is reported as `stale-allow`, so the list cannot outlive what it excuses.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const HEX = '(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]';

/** Text rules: id → patterns. Every match is a finding unless ALLOW covers it. */
const RULES = {
  'iso-date': [/(?<![\w.\/])(?:19|20)\d\d-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?(?![\d])/g],
  'compact-date': [
    /(?<![\w.])20[0-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:T\d{4,6}Z?)?(?!\w)/g,
    /(?<!\d)20[0-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{6}(?!\d)/g, // web.archive.org-style capture stamps
    /\/20(?:2[5-9]|3\d)\/(?:0?[1-9]|1[0-2])\//g, // recent year/month in a URL path
  ],
  'code-date': [/\bDate\.UTC\(\s*(?:19|20)\d\d\b|\bnew Date\(\s*(?:19|20)\d\d\s*,|(?<![\w.])20[0-3]\dQ[1-4]\b/g],
  'month-date': [
    new RegExp(`\\b(?:${MONTH})\\.? (?:\\d{1,2}(?:st|nd|rd|th)?|(?:19|20)\\d\\d)\\b(?![%×:.]\\d|\\s*[%×])`, 'g'),
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:${MONTH})\\b`, 'g'),
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g,
  ],
  'slash-date': [/(?<![\w\/.])(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])\/(?:19|20)\d\d(?![\w\/])/g],
  'relative-date': [
    /\b(?:yesterday|tomorrow|tonight|nowadays|this (?:week|weekend|month|morning|afternoon|evening|year)|last (?:week|weekend|month|night|year)|next (?:week|weekend|month|year)|(?:a|one|two|three|four|a few|few|several) (?:days|weeks|months|years) ago|earlier this (?:week|month|year)|(?:in|since|as of|during|until|by|early|late|mid-?)\s+20[2-3]\d)\b/gi,
  ],
  'commit-ref': [
    new RegExp(`\`${HEX}{7,40}\``, 'g'),
    new RegExp(`\\b(?:commit|commits|sha|rev|revision|cherry-picked|reverted|merged|master|main|HEAD|at|against|since|before|after)\\s+(?:\`|\\()?${HEX}{7,40}\\b`, 'gi'),
    new RegExp(`(?<![\\w#$%\\/.:'"=-])(?!ed25519\\b)${HEX}{7,12}(?![\\w-])`, 'g'),
    new RegExp(`["'](?!ed25519["'])${HEX}{7,12}(?:\\+dirty)?["']|(?<![0-9a-f])[0-9a-f]{40}(?:\\+dirty)?(?![0-9a-f])`, 'g'),
    /\bPR ?#\d+|\bpull request #\d+|\/pull\/\d+|\/commit\/[0-9a-f]{7,}|"commit"\s*:\s*"[0-9a-f]{7,40}/gi,
    /(?:\b(?:branch|branches|on|from|merged|into|worktree|checkout)\s+`?|`)(?:feat|feature|fix|bugfix|hotfix|chore|perf|refactor|wip|exp|release)\/[a-z0-9][\w.-]*/g,
    /\borigin\/(?:master|main|deploy|HEAD)\b/g,
  ],
  prerelease: [
    /\bpre-?release\b/gi,
    /\b(?:public|closed|open|early|private) (?:alpha|beta)\b|\b(?:alpha|beta) (?:release|build|version|testers?|testing|access|stage|period)\b|\bin (?:alpha|beta)\b|\bearly access\b/gi,
    /\b\d+\.\d+\.\d+-(?:alpha|beta|rc|pre)\b/gi,
  ],
  history: [
    /\b(?:before|after|since|during|until|closes|closing|post-|pre-)\s*(?:Phase|pass|checkpoint) [A-H\d]\w*/gi,
    /\b(?:Phase|Checkpoint|Pass) [A-H\d]\w* (?:complete|completed|closure|closed|in progress|done|finished|landed|shipped)\b/gi,
    /\bchangelog\b.{0,40}\bdate/gi,
  ],
};

/**
 * The whole allowlist. `match` is tested against the matched text, `line` (optional) against its whole line,
 * `path` (optional) against the file path.
 */
const ALLOW = [
  { rule: 'iso-date', match: /^2026-07-28$/, line: /\bMCP\b/, why: 'MCP protocol version identifier' },
  { rule: 'iso-date', match: /^(?:2025-11-20|2026-09-15)$/, line: /`mcp-client-(?:2025-11-20|2026-09-15)`/, why: 'Anthropic API `mcp-client-*` beta header identifiers' },
  { rule: 'iso-date', match: /^2000-0[1-2](?:-\d\d)?$/, why: 'synthetic fixture timestamps (year 2000 is the fixture epoch)' },
  { rule: 'code-date', match: /2000/, why: 'synthetic fixture timestamps and seasons (year 2000 is the fixture epoch)' },
  { rule: 'iso-date', match: /^2099-01-01$/, why: 'synthetic far-future fixture timestamp' },
  { rule: 'month-date', match: /./, path: /(?:^|\/)(?:LICENSE[^/]*|OFL[^/]*|CREDITS\.txt)$/, why: 'third-party licence texts carry their own publication dates' },
  { rule: 'month-date', match: /./, line: /\b1970\b/, why: 'Unix epoch in synthetic HTTP-date fixtures' },
];

/** Paths never scanned as text: the generated lockfile (integrity hashes only) and this file (its rules spell the words they reject). */
const SKIP_TEXT = [/(?:^|\/)pnpm-lock\.yaml$/, /^scripts\/check-public\.mjs$/];

const MEDIA = /\.(?:png|jpe?g|webp)$/i;
/** A year-month(-day) anywhere in a path, with or without separators (`notes-2031-04.md`, `run-20310402`). */
const DATED_PATH = /(?<![\d.])(?:19|20)\d\d-?(?:0[1-9]|1[0-2])(?:-?(?:0[1-9]|[12]\d|3[01]))?(?!\d)/g;

const args = process.argv.slice(2);
const refAt = args.indexOf('--ref');
const ref = refAt >= 0 ? args[refAt + 1] : undefined;
if (refAt >= 0 && !ref) { console.error('--ref needs a ref'); process.exit(2); }
const summary = args.includes('--summary');
process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());

/** [path, Buffer][] for every tracked regular file, read from `ref`'s tree or from the working tree. */
function trackedFiles() {
  if (ref) {
    const listing = execFileSync('git', ['ls-tree', '-r', '-z', ref], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0').filter(Boolean)
      .map((row) => { const [meta, path] = row.split('\t'); const [mode, type, sha] = meta.split(' '); return { mode, type, sha, path }; })
      .filter((e) => e.type === 'blob' && e.mode !== '120000');
    const out = spawnSync('git', ['cat-file', '--batch'], { input: listing.map((e) => e.sha).join('\n') + '\n', maxBuffer: 1 << 30 });
    if (out.status !== 0) throw new Error(`git cat-file failed: ${out.stderr}`);
    const buf = out.stdout;
    const files = [];
    let at = 0;
    for (const e of listing) {
      const nl = buf.indexOf(10, at);
      const size = Number(buf.subarray(at, nl).toString().split(' ')[2]);
      files.push([e.path, buf.subarray(nl + 1, nl + 1 + size)]);
      at = nl + 1 + size + 1;
    }
    return files;
  }
  const modes = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  const files = [];
  for (const row of modes) {
    const [meta, path] = row.split('\t');
    const mode = meta.split(' ')[0];
    if (mode === '120000' || mode === '160000') continue;
    let data;
    try { data = readFileSync(path); } catch { continue; } // deleted in the working tree
    files.push([path, data]);
  }
  return files;
}

/** True when an ALLOW entry covers the match; counts its uses so an entry that matches nothing is reported as stale. */
const used = new Set();
function allowed(rule, text, line, path) {
  const entry = ALLOW.find((a) =>
    a.rule === rule && a.match.test(text) && (!a.line || a.line.test(line)) && (!a.path || a.path.test(path)));
  if (entry) used.add(entry);
  return entry !== undefined;
}

/**
 * Timestamp-bearing metadata: PNG tIME, text and Exif chunks and C2PA `caBX`; JPEG APP1 (Exif/XMP), APP11 (C2PA
 * JUMBF), APP13 and comments; WebP EXIF and XMP. ICC profiles stay: their header date is the profile vendor's.
 */
function mediaFindings(path, data) {
  const found = [];
  if (/\.png$/i.test(path)) {
    for (let at = 8; at + 8 <= data.length;) {
      const len = data.readUInt32BE(at);
      const type = data.toString('latin1', at + 4, at + 8);
      if (['tIME', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'caBX'].includes(type)) found.push(`PNG ${type} chunk`);
      if (type === 'IEND') break;
      at += 12 + len;
    }
  } else if (/\.jpe?g$/i.test(path)) {
    for (let at = 2; at + 4 <= data.length && data[at] === 0xff;) {
      const marker = data[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = data.readUInt16BE(at + 2);
      const name = { 0xe1: 'APP1 (Exif/XMP)', 0xeb: 'APP11 (C2PA)', 0xed: 'APP13', 0xfe: 'COM' }[marker];
      if (name) found.push(`JPEG ${name} segment`);
      at += 2 + len;
    }
  } else if (/\.webp$/i.test(path)) {
    for (let at = 12; at + 8 <= data.length;) {
      const type = data.toString('latin1', at, at + 4);
      const len = data.readUInt32LE(at + 4);
      if (type === 'EXIF' || type === 'XMP ') found.push(`WebP ${type.trim()} chunk`);
      at += 8 + len + (len & 1);
    }
  }
  return found;
}

const findings = [];
for (const [path, data] of trackedFiles()) {
  for (const m of path.matchAll(DATED_PATH)) findings.push({ path, line: 0, rule: 'dated-path', text: m[0] });
  if (MEDIA.test(path)) {
    for (const what of mediaFindings(path, data)) findings.push({ path, line: 0, rule: 'media-metadata', text: what });
    continue;
  }
  if (SKIP_TEXT.some((re) => re.test(path)) || data.subarray(0, 8000).includes(0)) continue;
  const lines = data.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [rule, patterns] of Object.entries(RULES)) {
      const spans = []; // one finding per stretch of text, however many of the rule's patterns match it
      for (const re of patterns) {
        for (const m of line.matchAll(re)) {
          const from = m.index, to = m.index + m[0].length;
          if (spans.some(([a, b]) => from < b && a < to) || allowed(rule, m[0], line, path)) continue;
          spans.push([from, to]);
          findings.push({ path, line: i + 1, rule, text: m[0] });
        }
      }
    }
  });
}
for (const a of ALLOW) if (!used.has(a)) findings.push({ path: 'scripts/check-public.mjs', line: 0, rule: 'stale-allow', text: a.why });
const counts = {};
for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
if (!summary) for (const f of findings) console.log(`${f.path}:${f.line}: [${f.rule}] ${f.text}`);
console.log(findings.length
  ? `check-public: ${findings.length} finding(s) ${JSON.stringify(counts)}`
  : 'check-public: clean');
process.exit(findings.length ? 1 : 0);
