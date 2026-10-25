import { describe, expect, it } from 'vitest';
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
