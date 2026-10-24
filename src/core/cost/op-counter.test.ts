import { describe, expect, it } from 'vitest';
import { OperationCounter } from './op-counter';

describe('OperationCounter', () => {
  it('新規作成直後は両方 0', () => {
    expect(new OperationCounter().snapshot()).toEqual({ comparisons: 0, moves: 0 });
  });

  it('引数なしの加算は 1 ずつ', () => {
    const c = new OperationCounter();
    c.compare();
    c.move();
    expect(c.snapshot()).toEqual({ comparisons: 1, moves: 1 });
  });

  it('回数を指定して加算でき、比較と移動は独立に数える', () => {
    const c = new OperationCounter();
    c.compare(5);
    c.compare(2);
    c.move(3);
    c.move(0);
    expect(c.snapshot()).toEqual({ comparisons: 7, moves: 3 });
  });

  it('スナップショットは独立した値で、後の加算や書き換えの影響を受けない', () => {
    const c = new OperationCounter();
    c.compare(2);
    const s1 = c.snapshot();
    c.compare(3);
    c.move(4);
    expect(s1).toEqual({ comparisons: 2, moves: 0 });
    const s2 = c.snapshot();
    expect(s2).not.toBe(s1);
    (s2 as { comparisons: number }).comparisons = 999;
    expect(c.snapshot()).toEqual({ comparisons: 5, moves: 4 });
  });

  it('reset で両方 0 に戻り、その後また数えられる', () => {
    const c = new OperationCounter();
    c.compare(3);
    c.move(3);
    c.reset();
    expect(c.snapshot()).toEqual({ comparisons: 0, moves: 0 });
    c.move(1);
    expect(c.snapshot()).toEqual({ comparisons: 0, moves: 1 });
  });
});
