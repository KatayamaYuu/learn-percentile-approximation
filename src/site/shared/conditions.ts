// 実験の条件の型と既定値。すべて JSON にでき、postMessage で送れる平坦な値と配列からなる。
import type { DataOrder, Distribution } from '../../core';
import type { ScaleFunctionKind } from '../../streaming';
import { DEFAULT_MAX_BUCKETS } from './limits';

export interface DataCondition {
  readonly distribution: Distribution;
  readonly count: number;
  readonly seed: number;
  readonly order: DataOrder;
}

export type HistogramRangeMode =
  | { readonly kind: 'data-extent' }
  | { readonly kind: 'fixed'; readonly lower: number; readonly upper: number };

export interface HistogramPageCondition {
  readonly data: DataCondition;
  /** 既定 32 */
  readonly buckets: number;
  /** 既定 ['equal', 'exponential'] */
  readonly schemes: readonly ('equal' | 'exponential')[];
  readonly range: HistogramRangeMode;
}

export type StreamingMethod = 'gk' | 'kll' | 'tdigest';

export interface StreamingPageCondition {
  readonly data: DataCondition;
  /** 既定 ['gk', 'kll', 'tdigest'] */
  readonly methods: readonly StreamingMethod[];
  /** 既定 0.01 */
  readonly epsilon: number;
  /** 既定 200 */
  readonly k: number;
  /** 既定 100 */
  readonly compression: number;
  /** 既定 ['k1'] */
  readonly scales: readonly ScaleFunctionKind[];
  /** 既定 1 */
  readonly trials: number;
  /** 内部状態を表示する手法。既定 'gk'。t-digest は scales の先頭を使う */
  readonly inspectTarget: StreamingMethod;
}

export type HdrRangeMode =
  | { readonly kind: 'auto' }
  | { readonly kind: 'manual'; readonly lowest: number; readonly highest: number };

export interface RelativePageCondition {
  readonly data: DataCondition;
  /** 既定 ['ddsketch', 'hdr'] */
  readonly methods: readonly ('ddsketch' | 'hdr')[];
  /** 既定 0.01 */
  readonly alpha: number;
  /** 既定 DEFAULT_MAX_BUCKETS(2048) */
  readonly maxBuckets: number;
  /** 既定 2 */
  readonly significantDigits: number;
  readonly hdrRange: HdrRangeMode;
  /** 既定 'ddsketch' */
  readonly inspectTarget: 'ddsketch' | 'hdr';
}

export type CompareAlgorithm =
  | { readonly kind: 'exact-sort' }
  | { readonly kind: 'exact-quickselect' }
  | { readonly kind: 'histogram'; readonly scheme: 'equal' | 'exponential'; readonly buckets: number }
  | { readonly kind: 'gk'; readonly epsilon: number }
  | { readonly kind: 'kll'; readonly k: number }
  | { readonly kind: 'tdigest'; readonly compression: number; readonly scale: ScaleFunctionKind }
  | { readonly kind: 'ddsketch'; readonly alpha: number; readonly maxBuckets: number }
  | { readonly kind: 'hdr'; readonly significantDigits: number };

export interface CompareCondition {
  readonly data: DataCondition;
  /** 既定: 厳密解(整列)、ヒストグラム(指数幅, 64)、GK(0.01)、KLL(200)、t-digest(100, k1)、DDSketch(0.01, 2048)、HDR(2) */
  readonly algorithms: readonly CompareAlgorithm[];
  readonly hdrRange: HdrRangeMode;
}

export type PageId = 'home' | 'histogram' | 'streaming' | 'relative' | 'compare';

/** 条件を持つページと条件の型の対応(ConditionStore が使う) */
export interface PageConditionMap {
  readonly histogram: HistogramPageCondition;
  readonly streaming: StreamingPageCondition;
  readonly relative: RelativePageCondition;
  readonly compare: CompareCondition;
}

/** 分布の種類 */
export type DistributionKind = Distribution['kind'];

/** 分布のプリセット: 種類ごとの既定のパラメータ。多峰の山は 2 個に固定する */
export const DISTRIBUTION_PRESETS: { readonly [K in DistributionKind]: Extract<Distribution, { kind: K }> } = {
  uniform: { kind: 'uniform', min: 1, max: 1000 },
  normal: { kind: 'normal', mean: 100, stdDev: 15 },
  lognormal: { kind: 'lognormal', mu: 0, sigma: 1 },
  'heavy-tail': { kind: 'heavy-tail', scale: 1, shape: 1.5 },
  multimodal: {
    kind: 'multimodal',
    modes: [
      { weight: 1, mean: 50, stdDev: 5 },
      { weight: 1, mean: 200, stdDev: 20 },
    ],
  },
};

export const DEFAULT_DATA: DataCondition = {
  distribution: DISTRIBUTION_PRESETS.lognormal,
  count: 10_000,
  seed: 1,
  order: 'random',
};

export const DEFAULT_HISTOGRAM: HistogramPageCondition = {
  data: DEFAULT_DATA,
  buckets: 32,
  schemes: ['equal', 'exponential'],
  range: { kind: 'data-extent' },
};

export const DEFAULT_STREAMING: StreamingPageCondition = {
  data: DEFAULT_DATA,
  methods: ['gk', 'kll', 'tdigest'],
  epsilon: 0.01,
  k: 200,
  compression: 100,
  scales: ['k1'],
  trials: 1,
  inspectTarget: 'gk',
};

export const DEFAULT_RELATIVE: RelativePageCondition = {
  data: DEFAULT_DATA,
  methods: ['ddsketch', 'hdr'],
  alpha: 0.01,
  maxBuckets: DEFAULT_MAX_BUCKETS,
  significantDigits: 2,
  hdrRange: { kind: 'auto' },
  inspectTarget: 'ddsketch',
};

export const DEFAULT_COMPARE: CompareCondition = {
  data: DEFAULT_DATA,
  algorithms: [
    { kind: 'exact-sort' },
    { kind: 'histogram', scheme: 'exponential', buckets: 64 },
    { kind: 'gk', epsilon: 0.01 },
    { kind: 'kll', k: 200 },
    { kind: 'tdigest', compression: 100, scale: 'k1' },
    { kind: 'ddsketch', alpha: 0.01, maxBuckets: DEFAULT_MAX_BUCKETS },
    { kind: 'hdr', significantDigits: 2 },
  ],
  hdrRange: { kind: 'auto' },
};

/** ページごとの既定の条件 */
export const PAGE_DEFAULTS: PageConditionMap = {
  histogram: DEFAULT_HISTOGRAM,
  streaming: DEFAULT_STREAMING,
  relative: DEFAULT_RELATIVE,
  compare: DEFAULT_COMPARE,
};
