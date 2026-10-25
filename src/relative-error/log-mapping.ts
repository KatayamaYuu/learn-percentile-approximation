import { err, ok, type OperationCounter, type Result } from '../core';
import type { ConfigError } from './errors';

export interface LogMapping {
  readonly alpha: number;
  readonly gamma: number;
  /** x は有限の正の数(呼び出し側が検証する)。counter を渡すと補正の比較を数える(最大 3 回) */
  indexOf(x: number, counter?: OperationCounter): number;
  /** (γ^(i−1), γ^i] の下側の境界。極端に小さい番号では 0 に落ちうる */
  lowerBound(index: number): number;
  /** (γ^(i−1), γ^i] の上側の境界。正の最大値を超えない */
  upperBound(index: number): number;
  /** 2γ^i / (γ + 1)。正の最小値以上、正の最大値以下の有限の数 */
  representative(index: number): number;
}

const invalidAlpha = (reason: string): ConfigError => ({ kind: 'invalid-config', field: 'alpha', reason });

/**
 * 相対誤差の許容値 α から γ = (1 + α) / (1 − α) を決め、値と番号、番号と境界・代表値を相互に計算する写像を作る。
 * 値 x の番号 i は γ^(i−1) < x <= γ^i を満たす整数で、代表値 2γ^i / (γ + 1) は区間の両端で相対誤差がちょうど α になる。
 * α が数値でない・有限でない・0 以下・1 以上なら ConfigError(field は 'alpha')。
 */
export function createLogMapping(alpha: number): Result<LogMapping, ConfigError> {
  if (typeof alpha !== 'number' || Number.isNaN(alpha)) return err(invalidAlpha('数値ではありません'));
  if (!Number.isFinite(alpha)) return err(invalidAlpha('有限の数ではありません'));
  if (alpha <= 0 || alpha >= 1) return err(invalidAlpha('0 より大きく 1 より小さい必要があります'));

  const gamma = (1 + alpha) / (1 - alpha);
  const logGamma = Math.log(gamma);
  // α が極端に小さいと γ が 1 に丸められ、対数が 0 になる(番号を決められない)
  if (!Number.isFinite(gamma) || !(logGamma > 0) || !Number.isFinite(logGamma)) {
    return err(invalidAlpha('γ = (1 + α) / (1 − α) を 1 より大きい有限の数として表せません'));
  }
  const logHalfFactor = Math.log(2 / (gamma + 1));

  const upperBound = (index: number): number => Math.min(Math.exp(index * logGamma), Number.MAX_VALUE);
  const lowerBound = (index: number): number => upperBound(index - 1);

  return ok({
    alpha,
    gamma,
    indexOf(x, counter) {
      let i = Math.ceil(Math.log(x) / logGamma);
      // 対数の誤差は 1 バケット以内。計算した境界と比べて、lowerBound(i) < x <= upperBound(i) にそろえる
      let compared = 1;
      if (x <= lowerBound(i)) {
        i--;
        // x <= 旧 lowerBound(i) = 新 upperBound(i) なので、上側の確認は要らない
        while (x <= lowerBound(i)) {
          compared++;
          i--;
        }
        compared++;
      } else {
        compared++;
        while (x > upperBound(i)) {
          compared++;
          i++;
        }
      }
      counter?.compare(compared);
      return i;
    },
    lowerBound,
    upperBound,
    representative(index) {
      const r = Math.exp(index * logGamma + logHalfFactor);
      return Math.min(Math.max(r, Number.MIN_VALUE), Number.MAX_VALUE);
    },
  });
}
