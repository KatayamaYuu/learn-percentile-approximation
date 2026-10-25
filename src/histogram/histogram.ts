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
import { buildBoundaries, type BucketScheme } from './boundaries';
import type { SchemeError } from './errors';
import { estimateQuantile } from './estimate';

export interface HistogramSpecOptions {
  readonly id?: string;
  readonly label?: string;
}

type Kind = BucketScheme['kind'];

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  equal: '等幅',
  exponential: '指数幅',
  custom: '任意境界',
};

/** 範囲内の値が入るバケットの添字を返す。比較は実行した分だけ counter に数える */
type Locate = (value: number, counter: OperationCounter) => number;

/**
 * 計算で求めた添字を境界の配列と比べて補正する。計算の誤差は 1 バケット以内なので、比較は最大 3 回。
 * 区間は下側を含み上側を含まない。最後のバケットだけ上側も含む。
 */
function refine(boundaries: Float64Array, value: number, guess: number, counter: OperationCounter): number {
  const buckets = boundaries.length - 1;
  let i = Number.isFinite(guess) ? Math.min(Math.max(Math.floor(guess), 0), buckets - 1) : 0;
  // value は先頭の境界以上なので、添字が負にはならない
  for (;;) {
    counter.compare();
    if (value < boundaries[i]!) i--;
    else break;
  }
  while (i < buckets - 1) {
    counter.compare();
    if (value >= boundaries[i + 1]!) i++;
    else break;
  }
  return i;
}

function createLocate(kind: Kind, boundaries: Float64Array): Locate {
  const buckets = boundaries.length - 1;
  const lower = boundaries[0]!;
  const upper = boundaries[buckets]!;
  if (kind === 'equal') {
    const width = (upper - lower) / buckets;
    return (value, counter) => refine(boundaries, value, (value - lower) / width, counter);
  }
  if (kind === 'exponential') {
    const logLower = Math.log(lower);
    const step = (Math.log(upper) - logLower) / buckets;
    return (value, counter) => refine(boundaries, value, (Math.log(value) - logLower) / step, counter);
  }
  // 任意境界: b[i] <= value を満たす最大の i を二分探索する(比較は ceil(log2 B) 回以下)
  return (value, counter) => {
    let lo = 0;
    let hi = buckets - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      counter.compare();
      if (boundaries[mid]! <= value) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/**
 * 境界列が確定したヒストグラムを作る。境界列は不変で、複数のインスタンスで共有してよい。
 * 投入 1 回の移動は、バケットの件数と総件数の 2 回と数える。
 */
function makeHistogram(kind: Kind, boundaries: Float64Array): PercentileSketch {
  const buckets = boundaries.length - 1;
  const lower = boundaries[0]!;
  const upper = boundaries[buckets]!;
  const locate = createLocate(kind, boundaries);
  const counter = new OperationCounter();
  const counts = new Float64Array(buckets);
  let total = 0;

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      if (value < lower || value > upper) {
        return err({
          kind: 'unsupported-value',
          detail: `値 ${value} は扱える範囲 [${lower}, ${upper}] の外です`,
        });
      }
      const i = locate(value, counter);
      counts[i]! += 1;
      total += 1;
      counter.move(2);
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (total === 0) return err({ kind: 'empty' });
      return ok(estimateQuantile({ boundaries, counts, total, quantile, counter }));
    },

    memoryBytes() {
      // 保持するのは境界(B + 1 個)と、バケットの件数 B 個 + 総件数 1 個のカウンタ
      return estimateBytes({ numbers: buckets + 1, counters: buckets + 1 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      counter.reset();
      counts.fill(0);
      total = 0;
    },
  };
}

/** 境界の指定が不正なら SchemeError。成功時は共通規約に従う PercentileSketch */
export function createHistogram(scheme: BucketScheme): Result<PercentileSketch, SchemeError> {
  const built = buildBoundaries(scheme);
  if (!built.ok) return err(built.error);
  return ok(makeHistogram(scheme.kind, built.value));
}

/**
 * 境界の指定が不正なら SchemeError。成功時の create はシードを使わない。
 * id の既定は種類とバケット数から作り、範囲は含めない(データの範囲が件数ごとに変わっても系列が分断されないため)。
 */
export function histogramSpec(
  scheme: BucketScheme,
  options?: HistogramSpecOptions,
): Result<SketchSpec, SchemeError> {
  const built = buildBoundaries(scheme);
  if (!built.ok) return err(built.error);
  const boundaries = built.value;
  const buckets = boundaries.length - 1;
  const kind = scheme.kind;
  const params: ParamRecord = {
    scheme: kind,
    buckets,
    lower: boundaries[0]!,
    upper: boundaries[buckets]!,
  };
  return ok({
    id: options?.id ?? `histogram-${kind}-${buckets}`,
    label: options?.label ?? `ヒストグラム(${KIND_LABEL[kind]}, B=${buckets})`,
    params,
    supportedRange: { min: boundaries[0]!, max: boundaries[buckets]! },
    create: () => makeHistogram(kind, boundaries),
  });
}
