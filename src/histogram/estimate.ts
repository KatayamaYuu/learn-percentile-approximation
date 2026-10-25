import { nearestRank, type OperationCounter } from '../core';

export interface EstimateInput {
  /** 長さ バケット数 + 1。狭義単調増加 */
  readonly boundaries: Float64Array;
  /** バケットごとの件数 */
  readonly counts: Float64Array;
  /** counts の合計。1 以上 */
  readonly total: number;
  /** 0 以上 1 以下 */
  readonly quantile: number;
  readonly counter: OperationCounter;
}

/**
 * バケットの件数列から、分位点を線形補間で推定する。
 * 目標順位は最近順位法の丸め規則(誤差指標と同じ)で決め、累積件数が初めてそれ以上になるバケットを選ぶ。
 * 選んだバケットの下側から上側の境界までを、連続の目標順位(件数 × 分位点を、そのバケットが覆う順位の範囲に収めた値)の
 * 位置で補間する。調べたバケットごとに比較を 1 回数える。移動、累積の加算、補間の四則演算は数えない。
 */
export function estimateQuantile(input: EstimateInput): number {
  const { boundaries, counts, total, quantile, counter } = input;
  const k = nearestRank(total, quantile);
  let prev = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]!;
    const cum = prev + count;
    counter.compare();
    if (cum >= k) {
      // prev < k <= cum なので count は 1 以上
      const r = Math.min(Math.max(total * quantile, prev), cum);
      const lower = boundaries[i]!;
      const upper = boundaries[i + 1]!;
      const estimate = lower + (upper - lower) * ((r - prev) / count);
      return Math.min(Math.max(estimate, lower), upper);
    }
    prev = cum;
  }
  throw new Error('total が counts の合計と一致しません');
}
