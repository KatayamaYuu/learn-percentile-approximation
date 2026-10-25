import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, type PercentileSketch } from '../core';
import { buildBoundaries, type BucketScheme } from './boundaries';
import { createHistogram } from './histogram';

const RUNS = { numRuns: 200, seed: 20261025 } as const;

// ---- 入力の生成 ----

const lowerArb = fc.double({ min: 0.001, max: 1000, noNaN: true });
const ratioArb = fc.double({ min: 1.01, max: 1000, noNaN: true });

/** 等幅・指数幅・任意境界のいずれかの境界の指定 */
const schemeArb: fc.Arbitrary<BucketScheme> = fc.oneof(
  fc
    .tuple(lowerArb, ratioArb, fc.integer({ min: 1, max: 60 }))
    .map(([lower, ratio, buckets]): BucketScheme => ({ kind: 'equal', lower, upper: lower * ratio, buckets })),
  fc
    .tuple(lowerArb, ratioArb, fc.integer({ min: 1, max: 60 }))
    .map(([lower, ratio, buckets]): BucketScheme => ({ kind: 'exponential', lower, upper: lower * ratio, buckets })),
  fc
    .tuple(lowerArb, fc.array(fc.double({ min: 0.001, max: 50, noNaN: true }), { minLength: 1, maxLength: 60 }))
    .map(([start, steps]): BucketScheme => {
      const boundaries = [start];
      for (const step of steps) boundaries.push(boundaries[boundaries.length - 1]! + step);
      return { kind: 'custom', boundaries };
    }),
);

interface Case {
  readonly scheme: BucketScheme;
  readonly boundaries: Float64Array;
  /** 範囲内の値(境界ちょうどの値を含む) */
  readonly data: number[];
}

const caseArb: fc.Arbitrary<Case> = schemeArb.chain((scheme) => {
  const built = buildBoundaries(scheme);
  if (!built.ok) throw new Error(`generated an invalid scheme: ${JSON.stringify(built.error)}`);
  const boundaries = built.value;
  const lower = boundaries[0]!;
  const upper = boundaries[boundaries.length - 1]!;
  const value = fc.oneof(
    fc.double({ min: lower, max: upper, noNaN: true }),
    // 境界ちょうどの値を重点的に確かめる
    fc.integer({ min: 0, max: boundaries.length - 1 }).map((i) => boundaries[i]!),
  );
  return fc.array(value, { minLength: 1, maxLength: 200 }).map((data) => ({ scheme, boundaries, data }));
});

function fill(scheme: BucketScheme, data: readonly number[]): PercentileSketch {
  const h = createHistogram(scheme);
  if (!h.ok) throw new Error('histogram');
  for (const v of data) {
    const r = h.value.insert(v);
    if (!r.ok) throw new Error(`insert(${v}) failed: ${JSON.stringify(r.error)}`);
  }
  return h.value;
}

function query(s: PercentileSketch, q: number): number {
  const r = s.query(q);
  if (!r.ok) throw new Error('query');
  return r.value;
}

/** 値が属するバケット(下側を含み上側を含まない。最後だけ両端を含む)の添字 */
function bucketOf(boundaries: Float64Array, value: number): number {
  const last = boundaries.length - 2;
  for (let i = 0; i < last; i++) {
    if (value >= boundaries[i]! && value < boundaries[i + 1]!) return i;
  }
  return last;
}

const quantileArb = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(0, 1, 0.5, 0.07, 0.29, 0.57));

