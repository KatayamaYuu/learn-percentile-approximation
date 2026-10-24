import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { nearestRank } from '../quantile/definitions';
import { absoluteError, rankError, relativeError } from './error-metrics';

function value(r: { ok: boolean; value?: number }): number {
  if (!r.ok) throw new Error('expected ok');
  return r.value as number;
}

describe('absoluteError / relativeError (4.1, 4.2)', () => {
  it('絶対誤差は差の絶対値', () => {
    expect(value(absoluteError(12, 10))).toBe(2);
    expect(value(absoluteError(8, 10))).toBe(2);
    expect(value(absoluteError(10, 10))).toBe(0);
  });

  it('相対誤差は絶対誤差を厳密値で割った値', () => {
    expect(value(relativeError(12, 10))).toBeCloseTo(0.2, 12);
    expect(value(relativeError(5, 10))).toBeCloseTo(0.5, 12);
    expect(value(relativeError(10, 10))).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '推定値 %s は invalid-value(estimate)',
    (bad) => {
      expect(absoluteError(bad, 1)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'estimate' } });
      expect(relativeError(bad, 1)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'estimate' } });
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '厳密値 %s は invalid-value(exact)',
    (bad) => {
      expect(absoluteError(1, bad)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'exact' } });
      expect(relativeError(1, bad)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'exact' } });
    },
  );

  it('数値でない値も invalid-value', () => {
    const bad = 'x' as unknown as number;
    expect(absoluteError(bad, 1).ok).toBe(false);
  });
});

describe('rankError (4.3-4.5)', () => {
  const data = Float64Array.from([10, 20, 30, 40, 50]);

  it('推定値がデータにある場合: 目標順位との差 / n', () => {
    // q=0.5, n=5 -> 目標順位 3。推定値 50 は順位 5 -> |5-3|/5
    expect(value(rankError(data, 50, 0.5))).toBeCloseTo(0.4, 12);
    expect(value(rankError(data, 30, 0.5))).toBe(0);
    expect(value(rankError(data, 10, 0.5))).toBeCloseTo(0.4, 12);
  });

  it('推定値がデータにない場合: 小さい個数を順位とする', () => {
    // 25 より小さい個数 2 -> 順位 2、目標 3 -> 1/5
    expect(value(rankError(data, 25, 0.5))).toBeCloseTo(0.2, 12);
    // 35 -> 順位 3
    expect(value(rankError(data, 35, 0.5))).toBe(0);
  });

  it('最小値未満は順位 0、最大値超過は順位 n', () => {
    expect(value(rankError(data, 5, 0.5))).toBeCloseTo(3 / 5, 12);
    expect(value(rankError(data, 100, 0.5))).toBeCloseTo(2 / 5, 12);
    expect(value(rankError(data, 5, 1))).toBe(1);
    expect(value(rankError(data, 100, 0))).toBeCloseTo(4 / 5, 12);
  });

  it('重複がある場合: 占める順位の範囲で目標順位に最も近い位置', () => {
    const dup = Float64Array.from([1, 2, 2, 2, 2, 2, 8, 9, 10, 11]); // 2 は順位 2..6
    // q=0.5, n=10 -> 目標 5 は範囲内 -> 0
    expect(value(rankError(dup, 2, 0.5))).toBe(0);
    // q=0.9 -> 目標 9、範囲上端 6 -> 3/10
    expect(value(rankError(dup, 2, 0.9))).toBeCloseTo(0.3, 12);
    // q=0.1 -> 目標 1、範囲下端 2 -> 1/10
    expect(value(rankError(dup, 2, 0.1))).toBeCloseTo(0.1, 12);
  });

  it('目標順位は常に nearestRank(q=0 は 1)', () => {
    expect(value(rankError(data, 10, 0))).toBe(0);
    expect(value(rankError(data, 50, 1))).toBe(0);
    // 0.2*5 = 1 ちょうど -> 目標 1
    expect(value(rankError(data, 10, 0.2))).toBe(0);
  });

  it('件数 1', () => {
    const one = Float64Array.from([7]);
    expect(value(rankError(one, 7, 0.5))).toBe(0);
    expect(value(rankError(one, 3, 0.5))).toBe(1);
  });

  it('性質: [0,1] に収まり、厳密解(nearest-rank の値)で 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 60 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0.5, max: 30, noNaN: true }),
        (xs, q, est) => {
          const sorted = Float64Array.from(xs).sort();
          const e = value(rankError(sorted, est, q));
          expect(e).toBeGreaterThanOrEqual(0);
          expect(e).toBeLessThanOrEqual(1);
          const exact = sorted[nearestRank(sorted.length, q) - 1]!;
          expect(value(rankError(sorted, exact, q))).toBe(0);
        },
      ),
    );
  });

  it('性質: 線形探索の定義と一致', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 40 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0.5, max: 12, noNaN: true }),
        (xs, q, est) => {
          const sorted = Float64Array.from(xs).sort();
          const n = sorted.length;
          const a = xs.filter((x) => x < est).length;
          const b = xs.filter((x) => x <= est).length;
          const t = nearestRank(n, q);
          const rank = b > a ? Math.min(Math.max(t, a + 1), b) : a;
          expect(value(rankError(sorted, est, q))).toBeCloseTo(Math.abs(rank - t) / n, 12);
        },
      ),
    );
  });
});

describe('rankError の不正入力 (4.6)', () => {
  const data = Float64Array.from([1, 2, 3]);

  it('空のデータは empty-data', () => {
    expect(rankError(new Float64Array(0), 1, 0.5)).toEqual({ ok: false, error: { kind: 'empty-data' } });
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])('分位点 %s は invalid-quantile', (q) => {
    expect(rankError(data, 1, q)).toEqual({ ok: false, error: { kind: 'invalid-quantile' } });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('推定値 %s は invalid-value(estimate)', (bad) => {
    expect(rankError(data, bad, 0.5)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'estimate' } });
  });

  it('データに正でない値・非有限値があれば invalid-value(data)', () => {
    expect(rankError(Float64Array.from([0, 1]), 1, 0.5)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'data' } });
    expect(rankError(Float64Array.from([-1, 1]), 1, 0.5)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'data' } });
    expect(rankError(Float64Array.from([1, Number.NaN]), 1, 0.5)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'data' } });
    expect(rankError(Float64Array.from([1, Number.POSITIVE_INFINITY]), 1, 0.5)).toEqual({ ok: false, error: { kind: 'invalid-value', field: 'data' } });
  });
});
