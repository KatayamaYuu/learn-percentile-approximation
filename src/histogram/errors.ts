import type { GenerateError, HarnessError } from '../core';

/** 境界の指定が不正。field は不正な項目(例: 'buckets'、'lower'、'boundaries')。reason は人が読む説明で、分岐には使わない */
export type SchemeError = {
  readonly kind: 'invalid-scheme';
  readonly field: string;
  readonly reason: string;
};

export type ExperimentError =
  | SchemeError
  | { readonly kind: 'invalid-experiment'; readonly field: string; readonly reason: string }
  | { readonly kind: 'generate'; readonly error: GenerateError }
  | { readonly kind: 'harness'; readonly error: HarnessError };
