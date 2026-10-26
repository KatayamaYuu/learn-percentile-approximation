// データの範囲と、HDR の自動範囲・実行する有効桁数の決め方(6.2〜6.4、8.8)。
import { err, ok, type Result } from '../../core';
import { createHdrLayout } from '../../relative-error';
import type { HdrRangeMode } from '../shared/conditions';
import type { HdrDigitsInfo, HdrPlanSummary } from '../shared/protocol';
import type { FieldIssue } from '../shared/validate';
import { fromConfigError } from './error-map';

export interface Extent {
  readonly min: number;
  readonly max: number;
  /** 正の値の最小値。正の値がなければ null */
  readonly minPositive: number | null;
}

export function dataExtent(data: Float64Array): Extent {
  let min = Infinity;
  let max = -Infinity;
  let minPositive: number | null = null;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 0 && (minPositive === null || v < minPositive)) minPositive = v;
  }
  return { min, max, minPositive };
}

/** 有効桁数 d の half = S / 2(S は上流の構造から得る) */
export function hdrHalf(significantDigits: number): number {
  const r = createHdrLayout({ lowest: 1, highest: 2, significantDigits });
  if (!r.ok) throw new RangeError(`有効桁数 ${significantDigits} の構造を作れません`);
  return r.value.subBucketCount / 2;
}

/** 10^e。`10 ** e` は負の e で丸めの誤差が出る(10 ** -5 が 1e-5 にならない)ので、桁の表記から作る */
const pow10 = (e: number): number => Number(`1e${e}`);

/** 10 の累乗のうち x 以下の最大のもの(log10 の誤差で 1 ずれた場合は補正する) */
function floorPow10(x: number): number {
  if (!(x > 0)) return 0; // 下位桁あふれ(minPositive / half が 0 になった)
  let e = Math.floor(Math.log10(x));
  if (pow10(e) > x) e--;
  return pow10(e);
}

/** 10 の累乗のうち x 以上の最小のもの(あふれたら Infinity) */
function ceilPow10(x: number): number {
  if (!Number.isFinite(x)) return Infinity;
  let e = Math.ceil(Math.log10(x));
  if (pow10(e) < x) e++;
  return pow10(e);
}

/**
 * auto の範囲。lowest = 10^floor(log10(minPositive / half))、highest = max(10^ceil(log10(max)), 2 × lowest)。
 * 値の幅が極端なときは lowest が 0 に下位桁あふれし、highest が Infinity になりうる(そのまま返し、planHdr が切り詰める)。
 */
export function autoHdrRange(extent: Extent, referenceDigits: number): { readonly lowest: number; readonly highest: number } {
  if (extent.minPositive === null) return { lowest: 1, highest: 2 };
  const lowest = floorPow10(extent.minPositive / hdrHalf(referenceDigits));
  return { lowest, highest: Math.max(ceilPow10(extent.max), 2 * lowest) };
}

const ZERO_DIGITS_LIMIT_RATIO = 1e300;

/** 範囲の誤りの項目: lowest → hdrRange.lowest、それ以外 → hdrRange.highest(比の誤りは highest) */
const rangeFieldMap = (f: string): string => (f === 'lowest' ? 'hdrRange.lowest' : 'hdrRange.highest');

const isDigit = (d: number): boolean => Number.isInteger(d) && d >= 0 && d <= 5;

function tryLayout(range: { lowest: number; highest: number }, significantDigits: number) {
  return createHdrLayout({ lowest: range.lowest, highest: range.highest, significantDigits });
}

/** 範囲を決め、各有効桁数を createHdrLayout で検証し、総数の上限を超える有効桁数を除く */
export function planHdr(mode: HdrRangeMode, extent: Extent, digits: readonly number[]): Result<HdrPlanSummary, FieldIssue> {
  let range: { lowest: number; highest: number };
  let referenceDigits: number | null = null;
  let lowestClamped = false;

  if (mode.kind === 'manual') {
    range = { lowest: mode.lowest, highest: mode.highest };
  } else {
    const intDigits = digits.filter(isDigit);
    const start = intDigits.length > 0 ? Math.max(...intDigits) : 2;
    let found: number | null = null;
    let candidate = autoHdrRange(extent, start);
    for (let d = start; d >= 0; d--) {
      candidate = autoHdrRange(extent, d);
      if (tryLayout(candidate, d).ok) {
        found = d;
        break;
      }
    }
    if (found !== null) {
      range = candidate;
      referenceDigits = found;
    } else {
      // d = 0 でも作れない(値の幅が極端)。下限を切り詰め、比を 10^300 以下にする
      const h0 = Math.min(ceilPow10(extent.max), Number.MAX_VALUE);
      const lowest = Math.max(autoHdrRange(extent, 0).lowest, h0 / ZERO_DIGITS_LIMIT_RATIO, Number.MIN_VALUE);
      range = { lowest, highest: Math.max(h0, 2 * lowest) };
      referenceDigits = 0;
      lowestClamped = true;
      if (!tryLayout(range, 0).ok) {
        return err({
          field: 'hdrRange.lowest',
          reason: 'データの値の幅が広すぎるため、HDR の範囲を決められません',
        });
      }
    }
  }

  // 範囲そのものの検証(有効桁数 0 の構造。lowest・highest・比の誤りだけが失敗する)
  const rangeCheck = tryLayout(range, 0);
  if (!rangeCheck.ok) return err(fromConfigError(rangeCheck.error, rangeFieldMap));

  const included: HdrDigitsInfo[] = [];
  const excluded: { significantDigits: number; reason: string }[] = [];
  const seen = new Set<number>();
  for (const d of digits) {
    if (seen.has(d)) continue;
    seen.add(d);
    // 0〜5 の整数でない値は除かず、上流の significantDigits の失敗として表示させる
    if (!isDigit(d)) continue;
    const r = tryLayout(range, d);
    if (r.ok) {
      included.push({
        significantDigits: d,
        subBucketCount: r.value.subBucketCount,
        totalBuckets: r.value.totalBuckets,
        guaranteeFrom: (r.value.subBucketCount / 2) * range.lowest,
      });
    } else {
      excluded.push({ significantDigits: d, reason: r.error.reason });
    }
  }

  return ok({ range, mode: mode.kind, referenceDigits, lowestClamped, included, excluded });
}
