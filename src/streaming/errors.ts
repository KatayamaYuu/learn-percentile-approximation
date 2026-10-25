import type { GenerateError, HarnessError } from '../core';

/** 手法の設定が不正。field は不正な項目(例: 'epsilon'、'k'、'compression'、'scale'、'seed')。reason は人が読む説明で、分岐には使わない */
export type ConfigError = {
  readonly kind: 'invalid-config';
  readonly field: string;
  readonly reason: string;
};

export type StreamingExperimentError =
  | ConfigError
  | { readonly kind: 'invalid-experiment'; readonly field: string; readonly reason: string }
  | { readonly kind: 'generate'; readonly error: GenerateError }
  | { readonly kind: 'harness'; readonly error: HarnessError };
