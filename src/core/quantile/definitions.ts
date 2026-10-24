/** パーセンタイルの定義5種。 */
export type PercentileDefinition = 'nearest-rank' | 'linear' | 'lower' | 'higher' | 'midpoint';

export const DEFAULT_DEFINITION: PercentileDefinition = 'linear';

export interface OrderPosition {
  /** 0 始まり */
  readonly lo: number;
  /** 0 始まり。lo <= hi <= lo + 1 */
  readonly hi: number;
  /** [0, 1) */
  readonly frac: number;
}

const SNAP_TOLERANCE = 1e-9;

/** 最近傍の整数との差が 1e-9 × max(1, |x|) 以内ならその整数に丸める。 */
function snapToInteger(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - r) <= SNAP_TOLERANCE * Math.max(1, Math.abs(x)) ? r : x;
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

/** 最近順位法の順位(1 始まり、[1, n])。ceil(n·q) 番目。 */
export function nearestRank(n: number, q: number): number {
  return clamp(Math.ceil(snapToInteger(n * q)), 1, n);
}

/** 件数 n と分位点 q から、昇順に並べた値の下側・上側の添字と小数部を求める。 */
export function resolvePosition(
  n: number,
  q: number,
  definition: PercentileDefinition,
): OrderPosition {
  if (definition === 'nearest-rank') {
    const idx = nearestRank(n, q) - 1;
    return { lo: idx, hi: idx, frac: 0 };
  }
  const h = clamp(snapToInteger((n - 1) * q), 0, n - 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return { lo, hi, frac: h - lo };
}

/** 下側値と上側値から定義に従って値を合成する。結果は [xLo, xHi] に収まる。 */
export function combineOrderStatistics(
  definition: PercentileDefinition,
  position: OrderPosition,
  xLo: number,
  xHi: number,
): number {
  switch (definition) {
    case 'nearest-rank':
    case 'lower':
      return xLo;
    case 'higher':
      return xHi;
    case 'midpoint':
      return clamp((xLo + xHi) / 2, xLo, xHi);
    case 'linear':
      return clamp(xLo + (xHi - xLo) * position.frac, xLo, xHi);
  }
}
