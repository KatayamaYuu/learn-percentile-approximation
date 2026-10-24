import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_NUMBER,
  absoluteError,
  createQuickselectExact,
  createSortExact,
  estimateBytes,
  exactQuantileSorted,
  generate,
  nearestRank,
  rankError,
  relativeError,
  resolvePosition,
  type PercentileDefinition,
} from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'core');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

const sorted = (xs: number[]): Float64Array => Float64Array.from(xs);
const value = (r: { ok: boolean; value?: number }): number => {
  if (!r.ok) throw new Error('unexpected error result');
  return r.value as number;
};

describe('docs/core/percentile-definitions.md の例', () => {
  const doc = readDoc('percentile-definitions.md');
  const data = sorted([10, 20, 30, 40]);
  const expected: Record<PercentileDefinition, number> = {
    'nearest-rank': 20,
    linear: 22,
    lower: 20,
    higher: 30,
    midpoint: 25,
  };

  it.each(Object.entries(expected))('[10,20,30,40], q=0.4, %s は %d', (definition, want) => {
    expect(exactQuantileSorted(data, 0.4, definition as PercentileDefinition)).toBe(want);
    // 文書の表に定義名と値が同じ行で載っている
    const row = doc.split('\n').find((l) => l.includes(`| ${definition} |`));
    expect(row).toBeDefined();
    expect(row).toContain(`| ${want} |`);
  });

  it('位置の解決例: n=4, q=0.4 は h=1.2 で lo=1, hi=2, frac が約 0.2', () => {
    const p = resolvePosition(4, 0.4, 'linear');
    expect(p.lo).toBe(1);
    expect(p.hi).toBe(2);
    expect(p.frac).toBeCloseTo(0.2, 12);
    expect(doc).toContain('h = 1.2');
    expect(nearestRank(4, 0.4)).toBe(2);
    expect(doc).toContain('ceil(1.6) = 2');
  });

  it('丸め処理の例: 100 × 0.07 は 7 に丸まり、最近順位は 7 番目', () => {
    expect(100 * 0.07).toBe(7.000000000000001);
    expect(Math.ceil(100 * 0.07)).toBe(8);
    expect(nearestRank(100, 0.07)).toBe(7);
    expect(doc).toContain('7.000000000000001');
    expect(doc).toContain('7番目');
    const p = resolvePosition(101, 0.07, 'linear');
    expect(p).toEqual({ lo: 7, hi: 7, frac: 0 });
  });

  it('NumPy の nearest との違い: [10,20,30,40], q=0.5 で nearest-rank は 20、h は 1.5', () => {
    expect(doc).toContain('numpy.percentile');
    expect(doc).toContain('nearest');
    expect(resolvePosition(4, 0.5, 'linear').frac).toBe(0.5);
    expect(exactQuantileSorted(data, 0.5, 'nearest-rank')).toBe(20);
    expect(doc).toContain('h = 1.5');
    expect(doc).toContain('x[2] = 30');
  });
});

describe('docs/core/error-metrics.md の例', () => {
  const doc = readDoc('error-metrics.md');

  it('絶対誤差と相対誤差: 推定値 22、厳密値 20 で 2 と 0.1', () => {
    expect(value(absoluteError(22, 20))).toBe(2);
    expect(value(relativeError(22, 20))).toBeCloseTo(0.1, 12);
    expect(doc).toContain('推定値22、厳密値20');
    expect(doc).toContain('絶対誤差は2');
    expect(doc).toContain('相対誤差は0.1');
  });

  it('データにない推定値: [10,20,30,40], q=0.5, 推定値 25 は順位誤差 0、35 は 0.25', () => {
    const d = sorted([10, 20, 30, 40]);
    expect(nearestRank(4, 0.5)).toBe(2);
    expect(value(rankError(d, 25, 0.5))).toBe(0);
    expect(value(rankError(d, 35, 0.5))).toBe(0.25);
    expect(doc).toContain('推定値25の順位は2');
    expect(doc).toContain('推定値35の順位は3');
    expect(doc).toContain('0.25');
  });

  it('同値がある場合: [10,20,20,20,30] の推定値 20 は q=0.5 で 0、q=0.9 で 0.2', () => {
    const d = sorted([10, 20, 20, 20, 30]);
    expect(nearestRank(5, 0.5)).toBe(3);
    expect(nearestRank(5, 0.9)).toBe(5);
    expect(value(rankError(d, 20, 0.5))).toBe(0);
    expect(value(rankError(d, 20, 0.9))).toBeCloseTo(0.2, 12);
    expect(doc).toContain('[10, 20, 20, 20, 30]');
    expect(doc).toContain('2番目から4番目');
    expect(doc).toContain('目標順位は3');
    expect(doc).toContain('目標順位は5');
    expect(doc).toContain('順位誤差は0.2');
  });
});

