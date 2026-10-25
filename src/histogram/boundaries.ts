import { checkPositiveFinite, err, ok, type Result } from '../core';
import type { SchemeError } from './errors';

export type BucketScheme =
  | { readonly kind: 'equal'; readonly lower: number; readonly upper: number; readonly buckets: number }
  | { readonly kind: 'exponential'; readonly lower: number; readonly upper: number; readonly buckets: number }
  | { readonly kind: 'custom'; readonly boundaries: readonly number[] };

/** バケット数の上限。メモリを無制限に確保させないための防御的な制限 */
export const MAX_BUCKETS = 100_000;

const bad = (field: string, reason: string): SchemeError => ({ kind: 'invalid-scheme', field, reason });

function checkBound(field: 'lower' | 'upper', value: unknown): SchemeError | undefined {
  if (typeof value !== 'number') return bad(field, '数値である必要があります');
  return checkPositiveFinite(value) === undefined ? undefined : bad(field, '有限の正の数である必要があります');
}

function isStrictlyIncreasing(b: ArrayLike<number>): boolean {
  for (let i = 1; i < b.length; i++) {
    if (!(b[i]! > b[i - 1]!)) return false;
  }
  return true;
}

function validateRange(scheme: {
  readonly lower: number;
  readonly upper: number;
  readonly buckets: number;
}): SchemeError | undefined {
  const { lower, upper, buckets } = scheme;
  const e = checkBound('lower', lower) ?? checkBound('upper', upper);
  if (e) return e;
  if (!(upper > lower)) return bad('upper', 'lower より大きい必要があります');
  if (typeof buckets !== 'number' || !Number.isInteger(buckets) || buckets < 1 || buckets > MAX_BUCKETS) {
    return bad('buckets', `1 以上 ${MAX_BUCKETS} 以下の整数である必要があります`);
  }
  return undefined;
}

function buildCustom(boundaries: unknown): Result<Float64Array, SchemeError> {
  if (!Array.isArray(boundaries)) return err(bad('boundaries', '配列である必要があります'));
  if (boundaries.length < 2) return err(bad('boundaries', '2 個以上の境界が必要です'));
  if (boundaries.length - 1 > MAX_BUCKETS) {
    return err(bad('boundaries', `バケット数が上限 ${MAX_BUCKETS} を超えています`));
  }
  for (const x of boundaries) {
    if (typeof x !== 'number' || checkPositiveFinite(x) !== undefined) {
      return err(bad('boundaries', 'すべて有限の正の数である必要があります'));
    }
  }
  const b = Float64Array.from(boundaries as number[]);
  if (!isStrictlyIncreasing(b)) return err(bad('boundaries', '狭義単調増加である必要があります'));
  return ok(b);
}

/**
 * 境界の指定から、長さ バケット数 + 1 の境界列を作る。先頭と末尾は指定値そのもの。
 * 狭義単調増加でなければ(丸めで隣り合う境界が等しくなる場合を含む)エラーにする。
 */
export function buildBoundaries(scheme: BucketScheme): Result<Float64Array, SchemeError> {
  const kind: unknown = scheme === null || typeof scheme !== 'object' ? undefined : scheme.kind;
  if (kind === 'custom') return buildCustom((scheme as { boundaries?: unknown }).boundaries);
  if (kind !== 'equal' && kind !== 'exponential') {
    return err(bad('kind', 'equal / exponential / custom のいずれかです'));
  }
  const range = scheme as Extract<BucketScheme, { kind: 'equal' | 'exponential' }>;
  const invalid = validateRange(range);
  if (invalid) return err(invalid);

  const { lower, upper, buckets } = range;
  const b = new Float64Array(buckets + 1);
  b[0] = lower;
  b[buckets] = upper;
  if (kind === 'equal') {
    for (let i = 1; i < buckets; i++) b[i] = lower + ((upper - lower) * i) / buckets;
  } else {
    // 比 upper / lower や中間の指数があふれる範囲でも計算できるよう、対数の上で補間する
    const logLower = Math.log(lower);
    const logSpan = Math.log(upper) - logLower;
    for (let i = 1; i < buckets; i++) b[i] = Math.exp(logLower + (logSpan * i) / buckets);
  }
  for (const x of b) {
    if (checkPositiveFinite(x) !== undefined) return err(bad('buckets', '境界が有限の正の数になりません'));
  }
  if (!isStrictlyIncreasing(b)) return err(bad('buckets', '境界が浮動小数点の精度で区別できません'));
  return ok(b);
}