describe('推定値の性質', () => {
  it('有限の正の数で、範囲全体の閉区間に収まる', () => {
    fc.assert(
      fc.property(caseArb, quantileArb, ({ scheme, boundaries, data }, q) => {
        const v = query(fill(scheme, data), q);
        expect(Number.isFinite(v) && v > 0).toBe(true);
        expect(v).toBeGreaterThanOrEqual(boundaries[0]!);
        expect(v).toBeLessThanOrEqual(boundaries[boundaries.length - 1]!);
      }),
      RUNS,
    );
  });

  it('分位点について単調非減少', () => {
    fc.assert(
      fc.property(caseArb, fc.array(quantileArb, { minLength: 2, maxLength: 20 }), ({ scheme, data }, qs) => {
        const s = fill(scheme, data);
        const sorted = [...qs].sort((a, b) => a - b);
        const values = sorted.map((q) => query(s, q));
        for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
      }),
      RUNS,
    );
  });

  it('最近順位法の厳密値と同じバケットの閉区間に収まり、差はそのバケットの幅以下', () => {
    fc.assert(
      fc.property(caseArb, quantileArb, ({ scheme, boundaries, data }, q) => {
        const sorted = Float64Array.from(data).sort();
        const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
        const i = bucketOf(boundaries, exact);
        const estimate = query(fill(scheme, data), q);
        expect(estimate).toBeGreaterThanOrEqual(boundaries[i]!);
        expect(estimate).toBeLessThanOrEqual(boundaries[i + 1]!);
        expect(Math.abs(estimate - exact)).toBeLessThanOrEqual(boundaries[i + 1]! - boundaries[i]!);
      }),
      RUNS,
    );
  });

  it('q = k / n のように n × q が整数に近い分位点でも、厳密値と同じバケットの閉区間に収まる', () => {
    fc.assert(
      fc.property(caseArb, fc.nat(), ({ scheme, boundaries, data }, j) => {
        const n = data.length;
        const q = (j % (n + 1)) / n;
        const sorted = Float64Array.from(data).sort();
        const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
        const i = bucketOf(boundaries, exact);
        const estimate = query(fill(scheme, data), q);
        expect(estimate).toBeGreaterThanOrEqual(boundaries[i]!);
        expect(estimate).toBeLessThanOrEqual(boundaries[i + 1]!);
      }),
      { numRuns: 500, seed: 20261026 },
    );
  });

  it('1 件だけ入れた直後は、すべての分位点の推定値が、その値を含むバケットの閉区間に収まる', () => {
    fc.assert(
      fc.property(caseArb, quantileArb, ({ scheme, boundaries, data }, q) => {
        const value = data[0]!;
        const i = bucketOf(boundaries, value);
        const estimate = query(fill(scheme, [value]), q);
        expect(estimate).toBeGreaterThanOrEqual(boundaries[i]!);
        expect(estimate).toBeLessThanOrEqual(boundaries[i + 1]!);
      }),
      RUNS,
    );
  });
});

describe('操作数・再現性の性質', () => {
  it('投入 1 回の比較は、等幅・指数幅で 3 回以下、任意境界で ceil(log2 B) 回以下。移動は 2 回', () => {
    fc.assert(
      fc.property(caseArb, ({ scheme, boundaries, data }) => {
        const buckets = boundaries.length - 1;
        const limit = scheme.kind === 'custom' ? Math.ceil(Math.log2(buckets)) : 3;
        const h = createHistogram(scheme);
        if (!h.ok) throw new Error('histogram');
        let prev = h.value.operationCounts();
        for (const v of data) {
          h.value.insert(v);
          const now = h.value.operationCounts();
          expect(now.comparisons - prev.comparisons).toBeLessThanOrEqual(limit);
          expect(now.moves - prev.moves).toBe(2);
          prev = now;
        }
      }),
      RUNS,
    );
  });

  it('同じ入力で、推定値・操作数・メモリ見積もりが同じ', () => {
    fc.assert(
      fc.property(caseArb, quantileArb, ({ scheme, data }, q) => {
        const a = fill(scheme, data);
        const b = fill(scheme, data);
        expect(query(a, q)).toBe(query(b, q));
        expect(a.operationCounts()).toEqual(b.operationCounts());
        expect(a.memoryBytes()).toBe(b.memoryBytes());
      }),
      RUNS,
    );
  });

  it('問い合わせの比較はバケット数以下で、移動は数えない', () => {
    fc.assert(
      fc.property(caseArb, quantileArb, ({ scheme, boundaries, data }, q) => {
        const s = fill(scheme, data);
        const before = s.operationCounts();
        s.query(q);
        const after = s.operationCounts();
        expect(after.comparisons - before.comparisons).toBeLessThanOrEqual(boundaries.length - 1);
        expect(after.comparisons - before.comparisons).toBeGreaterThanOrEqual(1);
        expect(after.moves).toBe(before.moves);
      }),
      RUNS,
    );
  });

  it('メモリ見積もりは投入の前後で変わらない', () => {
    fc.assert(
      fc.property(caseArb, ({ scheme, boundaries, data }) => {
        const s = fill(scheme, []);
        const before = s.memoryBytes();
        for (const v of data) s.insert(v);
        expect(s.memoryBytes()).toBe(before);
        expect(before).toBe((2 * (boundaries.length - 1) + 2) * 8);
      }),
      RUNS,
    );
  });
});