describe('docs/core/cost-model.md の例', () => {
  const doc = readDoc('cost-model.md');

  const insertAll = (s: ReturnType<typeof createSortExact>, xs: number[]): void => {
    for (const x of xs) s.insert(x);
  };

  it('逆順の8個の併合整列: 投入で移動8、問い合わせで比較12・移動24、累計は比較12・移動32', () => {
    const s = createSortExact();
    insertAll(s, [8, 7, 6, 5, 4, 3, 2, 1]);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 8 });
    expect(s.query(0.5).ok).toBe(true);
    expect(s.operationCounts()).toEqual({ comparisons: 12, moves: 32 });
    // 整列済みなら再度の問い合わせで操作数は増えない
    s.query(0.5);
    expect(s.operationCounts()).toEqual({ comparisons: 12, moves: 32 });
    expect(doc).toContain('[8, 7, 6, 5, 4, 3, 2, 1]');
    expect(doc).toContain('比較は合計12回');
    expect(doc).toContain('移動は3段で8回ずつなので24回');
    expect(doc).toContain('累計は比較12回、移動32回');
  });

  it('17個の投入: 容量拡張のコピー16回と投入17回で移動33、見積もりは136バイト', () => {
    const s = createSortExact();
    insertAll(s, Array.from({ length: 17 }, (_, i) => i + 1));
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 33 });
    expect(s.memoryBytes()).toBe(136);
    expect(doc).toContain('移動が17回増える');
    expect(doc).toContain('合計33回');
    expect(doc).toContain('17個なら136バイト');
    expect(doc).toContain('容量32のうち、使っていない15個分');
  });

  it('メモリ見積もり: 1個8バイト、10個で80バイト、数値10個とカウンタ3個で104バイト', () => {
    expect(BYTES_PER_NUMBER).toBe(8);
    const s = createSortExact();
    insertAll(s, Array.from({ length: 10 }, (_, i) => i + 1));
    expect(s.memoryBytes()).toBe(80);
    expect(estimateBytes({ numbers: 10, counters: 3 })).toBe(104);
    expect(doc).toContain('値は8である');
    expect(doc).toContain('10個なら80バイト');
    expect(doc).toContain('(10 + 3) × 8 = 104バイト');
  });

  it('quickselect の同値4個: linear は比較9・移動8、lower は比較8・移動8(シードによらない)', () => {
    for (const seed of [0, 1, 7, 12345]) {
      const lin = createQuickselectExact(seed);
      insertAll(lin, [5, 5, 5, 5]);
      expect(lin.operationCounts()).toEqual({ comparisons: 0, moves: 4 });
      expect(lin.query(0.5)).toEqual({ ok: true, value: 5 });
      expect(lin.operationCounts()).toEqual({ comparisons: 9, moves: 8 });

      const low = createQuickselectExact(seed, { definition: 'lower' });
      insertAll(low, [5, 5, 5, 5]);
      expect(low.query(0.5)).toEqual({ ok: true, value: 5 });
      expect(low.operationCounts()).toEqual({ comparisons: 8, moves: 8 });
    }
    expect(doc).toContain('[5, 5, 5, 5]');
    expect(doc).toContain('合計8回');
    expect(doc).toContain('累計は比較9回、移動8回');
    expect(doc).toContain('累計は比較8回、移動8回');
  });

  it('quickselect は問い合わせごとにコピー n 回の移動を数える', () => {
    const s = createQuickselectExact(3);
    insertAll(s, [5, 5, 5, 5]);
    s.query(0.5);
    s.query(0.5);
    expect(s.operationCounts()).toEqual({ comparisons: 18, moves: 12 });
  });
});

describe('docs/core/distributions.md の例', () => {
  const doc = readDoc('distributions.md');

  it('0 以下を棄却した正規分布: mean=1, stdDev=1 の標本平均は約 1.29 で、すべて正', () => {
    const r = generate({ distribution: { kind: 'normal', mean: 1, stdDev: 1 }, count: 200_000, seed: 1 });
    if (!r.ok) throw new Error('generate failed');
    let sum = 0;
    for (const x of r.value) {
      expect(x).toBeGreaterThan(0);
      sum += x;
    }
    // 打ち切り正規分布の平均は 1 + φ(1)/Φ(1) = 1.2876
    expect(Math.abs(sum / r.value.length - 1.2876)).toBeLessThan(0.02);
    expect(doc).toContain('mean = 1、stdDev = 1のとき、標本の平均は約1.29');
  });

  it('採用確率の目安: Φ(1) は約 0.84、Φ(0.5) は約 0.69', () => {
    // 標準正規分布の分布関数を台形則で求める
    const phi = (z: number): number => {
      let acc = 0;
      const lo = -10;
      const steps = 20_000;
      const h = (z - lo) / steps;
      for (let i = 0; i <= steps; i++) {
        const x = lo + i * h;
        const w = i === 0 || i === steps ? 0.5 : 1;
        acc += w * Math.exp(-0.5 * x * x);
      }
      return (acc * h) / Math.sqrt(2 * Math.PI);
    };
    expect(phi(1)).toBeCloseTo(0.84, 2);
    expect(phi(0.5)).toBeCloseTo(0.69, 2);
    expect(doc).toContain('1のとき約0.84、0.5のとき約0.69');
  });

  it('パラメータの境界: lognormal の mu=-1000 は non-finite-sample、heavy-tail の最小値は scale 以上', () => {
    const bad = generate({ distribution: { kind: 'lognormal', mu: -1000, sigma: 1 }, count: 5, seed: 1 });
    expect(bad).toEqual({ ok: false, error: { kind: 'non-finite-sample' } });
    expect(doc).toContain('muが-1000のとき');
    const h = generate({ distribution: { kind: 'heavy-tail', scale: 3, shape: 1.5 }, count: 5000, seed: 2 });
    if (!h.ok) throw new Error('generate failed');
    expect(Math.min(...h.value)).toBeGreaterThanOrEqual(3);
  });

  it('並べ替えは乱数を消費せず、3つの並び順は同じ値の集まりになる', () => {
    const d = { kind: 'uniform', min: 1, max: 2 } as const;
    const get = (order: 'random' | 'ascending' | 'descending'): number[] => {
      const r = generate({ distribution: d, count: 50, seed: 4, order });
      if (!r.ok) throw new Error('generate failed');
      return Array.from(r.value);
    };
    const asc = get('ascending');
    expect([...get('random')].sort((a, b) => a - b)).toEqual(asc);
    expect(get('descending')).toEqual([...asc].reverse());
  });
});
