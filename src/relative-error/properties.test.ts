import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, type PercentileSketch } from '../core';
import { createDDSketch, type DDSketch } from './ddsketch';
import { createHdrHistogram } from './hdr-histogram';
import { createHdrLayout } from './hdr-layout';
import { createLogMapping } from './log-mapping';

const OPTIONS = { seed: 20260101, numRuns: 200 };
const GRID: readonly number[] = [0, 0.001, 0.01, 0.07, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999, 1];
const QUANTILES: readonly number[] = [...GRID, ...Array.from({ length: 41 }, (_, i) => i / 40)];

const normalDouble = fc.double({ min: 2 ** -1022, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const alphaArb = fc.double({ min: 0.001, max: 0.9, noNaN: true });
const dataArb = (min: number, max: number) =>
  fc.array(fc.double({ min, max, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 300 });

function ddOf(alpha: number, maxBuckets: number): DDSketch {
  const r = createDDSketch({ alpha, maxBuckets });
  if (!r.ok) throw new Error();
  return r.value;
}

function fill(s: PercentileSketch, data: readonly number[]): void {
  for (const x of data) if (!s.insert(x).ok) throw new Error('insert');
}

function sortedOf(data: readonly number[]): Float64Array {
  return Float64Array.from(data).sort();
}

function estimate(s: PercentileSketch, q: number): number {
  const r = s.query(q);
  if (!r.ok) throw new Error('query');
  return r.value;
}

describe('写像の性質', () => {
  it('正規化数の範囲の任意の値と α で、包含と代表値の相対誤差 α 以下が成り立つ', () => {
    fc.assert(
      fc.property(normalDouble, alphaArb, (x, alpha) => {
        const m = createLogMapping(alpha);
        if (!m.ok) return false;
        const i = m.value.indexOf(x);
        const rep = m.value.representative(i);
        return (
          m.value.lowerBound(i) < x &&
          x <= m.value.upperBound(i) &&
          Math.abs(rep - x) / x <= alpha + 1e-9
        );
      }),
      OPTIONS,
    );
  });
});

describe('DDSketch の誤差の上限', () => {
  it('縮約が起きない十分大きい m では、すべての分位点で最近順位法の厳密値に対する相対誤差が α 以下', () => {
    fc.assert(
      fc.property(dataArb(1e-300, 1e300), fc.double({ min: 0.01, max: 0.5, noNaN: true }), (data, alpha) => {
        const s = ddOf(alpha, 100_000);
        fill(s, data);
        if (s.inspect().collapsed) return false;
        const sorted = sortedOf(data);
        return QUANTILES.every((q) => {
          const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
          return Math.abs(estimate(s, q) - exact) / exact <= alpha + 1e-9;
        });
      }),
      OPTIONS,
    );
  });

  it('任意の m で、推定に使ったバケットが縮約の合算先より大きければ相対誤差が α 以下', () => {
    fc.assert(
      fc.property(
        dataArb(1e-6, 1e6),
        fc.double({ min: 0.01, max: 0.3, noNaN: true }),
        fc.integer({ min: 1, max: 40 }),
        (data, alpha, m) => {
          const s = ddOf(alpha, m);
          fill(s, data);
          const bound = s.inspect().collapsedUpperBound;
          const sorted = sortedOf(data);
          return QUANTILES.every((q) => {
            const est = estimate(s, q);
            if (bound !== null && est <= bound) return true;
            const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
            return Math.abs(est - exact) / exact <= alpha + 1e-9;
          });
        },
      ),
      OPTIONS,
    );
  });

  it('データ全体を 10 の累乗倍しても、相対誤差の最大値は α 以下で、保持範囲の長さの変化は 1 以内', () => {
    fc.assert(
      fc.property(
        dataArb(1e-3, 1e3),
        fc.double({ min: 0.01, max: 0.3, noNaN: true }),
        fc.integer({ min: -8, max: 8 }),
        (data, alpha, k) => {
          const scaled = data.map((x) => x * 10 ** k);
          const base = ddOf(alpha, 100_000);
          const shifted = ddOf(alpha, 100_000);
          fill(base, data);
          fill(shifted, scaled);
          if (base.inspect().collapsed || shifted.inspect().collapsed) return false;
          const sorted = sortedOf(scaled);
          const worst = Math.max(
            ...QUANTILES.map((q) => Math.abs(estimate(shifted, q) - exactQuantileSorted(sorted, q, 'nearest-rank')) /
              exactQuantileSorted(sorted, q, 'nearest-rank')),
          );
          return worst <= alpha + 1e-9 && Math.abs(shifted.inspect().span - base.inspect().span) <= 1;
        },
      ),
      OPTIONS,
    );
  });
});

describe('HDR Histogram の誤差の上限', () => {
  const configArb = fc
    .tuple(
      fc.double({ min: 0.001, max: 10, noNaN: true }),
      fc.double({ min: 2, max: 1e6, noNaN: true }),
      fc.integer({ min: 0, max: 4 }),
    )
    .map(([lowest, ratio, significantDigits]) => ({ lowest, highest: lowest * ratio, significantDigits }));

  it('任意の設定と範囲内のデータで、誤差が有効桁数の上限以下で、厳密値と同じバケット', () => {
    fc.assert(
      fc.property(configArb, fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 200 }), (config, unit) => {
        const layout = createHdrLayout(config);
        if (!layout.ok) return true;
        const l = layout.value;
        const data = unit.map((u) => config.lowest * (l.highest / config.lowest) ** u);
        const clamped = data.map((x) => Math.min(Math.max(x, l.lowest), l.highest));
        const h = createHdrHistogram(config);
        if (!h.ok) return false;
        fill(h.value, clamped);
        const sorted = sortedOf(clamped);
        const half = (l.subBucketCount / 2) * l.lowest;
        return QUANTILES.every((q) => {
          const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
          const est = estimate(h.value, q);
          const sameBucket = est === l.representative(l.indexOf(exact));
          const err = Math.abs(est - exact);
          const bounded = exact >= half ? err / exact <= 1 / l.subBucketCount + 1e-9 : err <= l.lowest / 2 + 1e-9 * l.lowest;
          return sameBucket && bounded;
        });
      }),
      OPTIONS,
    );
  });
});

describe('両手法に共通する性質', () => {
  const dataArbitrary = fc.array(fc.double({ min: 1, max: 1e5, noNaN: true }), { minLength: 1, maxLength: 200 });

  const makers: readonly [string, () => PercentileSketch & { inspect(): { totalCount: number; buckets: readonly { index: number; count: number }[] } }][] = [
    ['DDSketch', () => ddOf(0.02, 30)],
    ['HDR', () => {
      const r = createHdrHistogram({ lowest: 1, highest: 1e5, significantDigits: 2 });
      if (!r.ok) throw new Error();
      return r.value;
    }],
  ];

  it.each(makers)('%s: 推定値は有限の正の数で、分位点に対して単調非減少', (_name, make) => {
    fc.assert(
      fc.property(dataArbitrary, (data) => {
        const s = make();
        fill(s, data);
        let previous = 0;
        for (let k = 0; k <= 100; k++) {
          const e = estimate(s, k / 100);
          if (!(Number.isFinite(e) && e > 0 && e >= previous)) return false;
          previous = e;
        }
        return true;
      }),
      OPTIONS,
    );
  });

  it.each(makers)('%s: 観察結果の件数の合計は総件数で昇順、同じ入力で同じ結果', (_name, make) => {
    fc.assert(
      fc.property(dataArbitrary, (data) => {
        const a = make();
        const b = make();
        fill(a, data);
        fill(b, data);
        const snap = a.inspect();
        const sum = snap.buckets.reduce((acc, bucket) => acc + bucket.count, 0);
        const ascending = snap.buckets.every((bucket, i) => i === 0 || bucket.index > snap.buckets[i - 1]!.index);
        const same =
          JSON.stringify(snap) === JSON.stringify(b.inspect()) &&
          JSON.stringify(a.operationCounts()) === JSON.stringify(b.operationCounts()) &&
          a.memoryBytes() === b.memoryBytes() &&
          QUANTILES.every((q) => estimate(a, q) === estimate(b, q));
        return sum === snap.totalCount && snap.totalCount === data.length && ascending && same;
      }),
      OPTIONS,
    );
  });

  it('DDSketch: 保持範囲の長さは m 以下', () => {
    fc.assert(
      fc.property(dataArb(1e-100, 1e100), fc.integer({ min: 1, max: 50 }), (data, m) => {
        const s = ddOf(0.05, m);
        fill(s, data);
        return s.inspect().span <= m;
      }),
      OPTIONS,
    );
  });

  it('DDSketch: 厳密値と同じバケット(縮約が起きない場合)', () => {
    fc.assert(
      fc.property(dataArb(1e-6, 1e6), (data) => {
        const s = ddOf(0.02, 100_000);
        fill(s, data);
        const m = createLogMapping(0.02);
        if (!m.ok) return false;
        const sorted = sortedOf(data);
        return QUANTILES.every(
          (q) => estimate(s, q) === m.value.representative(m.value.indexOf(exactQuantileSorted(sorted, q, 'nearest-rank'))),
        );
      }),
      OPTIONS,
    );
  });
});
