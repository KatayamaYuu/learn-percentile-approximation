import { describe, expect, it } from 'vitest';
import { withoutTiming, type BenchmarkResult } from '../../core';
import type { RelativeErrorExperimentResult } from '../../relative-error';
import { DEFAULT_RELATIVE, type RelativePageCondition } from '../shared/conditions';
import { alphaGrid, countGrid, DETAIL_QUANTILES, digitsGrid, REFERENCE_DEFINITION } from '../shared/grids';
import type { RelativePageResult } from '../shared/protocol';
import { runRelativePage } from './run-relative-page';

const N = 1_000;
const base: RelativePageCondition = { ...DEFAULT_RELATIVE, data: { ...DEFAULT_RELATIVE.data, count: N } };

function unwrap(c: RelativePageCondition): RelativePageResult {
  const r = runRelativePage(c);
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function failure(c: RelativePageCondition) {
  const r = runRelativePage(c);
  if (r.ok) throw new Error('expected failure');
  return r.error;
}

const normalize = (r: RelativeErrorExperimentResult) => ({
  ...r,
  cases: r.cases.map((c) => ({ ...c, sweep: { ...c.sweep, runs: c.sweep.runs.map((run) => withoutTiming(run as BenchmarkResult)) } })),
});

/** 幅が 1e-42〜1e42 の手動の範囲: d = 4 は総数が上限(2^22)を超え、d <= 3 は収まる */
const WIDE = { kind: 'manual', lowest: 1e-42, highest: 1e42 } as const;

describe('runRelativePage', () => {
  it('結果の構造(手法の数、run の数、分位点の数、バケットの統計)が期待どおり', () => {
    const v = unwrap(base);
    expect(v.kind).toBe('relative');
    expect(v.hdrRange).toEqual(v.hdrPlan.range);
    expect(v.hdrPlan.excluded).toEqual([]);
    const digits = digitsGrid(base.significantDigits);
    expect(v.hdrPlan.included.map((i) => i.significantDigits)).toEqual(digits);

    const alphas = alphaGrid(base.alpha);
    const p = v.paramSweep.cases[0]!.sweep.runs;
    expect(v.paramSweep.cases).toHaveLength(1);
    expect(v.paramSweep.cases[0]!.label).toBe('site');
    expect(p).toHaveLength(1);
    expect(p[0]!.algorithms).toHaveLength(2 + alphas.length + digits.length);
    expect(p[0]!.referenceDefinition).toBe(REFERENCE_DEFINITION);
    expect(v.paramSweep.cases[0]!.bucketStats).toHaveLength(alphas.length + digits.length);

    const cs = v.countSweep.cases[0]!.sweep.runs;
    expect(cs.map((r) => r.count)).toEqual(countGrid(N));
    expect(cs[0]!.algorithms).toHaveLength(2 + 1 + 1);

    const d = v.detail.cases[0]!.sweep.runs;
    expect(d).toHaveLength(1);
    expect(d[0]!.algorithms).toHaveLength(4);
    const a = d[0]!.algorithms[2]!;
    if (a.status === 'ok') expect(a.queries).toHaveLength(DETAIL_QUANTILES.length);
  });

  it('DDSketch と HDR の内部状態の観察結果が返る', () => {
    const dd = unwrap(base).inspection;
    expect(dd.algorithm).toBe('ddsketch');
    if (dd.algorithm === 'ddsketch' && 'snapshot' in dd) {
      expect(dd.snapshot.totalCount).toBe(N);
      expect(dd.snapshot.alpha).toBe(base.alpha);
      expect(dd.snapshot.collapsed).toBe(false);
    }
    const hdr = unwrap({ ...base, inspectTarget: 'hdr' }).inspection;
    expect(hdr.algorithm).toBe('hdr');
    expect('snapshot' in hdr).toBe(true);
    if ('snapshot' in hdr && hdr.algorithm === 'hdr') expect(hdr.snapshot.totalCount).toBe(N);
  });

  it('バケット数の上限を小さくすると観察結果で縮約が起きている', () => {
    const v = unwrap({ ...base, alpha: 0.001, maxBuckets: 8 });
    expect(v.inspection.algorithm).toBe('ddsketch');
    if ('snapshot' in v.inspection && v.inspection.algorithm === 'ddsketch') {
      expect(v.inspection.snapshot.collapsed).toBe(true);
      expect(v.inspection.snapshot.collapsedUpperBound).not.toBeNull();
    }
  });

  it('狭い手動の範囲で HDR が失敗として記録され、観察が拒否になる', () => {
    const c: RelativePageCondition = { ...base, hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 }, inspectTarget: 'hdr' };
    const v = unwrap(c);
    expect(v.hdrRange).toEqual({ lowest: 1000, highest: 2000 });
    const algos = v.paramSweep.cases[0]!.sweep.runs[0]!.algorithms;
    const hdrs = algos.filter((a) => a.id.startsWith('hdr'));
    expect(hdrs.length).toBe(digitsGrid(base.significantDigits).length);
    expect(hdrs.every((a) => a.status === 'error')).toBe(true);
    expect(algos.filter((a) => a.id.startsWith('ddsketch')).every((a) => a.status === 'ok')).toBe(true);
    expect(v.inspection.algorithm).toBe('hdr');
    expect('rejected' in v.inspection && v.inspection.rejected).toBe(true);
    if ('rejected' in v.inspection) expect(v.inspection.reason).not.toBe('');
  });

  it('極端に広い手動の範囲で、上限を超える有効桁数だけが除かれて残りの結果が返る', () => {
    const v = unwrap({ ...base, hdrRange: WIDE });
    expect(v.hdrPlan.excluded.map((e) => e.significantDigits)).toEqual([4]);
    expect(v.hdrPlan.excluded[0]!.reason).not.toBe('');
    expect(v.hdrPlan.included.map((i) => i.significantDigits)).toEqual([0, 1, 2, 3]);
    const alphas = alphaGrid(base.alpha);
    const algos = v.paramSweep.cases[0]!.sweep.runs[0]!.algorithms;
    expect(algos).toHaveLength(2 + alphas.length + 4);
    expect(algos.filter((a) => a.id.startsWith('hdr'))).toHaveLength(4);
    expect(v.paramSweep.cases[0]!.bucketStats).toHaveLength(alphas.length + 4);
  });

  it('現在の有効桁数が除かれるとき、HDR を選んでいれば有効桁数の項目の失敗になる', () => {
    const r = runRelativePage({ ...base, significantDigits: 4, hdrRange: WIDE });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid-condition');
      if (r.error.kind === 'invalid-condition') {
        expect(r.error.issues[0]!.field).toBe('significantDigits');
        expect(r.error.issues[0]!.reason).not.toBe('');
      }
    }
  });

  it('現在の有効桁数が除かれるとき、HDR を選んでいなければ実行できる最小の有効桁数で代用する', () => {
    // 値の幅が極端な分布(約 1e-130〜1e130)。HDR を選んでいないので手動の範囲は使わず auto になる
    const wide = { ...base.data, distribution: { kind: 'lognormal', mu: 0, sigma: 60 } } as const;
    const c: RelativePageCondition = { ...base, methods: ['ddsketch'], data: wide, significantDigits: 4, hdrRange: WIDE };
    const v = unwrap(c);
    expect(v.hdrPlan.mode).toBe('auto');
    expect(v.hdrPlan.excluded.map((e) => e.significantDigits)).toContain(4);
    const min = Math.min(...v.hdrPlan.included.map((i) => i.significantDigits));
    const cs = v.countSweep.cases[0]!.sweep.runs[0]!.algorithms.filter((a) => a.id.startsWith('hdr'));
    expect(cs).toHaveLength(1);
    expect(cs[0]!.id).toContain(`${min}`);
  });

  it('HDR を選んでいなければ値の幅が極端な分布でもページ全体が失敗しない', () => {
    const data = { ...base.data, distribution: { kind: 'lognormal', mu: 0, sigma: 150 } } as const;
    const r = runRelativePage({ ...base, methods: ['ddsketch'], data });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hdrPlan.lowestClamped).toBe(true);
  });

  it('HDR の項を含めた計算量が上限を超えるとき、実験を始めずに上限超過で返す', () => {
    const r = runRelativePage({ ...base, significantDigits: 4, hdrRange: { kind: 'manual', lowest: 1e-30, highest: 1e30 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('over-limit');
      if (r.error.kind === 'over-limit') {
        expect(r.error.estimate.includesHdrTerm).toBe(true);
        expect(r.error.estimate.withinLimit).toBe(false);
      }
    }
  });

  it('同じ条件の 2 回の結果は処理時間を除いて等しい', () => {
    const a = unwrap(base);
    const b = unwrap(base);
    for (const k of ['paramSweep', 'countSweep', 'detail'] as const) {
      expect(normalize(a[k])).toEqual(normalize(b[k]));
    }
    expect(a.inspection).toEqual(b.inspection);
    expect(a.hdrPlan).toEqual(b.hdrPlan);
  });

  it('α・バケット数の上限・手動の範囲の誤りは対応する項目の失敗になる', () => {
    const fields = (c: RelativePageCondition): string => {
      const e = failure(c);
      if (e.kind !== 'invalid-condition') throw new Error(`unexpected ${e.kind}`);
      return e.issues[0]!.field;
    };
    expect(fields({ ...base, alpha: 1.5 })).toBe('alpha');
    expect(fields({ ...base, maxBuckets: 0 })).toBe('maxBuckets');
    expect(fields({ ...base, hdrRange: { kind: 'manual', lowest: 10, highest: 15 } })).toBe('hdrRange.highest');
    expect(fields({ ...base, significantDigits: 2.5 })).toBe('significantDigits');
    expect(fields({ ...base, data: { ...base.data, distribution: { kind: 'lognormal', mu: 0, sigma: -1 } } })).toBe(
      'data.distribution.sigma',
    );
  });
});
