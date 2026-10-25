import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, generate, type Distribution, type SweepResult } from '../core';
import { buildBoundaries, createHistogram, histogramSpec, runBucketExperiment } from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'histogram');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

const EQUAL = { kind: 'equal', lower: 10, upper: 50, buckets: 4 } as const;

function sketchWith(values: number[]) {
  const h = createHistogram(EQUAL);
  if (!h.ok) throw new Error('histogram');
  for (const v of values) h.value.insert(v);
  return h.value;
}

function estimate(values: number[], q: number): number {
  const r = sketchWith(values).query(q);
  if (!r.ok) throw new Error('query');
  return r.value;
}

function exact(values: number[], q: number): number {
  return exactQuantileSorted(Float64Array.from(values).sort(), q, 'nearest-rank');
}

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string): string[] {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${firstCell} |`));
  if (line === undefined) throw new Error(`row not found: ${firstCell}`);
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

describe('interpolation-and-error.md の例 [15, 25, 25, 35]', () => {
  const doc = readDoc('interpolation-and-error.md');
  const values = [15, 25, 25, 35];

  it.each([
    [0, '1', '[10, 20)', 10, 15, 5],
    [0.25, '1', '[10, 20)', 20, 15, 5],
    [0.5, '2', '[20, 30)', 25, 25, 0],
    [0.75, '3', '[20, 30)', 30, 25, 5],
    [1, '4', '[30, 40)', 40, 35, 5],
  ])('q=%d: 順位 %s、バケット %s、推定値 %d、厳密値 %d、誤差 %d', (q, k, bucket, est, ex, err) => {
    expect(estimate(values, q)).toBeCloseTo(est, 12);
    expect(exact(values, q)).toBe(ex);
    expect(Math.abs(estimate(values, q) - exact(values, q))).toBeCloseTo(err, 12);
    const row = rowOf(doc, String(q));
    expect(row).toEqual([String(q), k, bucket, String(est), String(ex), String(err)]);
  });

  it('バケットの件数は 1、2、1、0 で、境界は 10〜50 の等幅', () => {
    const b = buildBoundaries(EQUAL);
    expect(b.ok && Array.from(b.value)).toEqual([10, 20, 30, 40, 50]);
    expect(doc).toContain('件数は1、2、1、0');
    // 件数の確認: 値 15 だけなら [10, 20) に入る(q=0 が 10、q=1 が 20)
    expect([estimate([15], 0), estimate([15], 1)]).toEqual([10, 20]);
    expect([estimate([35], 0), estimate([35], 1)]).toEqual([30, 40]);
  });

  it('絶対誤差の最大は 5 で、バケット幅 10 以下', () => {
    const errors = [0, 0.25, 0.5, 0.75, 1].map((q) => Math.abs(estimate(values, q) - exact(values, q)));
    expect(Math.max(...errors)).toBe(5);
    expect(doc).toContain('実際の最大は5');
  });
});

describe('interpolation-and-error.md の境界付近のずれ [11, 12, 13, 29]', () => {
  const full = readDoc('interpolation-and-error.md');
  // 同じ分位点の行が前の表にもあるので、この節の表だけを対象にする
  const doc = full.slice(full.indexOf('## 境界付近のずれ'));
  const values = [11, 12, 13, 29];

  it.each([
    [0.75, '3', '[10, 20)', 20, 13, 7],
    [0.76, '4', '[20, 30)', 20.4, 29, 8.6],
  ])('q=%d: 順位 %s、バケット %s、推定値 %d、厳密値 %d、誤差 %d', (q, k, bucket, est, ex, err) => {
    expect(estimate(values, q)).toBeCloseTo(est, 10);
    expect(exact(values, q)).toBe(ex);
    expect(Math.abs(estimate(values, q) - exact(values, q))).toBeCloseTo(err, 10);
    expect(rowOf(doc, String(q))).toEqual([String(q), k, bucket, String(est), String(ex), String(err)]);
  });

  it('件数は 3、1、0、0 になる', () => {
    expect(doc).toContain('件数は3、1、0、0');
    // [10, 20) に 3 件: 3 件目の位置の推定値が上側の境界、4 件目が次のバケット
    expect(estimate(values, 0.75)).toBe(20);
    expect(estimate(values, 1)).toBeGreaterThan(20);
  });
});

describe('interpolation-and-error.md の丸めの例', () => {
  it('0.07 × 100 は 7.000000000000001 で、7 番目のバケットが選ばれる', () => {
    expect(100 * 0.07).toBe(7.000000000000001);
    expect(readDoc('interpolation-and-error.md')).toContain('7.000000000000001');
    const h = createHistogram({ kind: 'custom', boundaries: [1, 2, 3] });
    if (!h.ok) throw new Error('histogram');
    for (let i = 0; i < 7; i++) h.value.insert(1.5);
    for (let i = 0; i < 93; i++) h.value.insert(2.5);
    const r = h.value.query(0.07);
    // 累積件数 7 のバケット [1, 2) の上側の境界 2。次のバケットなら 2 より大きくなる
    expect(r.ok && r.value).toBe(2);
  });
});

describe('bucket-schemes.md の例', () => {
  const doc = readDoc('bucket-schemes.md');

  it('等幅 10〜50(4 バケット)の境界は 10、20、30、40、50', () => {
    const b = buildBoundaries(EQUAL);
    expect(b.ok && Array.from(b.value)).toEqual([10, 20, 30, 40, 50]);
    expect(doc).toContain('境界は10、20、30、40、50になる');
  });

  it('指数幅 1〜1024(10 バケット)の境界は 1、2、4、…、1024 で、比は 2', () => {
    const b = buildBoundaries({ kind: 'exponential', lower: 1, upper: 1024, buckets: 10 });
    if (!b.ok) throw new Error('boundaries');
    for (let i = 0; i < b.value.length; i++) expect(b.value[i]).toBeCloseTo(2 ** i, 9);
    expect(doc).toContain('境界は1、2、4、8、…、1024で、比は常に2である');
  });

  it('値 20 は [20, 30) に、値 50 は最後のバケットに入る', () => {
    expect([estimate([20], 0), estimate([20], 1)]).toEqual([20, 30]);
    expect([estimate([50], 0), estimate([50], 1)]).toEqual([40, 50]);
  });

  it('範囲外の値は拒否される', () => {
    const h = sketchWith([20]);
    for (const v of [9.99, 50.01]) {
      const r = h.insert(v);
      expect(!r.ok && r.error.kind).toBe('unsupported-value');
    }
  });

  it('丸めで境界が区別できない指定はエラー', () => {
    const r = buildBoundaries({ kind: 'equal', lower: 1, upper: 1 + Number.EPSILON, buckets: 4 });
    expect(r.ok).toBe(false);
    expect(doc).toContain('1 + 2.2e-16');
    expect(Number.EPSILON).toBeCloseTo(2.2e-16, 17);
  });

  it('メモリ見積もりは (2 × バケット数 + 2) × 8 バイト', () => {
    const s = histogramSpec(EQUAL);
    if (!s.ok) throw new Error('spec');
    expect(s.value.create(1).memoryBytes()).toBe((2 * 4 + 2) * 8);
    expect(doc).toContain('(2 × バケット数 + 2) × 8');
  });

  it('投入 1 回の移動は 2 回', () => {
    const s = sketchWith([20]);
    expect(s.operationCounts().moves).toBe(2);
  });
});

describe('experiments.md の実験結果', () => {
  const doc = readDoc('experiments.md');
  const QUANTILES = [0.01, 0.1, 0.5, 0.9, 0.99, 0.999, 1];
  const LOGNORMAL: Distribution = { kind: 'lognormal', mu: 0, sigma: 1 };
  const HEAVY_TAIL: Distribution = { kind: 'heavy-tail', scale: 1, shape: 1.5 };
  const fmt = (x: number): string => String(Number(x.toPrecision(3)));

  const experimentResult = runBucketExperiment({
    cases: [
      { label: 'lognormal', distribution: LOGNORMAL, range: 'data-extent' },
      { label: 'heavy-tail', distribution: HEAVY_TAIL, range: 'data-extent' },
    ],
    counts: [1000, 10000, 100000],
    seed: 1,
    quantiles: QUANTILES,
    bucketCounts: [20, 100],
    schemes: ['equal', 'exponential'],
    referenceDefinition: 'nearest-rank',
  });
  if (!experimentResult.ok) throw new Error(`experiment failed: ${JSON.stringify(experimentResult.error)}`);
  const result = experimentResult.value;

  function sweepOf(label: string): SweepResult {
    const c = result.cases.find((x) => x.label === label);
    if (!c) throw new Error(`no case ${label}`);
    return c.sweep;
  }

  function algorithm(label: string, count: number, id: string) {
    const run = sweepOf(label).runs.find((r) => r.count === count);
    const a = run?.algorithms.find((x) => x.id === id);
    if (!a || a.status !== 'ok') throw new Error(`missing ${label} ${count} ${id}`);
    return a;
  }

  const query = (label: string, count: number, id: string, q: number) => {
    const record = algorithm(label, count, id).queries.find((x) => x.quantile === q);
    if (!record) throw new Error(`missing q=${q}`);
    return record;
  };

  /** 見出しから、同じ階層以上の次の見出しまでの本文(下の階層の見出しは含む) */
  function section(heading: string): string {
    const start = doc.indexOf(heading);
    if (start < 0) throw new Error(`no heading ${heading}`);
    const level = heading.indexOf(' ');
    const rest = doc.slice(start + heading.length);
    const next = rest.search(new RegExp(`\\n#{1,${level}} `));
    return next < 0 ? rest : rest.slice(0, next);
  }

  /** データ件数 10,000 のバケットごとの件数と、境界列 */
  function occupancy(distribution: Distribution, kind: 'equal' | 'exponential') {
    const g = generate({ distribution, count: 10000, seed: 1 });
    if (!g.ok) throw new Error('generate');
    let lower = Infinity;
    let upper = -Infinity;
    for (const v of g.value) {
      lower = Math.min(lower, v);
      upper = Math.max(upper, v);
    }
    const b = buildBoundaries({ kind, lower, upper, buckets: 20 });
    if (!b.ok) throw new Error('boundaries');
    const counts = new Array<number>(20).fill(0);
    for (const v of g.value) {
      let i = 0;
      while (i < 19 && v >= b.value[i + 1]!) i++;
      counts[i]! += 1;
    }
    return { lower, upper, bounds: b.value, counts };
  }

  it('実験はすべて成功し、厳密解 2 方式と 4 つのヒストグラムが並ぶ', () => {
    for (const c of result.cases) {
      for (const run of c.sweep.runs) {
        expect(run.algorithms).toHaveLength(2 + 4);
        for (const a of run.algorithms) expect(a.status).toBe('ok');
      }
    }
  });

  it('裾での誤差の表(重い裾、件数 10,000、バケット数 20)', () => {
    const text = section('## 裾での誤差');
    for (const q of [0.1, 0.5, 0.9, 0.99]) {
      const e = query('heavy-tail', 10000, 'histogram-equal-20', q);
      const x = query('heavy-tail', 10000, 'histogram-exponential-20', q);
      expect(rowOf(text, String(q))).toEqual([
        String(q),
        fmt(e.rankError),
        fmt(e.relativeError),
        fmt(x.rankError),
        fmt(x.relativeError),
      ]);
    }
  });

  it('裾での誤差の説明に使う数値(範囲、バケットの幅、集まり方、倍率)', () => {
    const text = section('## 裾での誤差');
    const equal = occupancy(HEAVY_TAIL, 'equal');
    const expo = occupancy(HEAVY_TAIL, 'exponential');
    expect(equal.counts[0]).toBe(9895);
    expect(text).toContain('9,895件(98.95%)');
    expect(equal.counts.slice(1).reduce((s, c) => s + c, 0)).toBe(105);
    expect(equal.counts.filter((c) => c > 0).length).toBe(11);
    expect(text).toContain('件数が1以上のバケットは20個のうち11個');
    expect(equal.bounds[1]! - equal.bounds[0]!).toBeCloseTo(21.76, 2);
    expect(equal.bounds[1]!).toBeCloseTo(22.76, 2);
    expect(expo.bounds[1]! - expo.bounds[0]!).toBeCloseTo(0.3552, 4);
    expect(expo.counts[0]).toBe(3621);
    expect(text).toContain('3,621件(36.21%)');
    expect(expo.counts.every((c) => c > 0)).toBe(true);
    // q = 0.5 の等幅: 推定値は約 12、厳密値は約 1.6、相対誤差 6.5 は倍率 7.5
    const e = query('heavy-tail', 10000, 'histogram-equal-20', 0.5);
    expect(e.estimate).toBeGreaterThan(11.5);
    expect(e.estimate).toBeLessThan(12.5);
    expect(e.exact).toBeCloseTo(1.6, 1);
    expect(1 + e.relativeError).toBeCloseTo(7.5, 1);
    expect(text).toContain('約12を返す');
    // q = 0.1 の等幅の順位誤差 0.72 は 72%
    expect(query('heavy-tail', 10000, 'histogram-equal-20', 0.1).rankError).toBeCloseTo(0.72, 2);
    // 範囲
    expect(equal.lower).toBeCloseTo(1.0001, 4);
    expect(equal.upper).toBeCloseTo(436.2, 1);
    expect(doc).toContain('約1.0001から約436.2');
  });

  it.each([
    ['### バケット数20', 20],
    ['### バケット数100', 100],
  ])('等幅と指数幅の相対誤差の表(対数正規、件数 10,000)%s', (heading, buckets) => {
    const text = section(heading);
    for (const q of QUANTILES.slice(0, 6)) {
      const e = query('lognormal', 10000, `histogram-equal-${buckets}`, q);
      const x = query('lognormal', 10000, `histogram-exponential-${buckets}`, q);
      const smaller = e.relativeError < x.relativeError ? '等幅' : '指数幅';
      expect(rowOf(text, String(q))).toEqual([String(q), fmt(e.relativeError), fmt(x.relativeError), smaller]);
    }
  });

  it('どちらが有利かの傾向: 20 バケットは q ≤ 0.5 が指数幅・q ≥ 0.9 が等幅、100 バケットは q = 0.999 だけが等幅', () => {
    const winner = (buckets: number, q: number): string => {
      const e = query('lognormal', 10000, `histogram-equal-${buckets}`, q);
      const x = query('lognormal', 10000, `histogram-exponential-${buckets}`, q);
      return e.relativeError < x.relativeError ? '等幅' : '指数幅';
    };
    expect([0.01, 0.1, 0.5].map((q) => winner(20, q))).toEqual(['指数幅', '指数幅', '指数幅']);
    expect([0.9, 0.99, 0.999].map((q) => winner(20, q))).toEqual(['等幅', '等幅', '等幅']);
    expect([0.01, 0.1, 0.5, 0.9, 0.99].map((q) => winner(100, q)).every((w) => w === '指数幅')).toBe(true);
    expect(winner(100, 0.999)).toBe('等幅');
  });

  it('等幅と指数幅の説明に使う数値(バケットの幅、集まり方)', () => {
    const text = section('## 等幅と指数幅の相対誤差');
    const equal = occupancy(LOGNORMAL, 'equal');
    const expo = occupancy(LOGNORMAL, 'exponential');
    expect(equal.bounds[1]! - equal.bounds[0]!).toBeCloseTo(1.908, 3);
    expect(equal.bounds[1]!).toBeCloseTo(1.935, 3);
    expect(text).toContain('約1.908');
    expect(equal.counts[0]).toBe(7432);
    expect(text).toContain('7,432件(74.32%)');
    expect(expo.bounds[1]! - expo.bounds[0]!).toBeCloseTo(0.01186, 5);
    expect(text).toContain('約0.01186');
    const lastExpo = expo.bounds[20]! - expo.bounds[19]!;
    const lastEqual = equal.bounds[20]! - equal.bounds[19]!;
    expect(lastExpo).toBeCloseTo(11.61, 2);
    expect(text).toContain('約11.61');
    expect(lastExpo / lastEqual).toBeGreaterThan(5.5);
    expect(lastExpo / lastEqual).toBeLessThan(6.5);
    // q = 0.5 の厳密値は等幅の最初のバケットに入る
    const median = query('lognormal', 10000, 'histogram-equal-20', 0.5).exact;
    expect(median).toBeCloseTo(0.995, 3);
    expect(median).toBeLessThan(equal.bounds[1]!);
    expect(text).toContain('約0.995');
    // 指数幅で q = 0.5 を含むバケットの件数
    const target = Math.ceil(10000 * 0.5);
    let cum = 0;
    let medianBucket = 0;
    for (let i = 0; i < expo.counts.length; i++) {
      cum += expo.counts[i]!;
      if (cum >= target) {
        medianBucket = i;
        break;
      }
    }
    expect(expo.counts[medianBucket]).toBe(1423);
    expect(text).toContain('1,423件');
    expect(equal.lower).toBeCloseTo(0.02716, 5);
    expect(equal.upper).toBeCloseTo(38.19, 2);
    expect(doc).toContain('約0.02716から約38.19');
  });

  it('費用の表(対数正規、等幅)', () => {
    const text = section('## 費用の増え方');
    for (const n of [1000, 10000, 100000]) {
      const sort = algorithm('lognormal', n, 'exact-sort-nearest-rank');
      const h20 = algorithm('lognormal', n, 'histogram-equal-20');
      const h100 = algorithm('lognormal', n, 'histogram-equal-100');
      const q1 = (a: typeof h20) => a.queries.find((x) => x.quantile === 1)!.operations.comparisons;
      expect(rowOf(text, String(n))).toEqual([
        String(n),
        String(sort.afterQueries.memoryBytes),
        String(h20.afterQueries.memoryBytes),
        String(h100.afterQueries.memoryBytes),
        String(sort.afterInsertion.operations.moves),
        String(h20.afterInsertion.operations.moves),
        String(sort.queries[0]!.operations.comparisons),
        String(q1(h20)),
        String(q1(h100)),
      ]);
      // 説明の根拠: ヒストグラムのメモリは (2B + 2) × 8、投入の移動は 2n、整列方式のメモリは 8n
      expect(h20.afterQueries.memoryBytes).toBe((2 * 20 + 2) * 8);
      expect(h100.afterQueries.memoryBytes).toBe((2 * 100 + 2) * 8);
      expect(h20.afterInsertion.operations.moves).toBe(2 * n);
      expect(sort.afterQueries.memoryBytes).toBe(8 * n);
    }
    expect(text).toContain('約157万回');
    expect(algorithm('lognormal', 100000, 'exact-sort-nearest-rank').queries[0]!.operations.comparisons).toBeGreaterThan(1_550_000);
    expect(algorithm('lognormal', 100000, 'exact-sort-nearest-rank').queries[0]!.operations.comparisons).toBeLessThan(1_590_000);
  });
});
