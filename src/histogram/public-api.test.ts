import { describe, expect, it } from 'vitest';
import { runBenchmark, runConformance, generate } from '../core';
import {
  MAX_BUCKETS,
  buildBoundaries,
  createHistogram,
  histogramSpec,
  runBucketExperiment,
  type BucketExperimentSpec,
  type BucketScheme,
  type ExperimentError,
  type SchemeError,
} from './index';

describe('公開入口だけから使える', () => {
  it('境界の生成とヒストグラムの作成', () => {
    const scheme: BucketScheme = { kind: 'equal', lower: 1, upper: 101, buckets: 10 };
    const b = buildBoundaries(scheme);
    expect(b.ok && b.value.length).toBe(11);
    const h = createHistogram(scheme);
    expect(h.ok).toBe(true);
    expect(MAX_BUCKETS).toBeGreaterThan(0);
  });

  it('生成仕様を core のハーネスに渡して計測できる', () => {
    const spec = histogramSpec({ kind: 'exponential', lower: 1, upper: 1000, buckets: 30 });
    if (!spec.ok) throw new Error('spec');
    expect(runConformance(spec.value).failures).toEqual([]);
    const data = generate({ distribution: { kind: 'uniform', min: 2, max: 900 }, count: 500, seed: 1 });
    if (!data.ok) throw new Error('data');
    const r = runBenchmark({ data: data.value, quantiles: [0.5, 0.99], sketches: [spec.value], seed: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.algorithms[0]!.status).toBe('ok');
  });

  it('実験を実行できる', () => {
    const experiment: BucketExperimentSpec = {
      cases: [{ label: 'u', distribution: { kind: 'uniform', min: 2, max: 900 }, range: 'data-extent' }],
      counts: [100],
      seed: 1,
      quantiles: [0.5],
      bucketCounts: [8],
      schemes: ['equal', 'exponential'],
    };
    const r = runBucketExperiment(experiment);
    expect(r.ok).toBe(true);
  });

  it('エラーの型を判別できる', () => {
    const e = buildBoundaries({ kind: 'equal', lower: 0, upper: 1, buckets: 2 });
    if (e.ok) throw new Error('expected error');
    const scheme: SchemeError = e.error;
    const wrapped: ExperimentError = scheme;
    expect(wrapped.kind).toBe('invalid-scheme');
  });
});
