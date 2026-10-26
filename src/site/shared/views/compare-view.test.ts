import { describe, expect, it } from 'vitest';
import type { AlgorithmResult } from '../../../core';
import { DEFAULT_COMPARE, type CompareAlgorithm, type CompareCondition } from '../conditions';
import { formatInt } from '../format';
import { MAX_HDR_BUCKETS } from '../limits';
import type { ErrorSelection } from '../metric';
import type { CompareResult } from '../protocol';
import { allOperations, elapsedMs, insertOperations, memoryBytes } from '../series';
import { runCompare } from '../../worker/run-compare';
import { buildCompareCharts } from './compare-view';

const N = 1_000;
const base: CompareCondition = { ...DEFAULT_COMPARE, data: { ...DEFAULT_COMPARE.data, count: N } };
const WIDE = { kind: 'manual', lowest: 1e-42, highest: 1e42 } as const;
const rank: ErrorSelection = { metric: 'rank', pick: { kind: 'max' } };
const relative: ErrorSelection = { metric: 'relative', pick: { kind: 'max' } };

function run(c: CompareCondition): CompareResult {
  const r = runCompare(c);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
const okOf = (r: AlgorithmResult) => {
  if (r.status !== 'ok') throw new Error('unexpected');
  return r;
};

const result = run(base);
const builtRel = buildCompareCharts(result, base, { selection: relative });
const builtRank = buildCompareCharts(result, base, { selection: rank });
const byId = (b: typeof builtRel, id: string) => {
  const c = b.charts.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no chart ${id}`);
  return c;
};

describe('buildCompareCharts: グラフ (8.3, 8.4, 8.5)', () => {
  it('7 枚のグラフが決まった順序で出る', () => {
    expect(builtRel.charts.map((c) => c.id)).toEqual([
      'compare-method-error',
      'compare-method-memory',
      'compare-method-operations',
      'compare-method-elapsed',
      'compare-quantile-error',
      'compare-count-memory',
      'compare-count-elapsed',
    ]);
    for (const c of builtRel.charts) {
      expect(c.title).not.toBe('');
      expect(c.summary).not.toBe('');
    }
  });

  it('手法ごとの棒の値が詳細の run の値と等しい', () => {
    const detail = result.detail.runs[0]!;
    const mem = byId(builtRel, 'compare-method-memory');
    expect(mem.series.flatMap((s) => s.points.map((p) => p.y))).toEqual(detail.algorithms.map((a) => memoryBytes(okOf(a))));
    expect(mem.series.every((s) => s.kind === 'bar')).toBe(true);
    const el = byId(builtRel, 'compare-method-elapsed');
    expect(el.series.flatMap((s) => s.points.map((p) => p.y))).toEqual(detail.algorithms.map((a) => elapsedMs(okOf(a))));
    expect(el.y.unit).toBe('ミリ秒');
  });

  it('操作数は投入と問い合わせの 2 系列で、手法ごとの値が一致する', () => {
    const detail = result.detail.runs[0]!;
    const ops = byId(builtRel, 'compare-method-operations');
    expect(ops.series.map((s) => s.label)).toEqual(['投入', '問い合わせ']);
    const ins = ops.series[0]!.points.map((p) => p.y);
    const qry = ops.series[1]!.points.map((p) => p.y);
    expect(ins).toEqual(detail.algorithms.map((a) => insertOperations(okOf(a))));
    expect(qry).toEqual(detail.algorithms.map((a) => allOperations(okOf(a)) - insertOperations(okOf(a))));
    expect(ops.series[0]!.points.map((p) => p.x)).toEqual(detail.algorithms.map((a) => a.label));
  });

  it('誤差の棒は選んだ指標の最大値で、厳密解は 0', () => {
    const err = byId(builtRank, 'compare-method-error');
    const exact = err.series.find((s) => s.id.startsWith('exact-sort'));
    expect(exact?.points[0]?.y).toBe(0);
    expect(err.y.label).toBe('順位誤差');
  });

  it('分位点ごとの重ね描きは成功した手法ごとに 1 系列', () => {
    const q = byId(builtRel, 'compare-quantile-error');
    expect(q.series.map((s) => s.id)).toEqual(result.detail.runs[0]!.algorithms.map((a) => a.id));
    expect(q.x.label).toBe('分位点');
  });

  it('件数ごとのメモリと処理時間は手法ごとの系列で、点の数が件数の格子と等しい', () => {
    for (const id of ['compare-count-memory', 'compare-count-elapsed']) {
      const c = byId(builtRel, id);
      expect(c.series).toHaveLength(base.algorithms.length);
      for (const s of c.series) expect(s.points).toHaveLength(result.countSweep.runs.length);
    }
    const mem = byId(builtRel, 'compare-count-memory');
    const hdr = mem.series.find((s) => s.id.startsWith('hdr'))!;
    const expected = result.countSweep.runs.map((r) => memoryBytes(okOf(r.algorithms.find((a) => a.id === hdr.id)!)));
    expect(hdr.points.map((p) => p.y)).toEqual(expected);
  });
});

describe('buildCompareCharts: 基準線と注記 (8.4)', () => {
  it('相対誤差のとき DDSketch の α と HDR の 1/S の基準線が出る', () => {
    const q = byId(builtRel, 'compare-quantile-error');
    const hdr = result.hdrPlan.included[0]!;
    const values = q.referenceLines.map((l) => l.value);
    expect(q.referenceLines.every((l) => l.axis === 'y')).toBe(true);
    expect(values).toContain(0.01);
    expect(values).toContain(1 / hdr.subBucketCount);
    expect(q.referenceLines.some((l) => l.label.includes('DDSketch') && l.label.includes('α'))).toBe(true);
    expect(q.referenceLines.some((l) => l.label.includes('HDR') && l.label.includes('1/S'))).toBe(true);
  });

  it('相対誤差以外の指標では基準線が出ない', () => {
    expect(byId(builtRank, 'compare-quantile-error').referenceLines).toEqual([]);
    expect(byId(builtRank, 'compare-quantile-error').notes.some((n) => n.includes('half × L'))).toBe(false);
  });

  it('選んでいない手法の基準線は出ない', () => {
    const c: CompareCondition = { ...base, algorithms: [{ kind: 'ddsketch', alpha: 0.02, maxBuckets: 2048 }] };
    const b = buildCompareCharts(run(c), c, { selection: relative });
    expect(byId(b, 'compare-quantile-error').referenceLines.map((l) => l.value)).toEqual([0.02]);
  });

  it('HDR の保証が始まる値未満の分位点があれば注記が出る', () => {
    const c: CompareCondition = { ...base, algorithms: [{ kind: 'exact-sort' }, { kind: 'hdr', significantDigits: 3 }] };
    const r = run(c);
    const info = r.hdrPlan.included[0]!;
    const exact = okOf(r.detail.runs[0]!.algorithms[0]!);
    const below = exact.queries.filter((q) => q.exact < info.guaranteeFrom);
    const note = byId(buildCompareCharts(r, c, { selection: relative }), 'compare-quantile-error').notes.find((n) =>
      n.includes('half × L'),
    );
    if (below.length > 0) expect(note).toContain('保証の対象外');
    else expect(note).toBeUndefined();
    // 保証の開始を引き上げた結果で、注記が確実に出る
    const high = { ...r, hdrPlan: { ...r.hdrPlan, included: [{ ...info, guaranteeFrom: 1e12 }] } };
    const n2 = byId(buildCompareCharts(high, c, { selection: relative }), 'compare-quantile-error').notes;
    expect(n2.some((n) => n.includes('half × L') && n.includes('保証の対象外'))).toBe(true);
  });
});

describe('buildCompareCharts: 比較表 (8.3)', () => {
  it('表の行の値が結果の値と等しい', () => {
    const detail = result.detail.runs[0]!;
    expect(builtRank.rows.map((r) => r.id)).toEqual(detail.algorithms.map((a) => a.id));
    builtRank.rows.forEach((row, i) => {
      const a = okOf(detail.algorithms[i]!);
      expect(row.status).toBe('ok');
      expect(row.label).toBe(a.label);
      expect(row.memoryBytes).toBe(memoryBytes(a));
      expect(row.insertOperations).toBe(insertOperations(a));
      expect(row.queryOperations).toBe(allOperations(a) - insertOperations(a));
      expect(row.elapsedMs).toBe(elapsedMs(a));
      expect(row.error).toBe(Math.max(...a.queries.map((q) => q.rankError)));
      expect(row.reason).toBeNull();
    });
  });

  it('誤差の列は選んだ指標に従う', () => {
    const a = okOf(result.detail.runs[0]!.algorithms.find((x) => x.id.startsWith('ddsketch'))!);
    const row = builtRel.rows.find((r) => r.id === a.id)!;
    expect(row.error).toBe(Math.max(...a.queries.map((q) => q.relativeError)));
    const at = buildCompareCharts(result, base, { selection: { metric: 'rank', pick: { kind: 'at', quantile: 0.5 } } });
    expect(at.rows.find((r) => r.id === a.id)!.error).toBe(a.queries.find((q) => q.quantile === 0.5)!.rankError);
  });
});

describe('buildCompareCharts: 扱えない手法 (8.8)', () => {
  it('範囲外で失敗した HDR は表では理由つき、グラフでは注記になる', () => {
    const c: CompareCondition = { ...base, hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 } };
    const r = run(c);
    const b = buildCompareCharts(r, c, { selection: relative });
    const row = b.rows.find((x) => x.id.startsWith('hdr'))!;
    expect(row.status).toBe('error');
    expect(row.reason).not.toBeNull();
    expect(row.reason).not.toBe('');
    expect(row.error).toBeNull();
    expect(row.memoryBytes).toBeNull();
    expect(row.insertOperations).toBeNull();
    expect(row.queryOperations).toBeNull();
    expect(row.elapsedMs).toBeNull();
    for (const id of ['compare-method-error', 'compare-quantile-error', 'compare-count-memory', 'compare-count-elapsed']) {
      expect(byId(b, id).notes.some((n) => n.includes(row.label) && n.includes('計算できませんでした'))).toBe(true);
      expect(byId(b, id).series.some((s) => s.id.startsWith('hdr'))).toBe(false);
    }
    // 残りの手法は表示される
    expect(b.rows.filter((x) => x.status === 'ok')).toHaveLength(base.algorithms.length - 1);
    // 失敗した HDR の 1/S の基準線は出ない
    expect(byId(b, 'compare-quantile-error').referenceLines.map((l) => l.label).join('')).not.toContain('HDR');
  });

  it('バケットの総数の上限で除いた HDR は、表に理由つきの行、グラフに注記が出る', () => {
    const algorithms: CompareAlgorithm[] = [{ kind: 'exact-sort' }, { kind: 'hdr', significantDigits: 2 }, { kind: 'hdr', significantDigits: 4 }];
    const c: CompareCondition = { ...base, algorithms, hdrRange: WIDE };
    const r = run(c);
    const b = buildCompareCharts(r, c, { selection: relative });
    expect(b.rows).toHaveLength(3);
    const ex = b.rows[2]!;
    expect(ex.id).toBe('hdr-d4');
    expect(ex.status).toBe('error');
    expect(ex.reason).toContain(formatInt(MAX_HDR_BUCKETS));
    expect(ex.reason).toContain(r.hdrPlan.excluded[0]!.reason);
    expect(ex.error).toBeNull();
    for (const chart of b.charts) {
      expect(chart.notes.some((n) => n.includes(ex.label))).toBe(true);
    }
    // 除いた HDR の基準線は出ず、実行した有効桁数の 1/S だけが出る
    const q = byId(b, 'compare-quantile-error');
    expect(q.referenceLines.filter((l) => l.label.includes('HDR'))).toHaveLength(1);
  });
});

describe('buildCompareCharts: 処理時間は参考値 (8.3)', () => {
  it('処理時間のグラフに、環境によって変わる参考値であることが書かれ、操作数のグラフには環境によらないことが書かれる', () => {
    for (const id of ['compare-method-elapsed', 'compare-count-elapsed']) {
      const c = byId(builtRel, id);
      expect(c.notes.some((n) => n.includes('参考値'))).toBe(true);
      expect(c.summary).toContain('参考値');
    }
    expect(byId(builtRel, 'compare-method-operations').summary).toContain('環境によらない');
  });
});
