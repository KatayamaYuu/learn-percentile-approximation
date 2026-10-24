import {
  DEFAULT_DEFINITION,
  combineOrderStatistics,
  resolvePosition,
  type PercentileDefinition,
} from './definitions';

/**
 * 昇順に整列済みのデータから基準値を計算する純粋関数。計数は行わない。
 * 前提: data は 1 件以上、q は 0 以上 1 以下。
 */
export function exactQuantileSorted(
  data: Float64Array,
  q: number,
  definition: PercentileDefinition = DEFAULT_DEFINITION,
): number {
  const position = resolvePosition(data.length, q, definition);
  return combineOrderStatistics(definition, position, data[position.lo]!, data[position.hi]!);
}
