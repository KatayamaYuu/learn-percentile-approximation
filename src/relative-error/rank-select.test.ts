import { describe, expect, it } from 'vitest';
import { OperationCounter, exactQuantileSorted } from '../core';
import { selectSlot } from './rank-select';

const select = (counts: number[], q: number, counter = new OperationCounter()): number =>
  selectSlot(counts, counts.reduce((a, b) => a + b, 0), q, counter);

describe('selectSlot', () => {
  it('件数列 [0, 2, 0, 3] での選択', () => {
    const counts = [0, 2, 0, 3];
    expect(select(counts, 0)).toBe(1);
    expect(select(counts, 0.4)).toBe(1);
    expect(select(counts, 0.41)).toBe(3);
    expect(select(counts, 1)).toBe(3);
  });

  it('0.07 × 100 のような丸めの境目でも厳密値と同じスロットを選ぶ', () => {
    // 順位 7 の値が入るスロットは 6 番目(各スロット 1 件、100 件)
    const counts = Array.from({ length: 100 }, () => 1);
    expect(select(counts, 0.07)).toBe(6);
    const sorted = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    for (const q of [0.07, 0.29, 0.57, 0.58, 0.14, 0.01, 0.5, 0.99, 1, 0]) {
      const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
      expect(select(counts, q) + 1).toBe(exact);
    }
  });

  it('分位点に対して単調非減少', () => {
    const counts = [3, 0, 5, 1, 0, 0, 7];
    let previous = -1;
    for (let k = 0; k <= 1000; k++) {
      const i = select(counts, k / 1000);
      expect(i).toBeGreaterThanOrEqual(previous);
      previous = i;
    }
  });

  it('比較は選んだ位置 + 1 回で、移動は数えない', () => {
    const counts = [0, 2, 0, 3];
    for (const q of [0, 0.4, 0.41, 1]) {
      const c = new OperationCounter();
      const i = select(counts, q, c);
      expect(c.snapshot()).toEqual({ comparisons: i + 1, moves: 0 });
    }
  });

  it('総件数が合わず見つからないときは例外を投げる', () => {
    expect(() => selectSlot([1, 1], 5, 1, new OperationCounter())).toThrow();
  });
});
