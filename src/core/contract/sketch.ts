import type { OperationCounts } from '../cost/op-counter';
import type { SketchError } from '../foundation/errors';
import type { Result } from '../foundation/result';

/** すべてのアルゴリズムが従う共通の操作規約。 */
export interface PercentileSketch {
  /** value は有限の正の数。エラー時は状態・操作数・メモリ見積もりを変えない */
  insert(value: number): Result<void, SketchError>;
  /** quantile は 0 以上 1 以下。成功時は有限の正の数を返す。エラー時は状態を変えない */
  query(quantile: number): Result<number, SketchError>;
  memoryBytes(): number;
  operationCounts(): OperationCounts;
  /** 投入済みの値、操作数、メモリ見積もり、乱数列を新規作成直後に戻す */
  reset(): void;
}

/** number は有限の数に限る */
export type ParamValue = number | string | boolean;
export type ParamRecord = Readonly<Record<string, ParamValue>>;

export interface SupportedRange {
  /** 受け付ける最小値(含む)。有限の正の数 */
  readonly min: number;
  /** 受け付ける最大値(含む)。有限の正の数、または Infinity */
  readonly max: number;
}

export interface SketchSpec {
  /** 結果の識別子。重複させない */
  readonly id: string;
  /** 表示名 */
  readonly label: string;
  /** ε、バケット数、圧縮率など。結果にそのまま写す */
  readonly params?: ParamRecord;
  /** 省略時は値域全体(有限の正の数すべて)を受け付ける */
  readonly supportedRange?: SupportedRange;
  readonly create: (seed: number) => PercentileSketch;
}

/**
 * 有限の数・文字列・真偽値だけを値に持つ素のオブジェクトか。
 * NaN、±Infinity、入れ子の値、null、undefined などを含むと false。ハーネスと適合確認が共有する。
 */
export function isParamRecord(value: unknown): value is ParamRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
    } else if (typeof v !== 'string' && typeof v !== 'boolean') {
      return false;
    }
  }
  return true;
}
