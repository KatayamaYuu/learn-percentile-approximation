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
import type { BucketScheme } from './boundaries';
import type { ExperimentError } from './errors';
import { histogramSpec } from './histogram';

/** ヒストグラムが扱える値の範囲(下限以上、上限以下) */
export interface FixedRange {
  readonly lower: number;
  readonly upper: number;
}

export type BucketRange = FixedRange;

export interface ExperimentCase {
  /** ケースの識別。実験内で重複させない */
  readonly label: string;
  readonly distribution: Distribution;
  readonly range: BucketRange;
}

export type ExperimentSchemeKind = 'equal' | 'exponential';

export interface BucketExperimentSpec {
  readonly cases: readonly ExperimentCase[];
  /** データ件数の一覧 */
  readonly counts: readonly number[];
  readonly seed: number;
  readonly order?: DataOrder;
  readonly quantiles: readonly number[];
  /** バケット数の一覧 */
  readonly bucketCounts: readonly number[];
  readonly schemes: readonly ExperimentSchemeKind[];
  /** 厳密解の定義。省略時は core の既定 */
  readonly referenceDefinition?: PercentileDefinition;
}

export interface BucketExperimentResult {
  readonly schemaVersion: 1;
  readonly cases: readonly { readonly label: string; readonly sweep: SweepResult }[];
}

const SCHEME_KINDS: readonly ExperimentSchemeKind[] = ['equal', 'exponential'];

const invalid = (field: string, reason: string): ExperimentError => ({
  kind: 'invalid-experiment',
  field,
  reason,
});

function validateSpec(spec: BucketExperimentSpec): ExperimentError | undefined {
  for (const field of ['cases', 'counts', 'bucketCounts', 'schemes'] as const) {
    const list: unknown = spec[field];
    if (!Array.isArray(list) || list.length === 0) return invalid(field, '1 個以上の要素が必要です');
  }
  const labels = new Set<string>();
  for (let i = 0; i < spec.cases.length; i++) {
    const label = spec.cases[i]!.label;
    if (typeof label !== 'string' || label === '') return invalid(`cases[${i}].label`, '空でない文字列が必要です');
    if (labels.has(label)) return invalid(`cases[${i}].label`, `識別 ${label} が重複しています`);
    labels.add(label);
  }
  for (const kind of spec.schemes) {
    if (!SCHEME_KINDS.includes(kind)) return invalid('schemes', 'equal / exponential のいずれかです');
  }
  if (new Set(spec.schemes).size !== spec.schemes.length) return invalid('schemes', '重複しています');
  for (const b of spec.bucketCounts) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 1) {
      return invalid('bucketCounts', 'すべて 1 以上の整数である必要があります');
    }
  }
  if (new Set(spec.bucketCounts).size !== spec.bucketCounts.length) return invalid('bucketCounts', '重複しています');
  return undefined;
}

function buildSketches(
  spec: BucketExperimentSpec,
  range: FixedRange,
  bucketCounts: readonly number[],
): Result<SketchSpec[], ExperimentError> {
  const exactOptions = spec.referenceDefinition === undefined ? undefined : { definition: spec.referenceDefinition };
  const sketches: SketchSpec[] = [sortExactSpec(exactOptions), quickselectExactSpec(exactOptions)];
  for (const kind of spec.schemes) {
    for (const buckets of bucketCounts) {
      const scheme: BucketScheme = { kind, lower: range.lower, upper: range.upper, buckets };
      const h = histogramSpec(scheme);
      if (!h.ok) return err(h.error);
      sketches.push(h.value);
    }
  }
  return ok(sketches);
}

/**
 * 分布・データ件数・バケット数・境界の決め方を変えた計測条件を作り、core のハーネスで実行する。
 * 各条件には、厳密解 2 方式とすべてのヒストグラムを同じ入力として並べる。
 * 固定の範囲がデータを覆わない場合は、そのヒストグラムだけが投入段階のエラーとして記録される。
 * 検証 → 生成 → 境界の生成 → ハーネスの順に行い、最初のエラーを返す(部分的な結果は返さない)。
 */
export function runBucketExperiment(
  spec: BucketExperimentSpec,
): Result<BucketExperimentResult, ExperimentError> {
  const problem = validateSpec(spec);
  if (problem) return err(problem);

  const bucketCounts = [...spec.bucketCounts].sort((a, b) => a - b);
  const order = spec.order ?? 'random';
  const cases: { label: string; sweep: SweepResult }[] = [];

  for (const experimentCase of spec.cases) {
    const conditions: BenchmarkInput[] = [];
    for (const count of spec.counts) {
      const generated = generate({ distribution: experimentCase.distribution, count, seed: spec.seed, order });
      if (!generated.ok) return err({ kind: 'generate', error: generated.error });
      const sketches = buildSketches(spec, experimentCase.range, bucketCounts);
      if (!sketches.ok) return err(sketches.error);
      const meta: ParamRecord = {
        case: experimentCase.label,
        distribution: experimentCase.distribution.kind,
        order,
        rangeMode: 'fixed',
      };
      conditions.push({
        data: generated.value,
        quantiles: spec.quantiles,
        sketches: sketches.value,
        seed: spec.seed,
        ...(spec.referenceDefinition === undefined ? {} : { referenceDefinition: spec.referenceDefinition }),
        meta,
      });
    }
    const sweep = runSweep(conditions);
    if (!sweep.ok) return err({ kind: 'harness', error: sweep.error });
    cases.push({ label: experimentCase.label, sweep: sweep.value });
  }
  return ok({ schemaVersion: 1, cases });
}
