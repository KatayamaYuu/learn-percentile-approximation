import type { PercentileSketch, SketchSpec } from '../contract/sketch';
import { OperationCounter } from '../cost/op-counter';
import { estimateBytes } from '../cost/memory-model';
import { err, ok } from '../foundation/result';
import { checkPositiveFinite, isQuantile } from '../foundation/validation';
import {
  DEFAULT_DEFINITION,
  combineOrderStatistics,
  resolvePosition,
  type PercentileDefinition,
} from '../quantile/definitions';
import { createRng, type Rng } from '../rng/sfc32';

export interface ExactOptions {
  readonly definition?: PercentileDefinition;
}

const INITIAL_CAPACITY = 16;

function newRng(seed: number): Rng {
  const r = createRng(seed);
  if (!r.ok) throw new RangeError('seed must be an integer in [0, 2^32)');
  return r.value;
}

/**
 * quickselect 方式の厳密解。値を投入順に保持し、問い合わせごとに配列のコピーを作って
 * (n 回の移動)、そのコピー上で反復型の 3 分割 quickselect を行う。
 *
 * 計数規則(整列方式と同じく「実行した箇所」だけを数える):
 * - 比較: 要素と基準値の大小比較 1 回ごとに 1。各要素について「基準値より小さいか」を比べ、
 *   小さくなければ続けて「基準値より大きいか」を比べる(同値は 2 回)。
 *   補間の最小値探索では、値同士の比較 1 回ごとに 1(最初の候補は比較なし)。
 * - 移動: 配列の要素への書き込み 1 回ごとに 1。入れ替えは 2 回(自分自身との入れ替えは実行しないので 0)。
 *   投入は 1、容量拡張のコピーは件数分、問い合わせのコピーは n。
 * - 基準値の選択(乱数)は数えない。
 */
export function createQuickselectExact(seed: number, options?: ExactOptions): PercentileSketch {
  const definition = options?.definition ?? DEFAULT_DEFINITION;
  let rng = newRng(seed);
  const counter = new OperationCounter();
  let data = new Float64Array(INITIAL_CAPACITY);
  let size = 0;

  function swap(a: Float64Array, i: number, j: number): void {
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
    counter.move(2);
  }

  /** work の k 番目(0 始まり)を選び、その値を返す。選択後、k より右はすべて k 番目以上。 */
  function select(work: Float64Array, k: number): number {
    let l = 0;
    let r = size - 1;
    while (l < r) {
      const pivot = work[l + rng.nextIntBelow(r - l + 1)]!;
      let lt = l;
      let gt = r;
      let i = l;
      while (i <= gt) {
        const x = work[i]!;
        counter.compare();
        if (x < pivot) {
          if (i !== lt) swap(work, lt, i);
          lt++;
          i++;
          continue;
        }
        counter.compare();
        if (x > pivot) {
          if (i !== gt) swap(work, i, gt);
          gt--;
        } else {
          i++;
        }
      }
      // [l, lt) < pivot, [lt, gt] == pivot, (gt, r] > pivot
      if (k < lt) r = lt - 1;
      else if (k > gt) l = gt + 1;
      else return work[k]!;
    }
    return work[k]!;
  }

  return {
    insert(value) {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      if (size === data.length) {
        const grown = new Float64Array(data.length * 2);
        grown.set(data.subarray(0, size));
        counter.move(size);
        data = grown;
      }
      data[size++] = value;
      counter.move();
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (size === 0) return err({ kind: 'empty' });
      const position = resolvePosition(size, quantile, definition);
      const work = data.slice(0, size);
      counter.move(size);
      const lower = select(work, position.lo);
      let upper = lower;
      if (position.hi > position.lo && definition !== 'lower' && definition !== 'nearest-rank') {
        // 上側の値を使う定義(linear, midpoint, higher)だけ探す
        // 選択後、lo より右はすべて lo 番目以上なので、その最小値が lo+1 番目の値になる
        upper = work[position.lo + 1]!;
        for (let i = position.lo + 2; i < size; i++) {
          counter.compare();
          if (work[i]! < upper) upper = work[i]!;
        }
      }
      return ok(combineOrderStatistics(definition, position, lower, upper));
    },

    memoryBytes() {
      return estimateBytes({ numbers: size, counters: 0 });
    },

    operationCounts() {
      return counter.snapshot();
    },

    reset() {
      counter.reset();
      data = new Float64Array(INITIAL_CAPACITY);
      size = 0;
      rng = newRng(seed);
    },
  };
}

export function quickselectExactSpec(options?: ExactOptions): SketchSpec {
  const definition = options?.definition ?? DEFAULT_DEFINITION;
  return {
    id: `exact-quickselect-${definition}`,
    label: `厳密解(quickselect 方式, ${definition})`,
    params: { definition },
    create: (seed) => createQuickselectExact(seed, { definition }),
  };
}
