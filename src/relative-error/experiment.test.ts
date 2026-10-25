import { describe, expect, it } from 'vitest';
import { seriesByAlgorithm, withoutTiming } from '../core';
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
