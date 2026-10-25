import { err, ok, type OperationCounter, type Result } from '../core';
import type { ConfigError } from './errors';

export interface HdrConfig {
  /** 最小の識別単位 L。有限の正の数 */
  readonly lowest: number;
  /** 追跡する最大値 H。有限の正の数で 2L 以上 */
  readonly highest: number;
  /** 有効桁数 d。0 以上 5 以下の整数 */
  readonly significantDigits: number;
}

export interface HdrLayout {
  readonly lowest: number;
  readonly highest: number;
  readonly significantDigits: number;
  /** 副バケット数 S(2 × 10^d 以上の最小の 2 のべき乗) */
  readonly subBucketCount: number;
  readonly totalBuckets: number;
  /** x は L 以上 H 以下(呼び出し側が検証する)。counter を渡すと比較を数える(最大 4 回) */
  indexOf(x: number, counter?: OperationCounter): number;
  lowerBound(index: number): number;
  upperBound(index: number): number;
  /** バケットの中点。有限の正の数 */
  representative(index: number): number;
}

/** バケットの総数の上限(防御的な制限) */
export const MAX_HDR_BUCKETS = 2 ** 22;

const MAX_DIGITS = 5;

const invalid = (field: 'lowest' | 'highest' | 'significantDigits', reason: string): ConfigError => ({
  kind: 'invalid-config',
  field,
  reason,
});

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 最小の識別単位 L、追跡する最大値 H、有効桁数 d から、副バケット数 S とバケットの総数を決める。
 * 値を L 単位の整数 u に切り捨て、u < S は幅 1 単位、S 以上は 2 倍ごとの区間を S / 2 個の等しい幅に分ける。
 * 検証は L → H → 比 → d → 総数の順で、最初の 1 件を返す。
 */
export function createHdrLayout(config: HdrConfig): Result<HdrLayout, ConfigError> {
  const { lowest, highest, significantDigits } = config;
  if (!isPositiveFinite(lowest)) return err(invalid('lowest', '有限の正の数である必要があります'));
  if (!isPositiveFinite(highest)) return err(invalid('highest', '有限の正の数である必要があります'));
  if (highest < 2 * lowest) return err(invalid('highest', 'lowest の 2 倍以上である必要があります'));
  if (!Number.isFinite(highest / lowest)) return err(invalid('highest', 'highest / lowest が有限の数になりません'));
  if (
    typeof significantDigits !== 'number' ||
    !Number.isInteger(significantDigits) ||
    significantDigits < 0 ||
    significantDigits > MAX_DIGITS
  ) {
    return err(invalid('significantDigits', '0 以上 5 以下の整数である必要があります'));
  }

  const subBucketCount = 2 ** Math.ceil(Math.log2(2 * 10 ** significantDigits));
  const half = subBucketCount / 2;
  const maxUnits = Math.floor(highest / lowest);
  // maxUnits を含む最小の区間番号 K(区間 k は u < S × 2^k)
  let intervals = 0;
  while (maxUnits >= subBucketCount * 2 ** intervals) intervals++;
  const totalBuckets = subBucketCount + intervals * half;
  if (totalBuckets > MAX_HDR_BUCKETS) {
    return err(
      invalid('significantDigits', `バケットの総数 ${totalBuckets} が上限 ${MAX_HDR_BUCKETS} を超えます`),
    );
  }

  const units = (index: number): { readonly lowerUnit: number; readonly width: number } => {
    if (index < subBucketCount) return { lowerUnit: index, width: 1 };
    const j = index - subBucketCount;
    const k = Math.floor(j / half) + 1;
    const width = 2 ** k;
    return { lowerUnit: (half + (j % half)) * width, width };
  };
  const clamp = (v: number): number => Math.min(v, Number.MAX_VALUE);
  const lowerBound = (index: number): number => clamp(units(index).lowerUnit * lowest);
  const upperBound = (index: number): number => {
    const { lowerUnit, width } = units(index);
    return clamp((lowerUnit + width) * lowest);
  };

  return ok({
    lowest,
    highest,
    significantDigits,
    subBucketCount,
    totalBuckets,
    indexOf(x, counter) {
      const u = Math.floor(x / lowest);
      if (u < subBucketCount) {
        counter?.compare(1);
        return u;
      }
      let k = Math.floor(Math.log2(u / subBucketCount)) + 1;
      // 推定は 1 区間以内の誤差。区間 k は S × 2^(k−1) <= u < S × 2^k
      let compared = 2;
      if (u < subBucketCount * 2 ** (k - 1)) {
        k--;
        // u < 旧区間の下端 = 新区間の上端なので、上側の確認は要らない
        for (;;) {
          compared++;
          if (u < subBucketCount * 2 ** (k - 1)) k--;
          else break;
        }
      } else {
        compared++;
        while (u >= subBucketCount * 2 ** k) {
          k++;
          compared++;
        }
      }
      counter?.compare(compared);
      return subBucketCount + (k - 1) * half + (Math.floor(u / 2 ** k) - half);
    },
    lowerBound,
    upperBound,
    representative(index) {
      return lowerBound(index) / 2 + upperBound(index) / 2;
    },
  });
}
