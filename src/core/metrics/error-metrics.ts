import type { MetricError } from '../foundation/errors';
import { err, ok, type Result } from '../foundation/result';
import { checkPositiveFinite, isQuantile } from '../foundation/validation';
import { nearestRank } from '../quantile/definitions';

function checkPair(estimate: number, exact: number): MetricError | undefined {
  if (checkPositiveFinite(estimate) !== undefined) return { kind: 'invalid-value', field: 'estimate' };
  if (checkPositiveFinite(exact) !== undefined) return { kind: 'invalid-value', field: 'exact' };
  return undefined;
}

/** 絶対誤差 |推定値 - 厳密値|。 */
export function absoluteError(estimate: number, exact: number): Result<number, MetricError> {
  const e = checkPair(estimate, exact);
  if (e) return err(e);
  return ok(Math.abs(estimate - exact));
}

/** 相対誤差 |推定値 - 厳密値| / 厳密値。厳密値は正なので 0 割りは起きない。 */
export function relativeError(estimate: number, exact: number): Result<number, MetricError> {
  const e = checkPair(estimate, exact);
  if (e) return err(e);
  return ok(Math.abs(estimate - exact) / exact);
}

/** 整列済みデータ中で、条件を満たさなくなる最初の位置(= 条件を満たす個数)。 */
function countBelow(sorted: Float64Array, estimate: number, inclusive: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (inclusive ? v <= estimate : v < estimate) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 順位誤差 |推定値の順位 - 目標順位| / n。
 * 目標順位は常に nearestRank(n, q)。推定値より小さい個数を a、以下の個数を b とし、
 * b > a なら順位 a+1..b の範囲に目標順位を収めた値、b = a なら a を推定値の順位とする。
 * sortedData は昇順の有限の正の数であること(呼び出し側が保証する。先頭と末尾だけ検査する)。
 */
export function rankError(
  sortedData: Float64Array,
  estimate: number,
  quantile: number,
): Result<number, MetricError> {
  const n = sortedData.length;
  if (!isQuantile(quantile)) return err({ kind: 'invalid-quantile' });
  if (n === 0) return err({ kind: 'empty-data' });
  if (checkPositiveFinite(estimate) !== undefined) {
    return err({ kind: 'invalid-value', field: 'estimate' });
  }
  // 昇順なら先頭が最小、末尾が最大(NaN は整列で末尾に来る)
  if (checkPositiveFinite(sortedData[0]!) !== undefined || checkPositiveFinite(sortedData[n - 1]!) !== undefined) {
    return err({ kind: 'invalid-value', field: 'data' });
  }
  const target = nearestRank(n, quantile);
  const a = countBelow(sortedData, estimate, false);
  const b = countBelow(sortedData, estimate, true);
  const rank = b > a ? Math.min(Math.max(target, a + 1), b) : a;
  return ok(Math.abs(rank - target) / n);
}
