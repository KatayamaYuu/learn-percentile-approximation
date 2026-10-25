// 9 項目の解説が 4 項目・注意・文書名を持ち、文書が実在し、上流の記述と矛盾しないことを確かめる(9.1〜9.5)。
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALGORITHM_EXPLAINERS, type AlgorithmExplainer, type ExplainerId } from './algorithms';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const IDS: readonly ExplainerId[] = [
  'exact-sort', 'exact-quickselect', 'histogram-equal', 'histogram-exponential',
  'gk', 'kll', 'tdigest', 'ddsketch', 'hdr',
];

function get(id: ExplainerId): AlgorithmExplainer {
  const e = ALGORITHM_EXPLAINERS.find((x) => x.id === id);
  if (e === undefined) throw new Error(`解説がない: ${id}`);
  return e;
}
const allText = (e: AlgorithmExplainer): string =>
  [e.name, e.definition, e.guarantee, e.complexity, e.suitability, ...e.caveats].join('\n');

describe('アルゴリズムの解説(9.1, 9.4, 9.5)', () => {
  it('9 項目がちょうど 1 つずつある', () => {
    expect(ALGORITHM_EXPLAINERS.map((e) => e.id).sort()).toEqual([...IDS].sort());
  });

  it.each(IDS)('%s に 4 項目と注意と文書名がある', (id) => {
    const e = get(id);
    expect(e.name.length).toBeGreaterThan(0);
    for (const text of [e.definition, e.guarantee, e.complexity, e.suitability]) {
      expect(text.trim().length).toBeGreaterThan(10);
      // 日本語で書かれている
      expect(/[ぁ-んァ-ヶ一-龠]/.test(text)).toBe(true);
    }
    expect(e.caveats.length).toBeGreaterThan(0);
    for (const c of e.caveats) expect(c.trim().length).toBeGreaterThan(10);
    expect(e.docRefs.length).toBeGreaterThan(0);
  });

  it.each(IDS)('%s の文書名のファイルが実在する(9.5)', (id) => {
    for (const ref of get(id).docRefs) {
      expect(ref).toMatch(/^docs\/(core|histogram|streaming|relative-error)\/[a-z-]+\.md$/);
      expect(existsSync(resolve(ROOT, ref)), ref).toBe(true);
    }
  });

  it('表示先のページが決まっている(9.2)', () => {
    const pageOf = Object.fromEntries(ALGORITHM_EXPLAINERS.map((e) => [e.id, e.page]));
    expect(pageOf).toEqual({
      'exact-sort': 'histogram',
      'exact-quickselect': 'histogram',
      'histogram-equal': 'histogram',
      'histogram-exponential': 'histogram',
      gk: 'streaming',
      kll: 'streaming',
      tdigest: 'streaming',
      ddsketch: 'relative',
      hdr: 'relative',
    });
  });
});

describe('上流の記述との整合(9.3, 9.4)', () => {
  it('GK: 順位誤差 ε 以下の決定的な保証。簡略版の圧縮は空間の上限を証明しない', () => {
    const e = get('gk');
    expect(e.guarantee).toContain('ε');
    expect(e.guarantee).toContain('決定的');
    expect(e.caveats.join('')).toMatch(/上限.*証明/);
    expect(e.docRefs).toContain('docs/streaming/gk.md');
  });

  it('KLL: 確率的な保証で、同じシードなら再現する', () => {
    const e = get('kll');
    expect(e.guarantee).toContain('確率的');
    expect(allText(e)).toContain('シード');
    expect(e.docRefs).toContain('docs/streaming/kll.md');
  });

  it('t-digest: 順位誤差の上限を保証せず、まとめは昇順だけ', () => {
    const e = get('tdigest');
    expect(e.guarantee).toMatch(/上限.*(ない|保証しない)/);
    expect(e.caveats.join('')).toContain('昇順');
    expect(e.docRefs).toContain('docs/streaming/t-digest.md');
  });

  it('DDSketch: 相対誤差 α 以下。縮約の影響の上限以下の値には保証がない', () => {
    const e = get('ddsketch');
    expect(e.guarantee).toContain('α');
    expect(e.caveats.join('')).toContain('縮約');
    expect(e.caveats.join('')).toMatch(/保証(は|が)?(ない|成り立たない)/);
    expect(e.docRefs).toContain('docs/relative-error/ddsketch.md');
  });

  it('HDR Histogram: 1/S と L/2。推定値は中点で元の実装は上端', () => {
    const e = get('hdr');
    expect(e.guarantee).toContain('1/S');
    expect(e.guarantee).toContain('L/2');
    expect(e.caveats[0]).toContain('(S/2) × L');
    expect(e.caveats[0]).not.toContain('L の半分');
    expect(e.caveats.join('')).toContain('中点');
    expect(e.caveats.join('')).toContain('上端');
    expect(e.docRefs).toContain('docs/relative-error/hdr-histogram.md');
  });

  it('ヒストグラム: 範囲外の値を扱えない。等幅は裾の広い分布で粗い', () => {
    const eq = get('histogram-equal');
    const ex = get('histogram-exponential');
    expect(allText(eq)).toContain('範囲外');
    expect(allText(eq)).toContain('裾');
    expect(allText(ex)).toContain('範囲外');
    expect(ex.caveats.join('')).toMatch(/相対誤差.*保証しない/);
    expect(eq.docRefs).toContain('docs/histogram/bucket-schemes.md');
  });

  it('厳密解: メモリが件数に比例する', () => {
    for (const id of ['exact-sort', 'exact-quickselect'] as const) {
      const e = get(id);
      expect(e.complexity).toMatch(/件数に比例/);
      expect(e.docRefs).toContain('docs/core/cost-model.md');
    }
  });
});
