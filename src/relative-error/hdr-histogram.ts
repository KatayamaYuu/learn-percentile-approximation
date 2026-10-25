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
import type { ConfigError } from './errors';
import { createHdrLayout, type HdrConfig, type HdrLayout } from './hdr-layout';
import { selectSlot } from './rank-select';
import type { BucketView, SketchSpecOptions } from './snapshot';

export interface HdrSnapshot {
  readonly kind: 'hdr';
  readonly lowest: number;
  readonly highest: number;
  readonly significantDigits: number;
  readonly subBucketCount: number;
  readonly totalBuckets: number;
  readonly totalCount: number;
  readonly nonEmptyBuckets: number;
  readonly buckets: readonly BucketView[];
}

export interface HdrHistogram extends PercentileSketch {
  /** 内部状態を新しく組み立てた値で返す。状態・操作数・メモリ見積もりを変えない */
  inspect(): HdrSnapshot;
}

/**
 * 乱数を使わない。バケットの総数は作成時に決まり、件数配列も作成時に確保する。
 * 投入 1 回は比較 4 回以下・移動 2 回(件数と総件数)。
 */
function makeHdrHistogram(layout: HdrLayout): HdrHistogram {
  const { lowest, highest, totalBuckets } = layout;
  const counter = new OperationCounter();
  const counts = new Float64Array(totalBuckets);
  let total = 0;

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      if (value < lowest || value > highest) {
        return err({
          kind: 'unsupported-value',
          detail: `値 ${value} は扱える範囲 [${lowest}, ${highest}] の外です`,
        });
      }
      counts[layout.indexOf(value, counter)]! += 1;
      total += 1;
      counter.move(2);
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (total === 0) return err({ kind: 'empty' });
      return ok(layout.representative(selectSlot(counts, total, quantile, counter)));
    },

    memoryBytes() {
      // 数値 3 個(L、H、d)と、カウンタ(バケットの件数 + 総件数)。作成時から変わらない
      return estimateBytes({ numbers: 3, counters: totalBuckets + 1 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      counts.fill(0);
      total = 0;
      counter.reset();
    },

    inspect(): HdrSnapshot {
      throw new Error('inspect は 3.4 で実装する');
    },
  };
}

/** 設定が不正なら ConfigError。成功時は共通規約に従う HdrHistogram */
export function createHdrHistogram(config: HdrConfig): Result<HdrHistogram, ConfigError> {
  const layout = createHdrLayout(config);
  if (!layout.ok) return err(layout.error);
  return ok(makeHdrHistogram(layout.value));
}

/**
 * id の既定は有効桁数から作り、範囲を含めない(範囲は params と実験の meta で読める)。
 * 扱える値は L 以上 H 以下。create はシードを使わない。
 */
export function hdrSpec(config: HdrConfig, specOptions?: SketchSpecOptions): Result<SketchSpec, ConfigError> {
  const built = createHdrLayout(config);
  if (!built.ok) return err(built.error);
  const layout = built.value;
  const d = layout.significantDigits;
  const params: ParamRecord = {
    lowest: layout.lowest,
    highest: layout.highest,
    significantDigits: d,
    subBucketCount: layout.subBucketCount,
    totalBuckets: layout.totalBuckets,
  };
  return ok({
    id: specOptions?.id ?? `hdr-d${d}`,
    label: specOptions?.label ?? `HDR Histogram(有効桁数=${d})`,
    params,
    supportedRange: { min: layout.lowest, max: layout.highest },
    create: () => makeHdrHistogram(layout),
  });
}
