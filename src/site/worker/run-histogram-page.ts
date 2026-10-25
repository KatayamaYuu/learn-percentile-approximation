// ヒストグラムのページのジョブ(4.1、4.3〜4.6)。上流の実験関数を 3 回呼び、結果をそのまま返す。
import { err, ok, type Result } from '../../core';
import { runBucketExperiment, type BucketExperimentResult, type BucketExperimentSpec } from '../../histogram';
import type { HistogramPageCondition } from '../shared/conditions';
import { bucketsGrid, countGrid, DETAIL_QUANTILES, REFERENCE_DEFINITION, SUMMARY_QUANTILES } from '../shared/grids';
import type { HistogramPageResult } from '../shared/protocol';
import type { FieldIssue } from '../shared/validate';
import { fromExperimentError, histogramFieldMap } from './error-map';

/** 上流の実験の指定の項目名を UI の項目に対応づける(bucketCounts は現在のバケット数の項目) */
function fieldMap(upstreamField: string): string {
  if (upstreamField === 'bucketCounts') return 'buckets';
  return histogramFieldMap(upstreamField);
}

export function runHistogramPage(c: HistogramPageCondition): Result<HistogramPageResult, readonly FieldIssue[]> {
  const n = c.data.count;
  const common = {
    cases: [
      {
        label: 'site',
        distribution: c.data.distribution,
        range: c.range.kind === 'data-extent' ? ('data-extent' as const) : { lower: c.range.lower, upper: c.range.upper },
      },
    ],
    seed: c.data.seed,
    order: c.data.order,
    schemes: c.schemes,
    referenceDefinition: REFERENCE_DEFINITION,
  } satisfies Partial<BucketExperimentSpec>;

  const specs: readonly BucketExperimentSpec[] = [
    { ...common, counts: [n], bucketCounts: bucketsGrid(c.buckets), quantiles: SUMMARY_QUANTILES },
    { ...common, counts: countGrid(n), bucketCounts: [c.buckets], quantiles: SUMMARY_QUANTILES },
    { ...common, counts: [n], bucketCounts: [c.buckets], quantiles: DETAIL_QUANTILES },
  ];

  const results: BucketExperimentResult[] = [];
  for (const spec of specs) {
    const r = runBucketExperiment(spec);
    if (!r.ok) return err([fromExperimentError(r.error, fieldMap)]);
    results.push(r.value);
  }
  const [paramSweep, countSweep, detail] = results as [BucketExperimentResult, BucketExperimentResult, BucketExperimentResult];
  return ok({ kind: 'histogram', paramSweep, countSweep, detail });
}
