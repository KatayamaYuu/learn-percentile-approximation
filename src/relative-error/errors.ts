import type { GenerateError, HarnessError } from '../core';

/**
 * 設定が不正。field は設定の項目名をそのまま入れる
 * ('alpha'、'maxBuckets'、'lowest'、'highest'、'significantDigits' のいずれか。添字や接頭辞は付けない)。
 * reason は人が読む説明で、分岐には使わない。
 */
export type ConfigError = {
  readonly kind: 'invalid-config';
  readonly field: string;
  readonly reason: string;
};

export type RelativeErrorExperimentError =
  | ConfigError
  /**
   * field は RelativeErrorExperimentSpec の項目名
   * ('cases'、'counts'、'quantiles'、'alphas'、'maxBucketsList'、'significantDigitsList' のいずれか)。
   */
  | { readonly kind: 'invalid-experiment'; readonly field: string; readonly reason: string }
  | { readonly kind: 'generate'; readonly error: GenerateError }
  | { readonly kind: 'harness'; readonly error: HarnessError };
