// サイトとしての条件の検証。この段階では結果の型(FieldIssue)だけを定める。検証関数はタスク 2.2 で加える。
export interface FieldIssue {
  /** UI の項目の識別。例: 'data.count'、'data.distribution.sigma'、'epsilon'、'algorithms' */
  readonly field: string;
  readonly reason: string;
}
