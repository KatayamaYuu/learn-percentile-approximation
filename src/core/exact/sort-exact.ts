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

export interface ExactOptions {
  readonly definition?: PercentileDefinition;
}

const INITIAL_CAPACITY = 16;

/**
 * 整列方式の厳密解。値を投入順に保持し、問い合わせ時に未整列なら
 * 計数付きのボトムアップ併合整列を行う。整列済みの状態は次の投入まで使い回す。
 * 比較は値と値の大小比較ごとに 1、移動は配列の 1 要素への書き込みごとに 1 を数える。
 */
export function createSortExact(options?: ExactOptions): PercentileSketch {
  const definition = options?.definition ?? DEFAULT_DEFINITION;
  const counter = new OperationCounter();
  let data = new Float64Array(INITIAL_CAPACITY);
  let size = 0;
  let sorted = true;

  function mergeSort(): void {
    let src = data;
    let dst = new Float64Array(data.length);
    for (let width = 1; width < size; width *= 2) {
      for (let start = 0; start < size; start += 2 * width) {
        const mid = Math.min(start + width, size);
        const end = Math.min(start + 2 * width, size);
        let i = start;
        let j = mid;
        let k = start;
        while (i < mid && j < end) {
          counter.compare();
          // 同値は左を先にして安定にする
          if (src[j]! < src[i]!) dst[k++] = src[j++]!;
          else dst[k++] = src[i++]!;
          counter.move();
        }
        while (i < mid) {
          dst[k++] = src[i++]!;
          counter.move();
        }
        while (j < end) {
          dst[k++] = src[j++]!;
          counter.move();
        }
      }
      const t = src;
      src = dst;
      dst = t;
    }
    // 結果は src にある。作業用の配列は捨て、src を保持用の配列とする(容量は同じ)
    data = src;
    sorted = true;
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
      sorted = false;
      return ok(undefined);
    },

    query(quantile) {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (size === 0) return err({ kind: 'empty' });
      if (!sorted) mergeSort();
      const position = resolvePosition(size, quantile, definition);
      return ok(combineOrderStatistics(definition, position, data[position.lo]!, data[position.hi]!));
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
      sorted = true;
    },
  };
}

export function sortExactSpec(options?: ExactOptions): SketchSpec {
  const definition = options?.definition ?? DEFAULT_DEFINITION;
  return {
    id: `exact-sort-${definition}`,
    label: `厳密解(整列方式, ${definition})`,
    params: { definition },
    create: () => createSortExact({ definition }),
  };
}
