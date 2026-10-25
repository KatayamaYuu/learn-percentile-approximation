import { describe, expect, it } from 'vitest';
import { generate, seriesByAlgorithm, withoutTiming } from '../core';
import { createDDSketch } from './ddsketch';
import { createHdrHistogram } from './hdr-histogram';
import { runRelativeErrorExperiment, type RelativeErrorExperimentSpec } from './experiment';

const BASE: RelativeErrorExperimentSpec = {
  cases: [
    { label: 'ln3', distribution: { kind: 'lognormal', mu: 3, sigma: 1 }, hdrRange: { lowest: 0.001, highest: 100_000 } },
    { label: 'ln6', distribution: { kind: 'lognormal', mu: 6, sigma: 1 }, hdrRange: { lowest: 0.001, highest: 100_000 } },
  ],
  counts: [300, 100],
  seed: 1,
  quantiles: [0.5, 0.9, 0.99],
  alphas: [0.05, 0.01],
  maxBucketsList: [64, 16],
  significantDigitsList: [2, 1],
  referenceDefinition: 'nearest-rank',
};

function run(spec: RelativeErrorExperimentSpec) {
  const r = runRelativeErrorExperiment(spec);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('結果の構造', () => {
  const result = run(BASE);

  it('ケースの入力順で、各 sweep は件数の昇順', () => {
    expect(result.schemaVersion).toBe(1);
    expect(result.cases.map((c) => c.label)).toEqual(['ln3', 'ln6']);
    for (const c of result.cases) expect(c.sweep.runs.map((r) => r.count)).toEqual([100, 300]);
  });

  it('各条件に厳密解 2 方式とすべての sketch が決まった順で入る', () => {
    const ids = [
      '',
      '',
      'ddsketch-a0.01-m16',
      'ddsketch-a0.01-m64',
      'ddsketch-a0.05-m16',
      'ddsketch-a0.05-m64',
      'hdr-d1',
      'hdr-d2',
    ];
    for (const c of result.cases) {
      for (const run of c.sweep.runs) {
        expect(run.algorithms).toHaveLength(8);
        expect(run.algorithms.slice(2).map((a) => a.id)).toEqual(ids.slice(2));
        expect(run.algorithms.every((a) => a.status === 'ok')).toBe(true);
      }
    }
  });

  it('基準の定義とシードが結果に写り、条件が meta で読める', () => {
    const first = result.cases[0]!.sweep.runs[0]!;
    expect(first.referenceDefinition).toBe('nearest-rank');
    expect(first.seed).toBe(1);
    expect(first.meta).toEqual({
      case: 'ln3',
      distribution: 'lognormal',
      order: 'random',
      hdrLowest: 0.001,
      hdrHighest: 100_000,
    });
  });

  it('JSON を往復しても等しい', () => {
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('sketch の識別子はデータに依存せず、件数をまたいで系列化できる', () => {
    const series = seriesByAlgorithm(result.cases[0]!.sweep);
    expect(series['ddsketch-a0.01-m64']!.map((p) => p.count)).toEqual([100, 300]);
    expect(series['hdr-d2']).toHaveLength(2);
  });
});

describe('設定の反映', () => {
  it('sketch の params が設定を写す', () => {
    const run0 = run(BASE).cases[0]!.sweep.runs[0]!;
    const dd = run0.algorithms.find((a) => a.id === 'ddsketch-a0.05-m16');
    const hdr = run0.algorithms.find((a) => a.id === 'hdr-d2');
    expect(dd?.params).toMatchObject({ alpha: 0.05, maxBuckets: 16 });
    expect(hdr?.params).toMatchObject({ lowest: 0.001, highest: 100_000, significantDigits: 2 });
  });
});

describe('実験条件のエラー', () => {
  const field = (spec: RelativeErrorExperimentSpec): [string, string | undefined] => {
    const r = runRelativeErrorExperiment(spec);
    if (r.ok) return ['ok', undefined];
    return [r.error.kind, 'field' in r.error ? r.error.field : undefined];
  };
  const caseA = BASE.cases[0]!;

  it.each<[string, Partial<RelativeErrorExperimentSpec>, string]>([
    ['ケースが空', { cases: [] }, 'cases'],
    ['ケースの識別が空', { cases: [{ ...caseA, label: '' }] }, 'cases'],
    ['ケースの識別が重複', { cases: [caseA, caseA] }, 'cases'],
    ['件数が空', { counts: [] }, 'counts'],
    ['分位点が空', { quantiles: [] }, 'quantiles'],
    ['α が空', { alphas: [] }, 'alphas'],
    ['α が重複', { alphas: [0.01, 0.01] }, 'alphas'],
    ['m が空', { maxBucketsList: [] }, 'maxBucketsList'],
    ['m が重複', { maxBucketsList: [8, 8] }, 'maxBucketsList'],
    ['有効桁数が空', { significantDigitsList: [] }, 'significantDigitsList'],
    ['有効桁数が重複', { significantDigitsList: [2, 2] }, 'significantDigitsList'],
  ])('%s → invalid-experiment / %s', (_name, patch, expected) => {
    expect(field({ ...BASE, ...patch })).toEqual(['invalid-experiment', expected]);
  });

  it.each<[string, Partial<RelativeErrorExperimentSpec>, string]>([
    ['α が不正', { alphas: [0.01, 1.5] }, 'alpha'],
    ['m が不正', { maxBucketsList: [0] }, 'maxBuckets'],
    ['有効桁数が不正', { significantDigitsList: [9] }, 'significantDigits'],
    ['HDR の L が不正', { cases: [{ ...caseA, hdrRange: { lowest: 0, highest: 10 } }] }, 'lowest'],
    ['HDR の H が不正', { cases: [{ ...caseA, hdrRange: { lowest: 1, highest: 1 } }] }, 'highest'],
  ])('%s → invalid-config / %s(添字や接頭辞を含まない)', (_name, patch, expected) => {
    expect(field({ ...BASE, ...patch })).toEqual(['invalid-config', expected]);
  });

  it('生成のエラーとハーネスの入力エラーは部分的な結果を返さずに返る', () => {
    const g = runRelativeErrorExperiment({ ...BASE, counts: [0] });
    expect(!g.ok && g.error.kind).toBe('generate');
    const h = runRelativeErrorExperiment({ ...BASE, quantiles: [2] });
    expect(!h.ok && h.error.kind).toBe('harness');
    expect('value' in g).toBe(false);
  });

  it('設定の誤りはデータ生成より前に返す(生成が不正でも設定の誤りが先)', () => {
    expect(field({ ...BASE, counts: [0], alphas: [5] })).toEqual(['invalid-config', 'alpha']);
  });
});

describe('再現性', () => {
  it('同じ条件の再実行は処理時間を除いて同じ結果', () => {
    const a = run(BASE);
    const b = run(BASE);
    for (let i = 0; i < a.cases.length; i++) {
      expect(a.cases[i]!.sweep.runs.map(withoutTiming)).toEqual(b.cases[i]!.sweep.runs.map(withoutTiming));
    }
  });
});

describe('バケットの統計', () => {
  it('件数の昇順、同じ件数では sketch の並びで、観察結果と一致する', () => {
    const result = run(BASE);
    const ddIds = ['ddsketch-a0.01-m16', 'ddsketch-a0.01-m64', 'ddsketch-a0.05-m16', 'ddsketch-a0.05-m64'];
    const ids = [...ddIds, 'hdr-d1', 'hdr-d2'];
    for (const c of result.cases) {
      expect(c.bucketStats.map((s) => [s.count, s.sketchId])).toEqual(
        [100, 300].flatMap((count) => ids.map((id) => [count, id])),
      );
      for (const stat of c.bucketStats) {
        expect(stat.status).toBe('ok');
        const r = c.sweep.runs.find((run) => run.count === stat.count)!;
        // バケットの統計は、同じ識別子の計測結果と対応づけられる
        expect(r.algorithms.some((a) => a.id === stat.sketchId)).toBe(true);
      }
    }
    const spec = BASE.cases[0]!;
    const data = (count: number) => {
      const g = generate({ distribution: spec.distribution, count, seed: 1, order: 'random' });
      if (!g.ok) throw new Error();
      return g.value;
    };
    const dd = createDDSketch({ alpha: 0.05, maxBuckets: 16 });
    const hdr = createHdrHistogram({ ...spec.hdrRange, significantDigits: 2 });
    if (!dd.ok || !hdr.ok) throw new Error();
    for (const x of data(300)) {
      dd.value.insert(x);
      hdr.value.insert(x);
    }
    const stats = result.cases[0]!.bucketStats;
    const ddStat = stats.find((s) => s.count === 300 && s.sketchId === 'ddsketch-a0.05-m16');
    const hdrStat = stats.find((s) => s.count === 300 && s.sketchId === 'hdr-d2');
    const ddSnap = dd.value.inspect();
    const hdrSnap = hdr.value.inspect();
    expect(ddStat).toEqual({
      status: 'ok',
      count: 300,
      sketchId: 'ddsketch-a0.05-m16',
      bucketCount: ddSnap.span,
      nonEmptyBuckets: ddSnap.nonEmptyBuckets,
      collapsed: ddSnap.collapsed,
    });
    expect(hdrStat).toEqual({
      status: 'ok',
      count: 300,
      sketchId: 'hdr-d2',
      bucketCount: hdrSnap.totalBuckets,
      nonEmptyBuckets: hdrSnap.nonEmptyBuckets,
      collapsed: null,
    });
    // m = 16 では縮約が起きる
    expect(ddStat && ddStat.status === 'ok' && ddStat.collapsed).toBe(true);
  });

  it('件数が昇順でない入力でも、結果の並びと統計の並びが対応する', () => {
    const r = run({ ...BASE, counts: [300, 100, 200] });
    expect(r.cases[0]!.sweep.runs.map((x) => x.count)).toEqual([100, 200, 300]);
    expect(r.cases[0]!.bucketStats.filter((s) => s.sketchId === 'hdr-d1').map((s) => s.count)).toEqual([100, 200, 300]);
  });
});

describe('HDR の範囲がデータを覆わない場合', () => {
  const narrow: RelativeErrorExperimentSpec = {
    ...BASE,
    cases: [
      { label: 'narrow', distribution: { kind: 'lognormal', mu: 3, sigma: 1 }, hdrRange: { lowest: 1, highest: 20 } },
    ],
    counts: [200],
  };

  it('HDR だけが投入段階のエラーになり、統計は rejected で、他は続行する', () => {
    const c = run(narrow).cases[0]!;
    const algorithms = c.sweep.runs[0]!.algorithms;
    for (const a of algorithms) {
      if (a.id.startsWith('hdr-')) {
        expect(a).toMatchObject({ status: 'error', stage: 'insert', errorKind: 'unsupported-value' });
      } else {
        expect(a.status).toBe('ok');
      }
    }
    for (const s of c.bucketStats) {
      expect(s.status).toBe(s.sketchId.startsWith('hdr-') ? 'rejected' : 'ok');
    }
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });
});

describe('設定と件数による変化', () => {
  const spec: RelativeErrorExperimentSpec = {
    cases: [
      { label: 'ln', distribution: { kind: 'lognormal', mu: 3, sigma: 2 }, hdrRange: { lowest: 0.001, highest: 1e7 } },
    ],
    counts: [200, 2000],
    seed: 2,
    quantiles: [0.5],
    alphas: [0.1, 0.01],
    maxBucketsList: [100_000],
    significantDigitsList: [1, 3],
    referenceDefinition: 'nearest-rank',
  };

  it('α を小さく・有効桁数を大きくすると、バケット数とメモリ見積もりが増える', () => {
    const c = run(spec).cases[0]!;
    const stat = (id: string, count: number) => {
      const s = c.bucketStats.find((x) => x.sketchId === id && x.count === count);
      if (!s || s.status !== 'ok') throw new Error(id);
      return s;
    };
    const memory = (id: string, count: number): number => {
      const a = c.sweep.runs.find((r) => r.count === count)!.algorithms.find((x) => x.id === id)!;
      if (a.status !== 'ok') throw new Error(id);
      return a.afterInsertion.memoryBytes;
    };
    expect(stat('ddsketch-a0.01-m100000', 2000).bucketCount).toBeGreaterThan(stat('ddsketch-a0.1-m100000', 2000).bucketCount);
    expect(memory('ddsketch-a0.01-m100000', 2000)).toBeGreaterThan(memory('ddsketch-a0.1-m100000', 2000));
    expect(stat('hdr-d3', 2000).bucketCount).toBeGreaterThan(stat('hdr-d1', 2000).bucketCount);
    expect(memory('hdr-d3', 2000)).toBeGreaterThan(memory('hdr-d1', 2000));
  });

  it('件数を増やしても HDR のメモリ見積もりは増えず、厳密解は増える', () => {
    const c = run(spec).cases[0]!;
    const memory = (id: string, count: number): number => {
      const a = c.sweep.runs.find((r) => r.count === count)!.algorithms.find((x) => x.id === id)!;
      if (a.status !== 'ok') throw new Error(id);
      return a.afterInsertion.memoryBytes;
    };
    expect(memory('hdr-d3', 2000)).toBe(memory('hdr-d3', 200));
    const exactId = c.sweep.runs[0]!.algorithms[0]!.id;
    expect(memory(exactId, 2000)).toBeGreaterThan(memory(exactId, 200));
  });
});
