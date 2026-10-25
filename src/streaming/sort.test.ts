import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OperationCounter, createSortExact } from '../core';
import type { ConfigError, StreamingExperimentError } from './errors';
import { sortValues, sortWeighted } from './sort';

function sortedCopy(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

describe('sortValues', () => {
  it('昇順に並べ、長さより後ろは変更しない', () => {
    const values = Float64Array.from([5, 3, 9, 1, 7, 100, 50, 25]);
    sortValues(values, 5, new OperationCounter());
    expect(Array.from(values)).toEqual([1, 3, 5, 7, 9, 100, 50, 25]);
  });

  it('長さ 0 と 1 は何もせず操作数も 0', () => {
    const counter = new OperationCounter();
    const values = Float64Array.from([2, 1]);
    sortValues(values, 0, counter);
    sortValues(values, 1, counter);
    expect(Array.from(values)).toEqual([2, 1]);
    expect(counter.snapshot()).toEqual({ comparisons: 0, moves: 0 });
  });

  it('小さな入力の操作数が手計算と一致する(2 要素: 比較 1、移動 2 + 書き戻し 2)', () => {
    const counter = new OperationCounter();
    sortValues(Float64Array.from([2, 1]), 2, counter);
    expect(counter.snapshot()).toEqual({ comparisons: 1, moves: 4 });
  });

  it('逆順 4 要素の操作数が手計算と一致する(比較 4、移動 8)', () => {
    const counter = new OperationCounter();
    sortValues(Float64Array.from([4, 3, 2, 1]), 4, counter);
    expect(counter.snapshot()).toEqual({ comparisons: 4, moves: 8 });
  });

  it('共通基盤の厳密解(整列方式)と比較回数が一致し、移動は投入分を除いて一致する', () => {
    for (const n of [4, 16]) {
      const input = Array.from({ length: n }, (_, i) => ((i * 7919) % 101) + 1);
      const exact = createSortExact();
      for (const v of input) exact.insert(v);
      const before = exact.operationCounts();
      exact.query(0.5);
      const after = exact.operationCounts();

      const counter = new OperationCounter();
      sortValues(Float64Array.from(input), n, counter);
      expect(counter.snapshot()).toEqual({
        comparisons: after.comparisons - before.comparisons,
        moves: after.moves - before.moves,
      });
    }
  });

  it('同じ入力で同じ結果と同じ操作数になる', () => {
    const input = [8, 2, 7, 2, 9, 4, 4, 1, 6, 3, 5];
    const run = () => {
      const counter = new OperationCounter();
      const values = Float64Array.from(input);
      sortValues(values, input.length, counter);
      return { sorted: Array.from(values), counts: counter.snapshot() };
    };
    expect(run()).toEqual(run());
  });

  it('比較回数が length × ceil(log2 length) 以下', () => {
    for (let n = 2; n <= 200; n++) {
      const counter = new OperationCounter();
      const values = Float64Array.from({ length: n }, (_, i) => (i * 37) % 11);
      sortValues(values, n, counter);
      expect(counter.snapshot().comparisons).toBeLessThanOrEqual(n * Math.ceil(Math.log2(n)));
    }
  });

  it('性質: 昇順・多重集合の保存・後ろ不変・比較回数の上限', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { maxLength: 80 }),
        fc.nat(80),
        (xs, rawLength) => {
          const length = Math.min(rawLength, xs.length);
          const values = Float64Array.from(xs);
          const counter = new OperationCounter();
          sortValues(values, length, counter);
          expect(Array.from(values.subarray(0, length))).toEqual(sortedCopy(xs.slice(0, length)));
          expect(Array.from(values.subarray(length))).toEqual(xs.slice(length));
          if (length >= 2) {
            expect(counter.snapshot().comparisons).toBeLessThanOrEqual(length * Math.ceil(Math.log2(length)));
          }
        },
      ),
      { seed: 20260101, numRuns: 200 },
    );
  });
});

describe('sortWeighted', () => {
  it('重みを値に追従させ、長さより後ろは両方とも変更しない', () => {
    const values = Float64Array.from([3, 1, 2, 9, 8]);
    const weights = Float64Array.from([30, 10, 20, 90, 80]);
    sortWeighted(values, weights, 3, new OperationCounter());
    expect(Array.from(values)).toEqual([1, 2, 3, 9, 8]);
    expect(Array.from(weights)).toEqual([10, 20, 30, 90, 80]);
  });

  it('安定: 同値の重みは元の並びを保つ', () => {
    const values = Float64Array.from([2, 1, 2, 1, 2]);
    const weights = Float64Array.from([1, 2, 3, 4, 5]);
    sortWeighted(values, weights, 5, new OperationCounter());
    expect(Array.from(values)).toEqual([1, 1, 2, 2, 2]);
    expect(Array.from(weights)).toEqual([2, 4, 1, 3, 5]);
  });

  it('組の書き込みは移動 2 と数え、比較は値だけ(2 要素: 比較 1、移動 8)', () => {
    const counter = new OperationCounter();
    sortWeighted(Float64Array.from([2, 1]), Float64Array.from([5, 6]), 2, counter);
    expect(counter.snapshot()).toEqual({ comparisons: 1, moves: 8 });
  });

  it('値だけの整列と比較回数が同じで、移動はちょうど 2 倍', () => {
    const input = [9, 4, 6, 4, 1, 8, 3, 3, 7, 2, 5];
    const plain = new OperationCounter();
    sortValues(Float64Array.from(input), input.length, plain);
    const weighted = new OperationCounter();
    sortWeighted(Float64Array.from(input), new Float64Array(input.length).fill(1), input.length, weighted);
    expect(weighted.snapshot().comparisons).toBe(plain.snapshot().comparisons);
    expect(weighted.snapshot().moves).toBe(plain.snapshot().moves * 2);
  });

  it('性質: 昇順・安定・組の保存・後ろ不変・比較回数の上限', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 80 }),
        fc.nat(80),
        (xs, rawLength) => {
          const length = Math.min(rawLength, xs.length);
          const ws = xs.map((_, i) => i + 1);
          const values = Float64Array.from(xs);
          const weights = Float64Array.from(ws);
          const counter = new OperationCounter();
          sortWeighted(values, weights, length, counter);
          const expected = xs
            .slice(0, length)
            .map((v, i) => ({ v, w: ws[i]! }))
            .sort((a, b) => a.v - b.v || a.w - b.w);
          expect(Array.from(values.subarray(0, length))).toEqual(expected.map((e) => e.v));
          expect(Array.from(weights.subarray(0, length))).toEqual(expected.map((e) => e.w));
          expect(Array.from(values.subarray(length))).toEqual(xs.slice(length));
          expect(Array.from(weights.subarray(length))).toEqual(ws.slice(length));
          if (length >= 2) {
            expect(counter.snapshot().comparisons).toBeLessThanOrEqual(length * Math.ceil(Math.log2(length)));
          }
        },
      ),
      { seed: 20260102, numRuns: 200 },
    );
  });
});

describe('エラー型', () => {
  it('種別で判別できる', () => {
    const config: ConfigError = { kind: 'invalid-config', field: 'epsilon', reason: '範囲外' };
    const errors: StreamingExperimentError[] = [
      config,
      { kind: 'invalid-experiment', field: 'counts', reason: '空' },
      { kind: 'generate', error: { kind: 'invalid-count' } },
    ];
    expect(errors.map((e) => e.kind)).toEqual(['invalid-config', 'invalid-experiment', 'generate']);
  });
});
