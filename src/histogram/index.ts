// 唯一の公開入口。後続 spec はここだけを import する。内部の補助関数は再エクスポートしない。

// 境界
export { buildBoundaries, MAX_BUCKETS, type BucketScheme } from './boundaries';

// ヒストグラム
export { createHistogram, histogramSpec, type HistogramSpecOptions } from './histogram';

// 実験
export {
  runBucketExperiment,
  type BucketExperimentResult,
  type BucketExperimentSpec,
  type BucketRange,
  type ExperimentCase,
  type ExperimentSchemeKind,
  type FixedRange,
} from './experiment';

// エラー
export type { ExperimentError, SchemeError } from './errors';
