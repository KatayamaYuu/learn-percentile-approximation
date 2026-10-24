import type { OperationCounts } from '../cost/op-counter';
import type { ParamRecord, SketchSpec } from '../contract/sketch';
import type { SketchError } from '../foundation/errors';
import type { PercentileDefinition } from '../quantile/definitions';

export interface BenchmarkInput {
  readonly data: Float64Array | readonly number[];
  readonly quantiles: readonly number[];
  readonly sketches: readonly SketchSpec[];
  /** 各 SketchSpec.create に渡す */
  readonly seed: number;
  readonly referenceDefinition?: PercentileDefinition;
  /** 実験条件。結果にそのまま写す */
  readonly meta?: ParamRecord;
  /** 時間計測の注入。既定は performance.now */
  readonly now?: () => number;
}

export interface QueryRecord {
  readonly quantile: number;
  readonly estimate: number;
  readonly exact: number;
  readonly absoluteError: number;
  readonly relativeError: number;
  readonly rankError: number;
  /** この問い合わせで増えた分 */
  readonly operations: OperationCounts;
  readonly elapsedMs: number;
}

export type AlgorithmErrorKind = SketchError['kind'] | 'invalid-estimate' | 'exception';

export type AlgorithmResult =
  | {
      readonly status: 'ok';
      readonly id: string;
      readonly label: string;
      readonly params: ParamRecord;
      readonly afterInsertion: {
        readonly operations: OperationCounts;
        readonly memoryBytes: number;
        readonly elapsedMs: number;
      };
      readonly queries: readonly QueryRecord[];
      readonly afterQueries: { readonly operations: OperationCounts; readonly memoryBytes: number };
    }
  | {
      readonly status: 'error';
      readonly id: string;
      readonly label: string;
      readonly params: ParamRecord;
      readonly stage: 'insert' | 'query' | 'create';
      readonly errorKind: AlgorithmErrorKind;
      readonly message: string;
    };

export interface BenchmarkResult {
  readonly schemaVersion: 1;
  readonly count: number;
  readonly seed: number;
  readonly referenceDefinition: PercentileDefinition;
  readonly meta: ParamRecord;
  readonly algorithms: readonly AlgorithmResult[];
}
