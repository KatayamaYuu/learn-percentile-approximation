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
import { SCALE_FUNCTIONS, scaleLimit, type ScaleFunctionKind } from './scale';
import { sortValues } from './sort';

/** 圧縮パラメータ δ の許容範囲(両端を含む) */
export const COMPRESSION_RANGE = { min: 10, max: 10000 } as const;

/** バッファの容量は圧縮パラメータのこの倍数の切り上げ */
const BUFFER_FACTOR = 5;

export interface TDigestOptions {
  readonly compression: number;
  readonly scale: ScaleFunctionKind;
}

export interface Centroid {
  readonly mean: number;
  readonly weight: number;
}

export interface TDigestState {
  readonly algorithm: 'tdigest';
  readonly compression: number;
  readonly scale: ScaleFunctionKind;
  readonly count: number;
  /** 空のときは null */
  readonly min: number | null;
  readonly max: number | null;
  /** まだまとめていない値の件数 */
  readonly buffered: number;
  /** 平均値の昇順 */
  readonly centroids: readonly Centroid[];
}

export interface TDigestSketch extends PercentileSketch {
  inspect(): TDigestState;
}

function validateCompression(compression: unknown): ConfigError | undefined {
  if (typeof compression !== 'number' || !Number.isFinite(compression)) {
    return { kind: 'invalid-config', field: 'compression', reason: '圧縮パラメータは有限の数でなければなりません' };
  }
  if (compression < COMPRESSION_RANGE.min || compression > COMPRESSION_RANGE.max) {
    return {
      kind: 'invalid-config',
      field: 'compression',
      reason: `圧縮パラメータは ${COMPRESSION_RANGE.min} 以上 ${COMPRESSION_RANGE.max} 以下でなければなりません(指定値: ${compression})`,
    };
  }
  return undefined;
}

function validateScale(scale: unknown): ConfigError | undefined {
  if (SCALE_FUNCTIONS.some((kind) => kind === scale)) return undefined;
  return {
    kind: 'invalid-config',
    field: 'scale',
    reason: `スケール関数は ${SCALE_FUNCTIONS.join('、')} のいずれかでなければなりません(指定値: ${String(scale)})`,
  };
}

function validateOptions(options: TDigestOptions): ConfigError | undefined {
  return validateCompression(options.compression) ?? validateScale(options.scale);
}

/** バッファの容量 ⌈5δ⌉ */
function bufferCapacityOf(compression: number): number {
  return Math.ceil(BUFFER_FACTOR * compression);
}

/**
 * 検証済みの δ とスケール関数から t-digest を作る。
 * 不変条件: Σ 重み + バッファ件数 = 投入件数、最小値 ≤ すべての平均値 ≤ 最大値。
 * 簡略化: まとめる向きは常に昇順(参照実装の交互切り替えは省く)。乱数は使わない。
 */
