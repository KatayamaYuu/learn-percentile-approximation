import {
  err,
  generate,
  ok,
  quickselectExactSpec,
  runSweep,
  sortExactSpec,
  type BenchmarkInput,
  type DataOrder,
  type Distribution,
  type ParamRecord,
  type PercentileDefinition,
  type Result,
  type SketchSpec,
  type SweepResult,
} from '../core';
import { createDDSketch, ddsketchSpec } from './ddsketch';
import type { RelativeErrorExperimentError } from './errors';
import { createHdrHistogram, hdrSpec } from './hdr-histogram';
import { createHdrLayout } from './hdr-layout';

export interface HdrRange {
  readonly lowest: number;
  readonly highest: number;
}

export interface RelativeErrorCase {
  /** ケースの識別。実験内で重複させない */
  readonly label: string;
  readonly distribution: Distribution;
  /** このケースの HDR Histogram の L と H */
  readonly hdrRange: HdrRange;
}

export interface RelativeErrorExperimentSpec {
  readonly cases: readonly RelativeErrorCase[];
  readonly counts: readonly number[];
  readonly seed: number;
  readonly order?: DataOrder;
  readonly quantiles: readonly number[];
  readonly alphas: readonly number[];
  /** DDSketch の m の一覧。設定の項目名 maxBuckets と区別するため List を付ける */
  readonly maxBucketsList: readonly number[];
  /** HDR Histogram の有効桁数の一覧。設定の項目名 significantDigits と区別するため List を付ける */
  readonly significantDigitsList: readonly number[];
  /** 厳密解の定義。省略時は core の既定。上限の検証には 'nearest-rank' を指定する */
  readonly referenceDefinition?: PercentileDefinition;
}

export type BucketStatsRecord =
  | {
      readonly status: 'ok';
      readonly count: number;
      readonly sketchId: string;
      /** DDSketch は保持範囲の長さ、HDR はバケットの総数 */
      readonly bucketCount: number;
      readonly nonEmptyBuckets: number;
      /** DDSketch は縮約の有無、HDR は null */
      readonly collapsed: boolean | null;
    }
  | { readonly status: 'rejected'; readonly count: number; readonly sketchId: string };

export interface RelativeErrorExperimentResult {
  readonly schemaVersion: 1;
  readonly cases: readonly {
    readonly label: string;
    readonly sweep: SweepResult;
    readonly bucketStats: readonly BucketStatsRecord[];
  }[];
}

const invalid = (field: string, reason: string): RelativeErrorExperimentError => ({
  kind: 'invalid-experiment',
  field,
  reason,
});

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** 実験条件と、すべての設定を検証する(データ生成より前)。最初の 1 件を返す */
function validateSpec(spec: RelativeErrorExperimentSpec): RelativeErrorExperimentError | undefined {
  const lists = ['cases', 'counts', 'quantiles', 'alphas', 'maxBucketsList', 'significantDigitsList'] as const;
  for (const field of lists) {
    const list: unknown = spec[field];
    if (!Array.isArray(list) || list.length === 0) return invalid(field, '1 個以上の要素が必要です');
  }
  const labels = new Set<string>();
  for (let i = 0; i < spec.cases.length; i++) {
    const label = spec.cases[i]!.label;
    if (typeof label !== 'string' || label === '') return invalid('cases', `cases[${i}] の label は空でない文字列が必要です`);
    if (labels.has(label)) return invalid('cases', `label ${label} が重複しています`);
    labels.add(label);
  }
  for (const field of ['alphas', 'maxBucketsList', 'significantDigitsList'] as const) {
    if (new Set(spec[field]).size !== spec[field].length) return invalid(field, '重複があります');
  }
  for (const alpha of spec.alphas) {
    for (const maxBuckets of spec.maxBucketsList) {
      const r = createDDSketch({ alpha, maxBuckets });
      if (!r.ok) return { ...r.error, reason: `alpha=${alpha}, maxBuckets=${maxBuckets}: ${r.error.reason}` };
    }
  }
  for (const c of spec.cases) {
    for (const significantDigits of spec.significantDigitsList) {
      const r = createHdrLayout({ ...c.hdrRange, significantDigits });
      if (!r.ok) {
        return { ...r.error, reason: `ケース ${c.label}, significantDigits=${significantDigits}: ${r.error.reason}` };
      }
    }
  }
  return undefined;
}

/** 観察用のインスタンスに全件を投入し、バケットの統計を作る(1 件でも拒否されたら rejected) */
type BucketObserver = (data: Float64Array, count: number) => BucketStatsRecord;

interface Plan {
  readonly sketches: SketchSpec[];
  /** sketches のうち厳密解を除いた並びに対応する */
  readonly observers: BucketObserver[];
}

