import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generate, rankError, type DataOrder, type Distribution } from '../core';
import {
  SCALE_FUNCTIONS,
  createGk,
  createKll,
  createTDigest,
  type GkSketch,
  type KllSketch,
  type ScaleFunctionKind,
  type TDigestSketch,
} from './index';

const RUNS = { numRuns: 60, seed: 20261105 } as const;
/** 毎回の投入後に不変条件を確かめる性質は、入力が長いので回数を減らす */
const RUNS_STEPWISE = { numRuns: 30, seed: 20261106 } as const;
const RUNS_DETERMINISM = { numRuns: 40, seed: 20261107 } as const;

// ---- 入力の生成 ----

/** 正の有限数のみを返す分布(標本が不正にならないパラメータの範囲) */
const distributionArb: fc.Arbitrary<Distribution> = fc.oneof(
  fc
    .tuple(fc.double({ min: 1, max: 100, noNaN: true }), fc.double({ min: 1.5, max: 100, noNaN: true }))
    .map(([min, width]): Distribution => ({ kind: 'uniform', min, max: min + width })),
  fc
    .tuple(fc.double({ min: 0, max: 3, noNaN: true }), fc.double({ min: 0.1, max: 1.5, noNaN: true }))
    .map(([mu, sigma]): Distribution => ({ kind: 'lognormal', mu, sigma })),
  fc
    .tuple(fc.double({ min: 1, max: 10, noNaN: true }), fc.double({ min: 0.8, max: 3, noNaN: true }))
    .map(([scale, shape]): Distribution => ({ kind: 'heavy-tail', scale, shape })),
  fc.tuple(fc.double({ min: 0.1, max: 0.9, noNaN: true }), fc.double({ min: 200, max: 400, noNaN: true })).map(
    ([weight, gap]): Distribution => ({
      kind: 'multimodal',
      modes: [
        { weight, mean: 500, stdDev: 20 },
        { weight: 1 - weight, mean: 500 + gap, stdDev: 20 },
      ],
    }),
  ),
);

const orderArb: fc.Arbitrary<DataOrder> = fc.constantFrom('random', 'ascending', 'descending');

/** 分布・挿入順序・件数・データのシードで決まる入力 */
interface Input {
  readonly distribution: Distribution;
  readonly order: DataOrder;
  readonly data: Float64Array;
}

function inputArb(maxCount: number): fc.Arbitrary<Input> {
  return fc
    .tuple(distributionArb, orderArb, fc.integer({ min: 1, max: maxCount }), fc.integer({ min: 0, max: 2 ** 32 - 1 }))
    .map(([distribution, order, count, seed]) => {
      const r = generate({ distribution, count, seed, order });
      if (!r.ok) throw new Error(`generated an invalid input: ${JSON.stringify(r.error)}`);
      return { distribution, order, data: r.value };
    });
}

/** 値が一部重複する小さな整数列(重複値の扱いを確かめる) */
const duplicatedArb = fc
  .array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 300, size: 'max' })
  .map((xs) => Float64Array.from(xs));

/** 任意の入力: 分布から作ったものか、重複の多いもの */
function anyDataArb(maxCount: number): fc.Arbitrary<Float64Array> {
  return fc.oneof(
    inputArb(maxCount).map((i) => i.data),
    duplicatedArb,
  );
}

const arbitraryValuesArb = fc
  .array(fc.double({ min: 1e-3, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 400, size: 'max' })
  .map((xs) => Float64Array.from(xs));

/** KLL の段が何段にも増えるように長くした入力 */
const longValuesArb = fc
  .array(fc.double({ min: 1e-3, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 3000, size: 'max' })
  .map((xs) => Float64Array.from(xs));

const seedArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });

/** 問い合わせる分位点: 端、格子、任意の値 */
const quantilesArb = fc
  .array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 0, maxLength: 12 })
  .map((qs) => [0, 1, 0.5, 0.01, 0.25, 0.75, 0.9, 0.99, ...qs]);

// ---- 操作の補助 ----

