import { describe, expect, it } from 'vitest';
import type { AlgorithmResult } from '../../../core';
import { MAX_HDR_BUCKETS } from '../limits';
import { DEFAULT_RELATIVE, type RelativePageCondition } from '../conditions';
import { formatInt, formatSig3 } from '../format';
import { alphaGrid, countGrid, digitsGrid } from '../grids';
import type { ErrorSelection } from '../metric';
import type { HdrDigitsInfo, HdrPlanSummary, RelativePageResult } from '../protocol';
import { runRelativePage } from '../../worker/run-relative-page';
import { buildRelativeCharts } from './relative-view';

const N = 1_000;
const base: RelativePageCondition = { ...DEFAULT_RELATIVE, data: { ...DEFAULT_RELATIVE.data, count: N } };
const selection: ErrorSelection = { metric: 'relative', pick: { kind: 'max' } };
const options = { selection };

function run(c: RelativePageCondition): RelativePageResult {
  const r = runRelativePage(c);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const result = run(base);
const built = buildRelativeCharts(result, base, options);
const byId = (id: string, list = built.charts) => {
  const c = list.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no chart ${id}`);
  return c;
};
const ids = (list = built.charts) => list.map((c) => c.id);

function okOf(r: AlgorithmResult) {
  if (r.status !== 'ok') throw new Error('unexpected');
  return r;
}
const WIDE = { kind: 'manual', lowest: 1e-42, highest: 1e42 } as const;

/** 計画だけを差し替えた結果(通知の条件の検証用) */
function withPlan(r: RelativePageResult, plan: Partial<HdrPlanSummary>): RelativePageResult {
  return { ...r, hdrPlan: { ...r.hdrPlan, ...plan } };
}
function digitsInfo(from: HdrDigitsInfo, d: number): HdrDigitsInfo {
  return { ...from, significantDigits: d };
}

describe('buildRelativeCharts: グラフの枚数と順序', () => {
  it('除いた有効桁数の通知に、バケットの総数の上限と理由が入る', () => {
    const r = withPlan(result, { excluded: [{ significantDigits: 9, reason: 'r' }] });
    expect(buildRelativeCharts(r, base, options).hdrNotices[0]).toContain(`上限(${formatInt(MAX_HDR_BUCKETS)})`);
  });

  it('DDSketch と HDR を選ぶと、分位点 + α の 3 枚 + 有効桁数の 3 枚 + 件数の 2 枚の 9 枚 (6.3, 6.4, 6.8)', () => {
    expect(ids()).toEqual([
      'relative-quantile-error',
      'relative-alpha-error',
      'relative-alpha-buckets',
      'relative-alpha-memory',
      'relative-digits-error',
      'relative-digits-buckets',
      'relative-digits-memory',
      'relative-count-operations',
      'relative-count-memory',
    ]);
    for (const c of built.charts) {
      expect(c.title).not.toBe('');
      expect(c.summary).not.toBe('');
    }
  });

  it('DDSketch だけを選ぶと有効桁数のグラフと HDR の系列・通知がない (6.1)', () => {
    const c: RelativePageCondition = { ...base, methods: ['ddsketch'] };
    const b = buildRelativeCharts(run(c), c, options);
    expect(ids(b.charts)).toEqual([
      'relative-quantile-error',
      'relative-alpha-error',
      'relative-alpha-buckets',
      'relative-alpha-memory',
      'relative-count-operations',
      'relative-count-memory',
    ]);
    for (const chart of b.charts) {
      expect(chart.series.some((s) => s.id.startsWith('hdr'))).toBe(false);
      expect(chart.referenceLines.some((l) => l.label.includes('HDR'))).toBe(false);
      expect(chart.notes.some((n) => n.includes('HDR'))).toBe(false);
    }
    expect(b.hdrNotices).toEqual([]);
  });

  it('HDR を選ばないと、計画に除いた有効桁数や下限の切り詰めがあっても HDR の通知は出ない (6.4)', () => {
    const c: RelativePageCondition = { ...base, methods: ['ddsketch'] };
    const r = withPlan(run(c), {
      lowestClamped: true,
      referenceDigits: 0,
      excluded: [{ significantDigits: 4, reason: 'x' }],
    });
    const b = buildRelativeCharts(r, c, options);
    expect(b.hdrNotices).toEqual([]);
    for (const chart of b.charts) expect(chart.notes.join('')).not.toContain('有効桁数 4');
  });

  it('HDR だけを選ぶと α のグラフがなく、DDSketch の系列と基準線がない', () => {
    const c: RelativePageCondition = { ...base, methods: ['hdr'], inspectTarget: 'hdr' };
    const b = buildRelativeCharts(run(c), c, options);
    expect(ids(b.charts)).toEqual([
      'relative-quantile-error',
      'relative-digits-error',
      'relative-digits-buckets',
      'relative-digits-memory',
      'relative-count-operations',
      'relative-count-memory',
    ]);
    for (const chart of b.charts) {
      expect(chart.series.some((s) => s.id.startsWith('ddsketch'))).toBe(false);
      expect(chart.referenceLines.some((l) => l.label.includes('DDSketch'))).toBe(false);
    }
  });
});

describe('分位点 × 相対誤差 (6.3)', () => {
  const chart = byId('relative-quantile-error');
  const detail = result.detail.cases[0]!.sweep.runs[0]!;

  it('DDSketch と HDR の系列を作り、値は結果の相対誤差そのまま。厳密解は含めない', () => {
    expect(chart.series.map((s) => s.id).sort()).toEqual(
      detail.algorithms
        .map((a) => a.id)
        .filter((id) => id.startsWith('ddsketch') || id.startsWith('hdr'))
        .sort(),
    );
    const dd = chart.series.find((s) => s.id.startsWith('ddsketch'))!;
    const src = okOf(detail.algorithms.find((a) => a.id === dd.id)!);
    expect(dd.points.map((p) => [p.x, p.y])).toEqual(src.queries.map((q) => [q.quantile, q.relativeError]));
    expect(chart.x.label).toBe('分位点');
    expect(chart.y.label).toBe('相対誤差');
  });

  it('y = α と y = 1/S(現在の有効桁数)の基準線が出る', () => {
    const info = result.hdrPlan.included.find((i) => i.significantDigits === base.significantDigits)!;
    const alpha = chart.referenceLines.find((l) => l.label.includes('DDSketch'))!;
    const hdr = chart.referenceLines.find((l) => l.label.includes('HDR'))!;
    expect(alpha.axis).toBe('y');
    expect(alpha.value).toBe(base.alpha);
    expect(alpha.label).toContain('α');
    expect(hdr.axis).toBe('y');
    expect(hdr.value).toBe(1 / info.subBucketCount);
    expect(hdr.label).toContain('1/S');
    expect(hdr.label).toContain(`d = ${base.significantDigits}`);
  });

  it('指標が順位誤差のときは題名も順位誤差になる', () => {
    const b = buildRelativeCharts(result, base, { selection: { metric: 'rank', pick: { kind: 'max' } } });
    const title = byId('relative-quantile-error', b.charts).title;
    expect(title).toContain('順位誤差');
    expect(title).not.toContain('相対誤差');
    expect(chart.title).toContain('相対誤差');
  });

  it('指標が相対誤差でないときは α と 1/S の基準線を出さない', () => {
    const b = buildRelativeCharts(result, base, { selection: { metric: 'rank', pick: { kind: 'max' } } });
    expect(byId('relative-quantile-error', b.charts).referenceLines).toEqual([]);
  });

  it('自動の範囲では全分位点が half × L 以上なので、保証の対象外の注記はない', () => {
    expect(chart.notes.filter((n) => n.includes('対象外'))).toEqual([]);
  });

  it('厳密値が half × L 未満の分位点があると、その分位点の範囲と half × L を注記する', () => {
    const c: RelativePageCondition = { ...base, hdrRange: { kind: 'manual', lowest: 1e-3, highest: 1e3 } };
    const r = run(c);
    const info = r.hdrPlan.included.find((i) => i.significantDigits === c.significantDigits)!;
    expect(info.guaranteeFrom).toBeGreaterThan(0);
    const exact = r.detail.cases[0]!.sweep.runs[0]!.algorithms.map(okOf).find((a) => a.id.startsWith('exact'))!;
    const below = exact.queries.filter((q) => q.exact < info.guaranteeFrom).map((q) => q.quantile);
    expect(below.length).toBeGreaterThan(0);
    expect(below.length).toBeLessThan(exact.queries.length);
    const note = byId('relative-quantile-error', buildRelativeCharts(r, c, options).charts).notes.find((n) =>
      n.includes('対象外'),
    );
    expect(note).toBeDefined();
    expect(note).toContain(`分位点 ${Math.min(...below)}〜${Math.max(...below)}`);
    expect(note).toContain('half × L');
    expect(note).toContain('1/S');
    expect(note).toContain(formatSig3(info.guaranteeFrom));
  });

  it('HDR を選ばないと保証の対象外の注記は出ない', () => {
    const c: RelativePageCondition = { ...base, methods: ['ddsketch'], hdrRange: { kind: 'manual', lowest: 1e-3, highest: 1e3 } };
    const b = buildRelativeCharts(run(c), c, options);
    expect(byId('relative-quantile-error', b.charts).notes).toEqual([]);
  });
});

describe('α ごと・有効桁数ごと (6.4)', () => {
  const run0 = result.paramSweep.cases[0]!.sweep.runs[0]!;

  it('α × 誤差・バケット数・メモリ。x は α の格子で、y は結果の値', () => {
    const err = byId('relative-alpha-error');
    const buckets = byId('relative-alpha-buckets');
    const mem = byId('relative-alpha-memory');
    const grid = alphaGrid(base.alpha);
    for (const c of [err, buckets, mem]) {
      expect(c.series).toHaveLength(1);
      expect(c.series[0]!.label).toBe('DDSketch');
      expect(c.series[0]!.points.map((p) => p.x)).toEqual(grid);
      expect(c.x.label).toContain('α');
    }
    for (const p of err.series[0]!.points) {
      const a = okOf(run0.algorithms.find((x) => x.id === `ddsketch-a${p.x}-m${base.maxBuckets}`)!);
      expect(p.y).toBe(Math.max(...a.queries.map((q) => q.relativeError)));
    }
    for (const p of mem.series[0]!.points) {
      const a = okOf(run0.algorithms.find((x) => x.id === `ddsketch-a${p.x}-m${base.maxBuckets}`)!);
      expect(p.y).toBe(a.afterInsertion.memoryBytes);
    }
    const stats = result.paramSweep.cases[0]!.bucketStats;
    for (const p of buckets.series[0]!.points) {
      const s = stats.find((x) => x.sketchId === `ddsketch-a${p.x}-m${base.maxBuckets}`)!;
      expect(s.status === 'ok' && s.bucketCount).toBe(p.y);
    }
    expect(mem.y.unit).toBe('バイト');
  });

  it('有効桁数 × 誤差・バケット数・メモリ。x は有効桁数の格子', () => {
    const grid = digitsGrid(base.significantDigits);
    for (const id of ['relative-digits-error', 'relative-digits-buckets', 'relative-digits-memory']) {
      const c = byId(id);
      const s = c.series.find((x) => x.id === 'hdr')!;
      expect(s.label).toBe('HDR Histogram');
      expect(s.points.map((p) => p.x)).toEqual(grid);
      expect(c.x.label).toContain('有効桁数');
    }
    const buckets = byId('relative-digits-buckets').series[0]!;
    for (const p of buckets.points) {
      expect(p.y).toBe(result.hdrPlan.included.find((i) => i.significantDigits === p.x)!.totalBuckets);
    }
  });

  it('有効桁数ごとの誤差には、有効桁数ごとの 1/S を破線の系列として重ねる', () => {
    const err = byId('relative-digits-error');
    const dashed = err.series.filter((s) => s.dashed === true);
    expect(dashed).toHaveLength(1);
    expect(dashed[0]!.label).toContain('1/S');
    expect(dashed[0]!.points.map((p) => ({ x: p.x, y: p.y }))).toEqual(
      result.hdrPlan.included.map((i) => ({ x: i.significantDigits, y: 1 / i.subBucketCount })),
    );
    // 他のグラフ・他の系列は破線にしない
    expect(err.series.filter((s) => s.dashed !== true)).toHaveLength(1);
    expect(byId('relative-digits-memory').series.some((s) => s.dashed === true)).toBe(false);
  });

  it('指標が相対誤差でないときは 1/S の系列を重ねない', () => {
    const b = buildRelativeCharts(result, base, { selection: { metric: 'rank', pick: { kind: 'max' } } });
    expect(byId('relative-digits-error', b.charts).series.some((s) => s.dashed === true)).toBe(false);
  });

  it('除いた有効桁数は点を作らず、通知と有効桁数のグラフの注記に理由が出る', () => {
    const c: RelativePageCondition = { ...base, hdrRange: WIDE };
    const r = run(c);
    expect(r.hdrPlan.excluded.map((e) => e.significantDigits)).toEqual([4]);
    const b = buildRelativeCharts(r, c, options);
    const reason = r.hdrPlan.excluded[0]!.reason;
    const text = `有効桁数 4: バケットの総数が上限(${formatInt(MAX_HDR_BUCKETS)})を超えるため除きました(${reason})`;
    expect(b.hdrNotices).toContain(text);
    for (const id of ['relative-digits-error', 'relative-digits-buckets', 'relative-digits-memory']) {
      const chart = byId(id, b.charts);
      expect(chart.notes).toContain(text);
      for (const s of chart.series) expect(s.points.some((p) => p.x === 4)).toBe(false);
    }
  });

  it('範囲が狭くて HDR が計算できないと、有効桁数のグラフの注記に理由が出て DDSketch の結果は残る (6.7)', () => {
    const c: RelativePageCondition = { ...base, hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 }, inspectTarget: 'hdr' };
    const b = buildRelativeCharts(run(c), c, options);
    const q = byId('relative-quantile-error', b.charts);
    expect(q.series.some((s) => s.id.startsWith('hdr'))).toBe(false);
    expect(q.series.some((s) => s.id.startsWith('ddsketch'))).toBe(true);
    expect(q.notes.some((n) => n.includes('HDR') && n.includes('計算できませんでした'))).toBe(true);
    expect(byId('relative-digits-error', b.charts).notes.some((n) => n.includes('計算できませんでした'))).toBe(true);
    expect(byId('relative-alpha-error', b.charts).series).toHaveLength(1);
  });
});

describe('基準の有効桁数を下げた通知と下限の切り詰めの通知 (6.4)', () => {
  const info = result.hdrPlan.included[0]!;
  const upTo = (max: number): HdrDigitsInfo[] => Array.from({ length: max + 1 }, (_, d) => digitsInfo(info, d));
  const loweredText = (r: RelativePageResult) =>
    buildRelativeCharts(r, base, options).hdrNotices.filter((n) => n.includes('基準にして') || n.includes('を基準に'));

  it('基準の有効桁数が実行した最大値より小さければ通知する', () => {
    const r = withPlan(result, { mode: 'auto', referenceDigits: 3, included: upTo(4) });
    const notices = loweredText(r);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('有効桁数 3');
    expect(notices[0]).toContain('バケットの総数の上限');
  });

  it('現在の有効桁数が格子の最大値(4)より大きく、基準が格子の最大値に等しい結果でも通知する', () => {
    const c: RelativePageCondition = { ...base, significantDigits: 5 };
    const r = withPlan(result, { mode: 'auto', referenceDigits: 4, included: upTo(5) });
    const notices = buildRelativeCharts(r, c, options).hdrNotices.filter((n) => n.includes('を基準に'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('有効桁数 4');
  });

  it('基準が実行した最大値以上なら通知しない', () => {
    expect(loweredText(withPlan(result, { mode: 'auto', referenceDigits: 4, included: upTo(4) }))).toEqual([]);
    expect(loweredText(withPlan(result, { mode: 'auto', referenceDigits: 5, included: upTo(5) }))).toEqual([]);
  });

  it('手動の範囲(基準なし)では通知しない', () => {
    expect(loweredText(withPlan(result, { mode: 'manual', referenceDigits: null, included: upTo(4) }))).toEqual([]);
  });

  it('下限を切り詰めたときは、切り詰めた L とともに通知する', () => {
    const r = withPlan(result, { lowestClamped: true });
    const notices = buildRelativeCharts(r, base, options).hdrNotices.filter((n) => n.includes('切り詰め'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('範囲の下限 L');
    expect(notices[0]).toContain('L より小さい値は HDR の範囲外');
    expect(notices[0]).toMatch(/\d/);
  });

  it('切り詰めていなければ切り詰めの通知は出ない', () => {
    expect(built.hdrNotices.some((n) => n.includes('切り詰め'))).toBe(false);
  });

  it('通知は有効桁数のグラフの注記にも出る', () => {
    const r = withPlan(result, { mode: 'auto', referenceDigits: 3, included: upTo(4), lowestClamped: true });
    const b = buildRelativeCharts(r, base, options);
    expect(b.hdrNotices).toHaveLength(2);
    for (const n of b.hdrNotices) expect(byId('relative-digits-error', b.charts).notes).toContain(n);
  });
});

describe('件数 × メモリ・操作数 (6.8)', () => {
  it('厳密解 2 方式と選んだ手法の系列で、x は件数の格子、y は結果の値', () => {
    const mem = byId('relative-count-memory');
    const ops = byId('relative-count-operations');
    expect(mem.series.map((s) => s.id).sort()).toEqual(
      result.countSweep.cases[0]!.sweep.runs[0]!.algorithms.map((a) => a.id).sort(),
    );
    expect(mem.series.some((s) => s.id.startsWith('exact'))).toBe(true);
    for (const s of mem.series) expect(s.points.map((p) => p.x)).toEqual(countGrid(N));
    const lastRun = result.countSweep.cases[0]!.sweep.runs.at(-1)!;
    const dd = okOf(lastRun.algorithms.find((a) => a.id.startsWith('ddsketch'))!);
    expect(mem.series.find((s) => s.id === dd.id)!.points.at(-1)!.y).toBe(dd.afterInsertion.memoryBytes);
    const comparisons = dd.afterInsertion.operations.comparisons + dd.afterInsertion.operations.moves;
    const queryOps = dd.queries.reduce((n, q) => n + q.operations.comparisons + q.operations.moves, 0);
    expect(ops.series.find((s) => s.id === dd.id)!.points.at(-1)!.y).toBe(comparisons + queryOps);
    expect(mem.y.unit).toBe('バイト');
    expect(ops.y.unit).toBe('回');
  });

  it('選んでいない手法は系列に入らず、厳密解は残る', () => {
    const c: RelativePageCondition = { ...base, methods: ['ddsketch'] };
    const b = buildRelativeCharts(run(c), c, options);
    const ids2 = byId('relative-count-memory', b.charts).series.map((s) => s.id);
    expect(ids2.some((id) => id.startsWith('hdr'))).toBe(false);
    expect(ids2.some((id) => id.startsWith('exact'))).toBe(true);
  });
});

describe('バケットの状態 (6.5, 6.6)', () => {
  it('DDSketch: x は代表値(対数軸)、y は件数の点と、番号・下側・上側・代表値・件数の表', () => {
    if (!('inspection' in built) || 'rejected' in built.inspection) throw new Error('unexpected');
    const view = built.inspection;
    const snap = result.inspection;
    if (snap.algorithm !== 'ddsketch' || !('snapshot' in snap)) throw new Error('unexpected');
    expect(view.chart.x.scale).toBe('log');
    expect(view.chart.x.label).toContain('代表値');
    expect(view.chart.y.label).toBe('件数');
    expect(view.chart.series).toHaveLength(1);
    expect(view.chart.series[0]!.points.map((p) => [p.x, p.y])).toEqual(
      snap.snapshot.buckets.map((b) => [b.representative, b.count]),
    );
    expect(view.table.columns).toEqual(['番号', '下側の境界', '上側の境界', '代表値', '件数']);
    expect(view.table.rows).toHaveLength(Math.min(snap.snapshot.buckets.length, 200));
    expect(view.table.rows[0]![0]).toBe(String(snap.snapshot.buckets[0]!.index));
    expect(view.chart.referenceLines).toEqual([]);
  });

  it('縮約なし: 通知は縮約が起きていないことを示し、基準線はない', () => {
    expect(built.collapse).toMatchObject({ collapsed: false, upperBound: null, collapseCount: 0 });
    expect(built.collapse!.message).toContain('縮約は起きていません');
  });

  it('縮約あり: 回数・影響の上限を通知し、影響の上限の基準線を描く', () => {
    const c: RelativePageCondition = { ...base, alpha: 0.001, maxBuckets: 8, methods: ['ddsketch'] };
    const r = run(c);
    const b = buildRelativeCharts(r, c, options);
    if (r.inspection.algorithm !== 'ddsketch' || !('snapshot' in r.inspection)) throw new Error('unexpected');
    const snap = r.inspection.snapshot;
    expect(snap.collapsed).toBe(true);
    expect(b.collapse).toMatchObject({ collapsed: true, upperBound: snap.collapsedUpperBound, collapseCount: snap.collapseCount });
    expect(b.collapse!.collapseCount).toBeGreaterThan(0);
    expect(b.collapse!.message).toContain('縮約が起きました');
    if ('rejected' in b.inspection) throw new Error('unexpected');
    const line = b.inspection.chart.referenceLines.find((l) => l.axis === 'x')!;
    expect(line.value).toBe(snap.collapsedUpperBound);
    expect(line.label).toContain('縮約');
    expect(b.inspection.chart.notes.join('')).toContain('縮約が起きました');
  });

  it('HDR: 保証が始まる値 half × L と最小の識別単位 L の基準線を描き、縮約の通知はない', () => {
    const c: RelativePageCondition = { ...base, inspectTarget: 'hdr' };
    const r = run(c);
    const b = buildRelativeCharts(r, c, options);
    if (r.inspection.algorithm !== 'hdr' || !('snapshot' in r.inspection)) throw new Error('unexpected');
    if ('rejected' in b.inspection) throw new Error('unexpected');
    const info = r.hdrPlan.included.find((i) => i.significantDigits === c.significantDigits)!;
    const lines = b.inspection.chart.referenceLines;
    expect(lines.every((l) => l.axis === 'x')).toBe(true);
    expect(lines.find((l) => l.label.includes('half × L'))!.value).toBe(info.guaranteeFrom);
    expect(lines.find((l) => l.label.includes('最小の識別単位'))!.value).toBe(r.hdrRange.lowest);
    expect(lines).toHaveLength(2);
    expect(b.collapse).toBeNull();
    expect(b.inspection.chart.series[0]!.points).toHaveLength(r.inspection.snapshot.buckets.length);
    expect(b.inspection.table.columns).toEqual(['番号', '下側の境界', '上側の境界', '代表値', '件数']);
  });

  it('行数が上限を超えると先頭と末尾だけを表に出し、図は全点を描く', () => {
    const c: RelativePageCondition = { ...base, alpha: 0.001, data: { ...base.data, count: 5_000 } };
    const r = run(c);
    if (r.inspection.algorithm !== 'ddsketch' || !('snapshot' in r.inspection)) throw new Error('unexpected');
    const total = r.inspection.snapshot.buckets.length;
    const b = buildRelativeCharts(r, c, options);
    if ('rejected' in b.inspection) throw new Error('unexpected');
    expect(b.inspection.chart.series[0]!.points).toHaveLength(total);
    if (total > 200) {
      expect(b.inspection.truncated).toBe(true);
      expect(b.inspection.table.rows).toHaveLength(200);
    } else {
      expect(b.inspection.truncated).toBe(false);
      expect(b.inspection.table.rows).toHaveLength(total);
    }
  });

  it('観察が拒否されたときは理由を返し、残りのグラフは作る (6.7)', () => {
    const c: RelativePageCondition = { ...base, hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 }, inspectTarget: 'hdr' };
    const r = run(c);
    const b = buildRelativeCharts(r, c, options);
    if (!('rejected' in r.inspection)) throw new Error('unexpected');
    expect(b.inspection).toEqual({ rejected: r.inspection.reason });
    expect(r.inspection.reason).not.toBe('');
    expect(b.collapse).toBeNull();
    expect(b.charts).toHaveLength(9);
  });
});
