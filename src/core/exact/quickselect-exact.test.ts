import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { isParamRecord } from '../contract/sketch';
import {
  DEFAULT_DEFINITION,
  type PercentileDefinition,
} from '../quantile/definitions';
import { exactQuantileSorted } from '../quantile/reference';
import { createQuickselectExact, quickselectExactSpec } from './quickselect-exact';

const DEFINITIONS: readonly PercentileDefinition[] = [
  'nearest-rank',
  'linear',
  'lower',
  'higher',
  'midpoint',
];

type Sketch = ReturnType<typeof createQuickselectExact>;

function fill(sketch: Sketch, values: readonly number[]): void {
  for (const v of values) {
    const r = sketch.insert(v);
    if (!r.ok) throw new Error('insert failed');
  }
}

function sortedRef(values: readonly number[]): Float64Array {
  return Float64Array.from(values).sort();
}

function queryValue(sketch: Sketch, q: number): number {
  const r = sketch.query(q);
  if (!r.ok) throw new Error('query failed');
  return r.value;
}

/** テスト用の決定的な疑似データ(被験コードの乱数とは独立) */
function pseudoData(n: number): number[] {
  let x = 12345;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(1 + (x % 100000) / 7);
  }
  return out;
}

describe('createQuickselectExact: 基準値との一致', () => {
  it('小さなデータで5定義すべてが基準値計算と同じ値を返す', () => {
    const values = [40, 10, 30, 20, 50, 5, 25];
    for (const definition of DEFINITIONS) {
      const s = createQuickselectExact(1, { definition });
      fill(s, values);
      for (const q of [0, 0.1, 0.25, 0.4, 0.5, 0.9, 0.99, 1]) {
        expect(queryValue(s, q)).toBe(exactQuantileSorted(sortedRef(values), q, definition));
      }
    }
  });

  it('既定は線形補間 ([10,20,30,40], q=0.4 は 22)', () => {
    expect(DEFAULT_DEFINITION).toBe('linear');
    const s = createQuickselectExact(3);
    fill(s, [40, 10, 30, 20]);
    expect(queryValue(s, 0.4)).toBeCloseTo(22, 12);
    const explicit = createQuickselectExact(3, { definition: 'linear' });
    fill(explicit, [40, 10, 30, 20]);
    expect(queryValue(explicit, 0.4)).toBe(queryValue(s, 0.4));
  });

  it('性質: 任意のデータ・定義・シードで基準値計算と一致する', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...DEFINITIONS),
        fc.integer({ min: 0, max: 0xffffffff }),
        (values, q, definition, seed) => {
          const s = createQuickselectExact(seed, { definition });
          fill(s, values);
          return queryValue(s, q) === exactQuantileSorted(sortedRef(values), q, definition);
        },
      ),
    );
  });

  it('問い合わせは投入順を変えず、続けて何度問い合わせても・投入しても正しい', () => {
    const values = pseudoData(300);
    const s = createQuickselectExact(5);
    fill(s, values);
    for (const q of [0.9, 0.1, 0.5, 0.9, 0, 1]) {
      expect(queryValue(s, q)).toBe(exactQuantileSorted(sortedRef(values), q, 'linear'));
    }
    const more = [0.5, 1e5, 2.5];
    fill(s, more);
    const all = [...values, ...more];
    for (const q of [0, 0.3, 0.77, 1]) {
      expect(queryValue(s, q)).toBe(exactQuantileSorted(sortedRef(all), q, 'linear'));
    }
  });
});

