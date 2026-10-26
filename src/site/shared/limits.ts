// サイトの上限と、上流の定数の書き写し。
// 共有層はメインの bundle に入るので、上流は型だけを import し、値は実行時に import しない(11.5)。
// 書き写した値が上流の公開入口の値と等しいことは limits.test.ts が確かめる。
import type { ScaleFunctionKind } from '../../streaming';

export interface IntRange {
  readonly min: number;
  readonly max: number;
}

/** データの件数(整数) */
export const COUNT_RANGE: IntRange = { min: 100, max: 1_000_000 };
/** 乱数のシード(整数)。2^32 − 1 まで */
export const SEED_RANGE: IntRange = { min: 0, max: 2 ** 32 - 1 };
/** ストリーミングの試行の回数(整数) */
export const TRIALS_RANGE: IntRange = { min: 1, max: 10 };
/** 1 回の計算で許す仕事量の上限(件数 × sketch の数などの合計) */
export const WORK_LIMIT = 40_000_000;
/** HDR の有効桁数(整数) */
export const SIGNIFICANT_DIGITS_RANGE: IntRange = { min: 0, max: 5 };
/** DDSketch の α は 0 < α < 1(両端を含まない) */
export const ALPHA_BOUNDS = { exclusiveMin: 0, exclusiveMax: 1 } as const;

// ---- 上流の定数の書き写し(値は独自に決めない) ----
/** streaming の EPSILON_RANGE */
export const EPSILON_RANGE = { min: 0.0001, max: 0.5 } as const;
/** streaming の K_RANGE */
export const K_RANGE = { min: 8, max: 65536 } as const;
/** streaming の COMPRESSION_RANGE */
export const COMPRESSION_RANGE = { min: 10, max: 10000 } as const;
/** streaming の SCALE_FUNCTIONS */
export const SCALE_FUNCTIONS: readonly ScaleFunctionKind[] = ['k0', 'k1', 'k2'];
/** histogram の MAX_BUCKETS */
export const MAX_BUCKETS = 100_000;
/** relative-error の DEFAULT_MAX_BUCKETS */
export const DEFAULT_MAX_BUCKETS = 2048;
/** relative-error の MAX_DD_BUCKETS */
export const MAX_DD_BUCKETS = 100_000;
/** relative-error の MAX_HDR_BUCKETS */
export const MAX_HDR_BUCKETS = 2 ** 22;

/** 書き写した上流の定数の一覧(テストで上流の値と比べる) */
export const UPSTREAM_COPY = {
  EPSILON_RANGE,
  K_RANGE,
  COMPRESSION_RANGE,
  SCALE_FUNCTIONS,
  MAX_BUCKETS,
  DEFAULT_MAX_BUCKETS,
  MAX_DD_BUCKETS,
  MAX_HDR_BUCKETS,
} as const;