/** 検証済みの設定から、厳密解 2 方式 → DDSketch → HDR の順に SketchSpec と観察用の関数を並べる */
function buildPlan(spec: RelativeErrorExperimentSpec, hdrRange: HdrRange): Plan {
  const exactOptions = spec.referenceDefinition === undefined ? undefined : { definition: spec.referenceDefinition };
  const sketches: SketchSpec[] = [sortExactSpec(exactOptions), quickselectExactSpec(exactOptions)];
  const observers: BucketObserver[] = [];
  for (const alpha of ascending(spec.alphas)) {
    for (const maxBuckets of ascending(spec.maxBucketsList)) {
      const s = ddsketchSpec({ alpha, maxBuckets });
      if (!s.ok) throw new Error('検証済みの DDSketch 設定が不正です');
      sketches.push(s.value);
      const sketchId = s.value.id;
      observers.push((data, count) => {
        // 乱数を使わないので、ハーネス内のインスタンスと同じ状態になる
        const sketch = createDDSketch({ alpha, maxBuckets });
        if (!sketch.ok) throw new Error('検証済みの DDSketch 設定が不正です');
        for (const x of data) if (!sketch.value.insert(x).ok) return { status: 'rejected', count, sketchId };
        const snap = sketch.value.inspect();
        return {
          status: 'ok',
          count,
          sketchId,
          bucketCount: snap.span,
          nonEmptyBuckets: snap.nonEmptyBuckets,
          collapsed: snap.collapsed,
        };
      });
    }
  }
  for (const significantDigits of ascending(spec.significantDigitsList)) {
    const config = { ...hdrRange, significantDigits };
    const s = hdrSpec(config);
    if (!s.ok) throw new Error('検証済みの HDR 設定が不正です');
    sketches.push(s.value);
    const sketchId = s.value.id;
    observers.push((data, count) => {
      const sketch = createHdrHistogram(config);
      if (!sketch.ok) throw new Error('検証済みの HDR 設定が不正です');
      for (const x of data) if (!sketch.value.insert(x).ok) return { status: 'rejected', count, sketchId };
      const snap = sketch.value.inspect();
      return {
        status: 'ok',
        count,
        sketchId,
        bucketCount: snap.totalBuckets,
        nonEmptyBuckets: snap.nonEmptyBuckets,
        collapsed: null,
      };
    });
  }
  return { sketches, observers };
}

/**
 * 分布・件数・設定を変えた計測条件を作り、core のハーネスで実行する。
 * 各条件には、厳密解 2 方式とすべての DDSketch・HDR Histogram を同じ入力として並べる。
 * HDR の範囲がデータを覆わない場合は、その HDR だけが投入段階のエラーとして記録される。
 * 検証 → 生成 → ハーネスの順に行い、最初のエラーを返す(部分的な結果は返さない)。
 */
export function runRelativeErrorExperiment(
  spec: RelativeErrorExperimentSpec,
): Result<RelativeErrorExperimentResult, RelativeErrorExperimentError> {
  const problem = validateSpec(spec);
  if (problem) return err(problem);

  const order = spec.order ?? 'random';
  const cases: RelativeErrorExperimentResult['cases'][number][] = [];

  for (const experimentCase of spec.cases) {
    const conditions: BenchmarkInput[] = [];
    const statsByCondition: { readonly count: number; readonly stats: BucketStatsRecord[] }[] = [];
    for (const count of spec.counts) {
      const generated = generate({ distribution: experimentCase.distribution, count, seed: spec.seed, order });
      if (!generated.ok) return err({ kind: 'generate', error: generated.error });
      const meta: ParamRecord = {
        case: experimentCase.label,
        distribution: experimentCase.distribution.kind,
        order,
        hdrLowest: experimentCase.hdrRange.lowest,
        hdrHighest: experimentCase.hdrRange.highest,
      };
      const plan = buildPlan(spec, experimentCase.hdrRange);
      statsByCondition.push({ count, stats: plan.observers.map((observe) => observe(generated.value, count)) });
      conditions.push({
        data: generated.value,
        quantiles: spec.quantiles,
        sketches: plan.sketches,
        seed: spec.seed,
        ...(spec.referenceDefinition === undefined ? {} : { referenceDefinition: spec.referenceDefinition }),
        meta,
      });
    }
    const sweep = runSweep(conditions);
    if (!sweep.ok) return err({ kind: 'harness', error: sweep.error });
    // ハーネスの結果(件数の昇順、同じ件数は入力の並び)と同じ並びにそろえる。Array.prototype.sort は安定
    statsByCondition.sort((a, b) => a.count - b.count);
    cases.push({
      label: experimentCase.label,
      sweep: sweep.value,
      bucketStats: statsByCondition.flatMap((c) => c.stats),
    });
  }
  return ok({ schemaVersion: 1, cases });
}