describe('createQuickselectExact: 1件と同値', () => {
  it('1件のデータはどの q でもその値を返す', () => {
    for (const definition of DEFINITIONS) {
      const s = createQuickselectExact(0, { definition });
      fill(s, [7.5]);
      for (const q of [0, 0.3, 0.5, 1]) expect(queryValue(s, q)).toBe(7.5);
    }
  });

  it('同値が多いデータでも定義の規則に従った同じ値を返す', () => {
    const values = [3, 3, 3, 3, 3, 3, 9, 3, 3, 3];
    for (const definition of DEFINITIONS) {
      const s = createQuickselectExact(9, { definition });
      fill(s, values);
      expect(queryValue(s, 0.5)).toBe(exactQuantileSorted(sortedRef(values), 0.5, definition));
      expect(queryValue(s, 0.5)).toBe(3);
      expect(queryValue(s, 1)).toBe(9);
    }
    const all = createQuickselectExact(9);
    fill(all, [4, 4, 4, 4]);
    expect(queryValue(all, 0.77)).toBe(4);
  });

  it('全て同値のとき、3分割の1回で終わり比較は 2n(補間なら最小値探索が加わる)', () => {
    // 各要素を「小さい」「大きい」の2回比較し、どちらでもないので移動はコピーのみ
    const lower = createQuickselectExact(1, { definition: 'lower' });
    fill(lower, [4, 4, 4, 4]);
    queryValue(lower, 0.5);
    expect(lower.operationCounts()).toEqual({ comparisons: 8, moves: 4 + 4 });

    // linear, n=4, q=0.5 は lo=1, hi=2。右側 2 要素の最小値探索で比較 1
    const linear = createQuickselectExact(1, { definition: 'linear' });
    fill(linear, [4, 4, 4, 4]);
    queryValue(linear, 0.5);
    expect(linear.operationCounts()).toEqual({ comparisons: 8 + 1, moves: 4 + 4 });
  });
});

describe('createQuickselectExact: エラー時に状態が変わらない', () => {
  it('不正な値は invalid-value で、保持・操作数・メモリを変えない', () => {
    const s = createQuickselectExact(2);
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
      expect(s.insert(v)).toEqual({ ok: false, error: { kind: 'invalid-value', reason } });
    }
    expect(s.memoryBytes()).toBe(mem);
    expect(s.operationCounts()).toEqual(ops);
    expect(queryValue(s, 1)).toBe(3);
  });

  it('範囲外の分位点は quantile-out-of-range で、操作数を変えない', () => {
    const s = createQuickselectExact(2);
    fill(s, [5, 1, 3]);
    const ops = s.operationCounts();
    for (const q of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(s.query(q)).toEqual({ ok: false, error: { kind: 'quantile-out-of-range' } });
    }
    expect(s.operationCounts()).toEqual(ops);
  });

  it('空の状態の問い合わせは empty で、状態を変えない', () => {
    const s = createQuickselectExact(2);
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(0);
  });

  it('エラーの問い合わせは乱数列も進めない(後の操作数が変わらない)', () => {
    const clean = createQuickselectExact(8);
    const noisy = createQuickselectExact(8);
    const values = pseudoData(50);
    fill(clean, values);
    fill(noisy, values);
    noisy.query(2);
    noisy.query(Number.NaN);
    queryValue(clean, 0.5);
    queryValue(noisy, 0.5);
    expect(noisy.operationCounts()).toEqual(clean.operationCounts());
  });

  it('不正なシードで作ろうとすると RangeError を投げる', () => {
    for (const seed of [-1, 1.5, Number.NaN, 2 ** 32]) {
      expect(() => createQuickselectExact(seed)).toThrow(RangeError);
    }
  });
});

describe('createQuickselectExact: メモリ見積もり', () => {
  it('保持している値の個数 × 8 バイトで、問い合わせのコピーを含まない', () => {
    const s = createQuickselectExact(4);
    expect(s.memoryBytes()).toBe(0);
    fill(s, [5, 4, 3, 2, 1]);
    expect(s.memoryBytes()).toBe(40);
    queryValue(s, 0.5);
    expect(s.memoryBytes()).toBe(40);
  });
});

