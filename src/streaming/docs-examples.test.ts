import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, nearestRank, rankError } from '../core';
import * as api from './index';
import { createGk, createKll, createTDigest, type GkSketch } from './index';
import { scaleLimit } from './scale';

const docsDir = join(__dirname, '..', '..', 'docs', 'streaming');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string): string[] {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${firstCell} |`));
  if (line === undefined) throw new Error(`row not found: ${firstCell}`);
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** 見出しから次の同じ階層以上の見出しの手前までを取り出す(表の先頭セルが重なるのを避ける) */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const rest = doc.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next < 0 ? rest : rest.slice(0, next);
}

function gkOf(epsilon: number): GkSketch {
  const r = createGk({ epsilon });
  if (!r.ok) throw new Error('gk');
  return r.value;
}

const tuplesText = (g: GkSketch): string =>
  g
    .inspect()
    .tuples.map((t) => `(${t.value},${t.g},${t.delta})`)
    .join(' ');

function estimate(g: GkSketch, q: number): number {
  const r = g.query(q);
  if (!r.ok) throw new Error('query');
  return r.value;
}

describe('gk.md の例 ε = 0.2、値 5、3、8、1、9、2、7、4、10、6', () => {
  const doc = readDoc('gk.md');
  const trace = section(doc, '## 例 ε = 0.2、値 5、3、8、1、9、2、7、4、10、6');
  const values = [5, 3, 8, 1, 9, 2, 7, 4, 10, 6];
  const thresholds: Record<number, number> = { 2: 0, 4: 1, 6: 2, 8: 3, 10: 4 };

  it('1件ずつ投入した inspect() の結果が、文書の表の各行と一致する', () => {
    const g = gkOf(0.2);
    values.forEach((v, i) => {
      const n = i + 1;
      g.insert(v);
      expect(g.inspect().count).toBe(n);
      const t = thresholds[n];
      expect(rowOf(trace, String(n))).toEqual([String(n), String(v), t === undefined ? '—' : String(t), tuplesText(g)]);
    });
  });

  it('圧縮の周期は2件ごと、閾値は ⌊2εn⌋ で 0、1、2、3、4 になる', () => {
    expect(Math.max(1, Math.floor(1 / (2 * 0.2)))).toBe(2);
    expect([2, 4, 6, 8, 10].map((n) => Math.floor(2 * 0.2 * n))).toEqual([0, 1, 2, 3, 4]);
    expect(doc).toContain('max(1, ⌊1/0.4⌋) = 2');
    expect(doc).toContain('n = 2、4、6、8、10 のとき、それぞれ 0、1、2、3、4 になる');
  });

  it('不変条件: Σ g = n、g + Δ ≤ max(1, ⌊2εn⌋)、先頭と末尾は Δ = 0(各投入の後)', () => {
    const g = gkOf(0.2);
    values.forEach((v, i) => {
      g.insert(v);
      const s = g.inspect();
      const n = i + 1;
      expect(s.tuples.reduce((a, t) => a + t.g, 0)).toBe(n);
      for (const t of s.tuples) expect(t.g + t.delta).toBeLessThanOrEqual(Math.max(1, Math.floor(2 * 0.2 * n)));
      expect(s.tuples[0]!.delta).toBe(0);
      expect(s.tuples[s.tuples.length - 1]!.delta).toBe(0);
    });
  });

  it('n = 7 の挿入: 後続 (9,2,0) から Δ = 2 + 0 − 1 = 1 の (7,1,1) が入り、順位の範囲は [5, 6]', () => {
    const g = gkOf(0.2);
    for (const v of values.slice(0, 6)) g.insert(v);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (5,2,0) (9,2,0)');
    g.insert(7);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (5,2,0) (7,1,1) (9,2,0)');
    const tuples = g.inspect().tuples;
    const rminPrev = tuples[0]!.g + tuples[1]!.g + tuples[2]!.g;
    expect(rminPrev).toBe(4);
    expect([rminPrev + 1, rminPrev + 1 + tuples[3]!.delta]).toEqual([5, 6]);
    expect(doc).toContain('Δ = 2 + 0 − 1 = 1');
    expect(doc).toContain('直前のタプル(5,2,0)の最小順位は 1 + 1 + 2 = 4');
    expect(doc).toContain('最小順位は 4 + 1 = 5、最大順位は 5 + 1 = 6');
    expect(doc).toContain('範囲[5, 6]');
  });

  it('n = 6 の圧縮の手計算が表の結果と整合する(判定の式の数値)', () => {
    // 圧縮前は 1、2、3、5、8、9 がすべて (g, Δ) = (1, 0)。閾値 T = 2
    const T = Math.floor(2 * 0.2 * 6);
    expect(T).toBe(2);
    expect(1 + 1 + 0).toBeLessThanOrEqual(T); // 8 を 9 に併合 → (9,2,0)
    expect(1 + 2 + 0).toBeGreaterThan(T); // 5 は併合しない
    expect(1 + 1 + 0).toBeLessThanOrEqual(T); // 3 を 5 に併合 → (5,2,0)
    expect(1 + 2 + 0).toBeGreaterThan(T); // 2 は併合しない
    for (const s of [
      'g(8) + g(9) + Δ(9) = 1 + 1 + 0 = 2 ≤ 2',
      'g(5) + g(9) + Δ(9) = 1 + 2 + 0 = 3 > 2',
      'g(3) + g(5) + Δ(5) = 1 + 1 + 0 = 2 ≤ 2',
      'g(2) + g(5) + Δ(5) = 1 + 2 + 0 = 3 > 2',
      '(1,1,0) (2,1,0) (5,2,0) (9,2,0)',
    ]) {
      expect(doc).toContain(s);
    }
    const g = gkOf(0.2);
    for (const v of values.slice(0, 6)) g.insert(v);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (5,2,0) (9,2,0)');
  });

  it('最終状態 (1,1,0) (5,4,0) (6,1,2) (10,4,0): (6,1,2) の順位の範囲は [6, 8]、最大順位は 1、5、8、10', () => {
    const g = gkOf(0.2);
    for (const v of values) g.insert(v);
    const tuples = g.inspect().tuples;
    expect(tuplesText(g)).toBe('(1,1,0) (5,4,0) (6,1,2) (10,4,0)');
    let rmin = 0;
    const ranges = tuples.map((t) => {
      rmin += t.g;
      return [rmin, rmin + t.delta];
    });
    expect(ranges).toEqual([
      [1, 1],
      [5, 5],
      [6, 8],
      [10, 10],
    ]);
    expect(doc).toContain('最小順位は 1 + 4 + 1 = 6、最大順位は 6 + 2 = 8');
    expect(doc).toContain('最大順位は、先頭から 1、5、8、10 である');
    expect(doc).toContain('g + Δ = 3 ≤ ⌊2 × 0.2 × 10⌋ = 4');
    expect(tuples.length).toBe(4);
    expect(doc).toContain('10件が4個のタプルに縮む');
  });

  it('問い合わせの表: 目標順位、r + e、返される値、順位誤差が実装の出力と一致する', () => {
    const g = gkOf(0.2);
    for (const v of values) g.insert(v);
    const sorted = Float64Array.from(values).sort();
    const queryTable = section(doc, '### 問い合わせの結果');
    let worst = 0;
    for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const r = nearestRank(10, q);
      const e = 0.2 * 10;
      const est = estimate(g, q);
      const re = rankError(sorted, est, q);
      if (!re.ok) throw new Error('rankError');
      worst = Math.max(worst, re.value);
      expect(rowOf(queryTable, String(q))).toEqual([
        String(q),
        String(r),
        String(r + e),
        String(est),
        String(re.value),
      ]);
      expect(re.value).toBeLessThanOrEqual(0.2);
      // 値は 1..10 の異なる整数なので、値がそのまま真の順位
      expect(Math.abs(est - r) / 10).toBe(re.value);
    }
    expect(worst).toBe(0.2);
    expect(doc).toContain('q = 0.25 と q = 0.75 では、ちょうどεに達している');
    expect(estimate(g, 0.25)).toBe(5);
    expect(estimate(g, 0.75)).toBe(10);
    expect(doc).toContain('1つ前の(5,4,0)の値5を返す');
    expect(doc).toContain('(10 − 8) ÷ 10 = 0.2');
  });

  it('整列した値 1〜10 の最近順位法の厳密値と、返される値の関係(q = 0.5 は厳密値と一致)', () => {
    const g = gkOf(0.2);
    for (const v of values) g.insert(v);
    const sorted = Float64Array.from(values).sort();
    expect(estimate(g, 0.5)).toBe(exactQuantileSorted(sorted, 0.5, 'nearest-rank'));
    expect(estimate(g, 0.25)).not.toBe(exactQuantileSorted(sorted, 0.25, 'nearest-rank'));
  });
});

describe('gk.md の例 ε = 0.05、値 3、1、2(圧縮が働かない)', () => {
  const doc = readDoc('gk.md');

  it('周期 10、閾値 0 で、(1,1,0) (2,1,0) (3,1,0) のまま厳密値を返す', () => {
    const g = gkOf(0.05);
    for (const v of [3, 1, 2]) g.insert(v);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (3,1,0)');
    expect(Math.max(1, Math.floor(1 / (2 * 0.05)))).toBe(10);
    expect(Math.floor(2 * 0.05 * 3)).toBe(0);
    expect(doc).toContain('max(1, ⌊1/0.1⌋) = 10 件');
    expect(doc).toContain('⌊2 × 0.05 × 3⌋ = 0');
    expect(doc).toContain('(1,1,0) (2,1,0) (3,1,0)になる');
    const sorted = Float64Array.from([1, 2, 3]);
    for (const q of [0, 0.2, 0.34, 0.5, 0.67, 1]) {
      expect(estimate(g, q)).toBe(exactQuantileSorted(sorted, q, 'nearest-rank'));
    }
  });
});

describe('overview.md の記述', () => {
  const doc = readDoc('overview.md');

  it('マージの機能は提供しない: 公開 API にもスケッチにもマージがない', () => {
    expect(Object.keys(api).filter((k) => /merge/i.test(k))).toEqual([]);
    const kll = createKll({ k: 8 });
    const td = createTDigest({ compression: 20, scale: 'k1' });
    if (!kll.ok || !td.ok) throw new Error('create');
    for (const sk of [gkOf(0.1), kll.value, td.value]) {
      expect(Object.keys(sk).filter((k) => /merge/i.test(k))).toEqual([]);
      expect('merge' in sk).toBe(false);
    }
    expect(doc).toContain('このリポジトリの実装は、マージの機能を提供しない。');
  });

  it('KLL の下限容量 2 と、容量の合計 ≤ 3k + 2 × 段数、投入ごとの compaction は最大1回', () => {
    const r = createKll({ k: 8 });
    if (!r.ok) throw new Error('kll');
    let previous = 0;
    for (let i = 1; i <= 2000; i++) {
      r.value.insert(i);
      const s = r.value.inspect();
      expect(s.compactions - previous).toBeLessThanOrEqual(1);
      previous = s.compactions;
      const retained = s.levels.reduce((a, l) => a + l.values.length, 0);
      const capacity = s.levels.reduce((a, l) => a + l.capacity, 0);
      expect(retained).toBeLessThanOrEqual(capacity);
      expect(capacity).toBeLessThanOrEqual(3 * 8 + 2 * s.levels.length);
    }
    const levels = r.value.inspect().levels;
    expect(Math.min(...levels.map((l) => l.capacity))).toBe(2);
    expect(doc).toContain('下限を2にしている');
    expect(doc).toContain('3k + 2 × 段数 以下');
  });

  it('t-digest の k2 の正規化 Z(n) は n < δ では n = δ と同じ(下限は max(n/δ, 1))', () => {
    for (const q of [0.01, 0.3, 0.5, 0.9]) {
      expect(scaleLimit('k2', q, 100, 10)).toBe(scaleLimit('k2', q, 100, 1));
      expect(scaleLimit('k2', q, 100, 10)).toBe(scaleLimit('k2', q, 100, 100));
    }
    // n > δ では Z(n) が大きくなり、上限が変わる
    expect(scaleLimit('k2', 0.3, 100, 100000)).not.toBe(scaleLimit('k2', 0.3, 100, 100));
    expect(doc).toContain('Z(n) = 4 ln(max(n/δ, 1)) + 24');
  });

  it('保証の種類の比較表が3手法の行を持つ', () => {
    expect(rowOf(doc, 'GK')[2]).toBe('決定的(いつでも成り立つ)');
    expect(rowOf(doc, 'KLL')[2]).toBe('確率的(乱数のシードによって誤差が変わる)');
    expect(rowOf(doc, 't-digest')[2]).toBe('保証なし(傾向だけ)');
  });
});
