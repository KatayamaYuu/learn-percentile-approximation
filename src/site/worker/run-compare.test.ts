import { describe, expect, it } from 'vitest';
import { withoutTiming, type AlgorithmResult, type BenchmarkResult, type SweepResult } from '../../core';
import { DEFAULT_COMPARE, DEFAULT_HISTOGRAM, type CompareAlgorithm, type CompareCondition } from '../shared/conditions';
import { countGrid, DETAIL_QUANTILES, REFERENCE_DEFINITION, SUMMARY_QUANTILES } from '../shared/grids';
import type { CompareResult } from '../shared/protocol';
import { runCompare } from './run-compare';
import { runHistogramPage } from './run-histogram-page';

const N = 1_000;
const data = { ...DEFAULT_COMPARE.data, count: N };
const base: CompareCondition = { ...DEFAULT_COMPARE, data };

function unwrap(c: CompareCondition): CompareResult {
  const r = runCompare(c);
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function failure(c: CompareCondition) {
  const r = runCompare(c);
  if (r.ok) throw new Error('expected failure');
  return r.error;
}

const normalize = (s: SweepResult) => ({ ...s, runs: s.runs.map((run) => withoutTiming(run as BenchmarkResult)) });
const byPrefix = (algos: readonly AlgorithmResult[], p: string) => algos.filter((a) => a.id.startsWith(p));

/** 幅が 1e-42〜1e42 の手動の範囲: d = 4 は総数が上限(2^22)を超え、d <= 3 は収まる */
const WIDE = { kind: 'manual', lowest: 1e-42, highest: 1e42 } as const;

describe('runCompare', () => {
  it('すべての手法の結果が同じ run に入り、同じ厳密値を持つ', () => {
    const v = unwrap({ ...base, algorithms: [...base.algorithms, { kind: 'exact-quickselect' }] });
    expect(v.kind).toBe('compare');
    expect(v.countSweep.runs.map((r) => r.count)).toEqual(countGrid(N));
    for (const run of v.countSweep.runs) {
      expect(run.algorithms).toHaveLength(8);
      expect(run.referenceDefinition).toBe(REFERENCE_DEFINITION);
      expect(run.meta).toMatchObject({ distribution: 'lognormal', order: 'random' });
      expect(run.meta['hdrLowest']).toBe(v.hdrRange.lowest);
      expect(run.meta['hdrHighest']).toBe(v.hdrRange.highest);
      const exacts = run.algorithms.map((a) => (a.status === 'ok' ? a.queries.map((q) => q.exact) : null));
      expect(exacts.every((e) => e !== null && e.length === SUMMARY_QUANTILES.length)).toBe(true);
      for (const e of exacts) expect(e).toEqual(exacts[0]);
    }
    expect(v.detail.runs).toHaveLength(1);
    const d = v.detail.runs[0]!;
    expect(d.count).toBe(N);
    expect(d.algorithms).toHaveLength(8);
    const first = d.algorithms[0]!;
    if (first.status === 'ok') expect(first.queries).toHaveLength(DETAIL_QUANTILES.length);
    expect(v.hdrPlan.excluded).toEqual([]);
  });

  it('選んだ手法だけが並ぶ(厳密解を選ばなければ入らない)', () => {
    const v = unwrap({ ...base, algorithms: [{ kind: 'gk', epsilon: 0.01 }, { kind: 'kll', k: 200 }] });
    expect(v.countSweep.runs[0]!.algorithms.map((a) => a.id)).toEqual(['gk-eps-0.01', 'kll-k-200']);
  });

  it('データの範囲で作ったヒストグラムの範囲が、ヒストグラムの実験の「データの範囲」と等しい', () => {
    const buckets = 64;
    const compare = unwrap({ ...base, algorithms: [{ kind: 'histogram', scheme: 'exponential', buckets }] });
    const page = runHistogramPage({
      ...DEFAULT_HISTOGRAM,
      data,
      buckets,
      schemes: ['exponential'],
      range: { kind: 'data-extent' },
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const pageRuns = page.value.countSweep.cases[0]!.sweep.runs;
    expect(pageRuns.map((r) => r.count)).toEqual(compare.countSweep.runs.map((r) => r.count));
    compare.countSweep.runs.forEach((run, i) => {
      const a = run.algorithms[0]!;
      const b = pageRuns[i]!.algorithms.find((x) => x.params['scheme'] === 'exponential')!;
      expect(a.params['lower']).toBe(b.params['lower']);
      expect(a.params['upper']).toBe(b.params['upper']);
      expect(a.params['lower']).toBeLessThan(a.params['upper'] as number);
    });
    // 件数ごとにデータの範囲が変わる
    const lowers = new Set(compare.countSweep.runs.map((r) => r.algorithms[0]!.params['lower']));
    expect(lowers.size).toBeGreaterThan(1);
  });

  it('HDR の範囲外が HDR だけの失敗になる', () => {
    const v = unwrap({ ...base, hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 } });
    expect(v.hdrRange).toEqual({ lowest: 1000, highest: 2000 });
    for (const sweep of [v.countSweep, v.detail]) {
      for (const run of sweep.runs) {
        const hdr = byPrefix(run.algorithms, 'hdr');
        expect(hdr).toHaveLength(1);
        expect(hdr[0]!.status).toBe('error');
        expect(run.algorithms.filter((a) => !a.id.startsWith('hdr')).every((a) => a.status === 'ok')).toBe(true);
      }
    }
  });

  it('総数の上限を超える HDR だけが除かれ、理由が返る', () => {
    const algorithms: CompareAlgorithm[] = [{ kind: 'exact-sort' }, { kind: 'hdr', significantDigits: 2 }, { kind: 'hdr', significantDigits: 4 }];
    const v = unwrap({ ...base, algorithms, hdrRange: WIDE });
    expect(v.hdrPlan.excluded.map((e) => e.significantDigits)).toEqual([4]);
    expect(v.hdrPlan.excluded[0]!.reason).not.toBe('');
    expect(v.hdrPlan.included.map((i) => i.significantDigits)).toEqual([2]);
    for (const run of [...v.countSweep.runs, ...v.detail.runs]) {
      expect(run.algorithms).toHaveLength(2);
      expect(byPrefix(run.algorithms, 'hdr').map((a) => a.params['significantDigits'])).toEqual([2]);
    }
  });

  it('HDR を選んでいなければ、値の幅が極端な分布でも失敗しない', () => {
    const wide = { ...data, distribution: { kind: 'lognormal', mu: 0, sigma: 150 } } as const;
    const r = runCompare({ ...base, data: wide, algorithms: [{ kind: 'exact-sort' }, { kind: 'gk', epsilon: 0.01 }] });
    expect(r.ok).toBe(true);
  });

  it('HDR の項を含めた計算量が上限を超えるとき、実験を始めずに上限超過で返す', () => {
    const e = failure({
      ...base,
      algorithms: [{ kind: 'hdr', significantDigits: 4 }],
      hdrRange: { kind: 'manual', lowest: 1e-30, highest: 1e30 },
    });
    expect(e.kind).toBe('over-limit');
    if (e.kind === 'over-limit') {
      expect(e.estimate.includesHdrTerm).toBe(true);
      expect(e.estimate.withinLimit).toBe(false);
    }
  });

  it('同じ条件の 2 回の結果は処理時間を除いて等しい', () => {
    const a = unwrap(base);
    const b = unwrap(base);
    expect(normalize(a.countSweep)).toEqual(normalize(b.countSweep));
    expect(normalize(a.detail)).toEqual(normalize(b.detail));
    expect(a.hdrPlan).toEqual(b.hdrPlan);
  });

  it('設定の誤りは対応する項目の失敗になる', () => {
    const field = (c: CompareCondition): string => {
      const e = failure(c);
      if (e.kind !== 'invalid-condition') throw new Error(`unexpected ${e.kind}`);
      return e.issues[0]!.field;
    };
    expect(field({ ...base, algorithms: [{ kind: 'gk', epsilon: 0.01 }, { kind: 'kll', k: 1 }] })).toBe('algorithms[1].k');
    expect(field({ ...base, algorithms: [{ kind: 'ddsketch', alpha: 1.5, maxBuckets: 10 }] })).toBe('algorithms[0].alpha');
    expect(field({ ...base, algorithms: [{ kind: 'hdr', significantDigits: 2.5 }] })).toBe('algorithms[0].significantDigits');
    expect(field({ ...base, hdrRange: { kind: 'manual', lowest: 10, highest: 15 } })).toBe('hdrRange.highest');
    expect(field({ ...base, data: { ...data, distribution: { kind: 'lognormal', mu: 0, sigma: -1 } } })).toBe(
      'data.distribution.sigma',
    );
  });
});
