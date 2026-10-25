import { describe, expect, it } from 'vitest';
import type { AlgorithmResult } from '../../../core';
import type { GkTuple } from '../../../streaming';
import { DEFAULT_STREAMING, type StreamingPageCondition } from '../conditions';
import { DETAIL_QUANTILES, compressionGrid, epsilonGrid, kGrid } from '../grids';
import { DEFAULT_ERROR_SELECTION } from '../metric';
import type { StreamingPageResult } from '../protocol';
import { runStreamingPage } from '../../worker/run-streaming-page';
import { buildStreamingCharts, limitTableRows, STATE_TABLE_LIMIT } from './streaming-view';

const N = 1_000;
const base: StreamingPageCondition = { ...DEFAULT_STREAMING, data: { ...DEFAULT_STREAMING.data, count: N } };
const options = { selection: DEFAULT_ERROR_SELECTION };

function run(c: StreamingPageCondition): StreamingPageResult {
  const r = runStreamingPage(c);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const result = run(base);
const built = buildStreamingCharts(result, base, options);
const byId = (id: string, list = built.charts) => {
  const c = list.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no chart ${id}`);
  return c;
};
const hasId = (id: string, list = built.charts) => list.some((c) => c.id === id);

function okOf(r: AlgorithmResult) {
  if (r.status !== 'ok') throw new Error('unexpected');
  return r;
}
const maxRank = (r: AlgorithmResult) => Math.max(...okOf(r).queries.map((q) => q.rankError));

describe('buildStreamingCharts: グラフの枚数と順序', () => {
  it('試行 1 回・3 手法: 手法ごとに 2 枚 + メモリ×誤差 + 分位点×誤差 + 順序の 9 枚で、試行のグラフはない (5.7)', () => {
    expect(built.charts.map((c) => c.id)).toEqual([
      'streaming-gk-param-error',
      'streaming-gk-param-memory',
      'streaming-kll-param-error',
      'streaming-kll-param-memory',
      'streaming-tdigest-param-error',
      'streaming-tdigest-param-memory',
      'streaming-tradeoff',
      'streaming-quantile-error',
      'streaming-order-error',
    ]);
    expect(hasId('streaming-kll-trials')).toBe(false);
  });

  it('題名・要約が空でない', () => {
    for (const c of built.charts) {
      expect(c.title).not.toBe('');
      expect(c.summary).not.toBe('');
    }
  });
});

describe('パラメータ × 誤差 / メモリ (5.3)', () => {
  const run0 = result.paramSweep.cases[0]!.sweep.runs[0]!;

  it('GK: x は ε の格子、y は選んだ指標の最大値と投入後のメモリ', () => {
    const err = byId('streaming-gk-param-error');
    const mem = byId('streaming-gk-param-memory');
    expect(err.series).toHaveLength(1);
    expect(err.series[0]!.label).toBe('GK');
    expect(err.series[0]!.points.map((p) => p.x)).toEqual(epsilonGrid(base.epsilon));
    expect(err.x.label).toContain('ε');
    expect(err.y.label).toBe('順位誤差');
    for (const p of err.series[0]!.points) {
      const r = run0.algorithms.find((a) => a.id === `gk-eps-${p.x}`)!;
      expect(p.y).toBe(maxRank(r));
    }
    for (const p of mem.series[0]!.points) {
      const r = okOf(run0.algorithms.find((a) => a.id === `gk-eps-${p.x}`)!);
      expect(p.y).toBe(r.afterInsertion.memoryBytes);
    }
    expect(mem.y.unit).toBe('バイト');
    expect(mem.y.scale).toBe('log');
  });

  it('KLL と t-digest: x は k と δ の格子', () => {
    expect(byId('streaming-kll-param-error').series[0]!.points.map((p) => p.x)).toEqual(kGrid(base.k));
    const td = byId('streaming-tdigest-param-error');
    expect(td.series.map((s) => s.label)).toEqual(['t-digest(k1)']);
    expect(td.series[0]!.points.map((p) => p.x)).toEqual(compressionGrid(base.compression));
  });

  it('t-digest はスケール関数ごとの系列になる', () => {
    const two = run({ ...base, methods: ['tdigest'], scales: ['k1', 'k2'], inspectTarget: 'tdigest' });
    const out = buildStreamingCharts(two, { ...base, methods: ['tdigest'], scales: ['k1', 'k2'], inspectTarget: 'tdigest' }, options);
    const c = byId('streaming-tdigest-param-error', out.charts);
    expect(c.series.map((s) => s.label)).toEqual(['t-digest(k1)', 't-digest(k2)']);
  });
});

describe('メモリ × 誤差 (5.4)', () => {
  it('選んだ手法ごとの系列で、x は投入後のメモリ、y は誤差', () => {
    const c = byId('streaming-tradeoff');
    expect(c.series.map((s) => s.label)).toEqual(['GK', 'KLL', 't-digest(k1)']);
    const run0 = result.paramSweep.cases[0]!.sweep.runs[0]!;
    const gk = c.series[0]!;
    expect(gk.points).toHaveLength(epsilonGrid(base.epsilon).length);
    const memories = gk.points.map((p) => p.x);
    expect(memories).toEqual([...memories].sort((a, b) => (a as number) - (b as number)));
    const eps001 = okOf(run0.algorithms.find((a) => a.id === 'gk-eps-0.01')!);
    expect(gk.points.some((p) => p.x === eps001.afterInsertion.memoryBytes && p.y === maxRank(eps001))).toBe(true);
    expect(c.x.scale).toBe('log');
    expect(c.y.scale).toBe('log');
  });
});

describe('分位点 × 誤差 (5.5)', () => {
  it('詳細の random・最初の試行から、手法ごとに全分位点の系列を作る', () => {
    const c = byId('streaming-quantile-error');
    const ids = c.series.map((s) => s.id);
    expect(ids).toEqual(['gk-eps-0.01', 'kll-k-200', 'tdigest-k1-c100']);
    for (const s of c.series) expect(s.points.map((p) => p.x)).toEqual(DETAIL_QUANTILES);
    const random = result.detail.cases.find((x) => x.order === 'random')!.sweep.runs[0]!;
    const gk = okOf(random.algorithms.find((a) => a.id === 'gk-eps-0.01')!);
    expect(c.series[0]!.points.map((p) => p.y)).toEqual(gk.queries.map((q) => q.rankError));
    expect(c.x.scale).toBe('linear');
    expect(c.y.scale).toBe('log');
  });
});

describe('挿入順序ごとの誤差 (5.6)', () => {
  it('手法ごとの棒の系列で、項目はランダム・昇順・降順', () => {
    const c = byId('streaming-order-error');
    expect(c.series.map((s) => s.id)).toEqual(['gk-eps-0.01', 'kll-k-200', 'tdigest-k1-c100']);
    for (const s of c.series) {
      expect(s.kind).toBe('bar');
      expect(s.points.map((p) => p.x)).toEqual(['ランダム', '昇順', '降順']);
    }
    const asc = result.detail.cases.find((x) => x.order === 'ascending')!.sweep.runs[0]!;
    const kll = asc.algorithms.find((a) => a.id === 'kll-k-200')!;
    expect(c.series[1]!.points[1]!.y).toBe(maxRank(kll));
  });
});

describe('GK の ε の基準線 (5.9)', () => {
  it('GK を表示していて順位誤差のとき、誤差のグラフに y = ε の基準線を引く', () => {
    for (const id of ['streaming-gk-param-error', 'streaming-tradeoff', 'streaming-quantile-error', 'streaming-order-error']) {
      const c = byId(id);
      expect(c.referenceLines).toHaveLength(1);
      expect(c.referenceLines[0]).toMatchObject({ axis: 'y', value: base.epsilon });
      expect(c.referenceLines[0]!.label).toContain('ε');
    }
    expect(byId('streaming-kll-param-error').referenceLines).toEqual([]);
    expect(byId('streaming-gk-param-memory').referenceLines).toEqual([]);
  });

  it('順位誤差以外の指標では基準線がない', () => {
    const out = buildStreamingCharts(result, base, { selection: { metric: 'absolute', pick: { kind: 'max' } } });
    for (const c of out.charts) expect(c.referenceLines).toEqual([]);
  });

  it('GK を選んでいないと GK のグラフ・系列・基準線がない。選んでいない手法は除かれる', () => {
    const cond: StreamingPageCondition = { ...base, methods: ['kll'], inspectTarget: 'kll' };
    const only = buildStreamingCharts(run(cond), cond, options);
    expect(only.charts.map((c) => c.id)).toEqual([
      'streaming-kll-param-error',
      'streaming-kll-param-memory',
      'streaming-tradeoff',
      'streaming-quantile-error',
      'streaming-order-error',
    ]);
    for (const c of only.charts) {
      expect(c.referenceLines).toEqual([]);
      expect(c.series.every((s) => s.id.startsWith('kll'))).toBe(true);
    }
  });

  it('結果に選んでいない手法が入っていても条件の手法だけを描く', () => {
    const cond: StreamingPageCondition = { ...base, methods: ['kll'], inspectTarget: 'kll' };
    const out = buildStreamingCharts(result, cond, options);
    expect(hasId('streaming-gk-param-error', out.charts)).toBe(false);
    expect(byId('streaming-tradeoff', out.charts).series.map((s) => s.id)).toEqual(['kll']);
    expect(byId('streaming-quantile-error', out.charts).series.map((s) => s.id)).toEqual(['kll-k-200']);
  });
});

describe('KLL の試行ごとの誤差 (5.7)', () => {
  const cond: StreamingPageCondition = { ...base, methods: ['kll'], trials: 3, inspectTarget: 'kll' };
  const r3 = run(cond);
  const out = buildStreamingCharts(r3, cond, options);

  it('試行が 2 回以上なら、試行の番号ごとの点とシードを出す', () => {
    const c = byId('streaming-kll-trials', out.charts);
    expect(c.series).toHaveLength(1);
    const pts = c.series[0]!.points;
    expect(pts.map((p) => p.x)).toEqual([1, 2, 3]);
    const runs = r3.detail.cases.find((x) => x.order === 'random')!.sweep.runs;
    expect(runs).toHaveLength(3);
    pts.forEach((p, i) => {
      const kll = runs[i]!.algorithms.find((a) => a.id === 'kll-k-200')!;
      expect(p.y).toBe(maxRank(kll));
      expect(p.detail).toContain(String(runs[i]!.seed));
    });
    expect(c.x.label).toBe('試行');
  });

  it('KLL を選んでいなければ、試行が 2 回以上でも試行のグラフはない', () => {
    const c2: StreamingPageCondition = { ...base, methods: ['gk'], trials: 2, inspectTarget: 'gk' };
    const o = buildStreamingCharts(run(c2), c2, options);
    expect(hasId('streaming-kll-trials', o.charts)).toBe(false);
  });
});

describe('計算できなかった手法の注記 (7.5)', () => {
  it('失敗した GK は点にならず、注記になる', () => {
    const bad: StreamingPageResult = {
      ...result,
      paramSweep: {
        ...result.paramSweep,
        cases: result.paramSweep.cases.map((cs) => ({
          ...cs,
          sweep: {
            ...cs.sweep,
            runs: cs.sweep.runs.map((rn) => ({
              ...rn,
              algorithms: rn.algorithms.map(
                (a): AlgorithmResult =>
                  a.id === 'gk-eps-0.01'
                    ? { status: 'error', id: a.id, label: a.label, params: a.params, stage: 'insert', errorKind: 'exception', message: 'x' }
                    : a,
              ),
            })),
          },
        })),
      },
    };
    const out = buildStreamingCharts(bad, base, options);
    const c = byId('streaming-gk-param-error', out.charts);
    expect(c.series[0]!.points.map((p) => p.x)).not.toContain(0.01);
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]).toContain('計算できませんでした');
    expect(byId('streaming-kll-param-error', out.charts).notes).toEqual([]);
  });
});

describe('内部状態 (5.8)', () => {
  it('GK: 値 × (g + 順位の幅) の点と、タプルの表、要点の数値', () => {
    const insp = built.inspection;
    if (result.inspection.algorithm !== 'gk') throw new Error('unexpected');
    const st = result.inspection.state;
    expect(insp.chart.series).toHaveLength(1);
    expect(insp.chart.series[0]!.kind).toBe('scatter');
    expect(insp.chart.series[0]!.points.map((p) => [p.x, p.y])).toEqual(st.tuples.map((t) => [t.value, t.g + t.delta]));
    expect(insp.table.columns).toEqual(['番号', '値', 'g', '順位の幅 Δ', 'g + Δ']);
    expect(insp.table.rows.length).toBe(Math.min(st.tuples.length, STATE_TABLE_LIMIT));
    expect(insp.truncated).toBe(st.tuples.length > STATE_TABLE_LIMIT);
    const facts = Object.fromEntries(insp.facts.map((f) => [f.label, f.value]));
    expect(facts['件数']).toBe('1,000');
    expect(facts['タプル数']).toBe(String(st.tuples.length).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  });

  it('KLL: 段ごとの保持数と容量の棒、段の表、要点', () => {
    const cond: StreamingPageCondition = { ...base, inspectTarget: 'kll' };
    const r = run(cond);
    if (r.inspection.algorithm !== 'kll') throw new Error('unexpected');
    const st = r.inspection.state;
    const insp = buildStreamingCharts(r, cond, options).inspection;
    expect(insp.chart.series.map((s) => s.label)).toEqual(['保持数', '容量']);
    expect(insp.chart.series.every((s) => s.kind === 'bar')).toBe(true);
    expect(insp.chart.series[0]!.points.map((p) => p.y)).toEqual(st.levels.map((l) => l.values.length));
    expect(insp.chart.series[1]!.points.map((p) => p.y)).toEqual(st.levels.map((l) => l.capacity));
    expect(insp.chart.series[0]!.points.map((p) => p.x)).toEqual(st.levels.map((l) => `段 ${l.level}`));
    expect(insp.table.columns).toEqual(['段', '重み', '容量', '保持数']);
    expect(insp.table.rows).toHaveLength(st.levels.length);
    expect(insp.truncated).toBe(false);
    expect(insp.facts.map((f) => f.label)).toEqual(expect.arrayContaining(['件数', '段数', '圧縮の回数']));
  });

  it('t-digest: 平均値 × 重みの点と、centroid の表、要点', () => {
    const cond: StreamingPageCondition = { ...base, inspectTarget: 'tdigest' };
    const r = run(cond);
    if (r.inspection.algorithm !== 'tdigest') throw new Error('unexpected');
    const st = r.inspection.state;
    const insp = buildStreamingCharts(r, cond, options).inspection;
    expect(insp.chart.series[0]!.points.map((p) => [p.x, p.y])).toEqual(st.centroids.map((c) => [c.mean, c.weight]));
    expect(insp.table.columns).toEqual(['番号', '平均値', '重み']);
    expect(insp.table.rows).toHaveLength(Math.min(st.centroids.length, STATE_TABLE_LIMIT));
    expect(insp.facts.map((f) => f.label)).toEqual(expect.arrayContaining(['件数', 'centroid 数', 'バッファ件数', 'スケール関数']));
  });

  it('200 行を超える状態では先頭 100 行と末尾 100 行だけを表にし、省略を明記する', () => {
    if (result.inspection.algorithm !== 'gk') throw new Error('unexpected');
    const tuples: GkTuple[] = Array.from({ length: 450 }, (_, i) => ({ value: i + 1, g: 1, delta: i % 5 }));
    const big: StreamingPageResult = { ...result, inspection: { algorithm: 'gk', state: { ...result.inspection.state, tuples } } };
    const insp = buildStreamingCharts(big, base, options).inspection;
    expect(insp.truncated).toBe(true);
    expect(insp.table.rows).toHaveLength(200);
    expect(insp.table.rows[0]![0]).toBe('1');
    expect(insp.table.rows[99]![0]).toBe('100');
    expect(insp.table.rows[100]![0]).toBe('351');
    expect(insp.table.rows[199]![0]).toBe('450');
    expect(insp.truncation).toEqual({ total: 450, head: 100, tail: 100, notice: '先頭 100 行と末尾 100 行を表示(全 450 行)' });
    expect(insp.chart.series[0]!.points).toHaveLength(450);
  });
});

describe('limitTableRows', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [String(i + 1)]);

  it('200 行ちょうどは省略しない', () => {
    const r = limitTableRows(rows(200));
    expect(r.truncated).toBe(false);
    expect(r.rows).toHaveLength(200);
    expect(r.truncation).toBeNull();
  });

  it('201 行から省略する', () => {
    const r = limitTableRows(rows(201));
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(200);
    expect(r.rows[100]).toEqual(['102']);
    expect(r.truncation!.total).toBe(201);
  });

  it('入力を変更しない', () => {
    const input = rows(300);
    limitTableRows(input);
    expect(input).toHaveLength(300);
  });
});
