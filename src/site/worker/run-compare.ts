// 横断比較のジョブ(2.7、3.5、8.2、8.3、8.5、8.8)。件数の格子の各件数でデータを作り、選んだ手法の SketchSpec を
// 1 つの計測条件に並べて core の runSweep を呼ぶ。続いて現在の件数で詳細用の分位点の掃引を行う。
import {
  err,
  generate,
  ok,
  quickselectExactSpec,
  runSweep,
  sortExactSpec,
  type BenchmarkInput,
  type Result,
  type SketchSpec,
} from '../../core';
import { histogramSpec } from '../../histogram';
import { ddsketchSpec, hdrSpec } from '../../relative-error';
import { streamingSketchSpec } from '../../streaming';
import type { CompareAlgorithm, CompareCondition } from '../shared/conditions';
import { countGrid, DETAIL_QUANTILES, REFERENCE_DEFINITION, SUMMARY_QUANTILES } from '../shared/grids';
import type { CompareResult, JobFailure } from '../shared/protocol';
import type { FieldIssue } from '../shared/validate';
import { estimateWork } from '../shared/workload';
import { dataExtent, planHdr, type Extent } from './data-extent';
import { fromConfigError, fromGenerateError, fromHarnessError, GENERAL_FIELD, relativeCompareFieldMap } from './error-map';

const invalid = (...issues: FieldIssue[]): JobFailure => ({ kind: 'invalid-condition', issues });

const exact = { definition: REFERENCE_DEFINITION } as const;

/** 手法の項目の名前を algorithms[<i>].<項目> にする(対応のないものは全般) */
function algorithmField(index: number, known: readonly string[]): (upstreamField: string) => string {
  return (f) => (known.includes(f) ? `algorithms[${index}].${f}` : GENERAL_FIELD);
}

/** 1 つの手法の SketchSpec。hdrRange は HDR の手法だけが使う */
function buildSpec(
  a: CompareAlgorithm,
  index: number,
  extent: Extent,
  hdrRange: { readonly lowest: number; readonly highest: number },
): Result<SketchSpec, FieldIssue> {
  switch (a.kind) {
    case 'exact-sort':
      return ok(sortExactSpec(exact));
    case 'exact-quickselect':
      return ok(quickselectExactSpec(exact));
    case 'histogram': {
      const r = histogramSpec({ kind: a.scheme, lower: extent.min, upper: extent.max, buckets: a.buckets });
      return r.ok ? ok(r.value) : err({ field: algorithmField(index, ['buckets'])(r.error.field), reason: r.error.reason });
    }
    case 'gk':
    case 'kll':
    case 'tdigest': {
      const config =
        a.kind === 'gk'
          ? ({ kind: 'gk', epsilon: a.epsilon } as const)
          : a.kind === 'kll'
            ? ({ kind: 'kll', k: a.k } as const)
            : ({ kind: 'tdigest', compression: a.compression, scale: a.scale } as const);
      const r = streamingSketchSpec(config);
      return r.ok ? ok(r.value) : err(fromConfigError(r.error, algorithmField(index, ['epsilon', 'k', 'compression', 'scale'])));
    }
    case 'ddsketch': {
      const r = ddsketchSpec({ alpha: a.alpha, maxBuckets: a.maxBuckets });
      return r.ok ? ok(r.value) : err(fromConfigError(r.error, relativeCompareFieldMap(index)));
    }
    case 'hdr': {
      const r = hdrSpec({ ...hdrRange, significantDigits: a.significantDigits });
      return r.ok ? ok(r.value) : err(fromConfigError(r.error, relativeCompareFieldMap(index)));
    }
  }
}

export function runCompare(c: CompareCondition): Result<CompareResult, JobFailure> {
  const n = c.data.count;
  const counts = countGrid(n);

  // 件数ごとのデータ(最大の件数 n のデータは詳細と範囲の決定にも使う)
  const datasets = new Map<number, Float64Array>();
  for (const count of counts) {
    const g = generate({ ...c.data, count });
    if (!g.ok) return err(invalid(fromGenerateError(g.error, 'data.distribution')));
    datasets.set(count, g.value);
  }
  const current = datasets.get(n) as Float64Array;

  // HDR の範囲と、実行する有効桁数
  const hdrDigits = c.algorithms.flatMap((a) => (a.kind === 'hdr' ? [a.significantDigits] : []));
  const planned = planHdr(c.hdrRange, dataExtent(current), hdrDigits.length > 0 ? hdrDigits : [2]);
  if (!planned.ok) return err(invalid(planned.error));
  const hdrPlan = planned.value;

  // 総数の上限を超える有効桁数の HDR は計測条件に並べない(8.8)
  const excludedDigits = new Set(hdrPlan.excluded.map((e) => e.significantDigits));
  const kept = c.algorithms
    .map((algorithm, index) => ({ algorithm, index }))
    .filter(({ algorithm }) => !(algorithm.kind === 'hdr' && excludedDigits.has(algorithm.significantDigits)));

  // HDR の項を含めた計算量の再判定
  const estimate = estimateWork(
    { kind: 'compare', condition: { ...c, algorithms: kept.map((k) => k.algorithm) } },
    { totalBuckets: new Map(hdrPlan.included.map((i) => [i.significantDigits, i.totalBuckets])) },
  );
  if (!estimate.withinLimit) return err({ kind: 'over-limit', estimate });

  const meta = {
    distribution: c.data.distribution.kind,
    order: c.data.order,
    hdrLowest: hdrPlan.range.lowest,
    hdrHighest: hdrPlan.range.highest,
  };
  const conditionFor = (count: number, quantiles: readonly number[]): Result<BenchmarkInput, FieldIssue> => {
    const data = datasets.get(count) as Float64Array;
    const extent = dataExtent(data);
    const sketches: SketchSpec[] = [];
    for (const { algorithm, index } of kept) {
      const s = buildSpec(algorithm, index, extent, hdrPlan.range);
      if (!s.ok) return err(s.error);
      sketches.push(s.value);
    }
    return ok({ data, quantiles, sketches, seed: c.data.seed, referenceDefinition: REFERENCE_DEFINITION, meta });
  };

  const countInputs: BenchmarkInput[] = [];
  for (const count of counts) {
    const input = conditionFor(count, SUMMARY_QUANTILES);
    if (!input.ok) return err(invalid(input.error));
    countInputs.push(input.value);
  }
  const detailInput = conditionFor(n, DETAIL_QUANTILES);
  if (!detailInput.ok) return err(invalid(detailInput.error));

  const countSweep = runSweep(countInputs);
  if (!countSweep.ok) return err(invalid(fromHarnessError(countSweep.error)));
  const detail = runSweep([detailInput.value]);
  if (!detail.ok) return err(invalid(fromHarnessError(detail.error)));

  return ok({ kind: 'compare', hdrRange: hdrPlan.range, hdrPlan, countSweep: countSweep.value, detail: detail.value });
}
