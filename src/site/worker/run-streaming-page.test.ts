import { describe, expect, it } from 'vitest';
import { withoutTiming, type BenchmarkResult } from '../../core';
import type { StreamingExperimentResult } from '../../streaming';
import { DEFAULT_STREAMING, type StreamingPageCondition } from '../shared/conditions';
import { compressionGrid, countGrid, DETAIL_QUANTILES, epsilonGrid, kGrid, REFERENCE_DEFINITION } from '../shared/grids';
import { runStreamingPage } from './run-streaming-page';

const N = 1_000;
const base: StreamingPageCondition = { ...DEFAULT_STREAMING, data: { ...DEFAULT_STREAMING.data, count: N } };

function unwrap(c: StreamingPageCondition) {
  const r = runStreamingPage(c);
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

const normalize = (r: StreamingExperimentResult) => ({
  ...r,
  cases: r.cases.map((c) => ({ ...c, sweep: { ...c.sweep, runs: c.sweep.runs.map((run) => withoutTiming(run as BenchmarkResult)) } })),
});

describe('runStreamingPage', () => {
  it('結果の構造(手法の数、順序 3 つ、試行の数)が期待どおり', () => {
    const c = { ...base, trials: 3 };
    const v = unwrap(c);
    expect(v.kind).toBe('streaming');
    const algos = 2 + epsilonGrid(c.epsilon).length + kGrid(c.k).length + compressionGrid(c.compression).length * c.scales.length;

    expect(v.paramSweep.cases).toHaveLength(1);
    const p = v.paramSweep.cases[0]!.sweep.runs;
    expect(p).toHaveLength(1);
    expect(p[0]!.algorithms).toHaveLength(algos);
    expect(p[0]!.referenceDefinition).toBe(REFERENCE_DEFINITION);

    const cs = v.countSweep.cases[0]!.sweep.runs;
    expect(cs.map((r) => r.count)).toEqual(countGrid(N));
    expect(cs[0]!.algorithms).toHaveLength(2 + 3);

    expect(v.detail.cases.map((x) => x.order)).toEqual(['random', 'ascending', 'descending']);
    for (const cse of v.detail.cases) {
      expect(cse.sweep.runs).toHaveLength(3);
      expect(cse.sweep.runs[0]!.algorithms).toHaveLength(2 + 3);
      const a = cse.sweep.runs[0]!.algorithms[2]!;
      if (a.status === 'ok') expect(a.queries).toHaveLength(DETAIL_QUANTILES.length);
    }
  });

  it('t-digest は選んだスケール関数ごとに格子を持つ', () => {
    const v = unwrap({ ...base, methods: ['tdigest'], scales: ['k1', 'k2'] });
    expect(v.paramSweep.cases[0]!.sweep.runs[0]!.algorithms).toHaveLength(2 + 2 * compressionGrid(base.compression).length);
    expect(v.countSweep.cases[0]!.sweep.runs[0]!.algorithms).toHaveLength(2 + 2);
  });

  it('3 種の内部状態の観察結果が返る', () => {
    const gk = unwrap({ ...base, inspectTarget: 'gk' }).inspection;
    expect(gk.algorithm).toBe('gk');
    if (gk.algorithm === 'gk') {
      expect(gk.state.count).toBe(N);
      expect(gk.state.epsilon).toBe(base.epsilon);
    }
    const kll = unwrap({ ...base, inspectTarget: 'kll' }).inspection;
    expect(kll.algorithm).toBe('kll');
    if (kll.algorithm === 'kll') {
      expect(kll.state.count).toBe(N);
      expect(kll.state.k).toBe(base.k);
    }
    const td = unwrap({ ...base, inspectTarget: 'tdigest', scales: ['k2', 'k1'] }).inspection;
    expect(td.algorithm).toBe('tdigest');
    if (td.algorithm === 'tdigest') {
      expect(td.state.count).toBe(N);
      expect(td.state.scale).toBe('k2');
      expect(td.state.compression).toBe(base.compression);
    }
  });

  it('KLL の内部状態は最初の試行のシードで作られる', () => {
    const a = unwrap({ ...base, inspectTarget: 'kll', data: { ...base.data, seed: 5 } }).inspection;
    const b = unwrap({ ...base, inspectTarget: 'kll', data: { ...base.data, seed: 5 } }).inspection;
    expect(a).toEqual(b);
  });

  it('試行のシードは 2^32 を超えたら先頭へ折り返す', () => {
    const v = unwrap({ ...base, trials: 3, data: { ...base.data, seed: 2 ** 32 - 1 } });
    expect(v.detail.cases[0]!.sweep.runs).toHaveLength(3);
  });

  it('同じ条件の 2 回の結果は処理時間を除いて等しい', () => {
    const a = unwrap({ ...base, trials: 2 });
    const b = unwrap({ ...base, trials: 2 });
    for (const k of ['paramSweep', 'countSweep', 'detail'] as const) {
      expect(normalize(a[k])).toEqual(normalize(b[k]));
    }
    expect(a.inspection).toEqual(b.inspection);
  });

  it('ε の範囲外は ε の項目の失敗になり、部分的な結果を返さない', () => {
    for (const epsilon of [0.9, 0.00001]) {
      const r = runStreamingPage({ ...base, epsilon });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error[0]!.field).toBe('epsilon');
        expect(r.error[0]!.reason).not.toBe('');
      }
    }
  });

  it('k・δ・分布のパラメータの誤りも対応する項目の失敗になる', () => {
    const k = runStreamingPage({ ...base, k: 1 });
    if (!k.ok) expect(k.error[0]!.field).toBe('k');
    else throw new Error('expected failure');
    const d = runStreamingPage({ ...base, compression: 1 });
    if (!d.ok) expect(d.error[0]!.field).toBe('compression');
    else throw new Error('expected failure');
    const s = runStreamingPage({ ...base, data: { ...base.data, distribution: { kind: 'lognormal', mu: 0, sigma: -1 } } });
    if (!s.ok) expect(s.error[0]!.field).toBe('data.distribution.sigma');
    else throw new Error('expected failure');
  });
});
