import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createQuickselectExact,
  createSortExact,
  generate,
  quickselectExactSpec,
  rankError,
  runBenchmark,
  runConformance,
  sortExactSpec,
  type Distribution,
  type PercentileDefinition,
  type PercentileSketch,
  type SketchSpec,
} from '../index';

const DEFINITIONS: readonly PercentileDefinition[] = ['nearest-rank', 'linear', 'lower', 'higher', 'midpoint'];
const FC = { seed: 20260101, numRuns: 150 } as const;

const dataArb = fc.array(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 200 });
const quantileArb = fc.double({ min: 0, max: 1, noNaN: true });
const definitionArb = fc.constantFrom(...DEFINITIONS);

function filled(sketch: PercentileSketch, data: readonly number[]): PercentileSketch {
  for (const x of data) {
    const r = sketch.insert(x);
    if (!r.ok) throw new Error(`insert failed: ${r.error.kind}`);
  }
  return sketch;
}

function value(sketch: PercentileSketch, q: number): number {
  const r = sketch.query(q);
  if (!r.ok) throw new Error(`query failed: ${r.error.kind}`);
  return r.value;
}

function bothMethods(definition: PercentileDefinition, data: readonly number[], seed = 1): [PercentileSketch, PercentileSketch] {
  return [
    filled(createSortExact({ definition }), data),
    filled(createQuickselectExact(seed, { definition }), data),
  ];
}

/** 丸め誤差の許容: 相対 1e-9 */
function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

describe('厳密解2方式の適合確認(1.9)', () => {
  for (const definition of DEFINITIONS) {
    it(`定義 ${definition} で2方式とも失敗 0 件`, () => {
      const specs: readonly SketchSpec[] = [sortExactSpec({ definition }), quickselectExactSpec({ definition })];
      for (const spec of specs) {
        const report = runConformance(spec);
        expect(report.failures).toEqual([]);
        expect(report.checks.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('厳密解2方式の性質テスト(fast-check、シード固定)', () => {
  it('任意の正のデータ・分位点・定義で2方式が丸め誤差の範囲で同じ値を返す(2.3, 2.8)', () => {
    fc.assert(
      fc.property(dataArb, quantileArb, definitionArb, fc.integer({ min: 0, max: 1000 }), (data, q, def, seed) => {
        const [a, b] = bothMethods(def, data, seed);
        return closeTo(value(a, q), value(b, q));
      }),
      FC,
    );
  });

  it('同値が多いデータでも2方式が同じ値を返す(2.8)', () => {
    const dupArb = fc.array(fc.constantFrom(1, 2, 2.5, 10), { minLength: 1, maxLength: 100 });
    fc.assert(
      fc.property(dupArb, quantileArb, definitionArb, (data, q, def) => {
        const [a, b] = bothMethods(def, data);
        return closeTo(value(a, q), value(b, q));
      }),
      FC,
    );
  });

  it('値は最小値以上・最大値以下で、分位点に対して単調非減少(1.3)', () => {
    fc.assert(
      fc.property(dataArb, fc.array(quantileArb, { minLength: 2, maxLength: 12 }), definitionArb, (data, qs, def) => {
        const sorted = [...qs].sort((x, y) => x - y);
        const min = Math.min(...data);
        const max = Math.max(...data);
        for (const sketch of bothMethods(def, data)) {
          let prev = -Infinity;
          for (const q of sorted) {
            const v = value(sketch, q);
            if (v < min || v > max || v < prev) return false;
            prev = v;
          }
        }
        return true;
      }),
      FC,
    );
  });

  it('最近順位法の厳密値に対する順位誤差は 0(4.3)', () => {
    fc.assert(
      fc.property(dataArb, quantileArb, (data, q) => {
        const sortedData = Float64Array.from(data).sort();
        for (const sketch of bothMethods('nearest-rank', data)) {
          const r = rankError(sortedData, value(sketch, q), q);
          if (!r.ok || r.value !== 0) return false;
        }
        return true;
      }),
      FC,
    );
  });

  it('順位誤差は常に [0, 1] に収まる(4.3)', () => {
    fc.assert(
      fc.property(dataArb, quantileArb, definitionArb, fc.double({ min: 1e-9, max: 1e7, noNaN: true }), (data, q, def, arbitrary) => {
        const sortedData = Float64Array.from(data).sort();
        const [a] = bothMethods(def, data);
        for (const estimate of [value(a, q), arbitrary]) {
          const r = rankError(sortedData, estimate, q);
          if (!r.ok || r.value < 0 || r.value > 1) return false;
        }
        return true;
      }),
      FC,
    );
  });

  it('同じ入力列なら操作数とメモリ見積もりが同じ(5.4)', () => {
    fc.assert(
      fc.property(dataArb, fc.array(quantileArb, { maxLength: 5 }), definitionArb, fc.integer({ min: 0, max: 1000 }), (data, qs, def, seed) => {
        const factories: readonly (() => PercentileSketch)[] = [
          () => createSortExact({ definition: def }),
          () => createQuickselectExact(seed, { definition: def }),
        ];
        for (const make of factories) {
          const x = filled(make(), data);
          const y = filled(make(), data);
          if (x.memoryBytes() !== y.memoryBytes()) return false;
          if (JSON.stringify(x.operationCounts()) !== JSON.stringify(y.operationCounts())) return false;
          for (const q of qs) {
            if (value(x, q) !== value(y, q)) return false;
          }
          if (x.memoryBytes() !== y.memoryBytes()) return false;
          if (JSON.stringify(x.operationCounts()) !== JSON.stringify(y.operationCounts())) return false;
        }
        return true;
      }),
      FC,
    );
  });
});

describe('5分布 x 2方式のハーネス実行(6.3)', () => {
  const distributions: readonly Distribution[] = [
    { kind: 'uniform', min: 1, max: 100 },
    { kind: 'normal', mean: 50, stdDev: 10 },
    { kind: 'lognormal', mu: 0, sigma: 1 },
    { kind: 'heavy-tail', scale: 1, shape: 1.5 },
    {
      kind: 'multimodal',
      modes: [
        { weight: 1, mean: 10, stdDev: 2 },
        { weight: 2, mean: 100, stdDev: 5 },
      ],
    },
  ];

  for (const distribution of distributions) {
    it(`${distribution.kind}: 両方式が成功し、誤差 0 で、JSON を往復しても等しい`, () => {
      const data = generate({ distribution, count: 2000, seed: 42 });
      expect(data.ok).toBe(true);
      if (!data.ok) return;
      const bench = runBenchmark({
        data: data.value,
        quantiles: [0, 0.5, 0.9, 0.99, 1],
        sketches: [sortExactSpec(), quickselectExactSpec()],
        seed: 3,
        meta: { distribution: distribution.kind },
      });
      expect(bench.ok).toBe(true);
      if (!bench.ok) return;
      expect(bench.value.algorithms).toHaveLength(2);
      for (const a of bench.value.algorithms) {
        expect(a.status).toBe('ok');
        if (a.status !== 'ok') continue;
        expect(a.queries).toHaveLength(5);
        for (const q of a.queries) {
          expect(closeTo(q.estimate, q.exact)).toBe(true);
          expect(q.rankError).toBeGreaterThanOrEqual(0);
          expect(q.rankError).toBeLessThanOrEqual(1);
        }
      }
      expect(JSON.parse(JSON.stringify(bench.value))).toEqual(bench.value);
    });
  }
});
