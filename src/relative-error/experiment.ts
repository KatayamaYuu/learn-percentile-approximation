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
import { hdrSpec } from './hdr-histogram';
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

/** 検証済みの設定から、厳密解 2 方式 → DDSketch → HDR の順に SketchSpec を並べる */
function buildSketches(spec: RelativeErrorExperimentSpec, hdrRange: HdrRange): SketchSpec[] {
  const exactOptions = spec.referenceDefinition === undefined ? undefined : { definition: spec.referenceDefinition };
  const sketches: SketchSpec[] = [sortExactSpec(exactOptions), quickselectExactSpec(exactOptions)];
  for (const alpha of ascending(spec.alphas)) {
    for (const maxBuckets of ascending(spec.maxBucketsList)) {
      const s = ddsketchSpec({ alpha, maxBuckets });
      if (!s.ok) throw new Error('検証済みの DDSketch 設定が不正です');
      sketches.push(s.value);
    }
  }
  for (const significantDigits of ascending(spec.significantDigitsList)) {
    const s = hdrSpec({ ...hdrRange, significantDigits });
    if (!s.ok) throw new Error('検証済みの HDR 設定が不正です');
    sketches.push(s.value);
  }
  return sketches;
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
      conditions.push({
        data: generated.value,
        quantiles: spec.quantiles,
        sketches: buildSketches(spec, experimentCase.hdrRange),
        seed: spec.seed,
        ...(spec.referenceDefinition === undefined ? {} : { referenceDefinition: spec.referenceDefinition }),
        meta,
      });
    }
    const sweep = runSweep(conditions);
    if (!sweep.ok) return err({ kind: 'harness', error: sweep.error });
    cases.push({ label: experimentCase.label, sweep: sweep.value, bucketStats: [] });
  }
  return ok({ schemaVersion: 1, cases });
}
