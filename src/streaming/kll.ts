import {
  OperationCounter,
  checkPositiveFinite,
  createRng,
  err,
  estimateBytes,
  isQuantile,
  nearestRank,
  ok,
  type ParamRecord,
  type PercentileSketch,
  type Result,
  type Rng,
  type SketchSpec,
} from '../core';
import type { ConfigError } from './errors';
import { sortValues, sortWeighted } from './sort';

/** k の許容範囲(両端を含む整数) */
export const K_RANGE = { min: 8, max: 65536 } as const;
/** 段の容量の縮小率 c。最上段から 1 段下がるごとに容量が c 倍になる */
export const KLL_SHRINK = 2 / 3;

/** シードの省略時の値 */
const DEFAULT_SEED = 1;
/** シードの上限(含まない)。core の createRng と同じ */
const SEED_LIMIT = 2 ** 32;
/** 段の配列の初期容量。足りなくなったら 2 倍に広げる(計数しない。操作数に含めるのは要素の書き込みだけ) */
const INITIAL_LEVEL_CAPACITY = 8;
/** 段の容量の下限 */
const MIN_LEVEL_CAPACITY = 2;

export interface KllOptions {
  readonly k: number;
}

export interface KllLevel {
  readonly level: number;
  /** この段の要素 1 個が表す件数(2^level) */
  readonly weight: number;
  readonly capacity: number;
  /** 保持順(段 0 は投入順、上の段は送られてきた順) */
  readonly values: readonly number[];
}

export interface KllState {
  readonly algorithm: 'kll';
  readonly k: number;
  readonly count: number;
  readonly compactions: number;
  /** 段 0 から順に */
  readonly levels: readonly KllLevel[];
}

export interface KllSketch extends PercentileSketch {
  inspect(): KllState;
}

/** 内部の段。data[0..size) が保持している要素 */
interface Level {
  data: Float64Array;
  size: number;
}

function newLevel(): Level {
  return { data: new Float64Array(INITIAL_LEVEL_CAPACITY), size: 0 };
}

function append(level: Level, value: number): void {
  if (level.size === level.data.length) {
    const next = new Float64Array(level.data.length * 2);
    next.set(level.data);
    level.data = next;
  }
  level.data[level.size++] = value;
}

function validateK(k: unknown): ConfigError | undefined {
  if (typeof k !== 'number' || !Number.isInteger(k)) {
    return { kind: 'invalid-config', field: 'k', reason: 'k は整数でなければなりません' };
  }
  if (k < K_RANGE.min || k > K_RANGE.max) {
    return {
      kind: 'invalid-config',
      field: 'k',
      reason: `k は ${K_RANGE.min} 以上 ${K_RANGE.max} 以下でなければなりません(指定値: ${k})`,
    };
  }
  return undefined;
}

function isValidSeed(seed: unknown): seed is number {
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed < SEED_LIMIT;
}

function validateSeed(seed: unknown): ConfigError | undefined {
  if (isValidSeed(seed)) return undefined;
  return {
    kind: 'invalid-config',
    field: 'seed',
    reason: `シードは 0 以上 2^32 未満の整数でなければなりません(指定値: ${String(seed)})`,
  };
}

/** 段 h の容量(段数 H のとき)。最上段は k、1 段下がるごとに 2/3 倍して切り捨て、下限 2 */
function capacityOf(k: number, levelCount: number, h: number): number {
  return Math.max(MIN_LEVEL_CAPACITY, Math.floor(k * KLL_SHRINK ** (levelCount - 1 - h)));
}

function makeRng(seed: number): Rng {
  const r = createRng(seed);
  if (!r.ok) throw new Error(`KLL のシードが不正です: ${String(seed)}`);
  return r.value;
}

/**
 * 検証済みの k から KLL を作る。seed が不正なら例外を投げる(createKll は先に検証する)。
 * 不変条件: Σ 2^h × |段 h| = n、投入後の保持要素数 ≤ 容量の合計 ≤ 3k + 2H。
 * 簡略化: compaction は怠惰(合計が容量の合計を超えたときだけ、容量以上の最も下の段を 1 回)。
 */
