import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = join(root, 'src');

/** Small source guard, not a type checker: inspect builder attributes separately from ordinary title data. */
function nativeTitles(source: string): { offset: number; text: string }[] {
  const tokens = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\?\.|===|!==|==|!=|=>|[^\s]/g)]
    .filter((match) => !match[0].startsWith('//') && !match[0].startsWith('/*'))
    .map((match) => ({ text: match[0], offset: match.index }));
  const violations: { offset: number; text: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // h('tag', { ... }): only direct attribute keys, never nested data or text containing "title:".
    if (token.text === 'h' && tokens[i + 1]?.text === '(' && /^['"]/.test(tokens[i + 2]?.text ?? '') && tokens[i + 3]?.text === ',' && tokens[i + 4]?.text === '{') {
      let depth = 1;
      for (let j = i + 5; j < tokens.length && depth; j++) {
        const current = tokens[j]!;
        if (depth === 1 && /^(?:title|'title'|"title")$/.test(current.text) && ['{', ','].includes(tokens[j - 1]!.text) && [':', ',', '}'].includes(tokens[j + 1]?.text ?? '')) violations.push(current);
        if (['{', '[', '('].includes(current.text)) depth++;
        if (['}', ']', ')'].includes(current.text)) depth--;
      }
    }
    if (token.text === 'setAttribute' && tokens[i + 1]?.text === '(' && /^(?:'title'|"title")$/.test(tokens[i + 2]?.text ?? '')) violations.push(token);
    const dotted = token.text === 'title' && ['.', '?.'].includes(tokens[i - 1]?.text ?? '') && tokens[i + 1]?.text === '=';
    const indexed = /^(?:'title'|"title")$/.test(token.text) && tokens[i - 1]?.text === '[' && tokens[i + 1]?.text === ']' && tokens[i + 2]?.text === '=';
    if (dotted || indexed) {
      let start = i - 2;
      while (start >= 2 && tokens[start - 1]?.text === '.' && /^[\w$]+$/.test(tokens[start - 2]?.text ?? '')) start -= 2;
      const receiver = tokens.slice(start, i - 1).map((part) => part.text).join('');
      // document.title names the page; queue-panel's row.title caches tooltip data, not an element property.
      if (!['document', 'window.document', 'row'].includes(receiver)) violations.push(token);
    }
    if (/^['"`]/.test(token.text) && /<[A-Za-z][^>]*\s+title\s*=/i.test(token.text)) violations.push(token);
  }
  return violations;
}

describe('native tooltip prohibition', () => {
  it('allows page titles, ordinary title data and the queue row cache', () => {
    expect(nativeTitles(`
      document.title = 'Page';
      window.document['title'] = 'Page';
      const data = { title: 'Payload', nested: { 'title': 'Detail' } };
      const row = { title: '' };
      row.title = 'Updated cache';
      new CommanderLog({ title: 'Chat heading' });
      tip(el, { title: 'Rich tooltip' });
      h('button', { 'data-tip': 'Custom', onclick: () => tip(el, { title: 'Rich' }) });
      const text = "el.title = 'example'; title: example";
      // el.title = 'comment';
      /* h('button', { title: 'comment' }); */
    `)).toEqual([]);
  });

  it('rejects native properties, bracket access, builder keys and setAttribute', () => {
    expect(nativeTitles(`
      el.title = 'Native';
      el['title'] = 'Native';
      row.el.title = 'Native';
      this.button.title = 'Native';
      el.setAttribute('title', 'Native');
      el?.setAttribute("title", 'Native');
      h('button', { title: 'Native' });
      h('span', { 'title': 'Native' });
      h('button', { onclick: () => { doSomething(); }, title: 'Native' });
      h('span', { title });
      h('span', { 'data-tip': 'fine' }, h('b', { title: 'Nested native' }));
      const html = '<button title="Native">Action</button>';
    `)).toHaveLength(12);
  });

  it('uses only custom tooltip content throughout src', () => {
    const violations: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!/\.(?:[cm]?[jt]sx?|html)$/.test(entry.name)) continue;
        const source = readFileSync(path, 'utf8');
        if (entry.name.endsWith('.html')) {
          if (/<[A-Za-z][^>]*\s+title\s*=/i.test(source)) violations.push(`${relative(root, path)}: native title attribute`);
        } else {
          for (const match of nativeTitles(source)) {
            const line = source.slice(0, match.offset).split('\n').length;
            violations.push(`${relative(root, path)}:${line}: native ${match.text}`);
          }
        }
      }
    };
    scan(src);
    expect(violations).toEqual([]);
  });
});
