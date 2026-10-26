import { describe, expect, it } from 'vitest';
import { withoutTiming, type BenchmarkResult } from '../../core';
import type { BucketExperimentResult } from '../../histogram';
import { DEFAULT_HISTOGRAM, type HistogramPageCondition } from '../shared/conditions';
import { bucketsGrid, countGrid, DETAIL_QUANTILES, REFERENCE_DEFINITION, SUMMARY_QUANTILES } from '../shared/grids';
import { runHistogramPage } from './run-histogram-page';

const N = 1_000;
const base: HistogramPageCondition = { ...DEFAULT_HISTOGRAM, data: { ...DEFAULT_HISTOGRAM.data, count: N } };

function unwrap(c: HistogramPageCondition) {
  const r = runHistogramPage(c);
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

const normalize = (r: BucketExperimentResult) => ({
  ...r,
  cases: r.cases.map((c) => ({ ...c, sweep: { ...c.sweep, runs: c.sweep.runs.map((run) => withoutTiming(run as BenchmarkResult)) } }),
  ),
});

describe('runHistogramPage', () => {
  it('3 つの結果の run・手法・分位点の数が期待どおり', () => {
    const v = unwrap(base);
    expect(v.kind).toBe('histogram');
    const grid = bucketsGrid(base.buckets).length;
    const algos = 2 + base.schemes.length * grid;

    const p = v.paramSweep.cases[0]!.sweep.runs;
    expect(p).toHaveLength(1);
    expect(p[0]!.count).toBe(N);
    expect(p[0]!.algorithms).toHaveLength(algos);
    expect(p[0]!.referenceDefinition).toBe(REFERENCE_DEFINITION);
    for (const a of p[0]!.algorithms) {
      expect(a.status).toBe('ok');
      if (a.status === 'ok') expect(a.queries).toHaveLength(SUMMARY_QUANTILES.length);
    }

    const c = v.countSweep.cases[0]!.sweep.runs;
    expect(c.map((r) => r.count)).toEqual(countGrid(N));
    expect(c[0]!.algorithms).toHaveLength(2 + base.schemes.length);

    const d = v.detail.cases[0]!.sweep.runs;
    expect(d).toHaveLength(1);
    expect(d[0]!.algorithms).toHaveLength(2 + base.schemes.length);
    const first = d[0]!.algorithms[0]!;
    if (first.status === 'ok') expect(first.queries).toHaveLength(DETAIL_QUANTILES.length);
  });

  it('同じ条件の 2 回の結果は処理時間を除いて等しい', () => {
    const a = unwrap(base);
    const b = unwrap(base);
    for (const k of ['paramSweep', 'countSweep', 'detail'] as const) {
      expect(normalize(a[k])).toEqual(normalize(b[k]));
    }
  });

  it('固定の範囲がデータを覆わないとき、ヒストグラムだけが失敗として記録される', () => {
    const v = unwrap({ ...base, range: { kind: 'fixed', lower: 1e-9, upper: 1e-8 } });
    for (const r of [v.paramSweep, v.countSweep, v.detail]) {
      for (const run of r.cases[0]!.sweep.runs) {
        const [e1, e2, ...hs] = run.algorithms;
        expect(e1!.status).toBe('ok');
        expect(e2!.status).toBe('ok');
        expect(hs.length).toBeGreaterThan(0);
        for (const h of hs) expect(h.status).toBe('error');
      }
    }
  });

  it('上流がエラーを返したら項目の失敗を返し、部分的な結果を返さない', () => {
    const r = runHistogramPage({ ...base, buckets: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.error[0]!.field).toBe('buckets');
      expect(r.error[0]!.reason).not.toBe('');
      expect('paramSweep' in r.error).toBe(false);
    }
    const s = runHistogramPage({ ...base, range: { kind: 'fixed', lower: 5, upper: 1 } });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error[0]!.field).toMatch(/^range\./);
  });
});