function makeTDigest(compression: number, scale: ScaleFunctionKind): TDigestSketch {
  const capacity = bufferCapacityOf(compression);
  const counter = new OperationCounter();
  const buffer = new Float64Array(capacity);
  let buffered = 0;
  // centroid の平均値と重み(平均値の昇順)。有効なのは先頭 centroidCount 個
  let means = new Float64Array(0);
  let weights = new Float64Array(0);
  let centroidCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;

  /** バッファを整列し、既存の centroid と値の順に 1 列として読みながら、上限を超えない範囲で貪欲にまとめる */
  function mergeBuffer(): void {
    sortValues(buffer, buffered, counter);
    const outMeans = new Float64Array(centroidCount + buffered);
    const outWeights = new Float64Array(centroidCount + buffered);
    let outCount = 0;

    // 確定済みの重み、現在の centroid、その上限
    let settled = 0;
    let curMean = 0;
    let curWeight = 0;
    let curLimit = 0;

    /** 新しい centroid を始める。上限は、これまでに確定した重みから決まる左端の分位点で求める */
    function start(mean: number, weight: number): void {
      curMean = mean;
      curWeight = weight;
      curLimit = scaleLimit(scale, settled / count, compression, count);
    }

    function take(mean: number, weight: number): void {
      if (curWeight === 0) {
        // 各 centroid には少なくとも 1 項目が入る
        start(mean, weight);
        return;
      }
      counter.compare();
      if ((settled + curWeight + weight) / count <= curLimit) {
        curMean = (curMean * curWeight + mean * weight) / (curWeight + weight);
        curWeight += weight;
        return;
      }
      outMeans[outCount] = curMean;
      outWeights[outCount] = curWeight;
      outCount++;
      counter.move(2);
      settled += curWeight;
      start(mean, weight);
    }

    let c = 0;
    let b = 0;
    while (c < centroidCount && b < buffered) {
      counter.compare();
      // 同値は既存の centroid を先にする
      if (means[c]! <= buffer[b]!) {
        take(means[c]!, weights[c]!);
        c++;
      } else {
        take(buffer[b]!, 1);
        b++;
      }
    }
    while (c < centroidCount) {
      take(means[c]!, weights[c]!);
      c++;
    }
    while (b < buffered) {
      take(buffer[b]!, 1);
      b++;
    }
    if (curWeight > 0) {
      outMeans[outCount] = curMean;
      outWeights[outCount] = curWeight;
      outCount++;
      counter.move(2);
    }

    means = outMeans;
    weights = outWeights;
    centroidCount = outCount;
    buffered = 0;
  }

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      buffer[buffered++] = value;
      counter.move();
      counter.compare(2);
      if (value < min) {
        min = value;
        counter.move();
      }
      if (value > max) {
        max = value;
        counter.move();
      }
      count++;
      if (buffered >= capacity) mergeBuffer();
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (count === 0) return err({ kind: 'empty' });
      if (buffered > 0) mergeBuffer();

      // 点 (0, 最小値)、各 centroid の (重みの中心の位置, 平均値)、(投入件数, 最大値) を結ぶ折れ線。
      // 始点 (0, 最小値) は目標位置以下に決まっているので調べず(比較を数えず)、次の点から順に調べる
      const target = quantile * count;
      let prevX = 0;
      let prevY = min;
      let settled = 0;
      for (let i = 0; i <= centroidCount; i++) {
        let x: number;
        let y: number;
        if (i < centroidCount) {
          x = settled + weights[i]! / 2;
          y = means[i]!;
          settled += weights[i]!;
        } else {
          x = count;
          y = max;
        }
        counter.compare();
        if (x >= target) {
          const estimate = x === target ? y : prevY + ((y - prevY) * (target - prevX)) / (x - prevX);
          return ok(Math.min(max, Math.max(min, estimate)));
        }
        prevX = x;
        prevY = y;
      }
      // 最後の点の位置は投入件数で、目標位置(分位点 ≤ 1)はそれ以下なので、ここには来ない
      throw new Error('t-digest の内部矛盾: 目標位置が折れ線の範囲外です');
    },

    memoryBytes() {
      // 平均値 c 個、バッファの値 b 個、最小値と最大値、重み c 個、投入件数 1 個
      return estimateBytes({ numbers: centroidCount + buffered + 2, counters: centroidCount + 1 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      counter.reset();
      buffered = 0;
      means = new Float64Array(0);
      weights = new Float64Array(0);
      centroidCount = 0;
      min = Number.POSITIVE_INFINITY;
      max = Number.NEGATIVE_INFINITY;
      count = 0;
    },

    inspect() {
      const centroids: Centroid[] = [];
      for (let i = 0; i < centroidCount; i++) centroids.push({ mean: means[i]!, weight: weights[i]! });
      return {
        algorithm: 'tdigest',
        compression,
        scale,
        count,
        min: count === 0 ? null : min,
        max: count === 0 ? null : max,
        buffered,
        centroids,
      };
    },
  };
}

/** δ またはスケール関数が不正なら ConfigError(field: 'compression' / 'scale'。δ を先に検査) */
export function createTDigest(options: TDigestOptions): Result<TDigestSketch, ConfigError> {
  const invalid = validateOptions(options);
  if (invalid !== undefined) return err(invalid);
  return ok(makeTDigest(options.compression, options.scale));
}

/** δ またはスケール関数が不正なら ConfigError。乱数は使わないので create はシードを使わない。扱える値域は制限しない */
export function tdigestSpec(options: TDigestOptions): Result<SketchSpec, ConfigError> {
  const invalid = validateOptions(options);
  if (invalid !== undefined) return err(invalid);
  const { compression, scale } = options;
  const params: ParamRecord = {
    algorithm: 'tdigest',
    compression,
    scale,
    bufferCapacity: bufferCapacityOf(compression),
  };
  return ok({
    id: `tdigest-${scale}-c${compression}`,
    label: `t-digest(${scale}, δ=${compression})`,
    params,
    create: () => makeTDigest(compression, scale),
  });
}
