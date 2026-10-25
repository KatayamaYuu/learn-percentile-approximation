import {
  OperationCounter,
  checkPositiveFinite,
  err,
  estimateBytes,
  isQuantile,
  ok,
  type ParamRecord,
  type PercentileSketch,
  type Result,
  type SketchSpec,
} from '../core';
import { CollapsingStore } from './collapsing-store';
import type { ConfigError } from './errors';
import { createLogMapping, type LogMapping } from './log-mapping';
import { selectSlot } from './rank-select';
import type { BucketView, SketchSpecOptions } from './snapshot';

export interface DDSketchOptions {
  /** 相対誤差の許容値。0 < alpha < 1 */
  readonly alpha: number;
  /** バケット数の上限。1 以上 MAX_DD_BUCKETS 以下の整数。省略時は DEFAULT_MAX_BUCKETS */
  readonly maxBuckets?: number;
}

export const DEFAULT_MAX_BUCKETS = 2048;
export const MAX_DD_BUCKETS = 100_000;

export interface DDSketchSnapshot {
  readonly kind: 'ddsketch';
  readonly alpha: number;
  readonly gamma: number;
  readonly maxBuckets: number;
  readonly totalCount: number;
  /** 保持している範囲の長さ(最小番号から最大番号まで) */
  readonly span: number;
  readonly nonEmptyBuckets: number;
  readonly buckets: readonly BucketView[];
  readonly collapsed: boolean;
  /** この値以下の推定は相対誤差の上限を保証しない。縮約がなければ null */
  readonly collapsedUpperBound: number | null;
  readonly collapseCount: number;
}

export interface DDSketch extends PercentileSketch {
  /** 内部状態を新しく組み立てた値で返す。状態・操作数・メモリ見積もりを変えない */
  inspect(): DDSketchSnapshot;
}

function resolveOptions(options: DDSketchOptions): Result<{ mapping: LogMapping; maxBuckets: number }, ConfigError> {
  const mapping = createLogMapping(options.alpha);
  if (!mapping.ok) return err(mapping.error);
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  if (
    typeof maxBuckets !== 'number' ||
    !Number.isInteger(maxBuckets) ||
    maxBuckets < 1 ||
    maxBuckets > MAX_DD_BUCKETS
  ) {
    return err({
      kind: 'invalid-config',
      field: 'maxBuckets',
      reason: `1 以上 ${MAX_DD_BUCKETS} 以下の整数である必要があります`,
    });
  }
  return ok({ mapping: mapping.value, maxBuckets });
}

/** 乱数を使わない。投入 1 回の比較は写像の補正(3 回以下)とストアの範囲判定(2 回以下)、移動はストアが数える */
function makeDDSketch(mapping: LogMapping, maxBuckets: number): DDSketch {
  const store = new CollapsingStore(maxBuckets);
  const counter = new OperationCounter();

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      store.add(mapping.indexOf(value, counter), counter);
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      const view = store.view();
      if (view.total === 0) return err({ kind: 'empty' });
      const slot = selectSlot(view.counts, view.total, quantile, counter);
      return ok(mapping.representative(view.minIndex! + slot));
    },

    memoryBytes() {
      // 数値 4 個(γ、m、最小番号、縮約の合算先の番号)と、カウンタ(保持範囲の長さ + 総件数 + 縮約の回数)
      return estimateBytes({ numbers: 4, counters: store.view().span + 2 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      store.reset();
      counter.reset();
    },

    inspect(): DDSketchSnapshot {
      throw new Error('inspect は 3.2 で実装する');
    },
  };
}

/** α または m が不正なら ConfigError(検証は α → m の順)。成功時は共通規約に従う DDSketch */
export function createDDSketch(options: DDSketchOptions): Result<DDSketch, ConfigError> {
  const resolved = resolveOptions(options);
  if (!resolved.ok) return err(resolved.error);
  return ok(makeDDSketch(resolved.value.mapping, resolved.value.maxBuckets));
}

/**
 * id の既定は α と m から作り、データに依存しない。値域は宣言しない(正の最大値・最小値まで受け付ける)。
 * create はシードを使わない。
 */
export function ddsketchSpec(
  options: DDSketchOptions,
  specOptions?: SketchSpecOptions,
): Result<SketchSpec, ConfigError> {
  const resolved = resolveOptions(options);
  if (!resolved.ok) return err(resolved.error);
  const { mapping, maxBuckets } = resolved.value;
  const params: ParamRecord = { alpha: mapping.alpha, gamma: mapping.gamma, maxBuckets };
  return ok({
    id: specOptions?.id ?? `ddsketch-a${mapping.alpha}-m${maxBuckets}`,
    label: specOptions?.label ?? `DDSketch(α=${mapping.alpha}, m=${maxBuckets})`,
    params,
    create: () => makeDDSketch(mapping, maxBuckets),
  });
}