function makeKll(k: number, seed: number): KllSketch {
  const counter = new OperationCounter();
  let rng = makeRng(seed);
  let levels: Level[] = [newLevel()];
  let count = 0;
  let compactions = 0;

  function retained(): number {
    let total = 0;
    for (const level of levels) total += level.size;
    return total;
  }

  function totalCapacity(): number {
    let total = 0;
    for (let h = 0; h < levels.length; h++) total += capacityOf(k, levels.length, h);
    return total;
  }

  function compact(): void {
    let h = 0;
    while (h < levels.length && levels[h]!.size < capacityOf(k, levels.length, h)) h++;
    if (h === levels.length) throw new Error('KLL の内部矛盾: compaction できる段がありません');
    // 最上段なら先に段を足す
    if (h === levels.length - 1) levels.push(newLevel());
    const source = levels[h]!;
    const target = levels[h + 1]!;
    const m = source.size;
    sortValues(source.data, m, counter);
    // 奇数なら整列後の先頭(最小)を残し、残りの偶数個を対象にする
    const start = m % 2;
    const offset = rng.nextIntBelow(2);
    for (let i = start + offset; i < m; i += 2) {
      append(target, source.data[i]!);
      counter.move();
    }
    // 残す最小の要素は整列後すでに先頭にある。その書き戻しを移動 1 と数える
    if (start === 1) counter.move();
    source.size = start;
    compactions++;
  }

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      append(levels[0]!, value);
      counter.move();
      count++;
      if (retained() > totalCapacity()) compact();
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (count === 0) return err({ kind: 'empty' });
      const size = retained();
      const values = new Float64Array(size);
      const weights = new Float64Array(size);
      let at = 0;
      for (let h = 0; h < levels.length; h++) {
        const level = levels[h]!;
        const weight = 2 ** h;
        for (let i = 0; i < level.size; i++) {
          values[at] = level.data[i]!;
          weights[at] = weight;
          at++;
          counter.move(2);
        }
      }
      sortWeighted(values, weights, size, counter);
      const rank = nearestRank(count, quantile);
      let cumulative = 0;
      for (let i = 0; i < size; i++) {
        counter.compare();
        cumulative += weights[i]!;
        if (cumulative >= rank) return ok(values[i]!);
      }
      throw new Error('KLL の内部矛盾: 重みの合計が投入件数に届きません');
    },

    memoryBytes() {
      // 保持するのは要素 m 個、段ごとの要素数 H 個と投入件数 1 個
      return estimateBytes({ numbers: retained(), counters: levels.length + 1 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      counter.reset();
      levels = [newLevel()];
      count = 0;
      compactions = 0;
      rng = makeRng(seed);
    },

    inspect() {
      const snapshot: KllLevel[] = levels.map((level, h) => ({
        level: h,
        weight: 2 ** h,
        capacity: capacityOf(k, levels.length, h),
        values: Array.from(level.data.subarray(0, level.size)),
      }));
      return { algorithm: 'kll', k, count, compactions, levels: snapshot };
    },
  };
}

/** k またはシードが不正なら ConfigError(field: 'k' / 'seed'。k を先に検査)。シードの省略時は 1 */
export function createKll(options: KllOptions & { readonly seed?: number }): Result<KllSketch, ConfigError> {
  const invalidK = validateK(options.k);
  if (invalidK !== undefined) return err(invalidK);
  const seed = options.seed === undefined ? DEFAULT_SEED : options.seed;
  const invalidSeed = validateSeed(seed);
  if (invalidSeed !== undefined) return err(invalidSeed);
  return ok(makeKll(options.k, seed));
}

/** k が不正なら ConfigError。create に不正なシードが渡されると例外を投げる。扱える値域は制限しない */
export function kllSpec(options: KllOptions): Result<SketchSpec, ConfigError> {
  const invalid = validateK(options.k);
  if (invalid !== undefined) return err(invalid);
  const k = options.k;
  const params: ParamRecord = { algorithm: 'kll', k, c: KLL_SHRINK };
  return ok({
    id: `kll-k-${k}`,
    label: `KLL(k=${k})`,
    params,
    create: (seed) => makeKll(k, seed),
  });
}