describe('createQuickselectExact: 操作数', () => {
  it('投入で移動が増える(1件につき 1、容量拡張時はコピー分が加わる)', () => {
    const s = createQuickselectExact(4);
    fill(s, [1]);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 1 });
    const before = s.operationCounts().moves;
    fill(s, Array.from({ length: 1000 }, (_, i) => i + 1));
    const after = s.operationCounts().moves;
    expect(after - before).toBeGreaterThan(1000);
    expect(after).toBeLessThan(4 * 1001);
    expect(s.operationCounts().comparisons).toBe(0);
  });

  it('1件の問い合わせはコピーの移動 1 だけを数え、比較は 0', () => {
    const s = createQuickselectExact(4);
    fill(s, [2]);
    const before = s.operationCounts();
    queryValue(s, 0.5);
    const after = s.operationCounts();
    expect(after.moves - before.moves).toBe(1);
    expect(after.comparisons - before.comparisons).toBe(0);
  });

  it('問い合わせごとにコピーを作るので、問い合わせのたびに n 以上の移動が増える', () => {
    const s = createQuickselectExact(4);
    fill(s, pseudoData(100));
    for (let i = 0; i < 3; i++) {
      const before = s.operationCounts();
      queryValue(s, 0.5);
      const after = s.operationCounts();
      expect(after.moves - before.moves).toBeGreaterThanOrEqual(100);
      expect(after.comparisons).toBeGreaterThan(before.comparisons);
    }
  });

  it('比較回数は件数に対して線形のオーダーに収まる(同値だらけでも)', () => {
    for (const make of [pseudoData, (n: number) => Array.from({ length: n }, () => 5)]) {
      const n = 20000;
      const s = createQuickselectExact(6);
      fill(s, make(n));
      const before = s.operationCounts().comparisons;
      queryValue(s, 0.5);
      expect(s.operationCounts().comparisons - before).toBeLessThan(10 * n);
    }
  });

  it('同じシード・同じ入力列なら操作数・メモリ見積もりが同じ', () => {
    const run = (seed: number) => {
      const s = createQuickselectExact(seed);
      fill(s, pseudoData(500));
      queryValue(s, 0.3);
      queryValue(s, 0.95);
      return [s.operationCounts(), s.memoryBytes()];
    };
    expect(run(11)).toEqual(run(11));
  });
});

describe('createQuickselectExact: reset', () => {
  it('値、操作数、メモリ見積もり、乱数列を新規作成直後に戻し、同じ入力で同じ操作数を再現する', () => {
    const values = pseudoData(400);
    const s = createQuickselectExact(21);
    fill(s, values);
    queryValue(s, 0.5);
    queryValue(s, 0.8);
    const firstOps = s.operationCounts();
    s.reset();
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(0);
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    fill(s, values);
    queryValue(s, 0.5);
    queryValue(s, 0.8);
    expect(s.operationCounts()).toEqual(firstOps);
  });
});

describe('quickselectExactSpec', () => {
  it('params に使用する定義を記録し、supportedRange は省略する', () => {
    const spec = quickselectExactSpec();
    expect(spec.params).toEqual({ definition: 'linear' });
    expect(spec.supportedRange).toBeUndefined();
    expect(isParamRecord(spec.params)).toBe(true);
    expect(spec.id).toBe('exact-quickselect-linear');
    expect(spec.label.length).toBeGreaterThan(0);
    const other = quickselectExactSpec({ definition: 'higher' });
    expect(other.params).toEqual({ definition: 'higher' });
    expect(other.id).toBe('exact-quickselect-higher');
  });

  it('create はシードを使い、独立した新規の状態を返す', () => {
    const spec = quickselectExactSpec({ definition: 'lower' });
    const a = spec.create(1);
    const b = spec.create(2);
    fill(a, [3, 1, 2]);
    expect(b.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(queryValue(a, 0.5)).toBe(2);

    const run = (seed: number) => {
      const s = spec.create(seed);
      fill(s, pseudoData(300));
      queryValue(s, 0.5);
      return s.operationCounts();
    };
    expect(run(7)).toEqual(run(7));
  });
});
