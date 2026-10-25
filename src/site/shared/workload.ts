// 計算量の見積もり。この段階では型だけを定める。estimateWork はタスク 2.2 で加える。
export interface HdrWorkInput {
  /** 実行する有効桁数 → その範囲での HdrLayout.totalBuckets(除いた有効桁数は含めない) */
  readonly totalBuckets: ReadonlyMap<number, number>;
}

export interface WorkEstimate {
  /** 投入の項 Σ(データ件数 × その件数で動く sketch の数。厳密解を含む)+ HDR の項 */
  readonly units: number;
  /** HDR のバケットの総数の項を含めたか(hdr を渡したときだけ true) */
  readonly includesHdrTerm: boolean;
  readonly withinLimit: boolean;
  /** 上限を超えたときの減らし方の案内(日本語) */
  readonly suggestions: readonly string[];
}
