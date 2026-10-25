import { describe, expect, it } from 'vitest';
import { generate, runBenchmark, runConformance, seriesByAlgorithm } from '../core';
import {
  DEFAULT_MAX_BUCKETS,
  MAX_DD_BUCKETS,
  MAX_HDR_BUCKETS,
  createDDSketch,
  createHdrHistogram,
  createHdrLayout,
  createLogMapping,
  ddsketchSpec,
  hdrSpec,
  runRelativeErrorExperiment,
  type BucketStatsRecord,
  type BucketView,
  type ConfigError,
  type DDSketchSnapshot,
  type HdrSnapshot,
  type RelativeErrorExperimentError,
  type RelativeErrorExperimentSpec,
} from './index';

describe('公開入口だけから使える', () => {
  it('写像と構造の計算', () => {
    const m = createLogMapping(0.01);
    const l = createHdrLayout({ lowest: 1, highest: 1000, significantDigits: 2 });
    expect(m.ok && m.value.gamma).toBeGreaterThan(1);
    expect(l.ok && l.value.subBucketCount).toBe(256);
    expect(DEFAULT_MAX_BUCKETS).toBe(2048);
    expect(MAX_DD_BUCKETS).toBe(100_000);
    expect(MAX_HDR_BUCKETS).toBe(2 ** 22);
  });

  it('両手法の作成と観察', () => {
    const dd = createDDSketch({ alpha: 0.01 });
    const hdr = createHdrHistogram({ lowest: 1, highest: 1000, significantDigits: 2 });
    if (!dd.ok || !hdr.ok) throw new Error();
    for (const x of [1, 5, 50, 500]) {
      dd.value.insert(x);
      hdr.value.insert(x);
    }
    const a: DDSketchSnapshot = dd.value.inspect();
    const b: HdrSnapshot = hdr.value.inspect();
    const first: BucketView | undefined = a.buckets[0];
    expect(first?.count).toBe(1);
    expect([a.totalCount, b.totalCount]).toEqual([4, 4]);
  });

  it('エラー型が使える', () => {
    const e = createLogMapping(2);
    const x: ConfigError | undefined = e.ok ? undefined : e.error;
    const y: RelativeErrorExperimentError | undefined = x;
    expect(y?.kind).toBe('invalid-config');
  });

  it('生成仕様を core のハーネスに渡して計測できる', () => {
    const dd = ddsketchSpec({ alpha: 0.02, maxBuckets: 256 });
    const hdr = hdrSpec({ lowest: 1, highest: 1000, significantDigits: 2 });
    if (!dd.ok || !hdr.ok) throw new Error();
    for (const spec of [dd.value, hdr.value]) expect(runConformance(spec).failures).toEqual([]);
    const data = generate({ distribution: { kind: 'uniform', min: 2, max: 900 }, count: 500, seed: 1 });
    if (!data.ok) throw new Error();
    const r = runBenchmark({ data: data.value, quantiles: [0.5, 0.99], sketches: [dd.value, hdr.value], seed: 1 });
    expect(r.ok && r.value.algorithms.map((a) => a.status)).toEqual(['ok', 'ok']);
  });

  it('実験を実行できる', () => {
    const spec: RelativeErrorExperimentSpec = {
      cases: [
        { label: 'u', distribution: { kind: 'uniform', min: 2, max: 900 }, hdrRange: { lowest: 1, highest: 1000 } },
      ],
      counts: [100, 200],
      seed: 1,
      quantiles: [0.5, 0.99],
      alphas: [0.01],
      maxBucketsList: [2048],
      significantDigitsList: [2],
    };
    const r = runRelativeErrorExperiment(spec);
    if (!r.ok) throw new Error();
    const stats: readonly BucketStatsRecord[] = r.value.cases[0]!.bucketStats;
    expect(stats).toHaveLength(4);
    const series = seriesByAlgorithm(r.value.cases[0]!.sweep);
    expect(series['hdr-d2']).toHaveLength(2);
  });
});
