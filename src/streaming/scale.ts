/** t-digest のスケール関数の種類。k0 は一様、k1 は裾で小さく、k2 は裾でさらに強く小さくする */
export type ScaleFunctionKind = 'k0' | 'k1' | 'k2';

export const SCALE_FUNCTIONS: readonly ScaleFunctionKind[] = ['k0', 'k1', 'k2'];

const HALF_PI = Math.PI / 2;

/** k2 の正規化係数 Z(n) = 4 × ln(max(n / δ, 1)) + 24。総件数が δ より小さいときは下を抑える */
function normalizer(compression: number, total: number): number {
  return 4 * Math.log(Math.max(total / compression, 1)) + 24;
}

/** 浮動小数点の誤差で [lower, 1] を外れないように収める */
function clampToRange(value: number, lower: number): number {
  return Math.min(1, Math.max(lower, value));
}

/**
 * centroid の左端の分位点 qLeft から、「スケール関数の値が 1 増える位置」k⁻¹(k(qLeft) + 1) を返す。
 * centroid の右端の分位点がこの値以下なら k(q_right) − k(q_left) ≤ 1 を満たす。
 * 戻り値は [qLeft, 1] に収める。純粋関数で、操作数は数えない。
 *
 * - k0(q) = δq / 2 : 上限は qLeft + 2/δ(1 で頭打ち)
 * - k1(q) = δ / (2π) × asin(2q − 1) : qLeft = 0 のときは k1 = −δ/4 として扱う
 * - k2(q) = δ / Z(n) × ln(q / (1 − q)) : qLeft = 0 のときは k2 = −∞ として扱い、上限は 0
 */
export function scaleLimit(
  kind: ScaleFunctionKind,
  qLeft: number,
  compression: number,
  total: number,
): number {
  if (qLeft >= 1) return 1;
  switch (kind) {
    case 'k0':
      return clampToRange(qLeft + 2 / compression, qLeft);
    case 'k1': {
      const kLeft = qLeft <= 0 ? -compression / 4 : (compression / (2 * Math.PI)) * Math.asin(2 * qLeft - 1);
      // 2π y / δ を [−π/2, π/2] に収めてから逆関数を取る
      const angle = Math.min(HALF_PI, Math.max(-HALF_PI, (2 * Math.PI * (kLeft + 1)) / compression));
      return clampToRange((Math.sin(angle) + 1) / 2, qLeft);
    }
    case 'k2': {
      if (qLeft <= 0) return 0;
      const z = normalizer(compression, total);
      const kLeft = (compression / z) * Math.log(qLeft / (1 - qLeft));
      return clampToRange(1 / (1 + Math.exp((-(kLeft + 1) * z) / compression)), qLeft);
    }
  }
}
