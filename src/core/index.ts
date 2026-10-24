// 唯一の公開入口。後続 spec はここだけを import する。内部の補助関数は再エクスポートしない。

// 基盤
export { ok, err, type Result } from './foundation/result';
export type {
  InvalidValueReason,
  SketchError,
  GenerateError,
  MetricError,
  HarnessError,
} from './foundation/errors';
export { checkPositiveFinite, isQuantile } from './foundation/validation';

// 乱数
export { createRng, type Rng } from './rng/sfc32';

// コストモデル
export { OperationCounter, type OperationCounts } from './cost/op-counter';
export { BYTES_PER_NUMBER, estimateBytes } from './cost/memory-model';

// パーセンタイル定義と基準値
export {
  DEFAULT_DEFINITION,
  resolvePosition,
  combineOrderStatistics,
  nearestRank,
  type PercentileDefinition,
  type OrderPosition,
} from './quantile/definitions';
export { exactQuantileSorted } from './quantile/reference';

// アルゴリズム共通の契約
export {
  isParamRecord,
  type PercentileSketch,
  type SketchSpec,
  type ParamValue,
  type ParamRecord,
  type SupportedRange,
} from './contract/sketch';

// 厳密解
export { createSortExact, sortExactSpec, type ExactOptions } from './exact/sort-exact';
export { createQuickselectExact, quickselectExactSpec } from './exact/quickselect-exact';

// データ生成
export { generate, type GenerateSpec, type DataOrder } from './data/generate';
export type { Distribution, Mode } from './data/distributions';

// 誤差指標
export { absoluteError, relativeError, rankError } from './metrics/error-metrics';

// 適合確認
export { runConformance, type ConformanceCheck, type ConformanceReport } from './conformance/conformance';

// 計測ハーネス
export { runBenchmark, withoutTiming } from './harness/run-benchmark';
export { runSweep, seriesByAlgorithm } from './harness/run-sweep';
export type {
  BenchmarkInput,
  BenchmarkResult,
  QueryRecord,
  AlgorithmResult,
  AlgorithmErrorKind,
  SweepResult,
  SeriesPoint,
} from './harness/types';
