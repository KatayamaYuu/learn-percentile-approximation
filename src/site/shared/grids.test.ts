import { describe, expect, it } from 'vitest';
import { DEFAULT_DEFINITION } from '../../core';
import {
  DETAIL_QUANTILES,
  REFERENCE_DEFINITION,
  SUMMARY_QUANTILES,
  alphaGrid,
  bucketsGrid,
  compressionGrid,
  countGrid,
  digitsGrid,
  epsilonGrid,
  kGrid,
} from './grids';

function strictlyAscending(xs: readonly number[]): boolean {
  return xs.every((x, i) => i === 0 || (xs[i - 1] as number) < x);
}

describe('件数の格子(2.1)', () => {
  it('現在の件数以下の 10 のべきと現在の件数を、昇順・重複なしで返す', () => {
    expect(countGrid(10_000)).toEqual([100, 1_000, 10_000]);
    expect(countGrid(1_000_000)).toEqual([100, 1_000, 10_000, 100_000, 1_000_000]);
    expect(countGrid(5_000)).toEqual([100, 1_000, 5_000]);
    expect(countGrid(100)).toEqual([100]);
    expect(countGrid(150)).toEqual([100, 150]);
  });
  it('どの格子の最大も現在の件数以下である', () => {
    for (const n of [100, 101, 999, 1000, 1001, 123_456, 1_000_000]) {
      const g = countGrid(n);
      expect(Math.max(...g)).toBe(n);
      expect(g).toContain(n);
      expect(strictlyAscending(g)).toBe(true);
    }
  });
});

describe('パラメータの格子(2.6、4.2、5.2、6.2、8.1)', () => {
  it('基本の格子は設計の値を昇順で持つ', () => {
    expect(bucketsGrid(32)).toEqual([4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]);
    expect(epsilonGrid(0.01)).toEqual([0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1]);
    expect(kGrid(200)).toEqual([8, 16, 32, 64, 128, 200, 256, 512, 1024]);
    expect(compressionGrid(100)).toEqual([10, 20, 50, 100, 200, 500, 1000]);
    expect(alphaGrid(0.01)).toEqual([0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1]);
    expect(digitsGrid(2)).toEqual([0, 1, 2, 3, 4]);
  });
  it('現在の値が格子の外でも含まれ、昇順・重複なしになる', () => {
    expect(bucketsGrid(100)).toContain(100);
    expect(epsilonGrid(0.03)).toContain(0.03);
    expect(kGrid(10000)).toContain(10000);
    expect(compressionGrid(15)).toContain(15);
    expect(alphaGrid(0.3)).toContain(0.3);
    expect(digitsGrid(5)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const g of [bucketsGrid(100), epsilonGrid(0.03), kGrid(10000), compressionGrid(15), alphaGrid(0.3), digitsGrid(5)]) {
      expect(strictlyAscending(g)).toBe(true);
    }
  });
  it('現在の値が格子の中なら重複しない', () => {
    expect(bucketsGrid(64).filter((x) => x === 64)).toHaveLength(1);
  });
});

describe('分位点の集合と基準の定義', () => {
  it('要約用は設計の 9 点', () => {
    expect(SUMMARY_QUANTILES).toEqual([0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]);
  });
  it('詳細用は 0, 0.001, 0.005, 0.01〜0.99(0.01 刻み), 0.995, 0.999, 1', () => {
    expect(DETAIL_QUANTILES[0]).toBe(0);
    expect(DETAIL_QUANTILES.slice(0, 3)).toEqual([0, 0.001, 0.005]);
    expect(DETAIL_QUANTILES.slice(-4)).toEqual([0.99, 0.995, 0.999, 1]);
    expect(DETAIL_QUANTILES).toHaveLength(3 + 99 + 3);
    expect(DETAIL_QUANTILES).toContain(0.07);
    expect(DETAIL_QUANTILES).toContain(0.29);
    expect(strictlyAscending(DETAIL_QUANTILES)).toBe(true);
  });
  it('詳細用は要約用を含む', () => {
    for (const q of SUMMARY_QUANTILES) expect(DETAIL_QUANTILES).toContain(q);
  });
  it('基準の定義は最近順位法で、上流の型に合う(上流の既定とは別)', () => {
    expect(REFERENCE_DEFINITION).toBe('nearest-rank');
    expect(DEFAULT_DEFINITION).not.toBe(REFERENCE_DEFINITION);
  });
});
