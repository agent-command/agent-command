import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

/**
 * The web client imports these entry points, so nothing reachable from them at runtime may load Node built-ins or the
 * `playerthree` root (it pulls the Node host, e.g. node:crypto, into the browser bundle and the page fails to load).
 * Browser-safe playerthree subpaths (`playerthree/schema`, `playerthree/manifest`, …) are fine. Type-only imports are erased
 * and never load; an import whose names are all inline `type` still loads the module under verbatimModuleSyntax.
 */
const CLIENT_ENTRIES = ['./contract', './lobby', './world', './maps', './weather', './economy', './map-document', './map-registry'] as const;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exportsMap: Readonly<Record<string, string>> = pkg.exports;
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Specifiers a module loads at runtime (static imports/re-exports that survive type erasure, and dynamic imports). */
function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gms;
  for (const m of source.matchAll(statement)) if (!m[2]) out.push(m[4]!);
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

/** Every forbidden runtime import reachable from `entry`, as `importer → specifier`. */
function forbiddenImports(entry: string): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        if (spec.endsWith('.ts')) visit(resolve(dirname(file), spec));
      } else if (NODE_BUILTINS.has(spec) || spec === 'playerthree') {
        bad.push(`${relative(root, file)} → ${spec}`);
      }
    }
  };
  visit(resolve(root, exportsMap[entry]!));
  return bad;
}

describe('client-shared entry points', () => {
  it.each(CLIENT_ENTRIES)('%s loads no Node built-in and not the playerthree root', (entry) => {
    expect(exportsMap[entry]).toBeDefined();
    expect(forbiddenImports(entry)).toEqual([]);
  });

  it('the scan sees what it guards against', () => {
    expect(runtimeSpecifiers("import { createHash } from 'node:crypto';\nimport type { X } from 'playerthree';\nexport { a } from 'playerthree';"))
      .toEqual(['node:crypto', 'playerthree']);
  });
});
