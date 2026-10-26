// 誤差の指標と分位点の選択(7.2)。上流の問い合わせの記録の値をそのまま読み、計算し直さない(7.7)。
import type { QueryRecord } from '../../core';

export type ErrorMetric = 'absolute' | 'rank' | 'relative';
export type QuantilePick = { readonly kind: 'at'; readonly quantile: number } | { readonly kind: 'max' };
export interface ErrorSelection {
  readonly metric: ErrorMetric;
  readonly pick: QuantilePick;
}

/** 既定: 順位誤差・全分位点の最大(相対誤差型のページは呼び出し側で相対誤差・最大にする) */
export const DEFAULT_ERROR_SELECTION: ErrorSelection = { metric: 'rank', pick: { kind: 'max' } };

const FIELD = {
  absolute: 'absoluteError',
  rank: 'rankError',
  relative: 'relativeError',
} as const satisfies Record<ErrorMetric, keyof QueryRecord>;

/** QueryRecord の absoluteError / rankError / relativeError をそのまま読む。'max' は queries の最大値。該当する分位点がなければ null */
export function pickError(queries: readonly QueryRecord[], selection: ErrorSelection): number | null {
  const field = FIELD[selection.metric];
  const { pick } = selection;
  if (pick.kind === 'at') {
    const hit = queries.find((q) => q.quantile === pick.quantile);
    return hit === undefined ? null : hit[field];
  }
  if (queries.length === 0) return null;
  let max = queries[0]![field];
  for (const q of queries) if (q[field] > max) max = q[field];
  return max;
}

export function metricLabel(metric: ErrorMetric): string {
  switch (metric) {
    case 'absolute':
      return '絶対誤差';
    case 'rank':
      return '順位誤差';
    case 'relative':
      return '相対誤差';
  }
}
