export type InvalidValueReason = 'not-a-number' | 'not-finite' | 'not-positive';

export type SketchError =
  | { readonly kind: 'invalid-value'; readonly reason: InvalidValueReason }
  | { readonly kind: 'quantile-out-of-range' }
  | { readonly kind: 'empty' }
  // 有限の正の数だが、アルゴリズムが扱える範囲の外。detail は人が読む説明で、分岐には使わない
  | { readonly kind: 'unsupported-value'; readonly detail: string };

export type GenerateError =
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-seed' }
  | { readonly kind: 'invalid-parameter'; readonly field: string; readonly reason: string }
  | { readonly kind: 'non-finite-sample' };

export type MetricError =
  | { readonly kind: 'empty-data' }
  | { readonly kind: 'invalid-value'; readonly field: 'estimate' | 'exact' | 'data' }
  | { readonly kind: 'invalid-quantile' };

export type HarnessError =
  | { readonly kind: 'invalid-data'; readonly reason: InvalidValueReason | 'empty' }
  | { readonly kind: 'invalid-quantile' }
  | { readonly kind: 'no-sketches' }
  // params または meta に JSON にできない値がある
  | { readonly kind: 'invalid-params'; readonly field: string };
