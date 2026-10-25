import { describe, expect, it } from 'vitest';
import { createSortExact, generate, type PercentileSketch } from '../core';
import type { BucketScheme } from './boundaries';
import { createHistogram } from './histogram';

function make(scheme: BucketScheme): PercentileSketch {
  const r = createHistogram(scheme);
  if (!r.ok) throw new Error('histogram');
  return r.value;
}

function uniform(count: number, min: number, max: number): Float64Array {
  const r = generate({ distribution: { kind: 'uniform', min, max }, count, seed: 11 });
  if (!r.ok) throw new Error('data');
  return r.value;
}

/** 投入 1 回あたりの比較・移動の最大値を返す */
function insertCosts(sketch: PercentileSketch, data: Float64Array): { comparisons: number; moves: number } {
  let maxComparisons = 0;
  let maxMoves = 0;
  let prev = sketch.operationCounts();
  for (let i = 0; i < data.length; i++) {
    const r = sketch.insert(data[i]!);
    if (!r.ok) throw new Error(`insert failed: ${JSON.stringify(r.error)}`);
    const now = sketch.operationCounts();
    maxComparisons = Math.max(maxComparisons, now.comparisons - prev.comparisons);
    maxMoves = Math.max(maxMoves, now.moves - prev.moves);
    prev = now;
  }
  return { comparisons: maxComparisons, moves: maxMoves };
}

function queryComparisons(sketch: PercentileSketch, quantile: number): number {
  const before = sketch.operationCounts().comparisons;
  const r = sketch.query(quantile);
  if (!r.ok) throw new Error('query');
  return sketch.operationCounts().comparisons - before;
}

describe('投入の操作数', () => {
  it.each([
    [1_000, 10],
    [1_000, 10_000],
    [100_000, 10],
    [100_000, 10_000],
  ])('等幅・指数幅は件数 %d・バケット数 %d でも比較 3 回以下・移動 2 回', (count, buckets) => {
    const data = uniform(count, 1, 1000);
    for (const scheme of [
      { kind: 'equal', lower: 1, upper: 1000, buckets } as BucketScheme,
      { kind: 'exponential', lower: 1, upper: 1000, buckets } as BucketScheme,
    ]) {
      const costs = insertCosts(make(scheme), data);
      expect(costs.comparisons).toBeLessThanOrEqual(3);
      expect(costs.moves).toBe(2);
    }
  });

  it.each([2, 10, 1_000, 10_000])('任意境界はバケット数 %d で比較 ceil(log2 B) 回以下', (buckets) => {
    const boundaries = Array.from({ length: buckets + 1 }, (_, i) => 1 + i * 0.5);
    const data = uniform(5_000, 1, 1 + buckets * 0.5);
    const costs = insertCosts(make({ kind: 'custom', boundaries }), data);
    expect(costs.comparisons).toBeLessThanOrEqual(Math.ceil(Math.log2(buckets)));
    expect(costs.moves).toBe(2);
  });
});

describe('問い合わせの操作数', () => {
  function filled(count: number, buckets: number): PercentileSketch {
    const s = make({ kind: 'equal', lower: 1, upper: 1001, buckets });
    insertCosts(s, uniform(count, 1, 1001));
    return s;
  }

  it('バケット数を 10 倍にすると、問い合わせの比較が約 10 倍になる', () => {
    const small = queryComparisons(filled(20_000, 100), 1);
    const large = queryComparisons(filled(20_000, 1_000), 1);
    expect(large / small).toBeGreaterThan(8);
    expect(large / small).toBeLessThan(12);
  });

  it('件数を変えても増えず、バケット数以下', () => {
    for (const count of [1_000, 100_000]) {
      const c = queryComparisons(filled(count, 100), 1);
      expect(c).toBeLessThanOrEqual(100);
      expect(c).toBeGreaterThanOrEqual(90);
    }
  });

  it('問い合わせは移動を数えない', () => {
    const s = filled(1_000, 50);
    const before = s.operationCounts().moves;
    s.query(0.5);
    expect(s.operationCounts().moves).toBe(before);
  });
});

describe('メモリ見積もり', () => {
  it.each([4, 100, 10_000])('バケット数 %d で (2B + 2) × 8 バイトのまま、件数で変わらない', (buckets) => {
    const s = make({ kind: 'equal', lower: 1, upper: 100, buckets });
    const expected = (2 * buckets + 2) * 8;
    expect(s.memoryBytes()).toBe(expected);
    insertCosts(s, uniform(10_000, 1, 100));
    expect(s.memoryBytes()).toBe(expected);
  });

  it('厳密解は件数に比例して増える', () => {
    const exact = createSortExact();
    const hist = make({ kind: 'equal', lower: 1, upper: 100, buckets: 50 });
    const sizes: number[] = [];
    const histSizes: number[] = [];
    for (const n of [1_000, 10_000]) {
      const data = uniform(n, 1, 100);
      exact.reset();
      hist.reset();
      for (const v of data) {
        exact.insert(v);
        hist.insert(v);
      }
      sizes.push(exact.memoryBytes());
      histSizes.push(hist.memoryBytes());
    }
    expect(sizes[1]! / sizes[0]!).toBe(10);
    expect(histSizes[1]).toBe(histSizes[0]);
  });
});
