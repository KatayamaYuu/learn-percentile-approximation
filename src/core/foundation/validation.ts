import type { InvalidValueReason } from './errors';

/** 有限の正の数なら undefined、そうでなければ理由を返す。 */
export function checkPositiveFinite(value: number): InvalidValueReason | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'not-a-number';
  if (!Number.isFinite(value)) return 'not-finite';
  if (value <= 0) return 'not-positive';
  return undefined;
}

/** 0 以上 1 以下の有限の数か。 */
export function isQuantile(q: number): boolean {
  return typeof q === 'number' && q >= 0 && q <= 1;
}
