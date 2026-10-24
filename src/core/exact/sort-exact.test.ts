import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { isParamRecord } from '../contract/sketch';
import {
  DEFAULT_DEFINITION,
  type PercentileDefinition,
} from '../quantile/definitions';
import { exactQuantileSorted } from '../quantile/reference';
import { createSortExact, sortExactSpec } from './sort-exact';

const DEFINITIONS: readonly PercentileDefinition[] = [
  'nearest-rank',
  'linear',
  'lower',
  'higher',
  'midpoint',
];

function fill(sketch: ReturnType<typeof createSortExact>, values: readonly number[]): void {
  for (const v of values) {
    const r = sketch.insert(v);
    if (!r.ok) throw new Error('insert failed');
  }
}

function sortedRef(values: readonly number[]): Float64Array {
  return Float64Array.from(values).sort();
}

function queryValue(sketch: ReturnType<typeof createSortExact>, q: number): number {
  const r = sketch.query(q);
  if (!r.ok) throw new Error('query failed');
  return r.value;
}

describe('createSortExact: 基準値との一致', () => {
  it('小さなデータで5定義すべてが基準値計算と同じ値を返す', () => {
    const values = [40, 10, 30, 20, 50, 5, 25];
    for (const definition of DEFINITIONS) {
      const s = createSortExact({ definition });
      fill(s, values);
      for (const q of [0, 0.1, 0.25, 0.4, 0.5, 0.9, 0.99, 1]) {
        expect(queryValue(s, q)).toBe(exactQuantileSorted(sortedRef(values), q, definition));
      }
    }
  });

  it('既定は線形補間 ([10,20,30,40], q=0.4 は 22)', () => {
    expect(DEFAULT_DEFINITION).toBe('linear');
    const s = createSortExact();
    fill(s, [40, 10, 30, 20]);
    expect(queryValue(s, 0.4)).toBeCloseTo(22, 12);
    const explicit = createSortExact({ definition: 'linear' });
    fill(explicit, [40, 10, 30, 20]);
    expect(queryValue(explicit, 0.4)).toBe(queryValue(s, 0.4));
  });

  it('性質: 任意のデータ・定義で基準値計算と一致する', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...DEFINITIONS),
        (values, q, definition) => {
          const s = createSortExact({ definition });
          fill(s, values);
          return queryValue(s, q) === exactQuantileSorted(sortedRef(values), q, definition);
        },
      ),
    );
  });
});

describe('createSortExact: 1件と同値', () => {
  it('1件のデータはどの q でもその値を返す', () => {
    for (const definition of DEFINITIONS) {
      const s = createSortExact({ definition });
      fill(s, [7.5]);
      for (const q of [0, 0.3, 0.5, 1]) expect(queryValue(s, q)).toBe(7.5);
    }
  });

  it('同値が多いデータでも定義の規則に従った同じ値を返す', () => {
    const values = [3, 3, 3, 3, 3, 3, 9, 3, 3, 3];
    for (const definition of DEFINITIONS) {
      const s = createSortExact({ definition });
      fill(s, values);
      expect(queryValue(s, 0.5)).toBe(exactQuantileSorted(sortedRef(values), 0.5, definition));
      expect(queryValue(s, 0.5)).toBe(3);
    }
    const all = createSortExact();
    fill(all, [4, 4, 4, 4]);
    expect(queryValue(all, 0.77)).toBe(4);
  });
});

describe('createSortExact: エラー時に状態が変わらない', () => {
  it('不正な値は invalid-value で、保持・操作数・メモリを変えない', () => {
    const s = createSortExact();
    fill(s, [1, 2, 3]);
    const mem = s.memoryBytes();
    const ops = s.operationCounts();
    const cases: Array<[number, string]> = [
      [Number.NaN, 'not-a-number'],
      [Number.POSITIVE_INFINITY, 'not-finite'],
      [Number.NEGATIVE_INFINITY, 'not-finite'],
      [0, 'not-positive'],
      [-1, 'not-positive'],
    ];
    for (const [v, reason] of cases) {
      const r = s.insert(v);
      expect(r).toEqual({ ok: false, error: { kind: 'invalid-value', reason } });
    }
    expect(s.memoryBytes()).toBe(mem);
    expect(s.operationCounts()).toEqual(ops);
    expect(queryValue(s, 1)).toBe(3);
  });

  it('範囲外の分位点は quantile-out-of-range で、操作数を変えない', () => {
    const s = createSortExact();
    fill(s, [5, 1, 3]);
    const ops = s.operationCounts();
    for (const q of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(s.query(q)).toEqual({ ok: false, error: { kind: 'quantile-out-of-range' } });
    }
    expect(s.operationCounts()).toEqual(ops);
  });

  it('空の状態の問い合わせは empty で、状態を変えない', () => {
    const s = createSortExact();
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(0);
  });
});