function must<T, E>(r: { ok: true; value: T } | { ok: false; error: E }, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function insertAll(s: { insert(v: number): unknown }, data: ArrayLike<number>): void {
  for (let i = 0; i < data.length; i++) {
    const r = s.insert(data[i]!) as { ok: boolean };
    if (!r.ok) throw new Error(`insert(${data[i]}) failed`);
  }
}

function query(s: { query(q: number): unknown }, quantile: number): number {
  return must(s.query(quantile) as { ok: true; value: number }, `query(${quantile})`);
}

function sortedOf(data: Float64Array): Float64Array {
  return Float64Array.from(data).sort();
}

function makeGk(epsilon: number): GkSketch {
  return must(createGk({ epsilon }), 'createGk');
}

function makeKll(k: number, seed: number): KllSketch {
  return must(createKll({ k, seed }), 'createKll');
}

function makeTDigest(compression: number, scale: ScaleFunctionKind): TDigestSketch {
  return must(createTDigest({ compression, scale }), 'createTDigest');
}

/** 順位誤差(core の指標)。指標自体が失敗したら例外 */
function rankErrorOf(sorted: Float64Array, estimate: number, quantile: number): number {
  return must(rankError(sorted, estimate, quantile), 'rankError');
}

/** 状態に影響する観測結果を一式で取る(推定値、操作数、メモリ見積もり、観察結果) */
function observe(
  s: { query(q: number): unknown; operationCounts(): unknown; memoryBytes(): number; inspect(): unknown },
  quantiles: readonly number[],
): unknown {
  const estimates = quantiles.map((quantile) => query(s, quantile));
  return {
    estimates,
    counts: s.operationCounts(),
    memory: s.memoryBytes(),
    state: s.inspect(),
  };
}

const epsilonArb = fc.oneof(
  fc.constantFrom(0.5, 0.25, 0.1, 0.05, 0.01, 0.001),
  fc.double({ min: 0.001, max: 0.5, noNaN: true }),
);
const kArb = fc.constantFrom(8, 9, 16, 50, 81, 200);
const compressionArb = fc.constantFrom(10, 20, 50, 100);
const scaleArb = fc.constantFrom(...SCALE_FUNCTIONS);

describe('GK の性質(1.3、8.8)', () => {
  it('任意の分布・挿入順序・ε・件数で、すべての問い合わせの順位誤差が ε 以下で、推定値は投入済みの値(property)', () => {
    fc.assert(
      fc.property(anyDataArb(3000), epsilonArb, quantilesArb, (data, epsilon, quantiles) => {
        const s = makeGk(epsilon);
        insertAll(s, data);
        const sorted = sortedOf(data);
        const inserted = new Set(data);
        for (const quantile of quantiles) {
          const estimate = query(s, quantile);
          expect(inserted.has(estimate)).toBe(true);
          expect(rankErrorOf(sorted, estimate, quantile)).toBeLessThanOrEqual(epsilon);
        }
      }),
      RUNS,
    );
  });

  it('毎回の投入の後も、すべての問い合わせの順位誤差が ε 以下(途中の状態でも保証が成り立つ)(property)', () => {
    fc.assert(
      fc.property(
        inputArb(400),
        fc.constantFrom(0.25, 0.1, 0.05, 0.01),
        fc.double({ min: 0, max: 1, noNaN: true }),
        ({ data }, epsilon, quantile) => {
          const s = makeGk(epsilon);
          for (let i = 0; i < data.length; i++) {
            insertAll(s, [data[i]!]);
            const prefix = sortedOf(data.subarray(0, i + 1));
            expect(rankErrorOf(prefix, query(s, quantile), quantile)).toBeLessThanOrEqual(epsilon);
          }
        },
      ),
      RUNS_STEPWISE,
    );
  });

  it('任意の入力で、タプルの不変条件(g の合計 = 件数、g + Δ ≤ max(⌊2εn⌋, 1)、端の Δ = 0、値の昇順)が毎回の投入で成り立つ(property)', () => {
    fc.assert(
      fc.property(anyDataArb(500), epsilonArb, (data, epsilon) => {
        const s = makeGk(epsilon);
        for (let i = 0; i < data.length; i++) {
          insertAll(s, [data[i]!]);
          const n = i + 1;
          const state = s.inspect();
          expect(state.count).toBe(n);
          const limit = Math.max(Math.floor(2 * epsilon * n), 1);
          let sum = 0;
          let previous = 0;
          for (const t of state.tuples) {
            sum += t.g;
            expect(t.g + t.delta).toBeLessThanOrEqual(limit);
            expect(t.value).toBeGreaterThanOrEqual(previous);
            previous = t.value;
          }
          expect(sum).toBe(n);
          expect(state.tuples[0]!.delta).toBe(0);
          expect(state.tuples[state.tuples.length - 1]!.delta).toBe(0);
        }
      }),
      RUNS_STEPWISE,
    );
  });
});

describe('KLL の性質(2.4、2.6、8.8)', () => {
  it('任意の入力とシードで、毎回の投入の後に重みの合計 = 投入件数、保持要素数 ≤ 容量の合計 ≤ 3k + 2 × 段数(property)', () => {
    fc.assert(
      fc.property(longValuesArb, kArb, seedArb, (data, k, seed) => {
        const s = makeKll(k, seed);
        for (let i = 0; i < data.length; i++) {
          insertAll(s, [data[i]!]);
          const state = s.inspect();
          let weighted = 0;
          let retained = 0;
          let capacity = 0;
          for (const level of state.levels) {
            weighted += level.weight * level.values.length;
            retained += level.values.length;
            capacity += level.capacity;
          }
          expect(weighted).toBe(i + 1);
          expect(state.count).toBe(i + 1);
          expect(retained).toBeLessThanOrEqual(capacity);
          expect(capacity).toBeLessThanOrEqual(3 * k + 2 * state.levels.length);
        }
      }),
      RUNS_STEPWISE,
    );
  });

  it('十分に長い入力では compaction が起き、その後も重みが保存される(property)', () => {
    fc.assert(
      fc.property(inputArb(2500), fc.constantFrom(8, 16, 50), seedArb, ({ data }, k, seed) => {
        const s = makeKll(k, seed);
        insertAll(s, data);
        const state = s.inspect();
        const weighted = state.levels.reduce((sum, level) => sum + level.weight * level.values.length, 0);
        expect(weighted).toBe(data.length);
        if (data.length > 3 * k + 4) {
          expect(state.compactions).toBeGreaterThan(0);
          expect(state.levels.length).toBeGreaterThan(1);
        }
      }),
      RUNS,
    );
  });

  it('固定のシードの集合で、k = 200、件数 10,000 の順位誤差が 0.05 以下(固定シードの集合)', () => {
    const distributions: readonly Distribution[] = [
      { kind: 'uniform', min: 1, max: 1000 },
      { kind: 'lognormal', mu: 3, sigma: 1 },
    ];
    const grid = Array.from({ length: 41 }, (_, i) => i / 40);
    let maxError = 0;
    for (const distribution of distributions) {
      for (const order of ['random', 'ascending', 'descending'] as const) {
        const data = must(generate({ distribution, count: 10_000, seed: 1, order }), 'generate');
        const sorted = sortedOf(data);
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          const s = makeKll(200, seed);
          insertAll(s, data);
          for (const quantile of grid) {
            const e = rankErrorOf(sorted, query(s, quantile), quantile);
            maxError = Math.max(maxError, e);
            expect(e).toBeLessThanOrEqual(0.05);
          }
        }
      }
    }
    // 上限が空回りしていないこと: 誤差は 0 ではなく、緩い上限の内側にある
    expect(maxError).toBeGreaterThan(0);
  });

  it('シードが違えば推定の元になる状態が変わりうる(固定シードの組で少なくとも 1 組は異なる)', () => {
    const data = must(generate({ distribution: { kind: 'uniform', min: 1, max: 1000 }, count: 2000, seed: 3 }), 'g');
    const states = [1, 2, 3, 4].map((seed) => {
      const s = makeKll(16, seed);
      insertAll(s, data);
      return JSON.stringify(s.inspect().levels.map((l) => l.values));
    });
    expect(new Set(states).size).toBeGreaterThan(1);
  });
});

