import {
  OperationCounter,
  checkPositiveFinite,
  err,
  estimateBytes,
  isQuantile,
  nearestRank,
  ok,
  type ParamRecord,
  type PercentileSketch,
  type Result,
  type SketchSpec,
} from '../core';
import type { ConfigError } from './errors';

/** ε の許容範囲(両端を含む) */
export const EPSILON_RANGE = { min: 0.0001, max: 0.5 } as const;

export interface GkOptions {
  readonly epsilon: number;
}

export interface GkTuple {
  readonly value: number;
  /** 直前のタプルとの最小順位の差 */
  readonly g: number;
  /** 順位の幅(rmax − rmin) */
  readonly delta: number;
}

export interface GkState {
  readonly algorithm: 'gk';
  readonly epsilon: number;
  readonly count: number;
  /** 値の昇順 */
  readonly tuples: readonly GkTuple[];
}

export interface GkSketch extends PercentileSketch {
  inspect(): GkState;
}

/** タプル配列の初期容量。足りなくなったら 2 倍に広げる(複製したタプルごとに移動 3) */
const INITIAL_CAPACITY = 16;
/** タプル 1 つ(値、g、順位の幅)の書き込みを移動 3 と数える */
const MOVES_PER_TUPLE = 3;

function validateEpsilon(epsilon: unknown): ConfigError | undefined {
  if (typeof epsilon !== 'number' || !Number.isFinite(epsilon)) {
    return { kind: 'invalid-config', field: 'epsilon', reason: 'ε は有限の数でなければなりません' };
  }
  if (epsilon < EPSILON_RANGE.min || epsilon > EPSILON_RANGE.max) {
    return {
      kind: 'invalid-config',
      field: 'epsilon',
      reason: `ε は ${EPSILON_RANGE.min} 以上 ${EPSILON_RANGE.max} 以下でなければなりません(指定値: ${epsilon})`,
    };
  }
  return undefined;
}

/**
 * 検証済みの ε から GK を作る。
 * 不変条件: Σ g = n、すべてのタプルで g + Δ ≤ max(1, ⌊2εn⌋)、先頭と末尾は Δ = 0。
 * 簡略化: 論文のバンドは使わず、周期ごとに右から左へ併合する(保証は崩さない)。
 */
function makeGk(epsilon: number): GkSketch {
  const period = Math.max(1, Math.floor(1 / (2 * epsilon)));
  const counter = new OperationCounter();
  let values = new Float64Array(INITIAL_CAPACITY);
  let gs = new Float64Array(INITIAL_CAPACITY);
  let deltas = new Float64Array(INITIAL_CAPACITY);
  let size = 0;
  let count = 0;

  function grow(): void {
    const capacity = values.length * 2;
    const nextValues = new Float64Array(capacity);
    const nextGs = new Float64Array(capacity);
    const nextDeltas = new Float64Array(capacity);
    nextValues.set(values);
    nextGs.set(gs);
    nextDeltas.set(deltas);
    values = nextValues;
    gs = nextGs;
    deltas = nextDeltas;
    counter.move(size * MOVES_PER_TUPLE);
  }

  /** value より大きい最初のタプルの添字(なければ size)。比較は実行した分だけ数える */
  function upperBound(value: number): number {
    let lo = 0;
    let hi = size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      counter.compare();
      if (values[mid]! > value) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  function compress(): void {
    const threshold = Math.floor(2 * epsilon * count);
    for (let i = size - 2; i >= 1; i--) {
      counter.compare();
      if (gs[i]! + gs[i + 1]! + deltas[i + 1]! > threshold) continue;
      // タプル i を i + 1 に併合する
      gs[i + 1]! += gs[i]!;
      counter.move();
      for (let j = i; j < size - 1; j++) {
        values[j] = values[j + 1]!;
        gs[j] = gs[j + 1]!;
        deltas[j] = deltas[j + 1]!;
        counter.move(MOVES_PER_TUPLE);
      }
      size--;
    }
  }

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      const at = upperBound(value);
      const delta = at === 0 || at === size ? 0 : gs[at]! + deltas[at]! - 1;
      if (size === values.length) grow();
      for (let j = size; j > at; j--) {
        values[j] = values[j - 1]!;
        gs[j] = gs[j - 1]!;
        deltas[j] = deltas[j - 1]!;
        counter.move(MOVES_PER_TUPLE);
      }
      values[at] = value;
      gs[at] = 1;
      deltas[at] = delta;
      counter.move(MOVES_PER_TUPLE);
      size++;
      count++;
      if (count % period === 0) compress();
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (size === 0) return err({ kind: 'empty' });
      if (quantile === 0) return ok(values[0]!);
      const limit = nearestRank(count, quantile) + epsilon * count;
      let rmin = 0;
      for (let i = 0; i < size; i++) {
        counter.compare();
        rmin += gs[i]!;
        if (rmin + deltas[i]! > limit) return ok(values[Math.max(i - 1, 0)]!);
      }
      return ok(values[size - 1]!);
    },

    memoryBytes() {
      // 保持するのは値 s 個、g と順位の幅の 2s 個、件数 1 個
      return estimateBytes({ numbers: size, counters: 2 * size + 1 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      counter.reset();
      values = new Float64Array(INITIAL_CAPACITY);
      gs = new Float64Array(INITIAL_CAPACITY);
      deltas = new Float64Array(INITIAL_CAPACITY);
      size = 0;
      count = 0;
    },

    inspect() {
      const tuples: GkTuple[] = [];
      for (let i = 0; i < size; i++) {
        tuples.push({ value: values[i]!, g: gs[i]!, delta: deltas[i]! });
      }
      return { algorithm: 'gk', epsilon, count, tuples };
    },
  };
}

/** ε が不正なら ConfigError(field: 'epsilon')。成功時は共通規約と内部状態の観察を備えた GK */
export function createGk(options: GkOptions): Result<GkSketch, ConfigError> {
  const invalid = validateEpsilon(options.epsilon);
  if (invalid !== undefined) return err(invalid);
  return ok(makeGk(options.epsilon));
}

/** ε が不正なら ConfigError。create はシードを使わない。扱える値域は制限しない */
export function gkSpec(options: GkOptions): Result<SketchSpec, ConfigError> {
  const invalid = validateEpsilon(options.epsilon);
  if (invalid !== undefined) return err(invalid);
  const epsilon = options.epsilon;
  const params: ParamRecord = { algorithm: 'gk', epsilon };
  return ok({
    id: `gk-eps-${epsilon}`,
    label: `GK(ε=${epsilon})`,
    params,
    create: () => makeGk(epsilon),
  });
}
