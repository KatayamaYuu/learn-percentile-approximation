import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, generate, type AlgorithmResult, type BenchmarkResult } from '../core';
import {
  createDDSketch,
  createHdrLayout,
  createLogMapping,
  runRelativeErrorExperiment,
  type RelativeErrorCase,
  type RelativeErrorExperimentSpec,
} from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'relative-error');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

/** 有効数字 n 桁に丸めた数を、文書に書く形(指数表記にしない)の文字列にする */
const sig = (x: number, n = 6): string => String(Number(x.toPrecision(n)));

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string, width?: number): string[] {
  for (const line of doc.split('\n')) {
    if (!line.startsWith(`| ${firstCell} |`)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (width === undefined || cells.length === width) return cells;
  }
  throw new Error(`row not found: ${firstCell}`);
}

describe('ddsketch.md の数値例', () => {
  const doc = readDoc('ddsketch.md');
  const mapping = createLogMapping(0.01);
  if (!mapping.ok) throw new Error('mapping');
  const m = mapping.value;

  it('α = 0.01 の γ と ln γ', () => {
    expect(rowOf(doc, 'γ')).toEqual(['γ', sig(m.gamma)]);
    expect(rowOf(doc, 'ln γ')).toEqual(['ln γ', sig(Math.log(m.gamma))]);
  });

  it.each([100, 100000])('値 %i の番号・境界・代表値・相対誤差', (x) => {
    const i = m.indexOf(x);
    const rep = m.representative(i);
    expect(rowOf(doc, String(x))).toEqual([
      String(x),
      String(i),
      sig(m.lowerBound(i)),
      sig(m.upperBound(i)),
      sig(rep),
      sig(Math.abs(rep - x) / x, 3),
    ]);
    expect(Math.abs(rep - x) / x).toBeLessThanOrEqual(0.01);
  });

  it('10 倍ごとの番号の進みと、値 1・1,000・1,000,000 の番号', () => {
    expect(sig(Math.log(10) / Math.log(m.gamma), 4)).toBe('115.1');
    expect(doc).toContain('約 115.1 進む');
    const [i1, i1000, i1e6] = [1, 1000, 1_000_000].map((x) => m.indexOf(x)) as [number, number, number];
    expect([i1, i1000, i1e6]).toEqual([0, 346, 691]);
    expect([i1000 - i1, i1e6 - i1000]).toEqual([346, 345]);
    expect(doc).toContain('値 1 の番号は 0、値 1,000 の番号は 346、値 1,000,000 の番号は 691 で、差は 346 と 345');
  });

  it('縮約が起きない範囲の目安 γ^m', () => {
    const lg = Math.log(m.gamma);
    expect(Number(Math.exp(2048 * lg).toPrecision(3))).toBe(6.16e17);
    expect(doc).toContain('γ^2048 ≈ 6.16e17');
    expect(Number(Math.exp(64 * lg).toPrecision(3))).toBe(3.6);
    expect(doc).toContain('γ^64 ≈ 3.60');
  });
});

describe('hdr-histogram.md の数値例', () => {
  const doc = readDoc('hdr-histogram.md');
  const layoutOf = (significantDigits: number) => {
    const r = createHdrLayout({ lowest: 1, highest: 3_600_000, significantDigits });
    if (!r.ok) throw new Error('layout');
    return r.value;
  };

  it.each([0, 1, 2, 3, 4, 5])('d = %i の S、総数、メモリ見積もり', (d) => {
    const l = layoutOf(d);
    expect(rowOf(doc, String(d), 2)).toEqual([String(d), String(l.subBucketCount)]);
    expect(doc).toContain(`| ${d} | ${l.subBucketCount} | ${l.totalBuckets} | ${(3 + l.totalBuckets + 1) * 8} |`);
  });

  it('d = 2 の S と総数', () => {
    const l = layoutOf(2);
    expect(rowOf(doc, 'S')).toEqual(['S', String(l.subBucketCount)]);
    expect(rowOf(doc, 'バケットの総数')).toEqual(['バケットの総数', String(l.totalBuckets)]);
    expect(l.totalBuckets).toBe(256 + 14 * 128);
    expect(doc).toContain('`256 + 14 × 128 = 2048`');
  });

  it.each([1, 100, 150, 1_000_000])('値 %i の番号・境界・代表値', (x) => {
    const l = layoutOf(2);
    const i = l.indexOf(x);
    expect(rowOf(doc, String(x), 5)).toEqual([
      String(x),
      String(i),
      sig(l.lowerBound(i), 10),
      sig(l.upperBound(i), 10),
      sig(l.representative(i), 10),
    ]);
  });

  it('本文中の誤差の数値', () => {
    const l = layoutOf(2);
    const rep = l.representative(l.indexOf(1_000_000));
    expect(rep - 1_000_000).toBe(1472);
    expect(sig(Math.abs(rep - 1_000_000) / 1_000_000, 2)).toBe('0.0015');
    expect(sig(Math.abs(l.representative(l.indexOf(100)) - 100) / 100, 2)).toBe('0.005');
    expect(sig(1 / l.subBucketCount, 2)).toBe('0.0039');
    expect(l.upperBound(l.indexOf(1_000_000)) - l.lowerBound(l.indexOf(1_000_000))).toBe(4096);
  });
});

// ---- experiments.md: 固定のシード・最近順位法の基準での実験の出力と、文書の表を照合する ----

const SEED = 1;
const QUANTILES: readonly number[] = [0, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1];
const WIDE_HDR = { lowest: 1e-6, highest: 1e9 } as const;
const LOGNORMAL_WIDE = { kind: 'lognormal', mu: 3, sigma: 2 } as const;

function experiment(spec: Omit<RelativeErrorExperimentSpec, 'seed' | 'quantiles' | 'referenceDefinition'>) {
  const r = runRelativeErrorExperiment({ ...spec, seed: SEED, quantiles: QUANTILES, referenceDefinition: 'nearest-rank' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function algorithmOf(run: BenchmarkResult, id: string): Extract<AlgorithmResult, { status: 'ok' }> {
  const a = run.algorithms.find((x) => x.id === id);
  if (a === undefined || a.status !== 'ok') throw new Error(`algorithm: ${id}`);
  return a;
}

const maxRelativeError = (a: Extract<AlgorithmResult, { status: 'ok' }>): number =>
  Math.max(...a.queries.map((q) => q.relativeError));

function bucketCountOf(result: ReturnType<typeof experiment>['cases'][number], count: number, id: string): number {
  const s = result.bucketStats.find((x) => x.count === count && x.sketchId === id);
  if (s === undefined || s.status !== 'ok') throw new Error(`stats: ${id}`);
  return s.bucketCount;
}

const row = (...cells: (string | number)[]): string => `| ${cells.join(' | ')} |`;

/** 表 A: 桁の異なる分布での、縮約が起きない DDSketch(α = 0.01)と HDR(d = 2)の相対誤差の最大値 */
function tableA(): { rows: string[]; ddMax: number[]; hdrMax: number[]; spans: number[]; collapsed: boolean[] } {
  const cases: RelativeErrorCase[] = [
    { label: '対数正規 μ=0', distribution: { kind: 'lognormal', mu: 0, sigma: 1 }, hdrRange: WIDE_HDR },
    { label: '対数正規 μ=5', distribution: { kind: 'lognormal', mu: 5, sigma: 1 }, hdrRange: WIDE_HDR },
    { label: '対数正規 μ=10', distribution: { kind: 'lognormal', mu: 10, sigma: 1 }, hdrRange: WIDE_HDR },
    { label: '一様 1〜10', distribution: { kind: 'uniform', min: 1, max: 10 }, hdrRange: WIDE_HDR },
    { label: '一様 1e3〜1e4', distribution: { kind: 'uniform', min: 1e3, max: 1e4 }, hdrRange: WIDE_HDR },
    { label: '一様 1e6〜1e7', distribution: { kind: 'uniform', min: 1e6, max: 1e7 }, hdrRange: WIDE_HDR },
  ];
  const result = experiment({
    cases,
    counts: [10000],
    alphas: [0.01],
    maxBucketsList: [100000],
    significantDigitsList: [2],
  });
  const rows: string[] = [];
  const ddMax: number[] = [];
  const hdrMax: number[] = [];
  const spans: number[] = [];
  const collapsed: boolean[] = [];
  for (const c of result.cases) {
    const run = c.sweep.runs[0]!;
    const dd = maxRelativeError(algorithmOf(run, 'ddsketch-a0.01-m100000'));
    const hdr = maxRelativeError(algorithmOf(run, 'hdr-d2'));
    const stat = c.bucketStats.find((s) => s.sketchId === 'ddsketch-a0.01-m100000');
    if (stat === undefined || stat.status !== 'ok') throw new Error('stats');
    ddMax.push(dd);
    hdrMax.push(hdr);
    spans.push(stat.bucketCount);
    collapsed.push(stat.collapsed === true);
    rows.push(row(c.label, sig(dd, 3), stat.bucketCount, sig(hdr, 3)));
  }
  return { rows, ddMax, hdrMax, spans, collapsed };
}

const ALPHAS = [0.1, 0.05, 0.01, 0.005, 0.001] as const;
const DIGITS = [1, 2, 3, 4] as const;

/** 表 B: α・有効桁数ごとの相対誤差の最大値、バケット数、メモリ見積もり */
function tableB() {
  const result = experiment({
    cases: [{ label: 'ln', distribution: LOGNORMAL_WIDE, hdrRange: WIDE_HDR }],
    counts: [10000],
    alphas: ALPHAS,
    maxBucketsList: [100000],
    significantDigitsList: DIGITS,
  });
  const c = result.cases[0]!;
  const run = c.sweep.runs[0]!;
  const g = generate({ distribution: LOGNORMAL_WIDE, count: 10000, seed: SEED });
  if (!g.ok) throw new Error('generate');
  const logRange = Math.log(Math.max(...g.value) / Math.min(...g.value));
  const dd = [...ALPHAS].sort((a, b) => b - a).map((alpha) => {
    const id = `ddsketch-a${alpha}-m100000`;
    const a = algorithmOf(run, id);
    const gamma = (1 + alpha) / (1 - alpha);
    return {
      alpha,
      maxRel: maxRelativeError(a),
      span: bucketCountOf(c, 10000, id),
      memory: a.afterInsertion.memoryBytes,
      theory: logRange / Math.log(gamma),
    };
  });
  const hdr = DIGITS.map((d) => {
    const id = `hdr-d${d}`;
    const a = algorithmOf(run, id);
    const l = createHdrLayout({ ...WIDE_HDR, significantDigits: d });
    if (!l.ok) throw new Error('layout');
    return {
      d,
      s: l.value.subBucketCount,
      maxRel: maxRelativeError(a),
      total: bucketCountOf(c, 10000, id),
      memory: a.afterInsertion.memoryBytes,
    };
  });
  const ddRows = dd.map((r) => row(r.alpha, sig(r.maxRel, 3), r.span, sig(r.theory, 3), r.memory));
  const hdrRows = hdr.map((r) => row(r.d, r.s, sig(1 / r.s, 3), sig(r.maxRel, 3), r.total, r.memory));
  return { dd, hdr, ddRows, hdrRows };
}

const COLLAPSE_BUCKETS = [32, 128, 512, 2048] as const;
const COLLAPSE_QUANTILES: readonly number[] = [0, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999, 1];

/** 表 C: m を小さくして縮約が起きたときの、分位点ごとの相対誤差 */
function tableC() {
  const result = experiment({
    cases: [{ label: 'ln', distribution: LOGNORMAL_WIDE, hdrRange: WIDE_HDR }],
    counts: [10000],
    alphas: [0.01],
    maxBucketsList: COLLAPSE_BUCKETS,
    significantDigitsList: [2],
  });
  const run = result.cases[0]!.sweep.runs[0]!;
  const g = generate({ distribution: LOGNORMAL_WIDE, count: 10000, seed: SEED });
  if (!g.ok) throw new Error('generate');
  const columns = COLLAPSE_BUCKETS.map((m) => {
    const a = algorithmOf(run, `ddsketch-a0.01-m${m}`);
    const sketch = createDDSketch({ alpha: 0.01, maxBuckets: m });
    if (!sketch.ok) throw new Error('sketch');
    for (const x of g.value) sketch.value.insert(x);
    const snap = sketch.value.inspect();
    const byQuantile = a.queries.map((q) => ({ q: q.quantile, estimate: q.estimate, rel: q.relativeError }));
    return { m, snap, byQuantile };
  });
  const rows = COLLAPSE_QUANTILES.map((q) =>
    row(
      q,
      ...columns.map((c) => sig(c.byQuantile.find((x) => x.q === q)!.rel, 3)),
    ),
  );
  rows.push(row('縮約の回数', ...columns.map((c) => c.snap.collapseCount)));
  rows.push(row('縮約の影響の上限', ...columns.map((c) => (c.snap.collapsedUpperBound === null ? 'なし' : sig(c.snap.collapsedUpperBound, 3)))));
  return { columns, rows };
}

const SWEEP_COUNTS = [1000, 10000, 100000] as const;

/** 表 D: 件数を増やしたときのメモリ見積もりと、投入・問い合わせの操作数(DDSketch、HDR、厳密解) */
function tableD() {
  const result = experiment({
    cases: [{ label: 'ln', distribution: LOGNORMAL_WIDE, hdrRange: WIDE_HDR }],
    counts: SWEEP_COUNTS,
    alphas: [0.01],
    maxBucketsList: [2048],
    significantDigitsList: [2],
  });
  const ids = ['exact-sort-nearest-rank', 'ddsketch-a0.01-m2048', 'hdr-d2'] as const;
  const total = (o: { comparisons: number; moves: number }): number => o.comparisons + o.moves;
  const data = SWEEP_COUNTS.map((count) => {
    const run = result.cases[0]!.sweep.runs.find((r) => r.count === count)!;
    return {
      count,
      byId: ids.map((id) => {
        const a = algorithmOf(run, id);
        return {
          id,
          memory: a.afterInsertion.memoryBytes,
          insert: total(a.afterInsertion.operations),
          query: total(a.afterQueries.operations) - total(a.afterInsertion.operations),
        };
      }),
    };
  });
  const memoryRows = data.map((d) => row(d.count, ...d.byId.map((x) => x.memory)));
  const insertRows = data.map((d) => row(d.count, ...d.byId.map((x) => sig(x.insert / d.count, 3))));
  const queryRows = data.map((d) => row(d.count, ...d.byId.map((x) => x.query)));
  return { data, memoryRows, insertRows, queryRows };
}

describe('experiments.md の数値', () => {
  const doc = readDoc('experiments.md');
  const hasRows = (rows: readonly string[]): void => {
    for (const r of rows) expect(doc, r).toContain(`${r}\n`);
  };

  it('表 1: 桁の異なる分布', () => {
    const a = tableA();
    hasRows(a.rows);
    for (const dd of a.ddMax) expect(dd).toBeLessThanOrEqual(0.01);
    for (const hdr of a.hdrMax) expect(hdr).toBeLessThanOrEqual(1 / 256);
    expect(a.collapsed.every((c) => !c)).toBe(true);
    expect(a.spans.slice(0, 3)).toEqual([364, 364, 364]);
    expect(a.spans.slice(3)).toEqual([116, 116, 116]);
  });

  it('表 2: α・有効桁数ごとの誤差・バケット数・メモリ', () => {
    const b = tableB();
    hasRows(b.ddRows);
    hasRows(b.hdrRows);
    for (const r of b.dd) {
      expect(r.maxRel).toBeLessThanOrEqual(r.alpha);
      expect(Math.abs(r.span - r.theory)).toBeLessThan(2);
      expect(r.memory).toBe((r.span + 6) * 8);
    }
    for (const r of b.hdr) expect(r.maxRel).toBeLessThanOrEqual(1 / r.s);
    // α を小さく・有効桁数を大きくすると、バケット数とメモリが増える
    for (let i = 1; i < b.dd.length; i++) {
      expect(b.dd[i]!.span).toBeGreaterThan(b.dd[i - 1]!.span);
      expect(b.dd[i]!.memory).toBeGreaterThan(b.dd[i - 1]!.memory);
      // α にほぼ反比例する
      expect(b.dd[i]!.span / b.dd[i - 1]!.span).toBeGreaterThan(1.9);
    }
    for (let i = 1; i < b.hdr.length; i++) {
      const ratio = b.hdr[i]!.total / b.hdr[i - 1]!.total;
      expect(ratio).toBeGreaterThan(7);
      expect(ratio).toBeLessThan(14.5);
      expect(b.hdr[i]!.s / b.hdr[i - 1]!.s).toBeGreaterThanOrEqual(8);
    }
    const g = generate({ distribution: LOGNORMAL_WIDE, count: 10000, seed: SEED });
    if (!g.ok) throw new Error('generate');
    const [min, max] = [Math.min(...g.value), Math.max(...g.value)];
    expect(sig(min, 3)).toBe('0.0148');
    expect(Math.round(max)).toBe(29292);
    expect(sig(Math.log(max / min), 3)).toBe('14.5');
    expect(sig(Math.exp(5), 3)).toBe('148');
    expect(b.dd.find((r) => r.alpha === 0.005)!.span).toBe(1451);
    expect(b.hdr.find((r) => r.d === 2)!.total).toBe(5632);
  });

  it('表 3: 縮約の影響(低い分位点で破れ、高い分位点で保たれる)', () => {
    const c = tableC();
    hasRows(c.rows);
    for (const col of c.columns) {
      const bound = col.snap.collapsedUpperBound;
      for (const x of col.byQuantile) {
        // 影響の上限より大きい推定は、相対誤差が α 以下
        if (bound === null || x.estimate > bound) expect(x.rel).toBeLessThanOrEqual(0.01 * (1 + 1e-9));
      }
      // 最大値(分位点 1)は、どの m でも α 以下で、同じ値
      expect(col.byQuantile.find((x) => x.q === 1)!.rel).toBe(c.columns[0]!.byQuantile.find((x) => x.q === 1)!.rel);
    }
    const [m32, m128, m512, m2048] = c.columns as [
      (typeof c.columns)[number], (typeof c.columns)[number], (typeof c.columns)[number], (typeof c.columns)[number],
    ];
    expect(m2048.snap.collapsed).toBe(false);
    expect(m2048.byQuantile.every((x) => x.rel <= 0.01)).toBe(true);
    for (const col of [m32, m128, m512]) {
      expect(col.snap.collapsed).toBe(true);
      expect(col.byQuantile.find((x) => x.q === 0)!.rel).toBeGreaterThan(0.01);
    }
    // m が小さいほど影響の上限が大きく、破れる分位点が多い
    expect(m32.snap.collapsedUpperBound!).toBeGreaterThan(m128.snap.collapsedUpperBound!);
    expect(m128.snap.collapsedUpperBound!).toBeGreaterThan(m512.snap.collapsedUpperBound!);
    const broken = (col: typeof m32): number => col.byQuantile.filter((x) => x.rel > 0.01).length;
    expect(broken(m32)).toBeGreaterThan(broken(m128));
    expect(broken(m128)).toBeGreaterThan(broken(m512));
    // 高めの分位点でも、上限以下の推定には保証がない
    const q99 = m128.byQuantile.find((x) => x.q === 0.99)!;
    expect(q99.estimate).toBeLessThanOrEqual(m128.snap.collapsedUpperBound!);
    expect(q99.rel).toBeGreaterThan(0.01);
  });

  it('表 4: 件数を増やしたときのメモリと操作数', () => {
    const d = tableD();
    hasRows(d.memoryRows);
    hasRows(d.insertRows);
    hasRows(d.queryRows);
    const at = (count: number, index: number) => d.data.find((x) => x.count === count)!.byId[index]!;
    // 厳密解のメモリは件数に比例、HDR は一定、DDSketch は上限以下
    expect(at(10000, 0).memory).toBe(10 * at(1000, 0).memory);
    expect(at(100000, 0).memory).toBe(10 * at(10000, 0).memory);
    expect(at(1000, 2).memory).toBe(at(100000, 2).memory);
    for (const count of [1000, 10000, 100000]) expect(at(count, 1).memory).toBeLessThanOrEqual((2048 + 6) * 8);
    // 投入 1 件あたりの操作数は件数で増えない
    for (const count of [1000, 10000, 100000]) {
      expect(at(count, 1).insert / count).toBeLessThan(10);
      expect(at(count, 2).insert / count).toBeLessThan(5.1);
    }
    // 問い合わせ: 厳密解は件数より速く増え、DDSketch・HDR はほとんど増えない
    expect(at(100000, 0).query / at(1000, 0).query).toBeGreaterThan(100);
    expect(at(100000, 1).query / at(1000, 1).query).toBeLessThan(1.5);
    expect(at(100000, 2).query / at(1000, 2).query).toBeLessThan(1.1);
    expect(Math.round(at(100000, 0).query / at(1000, 0).query)).toBe(175);
    expect(Math.round((at(100000, 1).query / at(1000, 1).query) * 100) / 100).toBe(1.25);
  });
});

// ---- comparison.md: 相対誤差の保証と順位誤差の保証の向き不向き ----

const COMPARISON_QUANTILES: readonly number[] = [0.5, 0.9, 0.99, 0.999];
const RANK_EPSILON = 0.01;

function comparisonExperiment(distribution: RelativeErrorCase['distribution']) {
  const r = runRelativeErrorExperiment({
    cases: [{ label: 'c', distribution, hdrRange: WIDE_HDR }],
    counts: [100000],
    seed: SEED,
    quantiles: COMPARISON_QUANTILES,
    alphas: [0.01, 0.05],
    maxBucketsList: [2048],
    significantDigitsList: [2],
    referenceDefinition: 'nearest-rank',
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.cases[0]!.sweep.runs[0]!;
}

const queryOf = (run: BenchmarkResult, id: string, quantile: number) => {
  const q = algorithmOf(run, id).queries.find((x) => x.quantile === quantile);
  if (q === undefined) throw new Error(`query: ${id} ${quantile}`);
  return q;
};

/** 表 E: 重い裾の分布。DDSketch の相対誤差・順位誤差と、順位誤差 ε が許す値のずれ */
function tableE() {
  const distribution = { kind: 'heavy-tail', scale: 1, shape: 1.5 } as const;
  const run = comparisonExperiment(distribution);
  const g = generate({ distribution, count: 100000, seed: SEED });
  if (!g.ok) throw new Error('generate');
  const sorted = Float64Array.from(g.value).sort();
  const data = COMPARISON_QUANTILES.map((q) => {
    const dd = queryOf(run, 'ddsketch-a0.01-m2048', q);
    const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
    const lower = exactQuantileSorted(sorted, q - RANK_EPSILON, 'nearest-rank');
    return { q, rel: dd.relativeError, rank: dd.rankError, allowed: Math.abs(lower - exact) / exact };
  });
  return { data, rows: data.map((d) => row(d.q, sig(d.rel, 3), sig(d.rank, 3), sig(d.allowed, 3))) };
}

/** 表 F: 狭い範囲に集中した分布。DDSketch(α = 0.01、0.05)と HDR(d = 2)の相対誤差・順位誤差 */
function tableF() {
  const run = comparisonExperiment({ kind: 'uniform', min: 1000, max: 1010 });
  const ids = ['ddsketch-a0.01-m2048', 'ddsketch-a0.05-m2048', 'hdr-d2'] as const;
  const data = COMPARISON_QUANTILES.map((q) => ({ q, byId: ids.map((id) => queryOf(run, id, q)) }));
  return {
    data,
    rows: data.map((d) => row(d.q, ...d.byId.flatMap((x) => [sig(x.relativeError, 3), sig(x.rankError, 3)]))),
  };
}

describe('comparison.md の数値', () => {
  const doc = readDoc('comparison.md');
  const hasRows = (rows: readonly string[]): void => {
    for (const r of rows) expect(doc, r).toContain(`${r}\n`);
  };

  it('表 E: 重い裾の分布', () => {
    const e = tableE();
    hasRows(e.rows);
    for (const d of e.data) expect(d.rel).toBeLessThanOrEqual(0.01);
    // 順位誤差 ε が許す値のずれは、高い分位点ほど大きい
    for (let i = 1; i < e.data.length; i++) expect(e.data[i]!.allowed).toBeGreaterThan(e.data[i - 1]!.allowed);
    expect(sig(e.data[3]!.allowed * 100, 2)).toBe('79');
    expect(e.data[3]!.rank).toBeLessThan(0.0001);
    expect(sig(e.data[3]!.rank, 1)).toBe('0.00002');
  });

  it('表 F: 狭い範囲に集中した分布', () => {
    const f = tableF();
    hasRows(f.rows);
    const limits = [0.01, 0.05, 1 / 256];
    for (const d of f.data) {
      d.byId.forEach((x, i) => expect(x.relativeError).toBeLessThanOrEqual(limits[i]!));
    }
    const at = (q: number) => f.data.find((d) => d.q === q)!.byId;
    // α = 0.05 では中央値の順位誤差が 0.5、α = 0.01 では分位点 0.999 の順位誤差が 0.755
    expect(at(0.5)[1]!.rankError).toBe(0.5);
    expect(sig(at(0.999)[0]!.rankError, 3)).toBe('0.755');
    // 順位誤差 0.01 の保証を、この分布では満たさない
    for (const x of f.data.flatMap((d) => d.byId.slice(0, 1))) expect(x.rankError).toBeGreaterThan(RANK_EPSILON);
  });
});
