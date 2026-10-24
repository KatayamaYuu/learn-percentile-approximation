import { describe, expect, it } from 'vitest';
import type { ParamRecord, PercentileSketch, SketchSpec } from '../contract/sketch';
import type { SketchError } from '../foundation/errors';
import { err, ok, type Result } from '../foundation/result';
import { sortExactSpec } from '../exact/sort-exact';
import { quickselectExactSpec } from '../exact/quickselect-exact';
import { exactQuantileSorted } from '../quantile/reference';
import { runBenchmark, withoutTiming } from './run-benchmark';
import type { AlgorithmResult, BenchmarkInput, BenchmarkResult } from './types';

interface MockOptions {
  throwOnCreate?: boolean;
  insertError?: SketchError;
  throwOnInsert?: boolean;
  queryError?: SketchError;
  throwOnQuery?: boolean;
  estimate?: number;
  onCreate?: (seed: number) => void;
  inserted?: number[];
}

function mockSpec(id: string, o: MockOptions = {}, params?: ParamRecord): SketchSpec {
  return {
    id,
    label: `mock ${id}`,
    ...(params !== undefined ? { params } : {}),
    create(seed: number): PercentileSketch {
      o.onCreate?.(seed);
      if (o.throwOnCreate) throw new Error('create failed');
      let n = 0;
      let moves = 0;
      return {
        insert(value: number): Result<void, SketchError> {
          if (o.throwOnInsert) throw new Error('insert failed');
          if (o.insertError) return err(o.insertError);
          o.inserted?.push(value);
          n += 1;
          moves += 1;
          return ok(undefined);
        },
        query(): Result<number, SketchError> {
          if (o.throwOnQuery) throw new Error('query failed');
          if (o.queryError) return err(o.queryError);
          moves += 2;
          return ok(o.estimate ?? 5);
        },
        memoryBytes: () => 8 * n,
        operationCounts: () => ({ comparisons: 0, moves }),
        reset() {
          n = 0;
          moves = 0;
        },
      };
    },
  };
}

const DATA = [3, 1, 4, 1.5, 9, 2.6, 5.3, 5.8, 9.7, 2.3];

function base(extra: Partial<BenchmarkInput> = {}): BenchmarkInput {
  return {
    data: DATA,
    quantiles: [0, 0.5, 0.99, 1],
    sketches: [sortExactSpec(), quickselectExactSpec()],
    seed: 42,
    ...extra,
  };
}

