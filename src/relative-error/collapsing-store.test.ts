import { describe, expect, it } from 'vitest';
import { OperationCounter } from '../core';
import { CollapsingStore } from './collapsing-store';

function fill(store: CollapsingStore, indices: readonly number[], counter = new OperationCounter()): OperationCounter {
  for (const i of indices) store.add(i, counter);
  return counter;
}

const snapshot = (s: CollapsingStore) => {
  const v = s.view();
  return { min: v.minIndex, counts: Array.from(v.counts), total: v.total, n: v.collapseCount, up: v.collapsedUpToIndex };
};

describe('範囲の拡張(縮約なし)', () => {
  it('空から始まり、範囲内・上側・下側に広がる', () => {
    const s = new CollapsingStore(10);
    expect(snapshot(s)).toEqual({ min: null, counts: [], total: 0, n: 0, up: null });
    fill(s, [5]);
    expect(snapshot(s)).toMatchObject({ min: 5, counts: [1], total: 1 });
    fill(s, [5, 7]);
    expect(snapshot(s)).toMatchObject({ min: 5, counts: [2, 0, 1], total: 3 });
    fill(s, [3]);
    expect(snapshot(s)).toMatchObject({ min: 3, counts: [1, 0, 2, 0, 1], total: 4, n: 0, up: null });
    expect(s.view().span).toBe(5);
  });

  it('範囲の長さがちょうど上限になるまでは縮約しない', () => {
    const s = new CollapsingStore(4);
    fill(s, [0, 3]);
    expect(snapshot(s)).toMatchObject({ min: 0, counts: [1, 0, 0, 1], n: 0 });
    fill(s, [-0]);
    expect(snapshot(s).n).toBe(0);
  });
});

describe('上側の縮約', () => {
  it('小さい番号の件数を新しい最小番号へ合算し、総件数は変わらない', () => {
    const s = new CollapsingStore(3);
    fill(s, [0, 1, 1, 2]);
    expect(snapshot(s)).toMatchObject({ min: 0, counts: [1, 2, 1], n: 0 });
    fill(s, [3]);
    // 新しい最小番号 t = 1。番号 0 は 1 に合算される
    expect(snapshot(s)).toEqual({ min: 1, counts: [3, 1, 1], total: 5, n: 1, up: 1 });
    expect(s.view().span).toBe(3);
  });

  it('旧範囲より遠い上側への投入では、全件が合算先に入る', () => {
    const s = new CollapsingStore(3);
    fill(s, [0, 1, 2, 2]);
    fill(s, [100]);
    expect(snapshot(s)).toEqual({ min: 98, counts: [4, 0, 1], total: 5, n: 1, up: 98 });
  });

  it('最大番号のバケットは縮約で合算されず、記録は単調に増える', () => {
    const s = new CollapsingStore(2);
    const ups: number[] = [];
    let n = 0;
    for (const i of [0, 1, 2, 3, 4, 10]) {
      fill(s, [i]);
      const v = s.view();
      expect(v.counts[v.span - 1]).toBe(1);
      expect(v.collapseCount).toBeGreaterThanOrEqual(n);
      n = v.collapseCount;
      if (v.collapsedUpToIndex !== null) ups.push(v.collapsedUpToIndex);
    }
    expect(ups).toEqual([...ups].sort((a, b) => a - b));
    expect(n).toBe(4);
  });
});

describe('下側で範囲を超える番号', () => {
  it('範囲の長さが m を超えない最小番号のバケットに数える', () => {
    const s = new CollapsingStore(3);
    fill(s, [10, 11, 12]);
    fill(s, [0]);
    expect(snapshot(s)).toEqual({ min: 10, counts: [2, 1, 1], total: 4, n: 1, up: 10 });
  });

  it('範囲が上限に満たないときは、範囲を m まで広げてその最小番号に数える', () => {
    const s = new CollapsingStore(4);
    fill(s, [10, 11]);
    fill(s, [0]);
    expect(snapshot(s)).toEqual({ min: 8, counts: [1, 0, 1, 1], total: 3, n: 1, up: 8 });
  });

  it('記録の合算先は下側でも単調に増える', () => {
    const s = new CollapsingStore(2);
    fill(s, [10, 11, 0]);
    expect(s.view().collapsedUpToIndex).toBe(10);
    fill(s, [20]);
    expect(s.view().collapsedUpToIndex).toBe(19);
    fill(s, [0]);
    expect(s.view().collapsedUpToIndex).toBe(19);
  });
});

describe('m = 1 と reset', () => {
  it('m = 1 では常に 1 個のバケットで、総件数が保たれる', () => {
    const s = new CollapsingStore(1);
    fill(s, [4, 9, 2, 9]);
    const v = s.view();
    expect(v.span).toBe(1);
    expect(v.total).toBe(4);
    expect(Array.from(v.counts)).toEqual([4]);
    expect(v.minIndex).toBe(9);
  });

  it('reset は範囲・総件数・縮約の記録を戻し、上限を保つ', () => {
    const s = new CollapsingStore(2);
    fill(s, [0, 5, 9]);
    s.reset();
    expect(snapshot(s)).toEqual({ min: null, counts: [], total: 0, n: 0, up: null });
    fill(s, [0, 1, 2]);
    expect(s.view().span).toBe(2);
  });
});

describe('操作数', () => {
  it('範囲内の投入は比較 2 回以下・移動 2 回', () => {
    const s = new CollapsingStore(8);
    fill(s, [0, 7]);
    const c = new OperationCounter();
    s.add(3, c);
    expect(c.snapshot()).toEqual({ comparisons: 2, moves: 2 });
  });

  it('拡張・縮約を伴う投入の移動は m + 1 回以下で、比較は 2 回以下', () => {
    for (const m of [1, 2, 5, 64]) {
      const s = new CollapsingStore(m);
      // 昇順・降順・ランダム風
      const order: number[] = [];
      for (let i = 0; i < 300; i++) order.push(i);
      for (let i = 300; i > 0; i--) order.push(i);
      for (let i = 0; i < 300; i++) order.push((i * 7919) % 401);
      for (const idx of order) {
        const c = new OperationCounter();
        s.add(idx, c);
        const { comparisons, moves } = c.snapshot();
        expect(comparisons).toBeLessThanOrEqual(2);
        expect(moves).toBeLessThanOrEqual(m + 1);
        expect(s.view().span).toBeLessThanOrEqual(m);
      }
      const v = s.view();
      expect(Array.from(v.counts).reduce((a, b) => a + b, 0)).toBe(v.total);
      expect(v.total).toBe(order.length);
    }
  });
});
