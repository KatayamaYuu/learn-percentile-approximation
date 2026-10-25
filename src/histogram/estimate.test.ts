import { describe, expect, it } from 'vitest';
import { OperationCounter } from '../core';
import { estimateQuantile } from './estimate';

function estimate(
  boundaries: number[],
  counts: number[],
  quantile: number,
): { value: number; comparisons: number; moves: number } {
  const counter = new OperationCounter();
  const total = counts.reduce((s, c) => s + c, 0);
  const value = estimateQuantile({
    boundaries: Float64Array.from(boundaries),
    counts: Float64Array.from(counts),
    total,
    quantile,
    counter,
  });
  return { value, ...counter.snapshot() };
}

// 等幅(下限10、上限50、4バケット)に値 15、25、25、35 を入れた件数列
const BOUNDS = [10, 20, 30, 40, 50];
const COUNTS = [1, 2, 1, 0];

describe('設計例 [15, 25, 25, 35]', () => {
  it.each([
    [0, 10, 1],
    [0.25, 20, 1],
    [0.5, 25, 2],
    [0.75, 30, 2],
    [1, 40, 3],
  ])('q=%d の推定値は %d、比較は %d 回', (q, want, comparisons) => {
    const r = estimate(BOUNDS, COUNTS, q);
    expect(r.value).toBeCloseTo(want, 12);
    expect(r.comparisons).toBe(comparisons);
    expect(r.moves).toBe(0);
  });
});

describe('バケットの選択', () => {
  it('全件が1つのバケットに入る場合は、分位点に応じて下側から上側の境界まで補間する', () => {
    const counts = [0, 4, 0, 0];
    expect(estimate(BOUNDS, counts, 0).value).toBe(20);
    expect(estimate(BOUNDS, counts, 0.5).value).toBe(25);
    expect(estimate(BOUNDS, counts, 1).value).toBe(30);
  });

  it('空のバケットをまたいでも、非空のバケットの中の値を返す', () => {
    const counts = [2, 0, 0, 2];
    expect(estimate(BOUNDS, counts, 0.5).value).toBe(20);
    expect(estimate(BOUNDS, counts, 0.75).value).toBe(45);
    expect(estimate(BOUNDS, counts, 0).value).toBe(10);
  });

  it('分位点 0 は、最初の非空バケットの下側の境界', () => {
    expect(estimate(BOUNDS, [0, 0, 3, 0], 0).value).toBe(30);
  });

  it('0.07 × 100 のように丸めで整数からずれる分位点でも、選択が次のバケットにずれない', () => {
    expect(100 * 0.07).toBeGreaterThan(7);
    const r = estimate([1, 2, 3], [7, 93], 0.07);
    expect(r.value).toBe(2);
    expect(r.comparisons).toBe(1);
  });

  it('最後のバケットの上側の境界まで届く', () => {
    expect(estimate([1, 2, 3], [1, 1], 1).value).toBe(3);
  });

  it('総件数が件数列の合計と合わないと例外を投げる', () => {
    const counter = new OperationCounter();
    expect(() =>
      estimateQuantile({
        boundaries: Float64Array.from([1, 2]),
        counts: Float64Array.from([1]),
        total: 5,
        quantile: 1,
        counter,
      }),
    ).toThrow();
  });
});

describe('推定値の性質', () => {
  it('選んだバケットの閉区間に収まり、有限の正の数で、分位点について単調非減少', () => {
    const bounds = [0.5, 1, 2, 4, 8, 16];
    const counts = [3, 0, 5, 1, 7];
    let prev = 0;
    for (let i = 0; i <= 100; i++) {
      const q = i / 100;
      const v = estimate(bounds, counts, q).value;
      expect(Number.isFinite(v) && v > 0).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(16);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('入力の配列を変更しない', () => {
    const boundaries = Float64Array.from(BOUNDS);
    const counts = Float64Array.from(COUNTS);
    estimateQuantile({ boundaries, counts, total: 4, quantile: 0.5, counter: new OperationCounter() });
    expect(Array.from(boundaries)).toEqual(BOUNDS);
    expect(Array.from(counts)).toEqual(COUNTS);
  });
});
