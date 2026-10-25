import { nearestRank, type OperationCounter } from '../core';

/**
 * 最近順位法の目標順位 k を含むスロット(累積件数が初めて k 以上になる位置)を返す。
 * 調べたスロットごとに比較を 1 回数える。移動と累積の加算は数えない。
 * 前提: total >= 1、total は counts の合計、quantile は 0 以上 1 以下。前提に反して見つからなければ例外を投げる。
 */
export function selectSlot(
  counts: ArrayLike<number>,
  total: number,
  quantile: number,
  counter: OperationCounter,
): number {
  const rank = nearestRank(total, quantile);
  let cumulative = 0;
  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i]!;
    counter.compare();
    if (cumulative >= rank) return i;
  }
  throw new Error(`目標順位 ${rank} のスロットが見つかりません(総件数 ${total})`);
}