function runOk(input: BenchmarkInput): BenchmarkResult {
  const r = runBenchmark(input);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function fakeClock(step = 1.5): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

describe('runBenchmark: 結果の完全性 (6.1, 6.2, 6.3)', () => {
  it('全項目が揃い、基準値は整列済みコピーからの計算と一致し、入力は変更されない', () => {
    const data = Float64Array.from(DATA);
    const snapshot = Array.from(data);
    const result = runOk(base({ data, now: fakeClock() }));
    expect(Array.from(data)).toEqual(snapshot);
    expect(result.schemaVersion).toBe(1);
    expect(result.count).toBe(DATA.length);
    expect(result.seed).toBe(42);
    expect(result.referenceDefinition).toBe('linear');
    expect(result.meta).toEqual({});
    expect(result.algorithms.map((a) => a.id)).toEqual(['exact-sort-linear', 'exact-quickselect-linear']);
    const sorted = Float64Array.from(DATA).sort();
    for (const a of result.algorithms) {
      expect(a.status).toBe('ok');
      if (a.status !== 'ok') continue;
      expect(a.params).toEqual({ definition: 'linear' });
      expect(a.afterInsertion.operations.moves).toBeGreaterThan(0);
      expect(a.afterInsertion.memoryBytes).toBeGreaterThan(0);
      expect(a.afterInsertion.elapsedMs).toBeGreaterThan(0);
      expect(a.queries.map((q) => q.quantile)).toEqual([0, 0.5, 0.99, 1]);
      for (const q of a.queries) {
        expect(q.exact).toBe(exactQuantileSorted(sorted, q.quantile, 'linear'));
        expect(q.estimate).toBeCloseTo(q.exact, 12);
        expect(q.absoluteError).toBeCloseTo(Math.abs(q.estimate - q.exact), 12);
        expect(q.relativeError).toBeCloseTo(Math.abs(q.estimate - q.exact) / q.exact, 12);
        expect(q.rankError).toBeGreaterThanOrEqual(0);
        expect(q.rankError).toBeLessThanOrEqual(1);
        expect(q.operations.comparisons).toBeGreaterThanOrEqual(0);
        expect(q.operations.moves).toBeGreaterThanOrEqual(0);
        expect(q.elapsedMs).toBeGreaterThan(0);
      }
      const added = a.queries.reduce((s, q) => s + q.operations.comparisons + q.operations.moves, 0);
      const before = a.afterInsertion.operations.comparisons + a.afterInsertion.operations.moves;
      const after = a.afterQueries.operations.comparisons + a.afterQueries.operations.moves;
      expect(added).toBeGreaterThan(0);
      expect(after).toBe(before + added);
      expect(a.afterQueries.memoryBytes).toBeGreaterThan(0);
    }
  });

  it('Float64Array と number[] の入力で同じ結果になる', () => {
    const a = withoutTiming(runOk(base({ data: Float64Array.from(DATA) })));
    const b = withoutTiming(runOk(base({ data: DATA })));
    expect(a).toEqual(b);
  });

  it('JSON の往復で等しい(エラー結果を含む)', () => {
    const result = runOk(
      base({
        sketches: [sortExactSpec(), mockSpec('bad', { estimate: 0 }), mockSpec('boom', { throwOnQuery: true })],
        meta: { dist: 'uniform', order: 'random', seed: 7 },
        now: fakeClock(),
      }),
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('時間は注入した now で測る(挿入の前後と各問い合わせの前後)', () => {
    const result = runOk(base({ sketches: [mockSpec('m')], now: fakeClock(2) }));
    const a = result.algorithms[0]!;
    if (a.status !== 'ok') throw new Error('expected ok');
    expect(a.afterInsertion.elapsedMs).toBe(2);
    expect(a.queries.map((q) => q.elapsedMs)).toEqual([2, 2, 2, 2]);
  });
});

describe('runBenchmark: 再現性と基準定義 (6.4, 6.5)', () => {
  it('now が違っても withoutTiming を通せば同じで、時間以外は変わらない', () => {
    const r1 = runOk(base({ now: fakeClock(1) }));
    const r2 = runOk(base({ now: fakeClock(7.25) }));
    expect(r1).not.toEqual(r2);
    expect(withoutTiming(r1)).toEqual(withoutTiming(r2));
  });

  it('withoutTiming は elapsedMs だけを 0 にした複製を返し、元は変更しない', () => {
    const r = runOk(base({ sketches: [sortExactSpec(), mockSpec('x', { throwOnQuery: true })], now: fakeClock() }));
    const copy = withoutTiming(r);
    expect(copy).not.toBe(r);
    const first = r.algorithms[0]!;
    if (first.status !== 'ok') throw new Error('expected ok');
    expect(first.afterInsertion.elapsedMs).toBeGreaterThan(0);
    const c0 = copy.algorithms[0]!;
    if (c0.status !== 'ok') throw new Error('expected ok');
    expect(c0.afterInsertion.elapsedMs).toBe(0);
    expect(c0.queries.every((q) => q.elapsedMs === 0)).toBe(true);
    expect(c0.afterInsertion.operations).toEqual(first.afterInsertion.operations);
    expect(copy.algorithms[1]).toEqual(r.algorithms[1]);
  });

  it('既定のまま実行しても(performance.now)結果が有限の数になる', () => {
    const r = runOk(base());
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('基準定義を切り替えると基準値が変わり、結果に記録される', () => {
    const data = [10, 20, 30, 40];
    const mk = (referenceDefinition?: 'lower' | 'higher' | 'nearest-rank') =>
      runOk({
        data,
        quantiles: [0.5],
        sketches: [mockSpec('m', { estimate: 25 })],
        seed: 1,
        ...(referenceDefinition ? { referenceDefinition } : {}),
      });
    const exactOf = (r: BenchmarkResult) => {
      const a = r.algorithms[0]!;
      if (a.status !== 'ok') throw new Error('expected ok');
      return a.queries[0]!.exact;
    };
    expect(exactOf(mk())).toBe(25);
    expect(mk().referenceDefinition).toBe('linear');
    expect(exactOf(mk('lower'))).toBe(20);
    expect(exactOf(mk('higher'))).toBe(30);
    expect(exactOf(mk('nearest-rank'))).toBe(20);
    expect(mk('higher').referenceDefinition).toBe('higher');
  });

  it('全アルゴリズムに同じシードを渡し、同じデータを同じ順序で投入する', () => {
    const seeds: number[] = [];
    const inserted: number[] = [];
    runOk(
      base({
        sketches: [
          mockSpec('a', { onCreate: (s) => seeds.push(s), inserted }),
          mockSpec('b', { onCreate: (s) => seeds.push(s) }),
        ],
        seed: 1234,
      }),
    );
    expect(seeds).toEqual([1234, 1234]);
    expect(inserted).toEqual(DATA);
  });
});

describe('runBenchmark: 失敗の記録と続行 (6.6)', () => {
  const find = (r: BenchmarkResult, id: string): AlgorithmResult => {
    const a = r.algorithms.find((x) => x.id === id);
    if (!a) throw new Error(`missing ${id}`);
    return a;
  };

  it('一部が失敗しても残りを実行し、並びは入力の sketches と同じ', () => {
    const result = runOk(
      base({
        sketches: [
          mockSpec('create-throws', { throwOnCreate: true }),
          sortExactSpec(),
          mockSpec('insert-throws', { throwOnInsert: true }),
          mockSpec('query-throws', { throwOnQuery: true }),
          quickselectExactSpec(),
        ],
      }),
    );
    expect(result.algorithms.map((a) => a.id)).toEqual([
      'create-throws',
      'exact-sort-linear',
      'insert-throws',
      'query-throws',
      'exact-quickselect-linear',
    ]);
    expect(find(result, 'exact-sort-linear').status).toBe('ok');
    expect(find(result, 'exact-quickselect-linear').status).toBe('ok');
    expect(find(result, 'create-throws')).toMatchObject({ status: 'error', stage: 'create', errorKind: 'exception' });
    expect(find(result, 'insert-throws')).toMatchObject({ status: 'error', stage: 'insert', errorKind: 'exception' });
    expect(find(result, 'query-throws')).toMatchObject({ status: 'error', stage: 'query', errorKind: 'exception' });
  });

  it('扱えない値の投入は insert 段階の unsupported-value として記録する', () => {
    const result = runOk(
      base({ sketches: [mockSpec('narrow', { insertError: { kind: 'unsupported-value', detail: 'too big' } }), sortExactSpec()] }),
    );
    expect(find(result, 'narrow')).toMatchObject({ status: 'error', stage: 'insert', errorKind: 'unsupported-value' });
    expect(find(result, 'exact-sort-linear').status).toBe('ok');
  });

  it('SketchError の kind をそのまま写す(insert / query)', () => {
    const result = runOk(
      base({
        sketches: [
          mockSpec('i', { insertError: { kind: 'invalid-value', reason: 'not-positive' } }),
          mockSpec('q', { queryError: { kind: 'empty' } }),
        ],
      }),
    );
    expect(find(result, 'i')).toMatchObject({ stage: 'insert', errorKind: 'invalid-value' });
    expect(find(result, 'q')).toMatchObject({ stage: 'query', errorKind: 'empty' });
  });

  it.each([
    ['0', 0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['負数', -1],
  ])('推定値が %s なら契約違反として query 段階に記録し、誤差を計算しない', (_name, estimate) => {
    const result = runOk(base({ sketches: [mockSpec('bad', { estimate }), sortExactSpec()] }));
    const bad = find(result, 'bad');
    expect(bad).toMatchObject({ status: 'error', stage: 'query', errorKind: 'invalid-estimate' });
    expect(find(result, 'exact-sort-linear').status).toBe('ok');
    const json = JSON.stringify(result);
    expect(json).not.toContain('null');
    expect(JSON.parse(json)).toEqual(result);
  });

  it('エラー結果には ok 用の項目(queries など)が入らない', () => {
    const result = runOk(base({ sketches: [mockSpec('bad', { estimate: 0 })] }));
    expect(Object.keys(result.algorithms[0]!).sort()).toEqual(
      ['errorKind', 'id', 'label', 'message', 'params', 'stage', 'status'],
    );
  });
});

describe('runBenchmark: パラメータと実験条件の写し (6.3, 6.4)', () => {
  it('params と meta をそのまま写し、省略時は空のレコードにする', () => {
    const meta = { dist: 'lognormal', ordered: false, n: 10, seed: 3 };
    const result = runOk(
      base({
        sketches: [mockSpec('p', {}, { epsilon: 0.01, mode: 'fast', flag: true }), mockSpec('q'), mockSpec('e', { throwOnCreate: true }, { k: 2 })],
        meta,
      }),
    );
    expect(result.meta).toEqual(meta);
    expect(result.algorithms[0]).toMatchObject({ params: { epsilon: 0.01, mode: 'fast', flag: true } });
    expect(result.algorithms[1]).toMatchObject({ params: {} });
    expect(result.algorithms[2]).toMatchObject({ status: 'error', params: { k: 2 } });
  });

  it('呼び出し側の meta オブジェクトを後から変更しても結果は変わらない', () => {
    const meta: Record<string, number> = { a: 1 };
    const result = runOk(base({ meta }));
    meta.a = 2;
    expect(result.meta).toEqual({ a: 1 });
  });
});

describe('runBenchmark: 入力検証 (6.1)', () => {
  function expectRejected(input: BenchmarkInput, error: object): void {
    const created: number[] = [];
    const sketches = input.sketches.map((s) => ({
      ...s,
      create: (seed: number) => {
        created.push(seed);
        return s.create(seed);
      },
    }));
    const r = runBenchmark({ ...input, sketches });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject(error);
    expect(created).toEqual([]);
  }

  it('空のデータ', () => {
    expectRejected(base({ data: [] }), { kind: 'invalid-data', reason: 'empty' });
    expectRejected(base({ data: new Float64Array(0) }), { kind: 'invalid-data', reason: 'empty' });
  });

  it.each([
    [Number.NaN, 'not-a-number'],
    [Number.POSITIVE_INFINITY, 'not-finite'],
    [0, 'not-positive'],
    [-3, 'not-positive'],
  ])('データに %s を含む', (bad, reason) => {
    expectRejected(base({ data: [1, 2, bad, 4] }), { kind: 'invalid-data', reason });
  });

  it.each([[-0.1], [1.1], [Number.NaN], [Number.POSITIVE_INFINITY]])('分位点 %s', (q) => {
    expectRejected(base({ quantiles: [0.5, q] }), { kind: 'invalid-quantile' });
  });

  it('アルゴリズムの一覧が空', () => {
    expectRejected(base({ sketches: [] }), { kind: 'no-sketches' });
  });

  it('分位点が空でも入力としては有効(問い合わせ 0 件)', () => {
    const r = runOk(base({ quantiles: [] }));
    const a = r.algorithms[0]!;
    if (a.status !== 'ok') throw new Error('expected ok');
    expect(a.queries).toEqual([]);
  });

  it('params に NaN / Infinity / 入れ子を含む', () => {
    expectRejected(base({ sketches: [sortExactSpec(), mockSpec('x', {}, { e: Number.NaN })] }), { kind: 'invalid-params' });
    expectRejected(base({ sketches: [mockSpec('x', {}, { e: Number.POSITIVE_INFINITY })] }), { kind: 'invalid-params' });
    expectRejected(base({ sketches: [mockSpec('x', {}, { e: { a: 1 } } as unknown as ParamRecord)] }), { kind: 'invalid-params' });
  });

  it('meta に NaN / -Infinity を含む', () => {
    expectRejected(base({ meta: { a: Number.NaN } }), { kind: 'invalid-params', field: 'meta' });
    expectRejected(base({ meta: { a: Number.NEGATIVE_INFINITY } }), { kind: 'invalid-params', field: 'meta' });
  });
});
