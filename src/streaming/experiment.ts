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
import { streamingSketchSpec, type StreamingSketchConfig } from './config';
import type { StreamingExperimentError } from './errors';

export interface StreamingExperimentCase {
  /** ケースの識別。実験内で重複させない */
  readonly label: string;
  readonly distribution: Distribution;
}

export interface StreamingExperimentSpec {
  readonly cases: readonly StreamingExperimentCase[];
  /** データ件数の一覧 */
  readonly counts: readonly number[];
  /** データのシード */
  readonly seed: number;
  /** 挿入順序の一覧。省略時は ['random'] */
  readonly orders?: readonly DataOrder[];
  /** 試行のシードの一覧。省略時は [seed] */
  readonly trialSeeds?: readonly number[];
  readonly quantiles: readonly number[];
  readonly sketches: readonly StreamingSketchConfig[];
  /** 厳密解の定義。省略時は core の既定 */
  readonly referenceDefinition?: PercentileDefinition;
}

export interface StreamingExperimentResult {
  readonly schemaVersion: 1;
  /** ケースの順、同じケースの中は orders の順 */
  readonly cases: readonly {
    readonly label: string;
    readonly order: DataOrder;
    readonly sweep: SweepResult;
  }[];
}

const ORDERS: readonly DataOrder[] = ['random', 'ascending', 'descending'];
const SEED_LIMIT = 2 ** 32;

const invalid = (field: string, reason: string): StreamingExperimentError => ({
  kind: 'invalid-experiment',
  field,
  reason,
});

const isNonEmptyArray = (list: unknown): list is readonly unknown[] => Array.isArray(list) && list.length > 0;

/** 設計の順(一覧が空 → 識別 → 挿入順序 → 試行のシード)に検査し、最初の 1 件を返す */
function validateLists(
  spec: StreamingExperimentSpec,
  orders: readonly DataOrder[],
  trialSeeds: readonly number[],
): StreamingExperimentError | undefined {
  for (const field of ['cases', 'counts', 'sketches'] as const) {
    if (!isNonEmptyArray(spec[field])) return invalid(field, '1 個以上の要素が必要です');
  }
  const labels = new Set<string>();
  for (let i = 0; i < spec.cases.length; i++) {
    const label = spec.cases[i]?.label;
    if (typeof label !== 'string' || label === '') return invalid(`cases[${i}].label`, '空でない文字列が必要です');
    if (labels.has(label)) return invalid(`cases[${i}].label`, `識別 ${label} が重複しています`);
    labels.add(label);
  }
  if (!isNonEmptyArray(orders)) return invalid('orders', '1 個以上の要素が必要です');
  for (const order of orders) {
    if (!ORDERS.includes(order)) return invalid('orders', 'random / ascending / descending のいずれかです');
  }
  if (new Set(orders).size !== orders.length) return invalid('orders', '重複しています');
  if (!isNonEmptyArray(trialSeeds)) return invalid('trialSeeds', '1 個以上の要素が必要です');
  for (const s of trialSeeds) {
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s >= SEED_LIMIT) {
      return invalid('trialSeeds', 'すべて 0 以上 2^32 未満の整数である必要があります');
    }
  }
  if (new Set(trialSeeds).size !== trialSeeds.length) return invalid('trialSeeds', '重複しています');
  return undefined;
}

/** 手法の指定を SketchSpec に変換する(1 回だけ)。設定の誤りは項目に位置を加えて返し、識別子の重複を検出する */
function buildSketchSpecs(configs: readonly StreamingSketchConfig[]): Result<SketchSpec[], StreamingExperimentError> {
  const specs: SketchSpec[] = [];
  for (let i = 0; i < configs.length; i++) {
    const r = streamingSketchSpec(configs[i]!);
    if (!r.ok) return err({ ...r.error, field: `sketches[${i}].${r.error.field}` });
    specs.push(r.value);
  }
  const ids = new Set<string>();
  for (const s of specs) {
    if (ids.has(s.id)) return err(invalid('sketches', `識別子 ${s.id} が重複しています(同じ手法・同じパラメータ)`));
    ids.add(s.id);
  }
  return ok(specs);
}

/**
 * 分布・件数・挿入順序・試行のシード・手法を変えた計測条件を作り、core のハーネスで実行する。
 * 各計測条件には、厳密解 2 方式(基準の定義つき)と指定した手法を、この順で同じ入力として並べる。
 * 検証 → 手法の生成仕様(1 回)→ 生成 → ハーネスの順に行い、最初のエラーを返す(部分的な結果は返さない)。
 */
export function runStreamingExperiment(
  spec: StreamingExperimentSpec,
): Result<StreamingExperimentResult, StreamingExperimentError> {
  const orders: readonly DataOrder[] = spec.orders === undefined ? ['random'] : spec.orders;
  const trialSeeds = spec.trialSeeds === undefined ? [spec.seed] : spec.trialSeeds;
  const problem = validateLists(spec, orders, trialSeeds);
  if (problem) return err(problem);

  const built = buildSketchSpecs(spec.sketches);
  if (!built.ok) return err(built.error);
  const exactOptions = spec.referenceDefinition === undefined ? undefined : { definition: spec.referenceDefinition };
  const sketches: SketchSpec[] = [sortExactSpec(exactOptions), quickselectExactSpec(exactOptions), ...built.value];

  const cases: { label: string; order: DataOrder; sweep: SweepResult }[] = [];
  for (const experimentCase of spec.cases) {
    for (const order of orders) {
      const conditions: BenchmarkInput[] = [];
      for (const count of spec.counts) {
        const generated = generate({ distribution: experimentCase.distribution, count, seed: spec.seed, order });
        if (!generated.ok) return err({ kind: 'generate', error: generated.error });
        for (let trial = 0; trial < trialSeeds.length; trial++) {
          const meta: ParamRecord = {
            case: experimentCase.label,
            distribution: experimentCase.distribution.kind,
            order,
            dataSeed: spec.seed,
            trial,
          };
          conditions.push({
            data: generated.value,
            quantiles: spec.quantiles,
            sketches,
            seed: trialSeeds[trial]!,
            ...(spec.referenceDefinition === undefined ? {} : { referenceDefinition: spec.referenceDefinition }),
            meta,
          });
        }
      }
      const sweep = runSweep(conditions);
      if (!sweep.ok) return err({ kind: 'harness', error: sweep.error });
      cases.push({ label: experimentCase.label, order, sweep: sweep.value });
    }
  }
  return ok({ schemaVersion: 1, cases });
}
