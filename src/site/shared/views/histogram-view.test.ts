import { describe, expect, it } from 'vitest';
import { DEFAULT_HISTOGRAM, type HistogramPageCondition } from '../conditions';
import { bucketsGrid, countGrid, DETAIL_QUANTILES } from '../grids';
import type { HistogramPageResult } from '../protocol';
import { runHistogramPage } from '../../worker/run-histogram-page';
import { DEFAULT_ERROR_SELECTION } from '../metric';
import { buildHistogramCharts, cdfChart } from './histogram-view';

const N = 1_000;
const base: HistogramPageCondition = { ...DEFAULT_HISTOGRAM, data: { ...DEFAULT_HISTOGRAM.data, count: N } };
const options = { selection: DEFAULT_ERROR_SELECTION };

function run(c: HistogramPageCondition): HistogramPageResult {
  const r = runHistogramPage(c);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const result = run(base);
const charts = buildHistogramCharts(result, base, options);
const byId = (id: string) => {
  const c = charts.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no chart ${id}`);
  return c;
};

describe('buildHistogramCharts', () => {
  it('5 枚のグラフを決まった順序で作る', () => {
    expect(charts.map((c) => c.id)).toEqual([
      'histogram-buckets-error',
      'histogram-count-operations',
      'histogram-count-memory',
      'histogram-cdf',
      'histogram-quantile-error',
    ]);
  });

  it('バケット数 × 誤差: 境界の決め方ごとの系列で、厳密解を含まない (4.3)', () => {
    const c = byId('histogram-buckets-error');
    expect(c.series.map((s) => s.label)).toEqual(['等幅', '指数幅']);
    const grid = bucketsGrid(base.buckets);
    const run0 = result.paramSweep.cases[0]!.sweep.runs[0]!;
    for (const s of c.series) {
      expect(s.points.map((p) => p.x)).toEqual(grid);
    }
    const equal = c.series[0]!;
    for (const p of equal.points) {
      const r = run0.algorithms.find((a) => a.id === `histogram-equal-${p.x}`)!;
      if (r.status !== 'ok') throw new Error('unexpected');
      expect(p.y).toBe(Math.max(...r.queries.map((q) => q.rankError)));
    }
    expect(c.series.some((s) => s.id.startsWith('exact'))).toBe(false);
    expect(c.x.label).toBe('バケット数');
    expect(c.y.label).toBe('順位誤差');
    expect(c.y.scale).toBe('log');
    expect(c.notes).toEqual([]);
  });

  it('誤差の指標と分位点の選択が反映される', () => {
    const run0 = result.paramSweep.cases[0]!.sweep.runs[0]!;
    const out = buildHistogramCharts(result, base, { selection: { metric: 'absolute', pick: { kind: 'at', quantile: 0.5 } } });
    const c = out.find((x) => x.id === 'histogram-buckets-error')!;
    expect(c.y.label).toBe('絶対誤差');
    const p = c.series[0]!.points[0]!;
    const r = run0.algorithms.find((a) => a.id === `histogram-equal-${p.x}`)!;
    if (r.status !== 'ok') throw new Error('unexpected');
    expect(p.y).toBe(r.queries.find((q) => q.quantile === 0.5)!.absoluteError);
  });

  it('件数 × 操作数と件数 × メモリ: 厳密解 2 方式と現在のバケット数のヒストグラム (4.4)', () => {
    const grid = countGrid(N);
    for (const id of ['histogram-count-operations', 'histogram-count-memory']) {
      const c = byId(id);
      expect(c.series).toHaveLength(2 + base.schemes.length);
      expect(c.series.some((s) => s.label.includes('B=32'))).toBe(true);
      for (const s of c.series) expect(s.points.map((p) => p.x)).toEqual(grid);
      expect(c.x.scale).toBe('log');
      expect(c.y.scale).toBe('log');
    }
    const mem = byId('histogram-count-memory');
    const lastRun = result.countSweep.cases[0]!.sweep.runs.at(-1)!;
    const first = lastRun.algorithms[0]!;
    if (first.status !== 'ok') throw new Error('unexpected');
    expect(mem.series[0]!.points.at(-1)!.y).toBe(first.afterInsertion.memoryBytes);
    expect(byId('histogram-count-operations').series[0]!.label).toContain('整列');
  });

  it('累積分布: 厳密値の折れ線とヒストグラムの推定値の点が詳細の値に等しい (4.5)', () => {
    const c = byId('histogram-cdf');
    const run0 = result.detail.cases[0]!.sweep.runs[0]!;
    const sort = run0.algorithms.find((a) => a.id.startsWith('exact-sort'))!;
    if (sort.status !== 'ok') throw new Error('unexpected');
    const line = c.series.find((s) => s.kind === 'line')!;
    expect(line.points).toHaveLength(DETAIL_QUANTILES.length);
    expect(line.points.map((p) => [p.x, p.y])).toEqual(sort.queries.map((q) => [q.exact, q.quantile]));
    const dots = c.series.filter((s) => s.kind === 'scatter');
    expect(dots.map((s) => s.id)).toEqual(['histogram-equal-32', 'histogram-exponential-32']);
    for (const s of dots) {
      const r = run0.algorithms.find((a) => a.id === s.id)!;
      if (r.status !== 'ok') throw new Error('unexpected');
      expect(s.points.map((p) => [p.x, p.y])).toEqual(r.queries.map((q) => [q.estimate, q.quantile]));
    }
    expect(c.x.scale).toBe('log');
    expect(c.x.toggleable).toBe(true);
    expect(c.y.scale).toBe('linear');
  });

  it('分位点 × 誤差: ヒストグラムだけが系列になる', () => {
    const c = byId('histogram-quantile-error');
    expect(c.series.map((s) => s.id)).toEqual(['histogram-equal-32', 'histogram-exponential-32']);
    expect(c.series[0]!.points).toHaveLength(DETAIL_QUANTILES.length);
    expect(c.x.scale).toBe('linear');
    expect(c.y.scale).toBe('log');
  });

  it('題名・要約が空でない', () => {
    for (const c of charts) {
      expect(c.title).not.toBe('');
      expect(c.summary).not.toBe('');
    }
  });
});

describe('範囲外のヒストグラム (4.6)', () => {
  const fixed: HistogramPageCondition = { ...base, range: { kind: 'fixed', lower: 5, upper: 10 } };
  const bad = run(fixed);
  const out = buildHistogramCharts(bad, fixed, options);

  it('ヒストグラムは点にならず注記になり、厳密解の系列は残る', () => {
    const ops = out.find((c) => c.id === 'histogram-count-operations')!;
    expect(ops.series.map((s) => s.id).every((id) => id.startsWith('exact'))).toBe(true);
    expect(ops.series).toHaveLength(2);
    expect(ops.notes.length).toBe(2);
    expect(ops.notes[0]).toContain('計算できませんでした');
    expect(ops.notes[0]).toContain('ヒストグラム');
    const err = out.find((c) => c.id === 'histogram-buckets-error')!;
    expect(err.series).toHaveLength(0);
    expect(err.notes.length).toBeGreaterThan(0);
    const cdf = out.find((c) => c.id === 'histogram-cdf')!;
    expect(cdf.series.filter((s) => s.kind === 'scatter')).toHaveLength(0);
    expect(cdf.series.filter((s) => s.kind === 'line')).toHaveLength(1);
    expect(cdf.notes).toHaveLength(2);
  });
});

describe('cdfChart', () => {
  it('詳細がない結果では系列のない図になる', () => {
    const empty = cdfChart({ schemaVersion: 1, cases: [] });
    expect(empty.series).toEqual([]);
  });
});
