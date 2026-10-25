// 唯一の公開入口。後続 spec はここだけを import する。内部の補助関数(整列、スケール関数の上限計算など)は再エクスポートしない。

// GK
export { createGk, EPSILON_RANGE, gkSpec, type GkOptions, type GkSketch, type GkState, type GkTuple } from './gk';

// KLL
export {
  createKll,
  K_RANGE,
  KLL_SHRINK,
  kllSpec,
  type KllLevel,
  type KllOptions,
  type KllSketch,
  type KllState,
} from './kll';

// t-digest
export {
  COMPRESSION_RANGE,
  createTDigest,
  tdigestSpec,
  type Centroid,
  type TDigestOptions,
  type TDigestSketch,
  type TDigestState,
} from './tdigest';

// スケール関数
export { SCALE_FUNCTIONS, type ScaleFunctionKind } from './scale';

// 手法の指定
export { streamingSketchSpec, type StreamingSketchConfig } from './config';

// 実験
export {
  runStreamingExperiment,
  type StreamingExperimentCase,
  type StreamingExperimentResult,
  type StreamingExperimentSpec,
} from './experiment';

// エラー
export type { ConfigError, StreamingExperimentError } from './errors';