describe('t-digest の性質(3.5、3.8、4.8、8.8)', () => {
  it('任意の入力とスケール関数で、毎回の投入の後に重みの合計 + バッファ件数 = 投入件数、最小値 ≤ 平均値 ≤ 最大値(property)', () => {
    fc.assert(
      fc.property(arbitraryValuesArb, compressionArb, scaleArb, (data, compression, scale) => {
        const s = makeTDigest(compression, scale);
        for (let i = 0; i < data.length; i++) {
          insertAll(s, [data[i]!]);
          const state = s.inspect();
          const weights = state.centroids.reduce((sum, c) => sum + c.weight, 0);
          expect(weights + state.buffered).toBe(i + 1);
          expect(state.count).toBe(i + 1);
          for (const c of state.centroids) {
            expect(c.weight).toBeGreaterThanOrEqual(1);
            expect(c.mean).toBeGreaterThanOrEqual(state.min!);
            expect(c.mean).toBeLessThanOrEqual(state.max!);
          }
          for (let j = 1; j < state.centroids.length; j++) {
            expect(state.centroids[j]!.mean).toBeGreaterThanOrEqual(state.centroids[j - 1]!.mean);
          }
        }
      }),
      RUNS_STEPWISE,
    );
  });

  it('任意の入力・スケール関数で、推定値は有限の正の数で最小値以上・最大値以下、分位点について単調非減少(property)', () => {
    fc.assert(
      fc.property(anyDataArb(3000), compressionArb, scaleArb, quantilesArb, (data, compression, scale, quantiles) => {
        const s = makeTDigest(compression, scale);
        insertAll(s, data);
        const sorted = sortedOf(data);
        const min = sorted[0]!;
        const max = sorted[sorted.length - 1]!;
        // 任意の分位点に加えて、細かい格子(隣り合う点の間の補間の向きも確かめる)
        const dense = Array.from({ length: 201 }, (_, i) => i / 200);
        const ascending = [...quantiles, ...dense].sort((a, b) => a - b);
        let previous = Number.NEGATIVE_INFINITY;
        for (const quantile of ascending) {
          const estimate = query(s, quantile);
          expect(Number.isFinite(estimate)).toBe(true);
          expect(estimate).toBeGreaterThan(0);
          expect(estimate).toBeGreaterThanOrEqual(min);
          expect(estimate).toBeLessThanOrEqual(max);
          expect(estimate).toBeGreaterThanOrEqual(previous);
          previous = estimate;
        }
        // 問い合わせ後はバッファが空で、重みの合計 = 件数
        const state = s.inspect();
        expect(state.buffered).toBe(0);
        expect(state.centroids.reduce((sum, c) => sum + c.weight, 0)).toBe(data.length);
      }),
      RUNS,
    );
  });

  it('バッファが残っている途中でも、問い合わせの推定値は範囲内で単調(property)', () => {
    fc.assert(
      fc.property(arbitraryValuesArb, compressionArb, scaleArb, (data, compression, scale) => {
        const s = makeTDigest(compression, scale);
        let min = Number.POSITIVE_INFINITY;
        let max = 0;
        for (let i = 0; i < data.length; i++) {
          insertAll(s, [data[i]!]);
          min = Math.min(min, data[i]!);
          max = Math.max(max, data[i]!);
          if (i % 7 !== 0) continue;
          let previous = 0;
          for (const quantile of [0, 0.1, 0.5, 0.9, 1]) {
            const estimate = query(s, quantile);
            expect(estimate).toBeGreaterThanOrEqual(min);
            expect(estimate).toBeLessThanOrEqual(max);
            expect(estimate).toBeGreaterThanOrEqual(previous);
            previous = estimate;
          }
        }
      }),
      RUNS_STEPWISE,
    );
  });
});

