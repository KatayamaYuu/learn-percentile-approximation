import { describe, expect, it } from 'vitest';
import { seriesByAlgorithm, type BenchmarkResult } from '../core';
import { runBucketExperiment, type BucketExperimentSpec } from './experiment';

const base: BucketExperimentSpec = {
  cases: [
    { label: 'uniform', distribution: { kind: 'uniform', min: 1, max: 100 }, range: { lower: 0.5, upper: 200 } },
    {
      label: 'lognormal',
      distribution: { kind: 'lognormal', mu: 2, sigma: 0.5 },
      range: { lower: 0.5, upper: 200 },
    },
  ],
  counts: [200, 100],
  seed: 7,
  quantiles: [0.5, 0.9, 0.99],
  bucketCounts: [20, 5],
  schemes: ['equal', 'exponential'],
};

function run(spec: BucketExperimentSpec) {
  const r = runBucketExperiment(spec);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf(spec: unknown) {
  const r = runBucketExperiment(spec as BucketExperimentSpec);
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

describe('結果の構造', () => {
  const result = run(base);

  it('ケースは入力の並びで、各ケースの結果は件数の昇順', () => {
    expect(result.schemaVersion).toBe(1);
    expect(result.cases.map((c) => c.label)).toEqual(['uniform', 'lognormal']);
    for (const c of result.cases) {
      expect(c.sweep.runs.map((r) => r.count)).toEqual([100, 200]);
    }
  });

  it('厳密解 2 方式とすべてのヒストグラムが同じ入力に並び、すべて成功する', () => {
    for (const c of result.cases) {
      for (const run of c.sweep.runs) {
        expect(run.algorithms).toHaveLength(2 + 2 * 2);
        const ids = run.algorithms.map((a) => a.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.slice(2)).toEqual([
          'histogram-equal-5',
          'histogram-equal-20',
          'histogram-exponential-5',
          'histogram-exponential-20',
        ]);
        expect(ids[0]).toMatch(/^exact-sort/);
        expect(ids[1]).toMatch(/^exact-quickselect/);
        for (const a of run.algorithms) {
          expect(a.status).toBe('ok');
          if (a.status === 'ok') expect(a.queries.map((q) => q.quantile)).toEqual([0.5, 0.9, 0.99]);
        }
      }
    }
  });

  it('実験条件が結果から読み取れる', () => {
    const run0 = result.cases[1]!.sweep.runs[0]!;
    expect(run0.seed).toBe(7);
    expect(run0.meta).toEqual({ case: 'lognormal', distribution: 'lognormal', order: 'random', rangeMode: 'fixed' });
    const h = run0.algorithms.find((a) => a.id === 'histogram-equal-20');
    expect(h?.params).toEqual({ scheme: 'equal', buckets: 20, lower: 0.5, upper: 200 });
  });

  it('JSON を往復しても等しい', () => {
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('基準の定義を指定すると、結果の基準の定義と厳密解に反映される', () => {
    const r = run({ ...base, referenceDefinition: 'nearest-rank' });
    const first = r.cases[0]!.sweep.runs[0]!;
    expect(first.referenceDefinition).toBe('nearest-rank');
    expect(first.algorithms[0]!.id).toBe('exact-sort-nearest-rank');
  });

  it('並び順の指定が条件に反映される', () => {
    const r = run({ ...base, order: 'ascending' });
    expect(r.cases[0]!.sweep.runs[0]!.meta.order).toBe('ascending');
  });
});

describe('不正な実験条件', () => {
  it.each(['cases', 'counts', 'bucketCounts', 'schemes'] as const)('%s が空', (field) => {
    expect(errorOf({ ...base, [field]: [] })).toMatchObject({ kind: 'invalid-experiment', field });
  });

  it('ケースの識別の重複', () => {
    const c = base.cases[0]!;
    expect(errorOf({ ...base, cases: [c, c] })).toMatchObject({ kind: 'invalid-experiment', field: 'cases[1].label' });
  });

  it('ケースの識別が空', () => {
    const c = base.cases[0]!;
    expect(errorOf({ ...base, cases: [{ ...c, label: '' }] })).toMatchObject({
      kind: 'invalid-experiment',
      field: 'cases[0].label',
    });
  });

  it('未知の境界の決め方と重複', () => {
    expect(errorOf({ ...base, schemes: ['custom'] })).toMatchObject({ kind: 'invalid-experiment', field: 'schemes' });
    expect(errorOf({ ...base, schemes: ['equal', 'equal'] })).toMatchObject({
      kind: 'invalid-experiment',
      field: 'schemes',
    });
  });

  it.each([0, -3, 2.5, NaN, Infinity, '4'])('バケット数 %s', (bad) => {
    expect(errorOf({ ...base, bucketCounts: [10, bad] })).toMatchObject({
      kind: 'invalid-experiment',
      field: 'bucketCounts',
    });
  });

  it('バケット数の重複', () => {
    expect(errorOf({ ...base, bucketCounts: [10, 10] })).toMatchObject({
      kind: 'invalid-experiment',
      field: 'bucketCounts',
    });
  });

  it('バケット数が上限を超える・範囲が不正なのは境界の誤り', () => {
    expect(errorOf({ ...base, bucketCounts: [1_000_000] })).toMatchObject({ kind: 'invalid-scheme', field: 'buckets' });
    const c = base.cases[0]!;
    expect(errorOf({ ...base, cases: [{ ...c, range: { lower: 5, upper: 5 } }] })).toMatchObject({
      kind: 'invalid-scheme',
      field: 'upper',
    });
  });

  it('データ生成の失敗', () => {
    expect(errorOf({ ...base, counts: [0] })).toEqual({ kind: 'generate', error: { kind: 'invalid-count' } });
    const c = base.cases[0]!;
    expect(errorOf({ ...base, cases: [{ ...c, distribution: { kind: 'uniform', min: 5, max: 1 } }] })).toMatchObject({
      kind: 'generate',
      error: { kind: 'invalid-parameter' },
    });
  });

  it('ハーネスの入力エラー', () => {
    expect(errorOf({ ...base, quantiles: [2] })).toEqual({ kind: 'harness', error: { kind: 'invalid-quantile' } });
  });
});

describe('データの範囲による指定', () => {
  const spec: BucketExperimentSpec = {
    ...base,
    cases: [{ label: 'extent', distribution: { kind: 'lognormal', mu: 0, sigma: 1 }, range: 'data-extent' }],
    counts: [50, 500],
  };

  it('生成したデータの最小値と最大値が範囲になり、件数ごとに変わる', () => {
    const r = run(spec);
    const bounds = r.cases[0]!.sweep.runs.map((run) => {
      const h = run.algorithms.find((a) => a.id === 'histogram-equal-20')!;
      expect(h.params.lower).toBeLessThan(h.params.upper as number);
      expect(run.meta.rangeMode).toBe('data-extent');
      return [h.params.lower, h.params.upper];
    });
    expect(bounds[0]).not.toEqual(bounds[1]);
  });

  it('範囲が実データを覆うので、すべてのヒストグラムが成功する', () => {
    const r = run(spec);
    for (const run of r.cases[0]!.sweep.runs) {
      for (const a of run.algorithms) expect(a.status).toBe('ok');
    }
  });

  it('すべての値が等しく範囲が作れない場合は境界の誤り', () => {
    // 1 件だけなら最小値と最大値が等しい
    const e = errorOf({ ...spec, counts: [1] });
    expect(e).toMatchObject({ kind: 'invalid-scheme', field: 'upper' });
  });
});

describe('固定の範囲がデータを覆わない場合', () => {
  const spec: BucketExperimentSpec = {
    ...base,
    cases: [
      { label: 'narrow', distribution: { kind: 'uniform', min: 1, max: 100 }, range: { lower: 20, upper: 60 } },
      { label: 'wide', distribution: { kind: 'uniform', min: 1, max: 100 }, range: { lower: 0.5, upper: 200 } },
    ],
    counts: [300],
  };

  it('ヒストグラムだけが投入段階の扱えない値のエラーとして記録され、厳密解と他のケースは続行する', () => {
    const r = run(spec);
    const narrow = r.cases[0]!.sweep.runs[0]!;
    expect(narrow.algorithms).toHaveLength(6);
    for (const a of narrow.algorithms.slice(0, 2)) expect(a.status).toBe('ok');
    for (const a of narrow.algorithms.slice(2)) {
      expect(a).toMatchObject({ status: 'error', stage: 'insert', errorKind: 'unsupported-value' });
    }
    const wide = r.cases[1]!.sweep.runs[0]!;
    for (const a of wide.algorithms) expect(a.status).toBe('ok');
  });

  it('実験全体のエラーにはならず、JSON を往復しても等しい', () => {
    const r = run(spec);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe('再現性と系列化', () => {
  it('同じ条件の再実行は、処理時間を除いて同じ結果になる', () => {
    const strip = (r: ReturnType<typeof run>) =>
      JSON.parse(JSON.stringify(r), (key, value) => (key === 'elapsedMs' ? 0 : value));
    expect(strip(run(base))).toEqual(strip(run(base)));
  });

  it('シードを変えると結果が変わる', () => {
    const strip = (r: ReturnType<typeof run>) =>
      JSON.parse(JSON.stringify(r), (key, value) => (key === 'elapsedMs' ? 0 : value));
    expect(strip(run({ ...base, seed: 8 }))).not.toEqual(strip(run(base)));
  });

  it('件数をまたいでも、同じ識別の系列に件数順で並ぶ(データの範囲が件数ごとに変わっても)', () => {
    const r = run({
      ...base,
      cases: [{ label: 'extent', distribution: { kind: 'lognormal', mu: 0, sigma: 1 }, range: 'data-extent' }],
      counts: [400, 100, 200],
    });
    const series = seriesByAlgorithm(r.cases[0]!.sweep);
    expect(Object.keys(series)).toHaveLength(2 + 4);
    for (const points of Object.values(series)) {
      expect(points.map((p) => p.count)).toEqual([100, 200, 400]);
    }
  });
});

describe('件数・バケット数に対する費用の増え方', () => {
  const spec: BucketExperimentSpec = {
    cases: [{ label: 'u', distribution: { kind: 'uniform', min: 1, max: 100 }, range: { lower: 1, upper: 100 } }],
    counts: [1000, 10000],
    seed: 3,
    // 分位点 1 は最後の非空バケットまで走査するので、問い合わせの比較がバケット数に応じて増える
    quantiles: [1],
    bucketCounts: [10, 100],
    schemes: ['equal'],
  };

  function find(result: BenchmarkResult, id: string) {
    const a = result.algorithms.find((x) => x.id === id);
    if (!a || a.status !== 'ok') throw new Error(`missing ${id}`);
    return a;
  }

  it('厳密解は件数とともに増え、ヒストグラムは件数に対してメモリが増えず、投入は件数に比例する', () => {
    const [small, large] = run(spec).cases[0]!.sweep.runs;
    const exactSmall = find(small!, 'exact-sort-linear');
    const exactLarge = find(large!, 'exact-sort-linear');
    expect(exactLarge.afterQueries.memoryBytes).toBeGreaterThan(exactSmall.afterQueries.memoryBytes * 5);

    const hSmall = find(small!, 'histogram-equal-10');
    const hLarge = find(large!, 'histogram-equal-10');
    expect(hLarge.afterQueries.memoryBytes).toBe(hSmall.afterQueries.memoryBytes);
    // 投入の移動は1件あたり2回
    expect(hSmall.afterInsertion.operations.moves).toBe(2 * 1000);
    expect(hLarge.afterInsertion.operations.moves).toBe(2 * 10000);
    // 問い合わせの比較は件数によらずバケット数以下
    expect(hSmall.queries[0]!.operations.comparisons).toBeLessThanOrEqual(10);
    expect(hLarge.queries[0]!.operations.comparisons).toBeLessThanOrEqual(10);
  });

  it('バケット数を増やすと、問い合わせの操作数とメモリ見積もりが増える', () => {
    const large = run(spec).cases[0]!.sweep.runs[1]!;
    const h10 = find(large, 'histogram-equal-10');
    const h100 = find(large, 'histogram-equal-100');
    expect(h100.queries[0]!.operations.comparisons).toBeGreaterThan(h10.queries[0]!.operations.comparisons * 5);
    expect(h100.afterQueries.memoryBytes).toBeGreaterThan(h10.afterQueries.memoryBytes * 5);
  });
});
