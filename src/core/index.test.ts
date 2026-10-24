import { describe, expect, it } from 'vitest';
import * as core from './index';
import {
  generate,
  quickselectExactSpec,
  runBenchmark,
  runConformance,
  sortExactSpec,
  type BenchmarkResult,
  type PercentileDefinition,
  type SketchSpec,
} from './index';

const EXPECTED_EXPORTS = [
  'BYTES_PER_NUMBER',
  'DEFAULT_DEFINITION',
  'OperationCounter',
  'absoluteError',
  'checkPositiveFinite',
  'combineOrderStatistics',
  'createQuickselectExact',
  'createRng',
  'createSortExact',
  'err',
  'estimateBytes',
  'exactQuantileSorted',
  'generate',
  'isParamRecord',
  'isQuantile',
  'nearestRank',
  'ok',
  'quickselectExactSpec',
  'rankError',
  'relativeError',
  'resolvePosition',
  'runBenchmark',
  'runConformance',
  'runSweep',
  'seriesByAlgorithm',
  'sortExactSpec',
  'withoutTiming',
];

describe('公開入口(7.6)', () => {
  it('公開する名前が明示した一覧と一致し、内部の補助関数が漏れない', () => {
    expect(Object.keys(core).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it('入口だけで データ生成 → 2方式の計測 → 適合確認 まで通る', () => {
    const data = generate({ distribution: { kind: 'lognormal', mu: 0, sigma: 1 }, count: 500, seed: 7 });
    expect(data.ok).toBe(true);
    if (!data.ok) return;

    const definition: PercentileDefinition = 'linear';
    const sketches: readonly SketchSpec[] = [sortExactSpec({ definition }), quickselectExactSpec({ definition })];
    const bench = runBenchmark({ data: data.value, quantiles: [0.5, 0.99], sketches, seed: 1 });
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    const result: BenchmarkResult = bench.value;
    expect(result.algorithms).toHaveLength(2);
    for (const a of result.algorithms) {
      expect(a.status).toBe('ok');
      if (a.status === 'ok') {
        for (const q of a.queries) {
          expect(q.absoluteError).toBe(0);
          expect(q.rankError).toBe(0);
        }
      }
    }

    for (const spec of sketches) {
      const report = runConformance(spec);
      expect(report.failures).toEqual([]);
      expect(report.checks.length).toBeGreaterThan(0);
    }
  });
});
