import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEFINITION,
  combineOrderStatistics,
  nearestRank,
  resolvePosition,
  type PercentileDefinition,
} from './definitions';
import { exactQuantileSorted } from './reference';

const DEFINITIONS: readonly PercentileDefinition[] = [
  'nearest-rank',
  'linear',
  'lower',
  'higher',
  'midpoint',
];

describe('DEFAULT_DEFINITION', () => {
  it('既定は線形補間', () => {
    expect(DEFAULT_DEFINITION).toBe('linear');
  });
});

describe('5定義の値 ([10,20,30,40], q=0.4)', () => {
  const data = Float64Array.from([10, 20, 30, 40]);
  const expected: Record<PercentileDefinition, number> = {
    'nearest-rank': 20,
    linear: 22,
    lower: 20,
    higher: 30,
    midpoint: 25,
  };
  for (const def of DEFINITIONS) {
    it(`${def} は ${expected[def]}`, () => {
      expect(exactQuantileSorted(data, 0.4, def)).toBeCloseTo(expected[def], 12);
    });
  }
  it('定義を省略すると線形補間', () => {
    expect(exactQuantileSorted(data, 0.4)).toBeCloseTo(22, 12);
  });
});

describe('nearestRank の順位安定性', () => {
  it('n=10, q=0.1 は 1 位 (0.1*10=1.0000000000000002 でも 2 位にならない)', () => {
    expect(nearestRank(10, 0.1)).toBe(1);
  });
  it('n=10, q=0.7 は 7 位', () => {
    expect(nearestRank(10, 0.7)).toBe(7);
  });
  it('n=100, q=0.29 は 29 位', () => {
    expect(nearestRank(100, 0.29)).toBe(29);
  });
  it('n=100, q=0.57 は 57 位', () => {
    expect(nearestRank(100, 0.57)).toBe(57);
  });
  it('q=0 は 1 位、q=1 は n 位', () => {
    expect(nearestRank(5, 0)).toBe(1);
    expect(nearestRank(5, 1)).toBe(5);
  });
  it('整数でない n*q は切り上げ', () => {
    expect(nearestRank(4, 0.4)).toBe(2);
    expect(nearestRank(3, 0.5)).toBe(2);
  });
});

describe('resolvePosition', () => {
  it('nearest-rank は下側と上側が同じ添字', () => {
    expect(resolvePosition(10, 0.1, 'nearest-rank')).toEqual({ lo: 0, hi: 0, frac: 0 });
    expect(resolvePosition(4, 0.4, 'nearest-rank')).toEqual({ lo: 1, hi: 1, frac: 0 });
  });
  it('その他4種は h=(n-1)q から求める', () => {
    const p = resolvePosition(4, 0.4, 'linear');
    expect(p.lo).toBe(1);
    expect(p.hi).toBe(2);
    expect(p.frac).toBeCloseTo(0.2, 12);
    for (const d of ['lower', 'higher', 'midpoint'] as const) {
      expect(resolvePosition(4, 0.4, d)).toEqual(p);
    }
  });
  it('(n-1)q が整数付近なら丸める (q=0.7, n=11 → h=7, 6.999999999999999 でも lo=hi=7)', () => {
    expect(resolvePosition(11, 0.7, 'linear')).toEqual({ lo: 7, hi: 7, frac: 0 });
    expect(resolvePosition(101, 0.29, 'linear')).toEqual({ lo: 29, hi: 29, frac: 0 });
    expect(resolvePosition(101, 0.57, 'linear')).toEqual({ lo: 57, hi: 57, frac: 0 });
  });
  it('q=1 は末尾、q=0 は先頭', () => {
    expect(resolvePosition(5, 1, 'linear')).toEqual({ lo: 4, hi: 4, frac: 0 });
    expect(resolvePosition(5, 0, 'linear')).toEqual({ lo: 0, hi: 0, frac: 0 });
  });
  it('1 件ではどの q・定義でも lo=hi=0, frac=0', () => {
    for (const d of DEFINITIONS) {
      for (const q of [0, 0.1, 0.5, 0.99, 1]) {
        expect(resolvePosition(1, q, d)).toEqual({ lo: 0, hi: 0, frac: 0 });
      }
    }
  });
  it('frac は [0,1) で lo<=hi<=lo+1、範囲内', () => {
    for (let n = 1; n <= 30; n++) {
      for (let i = 0; i <= 100; i++) {
        const q = i / 100;
        const p = resolvePosition(n, q, 'linear');
        expect(p.frac).toBeGreaterThanOrEqual(0);
        expect(p.frac).toBeLessThan(1);
        expect(p.hi).toBeGreaterThanOrEqual(p.lo);
        expect(p.hi).toBeLessThanOrEqual(p.lo + 1);
        expect(p.lo).toBeGreaterThanOrEqual(0);
        expect(p.hi).toBeLessThanOrEqual(n - 1);
      }
    }
  });
});

describe('combineOrderStatistics', () => {
  const pos = { lo: 1, hi: 2, frac: 0.25 };
  it('各定義の合成', () => {
    expect(combineOrderStatistics('linear', pos, 20, 30)).toBeCloseTo(22.5, 12);
    expect(combineOrderStatistics('lower', pos, 20, 30)).toBe(20);
    expect(combineOrderStatistics('higher', pos, 20, 30)).toBe(30);
    expect(combineOrderStatistics('midpoint', pos, 20, 30)).toBe(25);
    expect(combineOrderStatistics('nearest-rank', { lo: 1, hi: 1, frac: 0 }, 20, 20)).toBe(20);
  });
  it('linear の結果は [xLo, xHi] に収まる', () => {
    const x = 0.1;
    const y = 0.30000000000000004;
    const v = combineOrderStatistics('linear', { lo: 0, hi: 1, frac: 0.999999999999 }, x, y);
    expect(v).toBeGreaterThanOrEqual(x);
    expect(v).toBeLessThanOrEqual(y);
    expect(combineOrderStatistics('linear', { lo: 0, hi: 1, frac: 0 }, 5, 5)).toBe(5);
  });
});

describe('exactQuantileSorted', () => {
  it('1 件のデータではどの q・定義でもその値', () => {
    const data = Float64Array.from([42]);
    for (const d of DEFINITIONS) {
      for (const q of [0, 0.1, 0.5, 0.99, 1]) {
        expect(exactQuantileSorted(data, q, d)).toBe(42);
      }
    }
  });
  it('q=0 は最小、q=1 は最大', () => {
    const data = Float64Array.from([1, 2, 3, 4, 5]);
    for (const d of DEFINITIONS) {
      expect(exactQuantileSorted(data, 0, d)).toBe(1);
      expect(exactQuantileSorted(data, 1, d)).toBe(5);
    }
  });
  it('中央値 (線形): [1,2,3,4] → 2.5', () => {
    expect(exactQuantileSorted(Float64Array.from([1, 2, 3, 4]), 0.5, 'linear')).toBe(2.5);
  });
  it('入力配列を変更しない', () => {
    const data = Float64Array.from([1, 2, 3]);
    exactQuantileSorted(data, 0.5);
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });
});
