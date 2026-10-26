// 共有層・解説・UI・起動ファイルが、上流 4 系統を「型だけ」で参照することを確かめる(11.5)。
// 上流の実行時の値を 1 つでも import すると、アルゴリズムのコードがメインの bundle に入りうる。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(SITE_DIR, '..');
const UPSTREAM_DIRS = ['core', 'histogram', 'streaming', 'relative-error'].map((d) => join(SRC_DIR, d));

/** メインの bundle に入りうるソースの置き場所(起動ファイルは個別に足す) */
const MAIN_DIRS = ['shared', 'content', 'ui'].map((d) => join(SITE_DIR, d));
const MAIN_ENTRY = join(SITE_DIR, 'main.ts');

export interface ImportViolation {
  readonly specifier: string;
  readonly statement: string;
}

function isUpstreamSpecifier(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = resolve(dirname(fromFile), specifier);
  return UPSTREAM_DIRS.some((dir) => target === dir || target.startsWith(dir + sep));
}

/** コメントと文字列の中身を取り除かずに、import / export … from / 動的 import の文を取り出す */
export function findUpstreamValueImports(fromFile: string, source: string): ImportViolation[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const violations: ImportViolation[] = [];
  const staticPattern = /\b(import|export)\s+(type\s+)?([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of withoutComments.matchAll(staticPattern)) {
    const specifier = m[4] ?? m[5];
    if (specifier === undefined || !isUpstreamSpecifier(fromFile, specifier)) continue;
    const typeOnly = m[2] !== undefined;
    if (!typeOnly) violations.push({ specifier, statement: m[0].replace(/\s+/g, ' ') });
  }
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of withoutComments.matchAll(dynamicPattern)) {
    const specifier = m[1];
    if (specifier !== undefined && isUpstreamSpecifier(fromFile, specifier)) {
      violations.push({ specifier, statement: m[0].replace(/\s+/g, ' ') });
    }
  }
  return violations;
}

function listSources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

describe('import の規則: メインの bundle に入るソースは上流を型だけで参照する(11.5)', () => {
  const files = [...MAIN_DIRS.flatMap(listSources), MAIN_ENTRY];

  it('検査の対象に起動ファイルと共有層のソースが含まれる(空の対象で素通りしない)', () => {
    const names = files.map((f) => relative(SITE_DIR, f).split(sep).join('/'));
    expect(names).toContain('main.ts');
    expect(names.some((n) => n.startsWith('shared/'))).toBe(true);
    for (const f of files) expect(statSync(f).isFile()).toBe(true);
  });

  it('上流への import は import type / export type … from だけである', () => {
    const found = files.flatMap((f) =>
      findUpstreamValueImports(f, readFileSync(f, 'utf8')).map(
        (v) => `${relative(SITE_DIR, f)}: ${v.statement}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe('findUpstreamValueImports(検査器の自己確認)', () => {
  const from = join(SITE_DIR, 'shared', 'x.ts');
  it('値の import、export … from、副作用 import、動的 import、型修飾子つきの名前を検出する', () => {
    expect(findUpstreamValueImports(from, `import { generate } from '../../core';`)).toHaveLength(1);
    expect(findUpstreamValueImports(from, `import { type Distribution } from '../../core';`)).toHaveLength(1);
    expect(findUpstreamValueImports(from, `export { MAX_BUCKETS } from '../../histogram';`)).toHaveLength(1);
    expect(findUpstreamValueImports(from, `import '../../streaming';`)).toHaveLength(1);
    expect(findUpstreamValueImports(from, `const m = await import('../../relative-error/index');`)).toHaveLength(1);
    expect(findUpstreamValueImports(from, `import {\n  a,\n  b,\n} from '../../core/index';`)).toHaveLength(1);
  });
  it('型だけの import と、上流以外の import、コメント内の記述は許す', () => {
    expect(findUpstreamValueImports(from, `import type { Distribution } from '../../core';`)).toEqual([]);
    expect(findUpstreamValueImports(from, `export type { Distribution } from '../../core';`)).toEqual([]);
    expect(findUpstreamValueImports(from, `import { x } from './local';`)).toEqual([]);
    expect(findUpstreamValueImports(from, `import { Chart } from 'chart.js';`)).toEqual([]);
    expect(findUpstreamValueImports(from, `// import { generate } from '../../core';`)).toEqual([]);
  });
});
