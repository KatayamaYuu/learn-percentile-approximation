import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, generate, runSweep, type BenchmarkInput, type Distribution } from '../core';
import * as core from '../core';
import { streamingSketchSpec, type StreamingSketchConfig } from './config';
import { runStreamingExperiment, type StreamingExperimentSpec } from './experiment';
import { kllSpec } from './kll';

// 呼び出しの回数・引数・順序を観察するため、core の generate / runSweep と config の変換は本物に委譲する薄い spy にする
vi.mock('../core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core')>();
  return { ...actual, generate: vi.fn(actual.generate), runSweep: vi.fn(actual.runSweep) };
});
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return { ...actual, streamingSketchSpec: vi.fn(actual.streamingSketchSpec) };
});

const uniform: Distribution = { kind: 'uniform', min: 1, max: 100 };
const lognormal: Distribution = { kind: 'lognormal', mu: 2, sigma: 0.5 };

const base: StreamingExperimentSpec = {
  cases: [
    { label: 'uniform', distribution: uniform },
    { label: 'lognormal', distribution: lognormal },
  ],
  counts: [200, 100],
  seed: 7,
  orders: ['ascending', 'random'],
  trialSeeds: [11, 5],
  quantiles: [0.5, 0.99],
  sketches: [
    { kind: 'gk', epsilon: 0.05 },
    { kind: 'kll', k: 16 },
    { kind: 'tdigest', compression: 20, scale: 'k1' },
  ],
};

