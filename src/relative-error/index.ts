// 唯一の公開入口。後続 spec はここだけを import する。内部の補助(selectSlot、CollapsingStore)は再エクスポートしない。

// 写像と構造
export { createLogMapping, type LogMapping } from './log-mapping';
export { createHdrLayout, MAX_HDR_BUCKETS, type HdrConfig, type HdrLayout } from './hdr-layout';

// DDSketch
export {
  createDDSketch,
  ddsketchSpec,
  DEFAULT_MAX_BUCKETS,
  MAX_DD_BUCKETS,
  type DDSketch,
  type DDSketchOptions,
  type DDSketchSnapshot,
} from './ddsketch';

// HDR Histogram
export { createHdrHistogram, hdrSpec, type HdrHistogram, type HdrSnapshot } from './hdr-histogram';

// 観察・識別の共有型
export type { BucketView, SketchSpecOptions } from './snapshot';

// 実験
export {
  runRelativeErrorExperiment,
  type BucketStatsRecord,
  type HdrRange,
  type RelativeErrorCase,
  type RelativeErrorExperimentResult,
  type RelativeErrorExperimentSpec,
} from './experiment';

// エラー
export type { ConfigError, RelativeErrorExperimentError } from './errors';