describe('3 手法の再現性(1.6、2.7、3.9)', () => {
  it('GK: 同じ入力から、同じ推定値・操作数・メモリ見積もり・観察結果が得られる(property)', () => {
    fc.assert(
      fc.property(anyDataArb(1500), epsilonArb, quantilesArb, (data, epsilon, quantiles) => {
        const a = makeGk(epsilon);
        const b = makeGk(epsilon);
        insertAll(a, data);
        insertAll(b, data);
        expect(a.operationCounts()).toEqual(b.operationCounts());
        expect(a.memoryBytes()).toBe(b.memoryBytes());
        expect(a.inspect()).toEqual(b.inspect());
        expect(observe(a, quantiles)).toEqual(observe(b, quantiles));
      }),
      RUNS_DETERMINISM,
    );
  });

  it('KLL: 同じ入力と同じシードから、同じ推定値・操作数・メモリ見積もり・観察結果が得られる(property)', () => {
    fc.assert(
      fc.property(anyDataArb(1500), kArb, seedArb, quantilesArb, (data, k, seed, quantiles) => {
        const a = makeKll(k, seed);
        const b = makeKll(k, seed);
        insertAll(a, data);
        insertAll(b, data);
        expect(a.operationCounts()).toEqual(b.operationCounts());
        expect(a.memoryBytes()).toBe(b.memoryBytes());
        expect(a.inspect()).toEqual(b.inspect());
        expect(observe(a, quantiles)).toEqual(observe(b, quantiles));
      }),
      RUNS_DETERMINISM,
    );
  });

  it('t-digest: 同じ入力から、同じ推定値・操作数・メモリ見積もり・観察結果が得られる(property)', () => {
    fc.assert(
      fc.property(anyDataArb(1500), compressionArb, scaleArb, quantilesArb, (data, compression, scale, quantiles) => {
        const a = makeTDigest(compression, scale);
        const b = makeTDigest(compression, scale);
        insertAll(a, data);
        insertAll(b, data);
        // バッファが残った状態の観察結果も同じ
        expect(a.operationCounts()).toEqual(b.operationCounts());
        expect(a.memoryBytes()).toBe(b.memoryBytes());
        expect(a.inspect()).toEqual(b.inspect());
        expect(observe(a, quantiles)).toEqual(observe(b, quantiles));
      }),
      RUNS_DETERMINISM,
    );
  });

  it('初期化すると、同じ入力を入れ直して同じ観測結果になる(3 手法、property)', () => {
    fc.assert(
      fc.property(anyDataArb(600), kArb, seedArb, compressionArb, scaleArb, (data, k, seed, compression, scale) => {
        const sketches = [makeGk(0.05), makeKll(k, seed), makeTDigest(compression, scale)] as const;
        for (const s of sketches) {
          insertAll(s, data);
          const first = observe(s, [0, 0.5, 0.99]);
          s.reset();
          insertAll(s, data);
          // 初期化は操作数と乱数列も戻すので、1 回目と同じ観測結果になる
          expect(observe(s, [0, 0.5, 0.99])).toEqual(first);
        }
      }),
      RUNS_DETERMINISM,
    );
  });
});