function run(spec: StreamingExperimentSpec) {
  const r = runStreamingExperiment(spec);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf(spec: unknown) {
  const r = runStreamingExperiment(spec as StreamingExperimentSpec);
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

beforeEach(() => {
  vi.mocked(generate).mockClear();
  vi.mocked(runSweep).mockClear();
  vi.mocked(streamingSketchSpec).mockClear();
});

describe('結果の構造(7.1、7.4、7.7)', () => {
  const result = run(base);

  it('ケースの順、同じケースの中は挿入順序の順に並ぶ', () => {
    expect(result.schemaVersion).toBe(1);
    expect(result.cases.map((c) => [c.label, c.order])).toEqual([
      ['uniform', 'ascending'],
      ['uniform', 'random'],
      ['lognormal', 'ascending'],
      ['lognormal', 'random'],
    ]);
  });

  it('各組の runs は件数の昇順、同じ件数は試行のシードの順(入力の件数・試行の並びによらない)', () => {
    for (const c of result.cases) {
      expect(c.sweep.schemaVersion).toBe(1);
      expect(c.sweep.runs.map((r) => [r.count, r.seed])).toEqual([
        [100, 11],
        [100, 5],
        [200, 11],
        [200, 5],
      ]);
    }
  });

  it('各 run に厳密解 2 方式と指定した手法が、この順で同じ入力に並び、すべて成功する', () => {
    for (const c of result.cases) {
      for (const r of c.sweep.runs) {
        const ids = r.algorithms.map((a) => a.id);
        expect(ids).toHaveLength(5);
        expect(ids[0]).toMatch(/^exact-sort/);
        expect(ids[1]).toMatch(/^exact-quickselect/);
        expect(ids.slice(2)).toEqual(['gk-eps-0.05', 'kll-k-16', 'tdigest-k1-c20']);
        for (const a of r.algorithms) {
          expect(a.status).toBe('ok');
          if (a.status === 'ok') {
            expect(a.queries.map((q) => q.quantile)).toEqual([0.5, 0.99]);
            // 誤差、操作数、メモリ見積もり
            for (const q of a.queries) {
              expect(typeof q.absoluteError).toBe('number');
              expect(typeof q.relativeError).toBe('number');
              expect(typeof q.rankError).toBe('number');
            }
            expect(a.afterQueries.memoryBytes).toBeGreaterThan(0);
            expect(a.afterInsertion.operations.comparisons).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('手法の params が結果に入る', () => {
    const r = result.cases[0]!.sweep.runs[0]!;
    expect(r.algorithms.find((a) => a.id === 'gk-eps-0.05')?.params).toEqual({ algorithm: 'gk', epsilon: 0.05 });
    expect(r.algorithms.find((a) => a.id === 'kll-k-16')?.params).toMatchObject({ algorithm: 'kll', k: 16 });
  });

  it('計測条件の記録は、ケース・分布の種類・挿入順序・データのシード・試行の位置の平坦な記録で、試行のシードが seed になる(7.5)', () => {
    const lnRandom = result.cases[3]!.sweep.runs;
    expect(lnRandom.map((r) => r.meta)).toEqual([
      { case: 'lognormal', distribution: 'lognormal', order: 'random', dataSeed: 7, trial: 0 },
      { case: 'lognormal', distribution: 'lognormal', order: 'random', dataSeed: 7, trial: 1 },
      { case: 'lognormal', distribution: 'lognormal', order: 'random', dataSeed: 7, trial: 0 },
      { case: 'lognormal', distribution: 'lognormal', order: 'random', dataSeed: 7, trial: 1 },
    ]);
    expect(lnRandom.map((r) => r.seed)).toEqual([11, 5, 11, 5]);
    const uniAsc = result.cases[0]!.sweep.runs[3]!;
    expect(uniAsc.meta).toEqual({
      case: 'uniform',
      distribution: 'uniform',
      order: 'ascending',
      dataSeed: 7,
      trial: 1,
    });
    expect(uniAsc.count).toBe(200);
    expect(uniAsc.seed).toBe(5);
  });

  it('JSON を往復しても等しい(7.5)', () => {
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('基準の定義を指定すると、結果の基準の定義と厳密解の識別に反映される', () => {
    const r = run({ ...base, referenceDefinition: 'nearest-rank' });
    const first = r.cases[0]!.sweep.runs[0]!;
    expect(first.referenceDefinition).toBe('nearest-rank');
    expect(first.algorithms[0]!.id).toBe('exact-sort-nearest-rank');
    expect(first.algorithms[1]!.id).toBe('exact-quickselect-nearest-rank');
    // 省略時は core の既定
    const d = result.cases[0]!.sweep.runs[0]!;
    expect(d.referenceDefinition).not.toBe('nearest-rank');
    expect(d.algorithms[0]!.id).not.toBe('exact-sort-nearest-rank');
  });

  it('orders と trialSeeds を省略すると、orders は random、試行のシードはデータのシード 1 つになる', () => {
    const r = run({
      cases: base.cases,
      counts: [100, 200],
      seed: 9,
      quantiles: [0.5],
      sketches: [{ kind: 'gk', epsilon: 0.05 }],
    });
    expect(r.cases.map((c) => [c.label, c.order])).toEqual([
      ['uniform', 'random'],
      ['lognormal', 'random'],
    ]);
    for (const c of r.cases) {
      expect(c.sweep.runs.map((x) => [x.count, x.seed, x.meta.dataSeed, x.meta.trial])).toEqual([
        [100, 9, 9, 0],
        [200, 9, 9, 0],
      ]);
    }
  });

  it('5 種類の分布のケースが並べて取得できる(7.7)', () => {
    const distributions: Distribution[] = [
      uniform,
      { kind: 'normal', mean: 50, stdDev: 5 },
      lognormal,
      { kind: 'heavy-tail', scale: 1, shape: 1.5 },
      {
        kind: 'multimodal',
        modes: [
          { weight: 1, mean: 10, stdDev: 1 },
          { weight: 1, mean: 50, stdDev: 2 },
        ],
      },
    ];
    const r = run({
      ...base,
      cases: distributions.map((distribution, i) => ({ label: `d${i}`, distribution })),
      counts: [100],
      orders: ['random'],
      trialSeeds: [1],
    });
    expect(r.cases.map((c) => c.label)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(r.cases.map((c) => c.sweep.runs[0]!.meta.distribution)).toEqual([
      'uniform',
      'normal',
      'lognormal',
      'heavy-tail',
      'multimodal',
    ]);
  });

  it('ケース × 順序の要素数になる', () => {
    expect(run({ ...base, orders: ['random', 'ascending', 'descending'] }).cases).toHaveLength(2 * 3);
    expect(run({ ...base, orders: ['descending'] }).cases.map((c) => c.order)).toEqual(['descending', 'descending']);
  });

  it('境界の試行のシード(0 と 2^32 - 1)を受け付け、そのまま seed に記録される', () => {
    const r = run({ ...base, counts: [100], trialSeeds: [0, 2 ** 32 - 1] });
    expect(r.cases[0]!.sweep.runs.map((x) => x.seed)).toEqual([0, 2 ** 32 - 1]);
  });
});

describe('組み立ての手順(7.1)', () => {
  const sketchConfigs = base.sketches;

  function runObserved() {
    vi.mocked(generate).mockClear();
    vi.mocked(runSweep).mockClear();
    vi.mocked(streamingSketchSpec).mockClear();
    const r = run({ ...base, referenceDefinition: 'nearest-rank' });
    return r;
  }

  it('手法の生成仕様は検証の直後に 1 回だけ、手法ごとに作られ、データ生成より前に終わる', () => {
    runObserved();
    const spy = vi.mocked(streamingSketchSpec);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(sketchConfigs);
    const lastSpec = Math.max(...spy.mock.invocationCallOrder);
    const firstGenerate = Math.min(...vi.mocked(generate).mock.invocationCallOrder);
    expect(lastSpec).toBeLessThan(firstGenerate);
  });

  it('データ生成は、ケース・挿入順序・件数の入力順に 1 回ずつで、データのシードと順序を渡す', () => {
    runObserved();
    const calls = vi.mocked(generate).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { distribution: uniform, count: 200, seed: 7, order: 'ascending' },
      { distribution: uniform, count: 100, seed: 7, order: 'ascending' },
      { distribution: uniform, count: 200, seed: 7, order: 'random' },
      { distribution: uniform, count: 100, seed: 7, order: 'random' },
      { distribution: lognormal, count: 200, seed: 7, order: 'ascending' },
      { distribution: lognormal, count: 100, seed: 7, order: 'ascending' },
      { distribution: lognormal, count: 200, seed: 7, order: 'random' },
      { distribution: lognormal, count: 100, seed: 7, order: 'random' },
    ]);
  });

  it('組ごとにハーネスを 1 回呼び、試行の数だけ計測条件を渡す', () => {
    runObserved();
    const spy = vi.mocked(runSweep);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) {
      // 件数 2 × 試行 2
      expect(call[0]).toHaveLength(4);
    }
    // 組ごとの呼び出しは、その組のデータ生成より後、次の組のデータ生成より前
    const gen = vi.mocked(generate).mock.invocationCallOrder;
    const sw = spy.mock.invocationCallOrder;
    for (let pair = 0; pair < 4; pair++) {
      expect(sw[pair]!).toBeGreaterThan(gen[pair * 2 + 1]!);
      if (pair < 3) expect(sw[pair]!).toBeLessThan(gen[(pair + 1) * 2]!);
    }
  });

  it('計測条件は、同じ件数の試行が同じデータを共有し、試行のシードを seed にし、厳密解 2 方式 + 手法の順に並べる', () => {
    runObserved();
    const generated = vi
      .mocked(generate)
      .mock.results.map((r) => (r.type === 'return' && r.value.ok ? r.value.value : null));
    const specs = vi
      .mocked(streamingSketchSpec)
      .mock.results.map((r) => (r.type === 'return' && r.value.ok ? r.value.value : null));
    const firstPair = vi.mocked(runSweep).mock.calls[0]![0] as readonly BenchmarkInput[];
    // 入力順: 件数 200 (試行 11, 5)、件数 100 (試行 11, 5)
    expect(firstPair.map((c) => c.seed)).toEqual([11, 5, 11, 5]);
    expect(firstPair[0]!.data).toBe(generated[0]);
    expect(firstPair[1]!.data).toBe(generated[0]);
    expect(firstPair[2]!.data).toBe(generated[1]);
    expect(firstPair[3]!.data).toBe(generated[1]);
    expect(firstPair[0]!.data).not.toBe(firstPair[2]!.data);
    expect((firstPair[0]!.data as Float64Array).length).toBe(200);
    expect((firstPair[2]!.data as Float64Array).length).toBe(100);
    for (const c of firstPair) {
      expect(c.quantiles).toEqual([0.5, 0.99]);
      expect(c.referenceDefinition).toBe('nearest-rank');
      expect(c.sketches).toHaveLength(5);
      expect(c.sketches[0]!.id).toBe('exact-sort-nearest-rank');
      expect(c.sketches[1]!.id).toBe('exact-quickselect-nearest-rank');
      // 手法の生成仕様は作り直さず、同じものを並べる
      expect(c.sketches[2]).toBe(specs[0]);
      expect(c.sketches[3]).toBe(specs[1]);
      expect(c.sketches[4]).toBe(specs[2]);
    }
    expect(firstPair.map((c) => c.meta)).toEqual([
      { case: 'uniform', distribution: 'uniform', order: 'ascending', dataSeed: 7, trial: 0 },
      { case: 'uniform', distribution: 'uniform', order: 'ascending', dataSeed: 7, trial: 1 },
      { case: 'uniform', distribution: 'uniform', order: 'ascending', dataSeed: 7, trial: 0 },
      { case: 'uniform', distribution: 'uniform', order: 'ascending', dataSeed: 7, trial: 1 },
    ]);
  });

  it('基準の定義を省略すると、計測条件に referenceDefinition を持たせない', () => {
    run(base);
    const first = vi.mocked(runSweep).mock.calls[0]![0][0]!;
    expect('referenceDefinition' in first).toBe(false);
    expect(first.sketches[0]!.id).not.toContain('nearest-rank');
  });
});

describe('不正な実験条件(7.8)', () => {
  const c0 = base.cases[0]!;

  it.each(['cases', 'counts', 'sketches'] as const)('%s が空', (field) => {
    const e = errorOf({ ...base, [field]: [] });
    expect(e).toMatchObject({ kind: 'invalid-experiment', field });
    expect(typeof (e as { reason: unknown }).reason).toBe('string');
  });

  it.each(['cases', 'counts', 'sketches'] as const)('%s が配列でない', (field) => {
    expect(errorOf({ ...base, [field]: undefined })).toMatchObject({ kind: 'invalid-experiment', field });
    expect(errorOf({ ...base, [field]: 'abc' })).toMatchObject({ kind: 'invalid-experiment', field });
  });

  it('ケースの識別が空: 項目に位置を含む', () => {
    expect(errorOf({ ...base, cases: [c0, { ...c0, label: '' }] })).toMatchObject({
      kind: 'invalid-experiment',
      field: 'cases[1].label',
    });
    expect(errorOf({ ...base, cases: [{ ...c0, label: 5 }] })).toMatchObject({ field: 'cases[0].label' });
  });

  it('ケースの識別が重複: 2 つ目以降の位置を示し、理由は空の場合と異なる', () => {
    const dup = errorOf({
      ...base,
      cases: [c0, { ...c0, label: 'b' }, { ...c0, label: 'uniform' }],
    }) as { kind: string; field: string; reason: string };
    expect(dup).toMatchObject({ kind: 'invalid-experiment', field: 'cases[2].label' });
    expect(dup.reason).toContain('uniform');
    const empty = errorOf({ ...base, cases: [{ ...c0, label: '' }] }) as { reason: string };
    expect(empty.reason).not.toBe(dup.reason);
  });

  it('挿入順序が空・未知・重複(理由は区別される)', () => {
    const empty = errorOf({ ...base, orders: [] }) as { reason: string };
    const unknown = errorOf({ ...base, orders: ['random', 'sorted'] }) as { reason: string };
    const dup = errorOf({ ...base, orders: ['random', 'ascending', 'random'] }) as { reason: string };
    for (const e of [empty, unknown, dup]) expect(e).toMatchObject({ kind: 'invalid-experiment', field: 'orders' });
    expect(new Set([empty.reason, unknown.reason, dup.reason]).size).toBe(3);
    expect(errorOf({ ...base, orders: null })).toMatchObject({ kind: 'invalid-experiment', field: 'orders' });
  });

  it('挿入順序の 3 種類はすべて受け付ける', () => {
    expect(run({ ...base, orders: ['descending', 'ascending', 'random'], counts: [50] }).cases).toHaveLength(6);
  });

  it('試行のシードが空', () => {
    expect(errorOf({ ...base, trialSeeds: [] })).toMatchObject({ kind: 'invalid-experiment', field: 'trialSeeds' });
    expect(errorOf({ ...base, trialSeeds: null })).toMatchObject({ kind: 'invalid-experiment', field: 'trialSeeds' });
  });

  it.each([-1, 1.5, NaN, Infinity, 2 ** 32, 2 ** 32 + 1, '3', null])('試行のシード %s は範囲外', (bad) => {
    expect(errorOf({ ...base, trialSeeds: [1, bad] })).toMatchObject({
      kind: 'invalid-experiment',
      field: 'trialSeeds',
    });
  });

  it('試行のシードが重複(理由は範囲外と異なる)', () => {
    const dup = errorOf({ ...base, trialSeeds: [3, 4, 3] }) as { reason: string };
    expect(dup).toMatchObject({ kind: 'invalid-experiment', field: 'trialSeeds' });
    const range = errorOf({ ...base, trialSeeds: [-1] }) as { reason: string };
    expect(range.reason).not.toBe(dup.reason);
  });

  it('不正な手法の指定: 項目に一覧内の位置を含み、設定側の理由をそのまま返す', () => {
    const direct = kllSpec({ k: 1 });
    if (direct.ok) throw new Error('kll k=1 should be invalid');
    expect(
      errorOf({
        ...base,
        sketches: [
          { kind: 'gk', epsilon: 0.05 },
          { kind: 'kll', k: 1 },
        ],
      }),
    ).toEqual({
      kind: 'invalid-config',
      field: 'sketches[1].k',
      reason: direct.error.reason,
    });
    expect(errorOf({ ...base, sketches: [{ kind: 'gk', epsilon: 0 }] })).toMatchObject({
      kind: 'invalid-config',
      field: 'sketches[0].epsilon',
    });
    expect(
      errorOf({
        ...base,
        sketches: [
          { kind: 'gk', epsilon: 0.1 },
          { kind: 'gk', epsilon: 0.2 },
          { kind: 'tdigest', compression: 20, scale: 'k9' },
        ],
      }),
    ).toMatchObject({ kind: 'invalid-config', field: 'sketches[2].scale' });
    expect(errorOf({ ...base, sketches: [{ kind: 'tdigest', compression: 1, scale: 'k1' }] })).toMatchObject({
      field: 'sketches[0].compression',
    });
  });

  it('未知の種類・オブジェクトでない指定', () => {
    expect(errorOf({ ...base, sketches: [{ kind: 'gk', epsilon: 0.1 }, { kind: 'foo' }] })).toMatchObject({
      kind: 'invalid-config',
      field: 'sketches[1].kind',
    });
    expect(errorOf({ ...base, sketches: [null] })).toMatchObject({ kind: 'invalid-config', field: 'sketches[0].kind' });
  });

  it('最初の不正な指定を返す', () => {
    expect(
      errorOf({
        ...base,
        sketches: [
          { kind: 'kll', k: 1 },
          { kind: 'gk', epsilon: 0 },
        ],
      }),
    ).toMatchObject({
      field: 'sketches[0].k',
    });
  });

  it('識別子が重複する指定(同じ手法・同じパラメータ)。パラメータが違えば重複でない', () => {
    for (const sketches of [
      [
        { kind: 'gk', epsilon: 0.05 },
        { kind: 'gk', epsilon: 0.05 },
      ],
      [
        { kind: 'kll', k: 16 },
        { kind: 'gk', epsilon: 0.05 },
        { kind: 'kll', k: 16 },
      ],
      [
        { kind: 'tdigest', compression: 20, scale: 'k1' },
        { kind: 'tdigest', compression: 20, scale: 'k1' },
      ],
    ]) {
      expect(errorOf({ ...base, sketches })).toMatchObject({ kind: 'invalid-experiment', field: 'sketches' });
    }
    const ok1 = run({
      ...base,
      counts: [50],
      sketches: [
        { kind: 'gk', epsilon: 0.05 },
        { kind: 'gk', epsilon: 0.1 },
        { kind: 'tdigest', compression: 20, scale: 'k1' },
        { kind: 'tdigest', compression: 20, scale: 'k2' },
        { kind: 'tdigest', compression: 30, scale: 'k1' },
      ],
    });
    expect(ok1.cases[0]!.sweep.runs[0]!.algorithms).toHaveLength(7);
  });

  it('データ生成の失敗は generate として返る', () => {
    expect(errorOf({ ...base, counts: [100, 0] })).toEqual({ kind: 'generate', error: { kind: 'invalid-count' } });
    expect(errorOf({ ...base, seed: -1 })).toEqual({ kind: 'generate', error: { kind: 'invalid-seed' } });
    expect(
      errorOf({ ...base, cases: [{ label: 'bad', distribution: { kind: 'uniform', min: 5, max: 1 } }] }),
    ).toMatchObject({
      kind: 'generate',
      error: { kind: 'invalid-parameter' },
    });
  });

  it('ハーネスの入力エラーは harness として返る', () => {
    expect(errorOf({ ...base, quantiles: [2] })).toEqual({ kind: 'harness', error: { kind: 'invalid-quantile' } });
  });
});

describe('検証の順序と、部分的な結果を返さないこと(7.8)', () => {
  const c0 = base.cases[0]!;
  const bothBadSketch = [{ kind: 'kll', k: 1 }];

  it('挿入順序の誤りは、空の試行のシード・範囲外の試行のシードより先に報告する', () => {
    expect(errorOf({ ...base, orders: [], trialSeeds: [] })).toMatchObject({ field: 'orders' });
    expect(errorOf({ ...base, orders: ['x'], trialSeeds: [] })).toMatchObject({ field: 'orders' });
    expect(errorOf({ ...base, orders: ['random', 'random'], trialSeeds: [-1] })).toMatchObject({ field: 'orders' });
  });

  it('空の一覧は cases、counts、sketches の順に報告する', () => {
    expect(errorOf({ ...base, cases: [], counts: [], sketches: [] })).toMatchObject({ field: 'cases' });
    expect(errorOf({ ...base, counts: [], sketches: [] })).toMatchObject({ field: 'counts' });
    expect(errorOf({ ...base, sketches: [] })).toMatchObject({ field: 'sketches' });
  });

  it('空の一覧は、ケースの識別・挿入順序・試行のシード・手法の設定の誤りより先に報告する', () => {
    expect(
      errorOf({
        ...base,
        cases: [{ ...c0, label: '' }],
        counts: [],
        orders: [],
        trialSeeds: [],
        sketches: bothBadSketch,
      }),
    ).toMatchObject({ field: 'counts' });
    expect(errorOf({ ...base, cases: [{ ...c0, label: '' }], orders: [], trialSeeds: [], sketches: [] })).toMatchObject(
      { field: 'sketches' },
    );
  });

  it('ケースの識別 → 挿入順序 → 試行のシード → 手法の設定 → 識別子の重複 → 生成 → ハーネスの順', () => {
    const dupIds = [
      { kind: 'gk', epsilon: 0.05 },
      { kind: 'gk', epsilon: 0.05 },
    ];
    const all = {
      ...base,
      cases: [{ ...c0, label: '' }],
      orders: ['x'],
      trialSeeds: [-1],
      sketches: [...dupIds, ...bothBadSketch],
      counts: [0],
      quantiles: [2],
    };
    expect(errorOf(all)).toMatchObject({ kind: 'invalid-experiment', field: 'cases[0].label' });
    const noLabel = { ...all, cases: [c0] };
    expect(errorOf(noLabel)).toMatchObject({ kind: 'invalid-experiment', field: 'orders' });
    const noOrder = { ...noLabel, orders: ['random'] };
    expect(errorOf(noOrder)).toMatchObject({ kind: 'invalid-experiment', field: 'trialSeeds' });
    const noSeed = { ...noOrder, trialSeeds: [1] };
    expect(errorOf(noSeed)).toMatchObject({ kind: 'invalid-config', field: 'sketches[2].k' });
    const noConfig = { ...noSeed, sketches: dupIds };
    expect(errorOf(noConfig)).toMatchObject({ kind: 'invalid-experiment', field: 'sketches' });
    const noDup = { ...noConfig, sketches: [dupIds[0]] };
    expect(errorOf(noDup)).toEqual({ kind: 'generate', error: { kind: 'invalid-count' } });
    const noGen = { ...noDup, counts: [100] };
    expect(errorOf(noGen)).toEqual({ kind: 'harness', error: { kind: 'invalid-quantile' } });
  });

  it('実験条件の誤りでは、手法の生成もデータ生成もハーネスも呼ばない', () => {
    for (const bad of [
      { ...base, cases: [] },
      { ...base, cases: [c0, c0] },
      { ...base, orders: ['x'] },
      { ...base, trialSeeds: [-1] },
    ]) {
      errorOf(bad);
    }
    expect(vi.mocked(streamingSketchSpec)).not.toHaveBeenCalled();
    expect(vi.mocked(generate)).not.toHaveBeenCalled();
    expect(vi.mocked(runSweep)).not.toHaveBeenCalled();
  });

  it('手法の設定・識別子の誤りでは、データ生成もハーネスも呼ばない', () => {
    errorOf({ ...base, sketches: bothBadSketch });
    errorOf({
      ...base,
      sketches: [
        { kind: 'gk', epsilon: 0.05 },
        { kind: 'gk', epsilon: 0.05 },
      ],
    });
    expect(vi.mocked(generate)).not.toHaveBeenCalled();
    expect(vi.mocked(runSweep)).not.toHaveBeenCalled();
  });

  it('後の組で生成が失敗しても、部分的な結果は返さずエラーだけを返す', () => {
    const r = runStreamingExperiment({
      ...base,
      cases: [c0, { label: 'bad', distribution: { kind: 'uniform', min: 5, max: 1 } }],
    });
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('value');
    expect(r).toMatchObject({ error: { kind: 'generate', error: { kind: 'invalid-parameter' } } });
    // 最初のケースの組は実行済みで、その後で失敗している
    expect(vi.mocked(runSweep)).toHaveBeenCalledTimes(2);
  });

  it('後の組でハーネスがエラーを返しても、部分的な結果は返さずそのエラーを返す', async () => {
    const actual = await vi.importActual<typeof core>('../core');
    vi.mocked(runSweep)
      .mockImplementationOnce(actual.runSweep)
      .mockImplementationOnce(() => err({ kind: 'invalid-data', reason: 'empty' }));
    const r = runStreamingExperiment(base);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('value');
    expect(r).toEqual({ ok: false, error: { kind: 'harness', error: { kind: 'invalid-data', reason: 'empty' } } });
    expect(vi.mocked(runSweep)).toHaveBeenCalledTimes(2);
  });
});