describe('createSortExact: メモリ見積もり', () => {
  it('保持している値の個数 × 8 バイトで、問い合わせの作業領域を含まない', () => {
    const s = createSortExact();
    expect(s.memoryBytes()).toBe(0);
    fill(s, [5, 4, 3, 2, 1]);
    expect(s.memoryBytes()).toBe(40);
    queryValue(s, 0.5);
    expect(s.memoryBytes()).toBe(40);
    fill(s, Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s.memoryBytes()).toBe(105 * 8);
  });
});

describe('createSortExact: 操作数', () => {
  it('投入で移動が増える(1件につき 1、容量拡張時はコピー分が加わる)', () => {
    const s = createSortExact();
    fill(s, [1]);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 1 });
    const before = s.operationCounts().moves;
    fill(s, Array.from({ length: 1000 }, (_, i) => i + 1));
    const after = s.operationCounts().moves;
    expect(after - before).toBeGreaterThan(1000);
    // 倍々拡張なので、コピーの合計は件数の定数倍に収まる
    expect(after).toBeLessThan(4 * 1001);
    expect(s.operationCounts().comparisons).toBe(0);
  });

  it('問い合わせで整列の比較と移動が増える', () => {
    const s = createSortExact();
    fill(s, [8, 7, 6, 5, 4, 3, 2, 1]);
    const before = s.operationCounts();
    queryValue(s, 0.5);
    const after = s.operationCounts();
    expect(after.comparisons).toBeGreaterThan(before.comparisons);
    expect(after.moves).toBeGreaterThan(before.moves);
  });

  it('逆順 8 件の併合整列は、比較 12・移動 24 回(ボトムアップ)', () => {
    const s = createSortExact();
    fill(s, [8, 7, 6, 5, 4, 3, 2, 1]);
    const before = s.operationCounts();
    queryValue(s, 0.5);
    const after = s.operationCounts();
    // 幅1,2,4 の3段階で各 8 回の書き込み(24)、比較は 4 + 4 + 4
    expect(after.moves - before.moves).toBe(24);
    expect(after.comparisons - before.comparisons).toBe(12);
  });

  it('整列済みの状態は次の投入まで使い回され、再問い合わせで操作数が増えない', () => {
    const s = createSortExact();
    fill(s, [3, 1, 2, 5, 4]);
    queryValue(s, 0.5);
    const ops = s.operationCounts();
    queryValue(s, 0.9);
    queryValue(s, 0.1);
    expect(s.operationCounts()).toEqual(ops);
    fill(s, [0.5]);
    queryValue(s, 0.5);
    expect(s.operationCounts().comparisons).toBeGreaterThan(ops.comparisons);
  });

  it('投入後に再整列しても結果が正しい', () => {
    const s = createSortExact();
    fill(s, [5, 3, 9]);
    expect(queryValue(s, 1)).toBe(9);
    fill(s, [100, 1]);
    expect(queryValue(s, 1)).toBe(100);
    expect(queryValue(s, 0)).toBe(1);
  });

  it('同じ入力列なら操作数・メモリ見積もりが同じ', () => {
    const run = () => {
      const s = createSortExact();
      fill(s, [9, 2, 7, 4, 4, 1]);
      queryValue(s, 0.3);
      return [s.operationCounts(), s.memoryBytes()];
    };
    expect(run()).toEqual(run());
  });
});

describe('createSortExact: reset', () => {
  it('値、操作数、メモリ見積もりを新規作成直後に戻し、同じ入力で同じ結果を再現する', () => {
    const s = createSortExact();
    fill(s, [9, 2, 7, 4]);
    queryValue(s, 0.5);
    const firstOps = s.operationCounts();
    s.reset();
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(0);
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    fill(s, [9, 2, 7, 4]);
    expect(queryValue(s, 0.5)).toBe(5.5);
    expect(s.operationCounts()).toEqual(firstOps);
  });
});

describe('sortExactSpec', () => {
  it('params に使用する定義を記録し、supportedRange は省略する', () => {
    const spec = sortExactSpec();
    expect(spec.params).toEqual({ definition: 'linear' });
    expect(spec.supportedRange).toBeUndefined();
    expect(isParamRecord(spec.params)).toBe(true);
    expect(spec.id.length).toBeGreaterThan(0);
    expect(spec.label.length).toBeGreaterThan(0);
    const other = sortExactSpec({ definition: 'higher' });
    expect(other.params).toEqual({ definition: 'higher' });
  });

  it('create はシードを無視して、独立した新規の状態を返す', () => {
    const spec = sortExactSpec({ definition: 'lower' });
    const a = spec.create(1);
    const b = spec.create(2);
    fill(a, [3, 1, 2]);
    expect(b.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(queryValue(a, 0.5)).toBe(2);
  });
});
