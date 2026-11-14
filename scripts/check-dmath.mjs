#!/usr/bin/env node
/**
 * Lint: transcendental Math in packages/game/src is the deterministic fdlibm port (`dmath` from src/util/fdlibm.js),
 * never the engine's. `Math.sin` … `Math.hypot` and the `**` operator (the engine's pow) differ between engines and
 * versions, so a bot would decide differently in-process, in the trusted runner and in QuickJS, and a replay could
 * drift across Node upgrades.
 *
 * Every module is held at zero; `Math.sqrt` (correctly rounded by ECMA-262) is fine, so distances use `norm`/`dist`
 * from src/util/math.ts.
 *   node scripts/check-dmath.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../packages/game/src/', import.meta.url);
const EXEMPT = 'util/fdlibm.js';
const NATIVE = /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/g;
const POWER = /\*\*/g;

/** Skips template text from `i` to its end or to a `${` (pushing a substitution depth); returns the next index. */
function skipTemplate(source, i, templates) {
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '`') return i + 1;
    if (source[i] === '$' && source[i + 1] === '{') { templates.push(0); return i + 2; }
    i++;
  }
  return i;
}

/** `source` with comments, string and template text and regular expression literals blanked (code left as is). */
function codeOnly(source) {
  let out = '';
  let last = '';
  const templates = [];
  for (let i = 0; i < source.length;) {
    const ch = source[i], next = source[i + 1];
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; out += ' '; continue; }
    if (ch === '}' && templates.length && templates.at(-1) === 0) { templates.pop(); i = skipTemplate(source, i + 1, templates); out += '0'; last = '0'; continue; }
    if (ch === '{' && templates.length) templates[templates.length - 1]++;
    if (ch === '}' && templates.length) templates[templates.length - 1]--;
    if (ch === '`') { i = skipTemplate(source, i + 1, templates); out += '0'; last = '0'; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      i = j + 1; out += '0'; last = '0'; continue;
    }
    // A slash after an operator or an opening bracket starts a regular expression literal.
    if (ch === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
      let j = i + 1, inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
      while (i < source.length && /[a-z]/.test(source[i])) i++;
      out += '0'; last = '0'; continue;
    }
    out += ch;
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  return out;
}

const found = {};
for (const e of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
  if (!e.isFile() || !/\.(ts|js)$/.test(e.name)) continue;
  const path = relative(fileURLToPath(SRC), join(e.parentPath, e.name)).split('\\').join('/');
  if (path === EXEMPT) continue;
  const code = codeOnly(readFileSync(new URL(path, SRC), 'utf8'));
  const uses = (code.match(NATIVE)?.length ?? 0) + (code.match(POWER)?.length ?? 0);
  if (uses > 0) found[path] = uses;
}
const problems = Object.entries(found).map(([path, uses]) => `${path}: ${uses} native Math/** uses. Use dmath from packages/game/src/util/fdlibm.js (dmath.sin, dmath.atan2, …), norm/dist/sq from packages/game/src/util/math.ts for lengths and squares.`);
if (problems.length) {
  console.error(`Native transcendental Math in packages/game/src (scripts/check-dmath.mjs):\n${problems.join('\n')}`);
  process.exitCode = 1;
} else console.log('dmath check: packages/game/src is clean');
