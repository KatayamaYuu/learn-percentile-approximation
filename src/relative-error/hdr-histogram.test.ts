import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, generate, type PercentileSketch } from '../core';
import { createHdrHistogram, hdrSpec, type HdrHistogram } from './hdr-histogram';
import { createHdrLayout, type HdrConfig } from './hdr-layout';

const CONFIG: HdrConfig = { lowest: 1, highest: 1000, significantDigits: 2 };

function make(config: HdrConfig = CONFIG): HdrHistogram {
  const r = createHdrHistogram(config);
  if (!r.ok) throw new Error('hdr');
  return r.value;
}

function load(s: PercentileSketch, data: ArrayLike<number>): void {
  for (let i = 0; i < data.length; i++) {
    if (!s.insert(data[i]!).ok) throw new Error('insert');
  }
}

const QS = [0, 0.001, 0.01, 0.07, 0.25, 0.5, 0.9, 0.99, 0.999, 1];

describe('投入', () => {
  it('範囲外の値は unsupported-value で拒否し、状態・操作数・メモリを変えない', () => {
    const s = make();
    load(s, [5, 50, 500]);
    const q = s.query(0.5);
    const ops = s.operationCounts();
    const mem = s.memoryBytes();
    for (const v of [0.5, 0.999, 1000.001, 2000, Number.MAX_VALUE]) {
      const r = s.insert(v);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('unsupported-value');
        if (r.error.kind === 'unsupported-value') expect(r.error.detail).toContain('[1, 1000]');
      }
    }
    expect(s.operationCounts()).toEqual(ops);
    expect(s.memoryBytes()).toBe(mem);
    expect(s.query(0.5)).toEqual(q);
  });

  it('範囲の両端(L と H)は受け付ける', () => {
    const s = make();
    expect(s.insert(1).ok).toBe(true);
    expect(s.insert(1000).ok).toBe(true);
  });

  it('不正な値は invalid-value で拒否し、状態を変えない', () => {
    const s = make();
    for (const [v, reason] of [
      [Number.NaN, 'not-a-number'],
      [Number.POSITIVE_INFINITY, 'not-finite'],
      [0, 'not-positive'],
      [-5, 'not-positive'],
    ] as const) {
      expect(s.insert(v)).toEqual({ ok: false, error: { kind: 'invalid-value', reason } });
    }
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
  });

  it('1 回の投入は移動 2 回・比較 4 回以下', () => {
    const s = make();
    let prev = s.operationCounts();
    for (let x = 1; x <= 1000; x *= 1.31) {
      s.insert(x);
      const now = s.operationCounts();
      expect(now.moves - prev.moves).toBe(2);
      expect(now.comparisons - prev.comparisons).toBeLessThanOrEqual(4);
      prev = now;
    }
  });
});

describe('問い合わせ', () => {
  it('空・範囲外の分位点はエラーで、状態を変えない', () => {
    const s = make();
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(s.query(2)).toEqual({ ok: false, error: { kind: 'quantile-out-of-range' } });
    load(s, [3]);
    const ops = s.operationCounts();
    for (const q of [-1, 1.5, Number.NaN]) {
      expect(s.query(q)).toEqual({ ok: false, error: { kind: 'quantile-out-of-range' } });
    }
    expect(s.operationCounts()).toEqual(ops);
  });

  it('推定値は目標順位のバケットの中点で、誤差が上限以下', () => {
    const cfg: HdrConfig = { lowest: 1, highest: 1_000_000, significantDigits: 2 };
    const layout = createHdrLayout(cfg);
    if (!layout.ok) throw new Error();
    const g = generate({ distribution: { kind: 'lognormal', mu: 6, sigma: 1.5 }, count: 5000, seed: 5 });
    if (!g.ok) throw new Error();
    const data = g.value.map((x) => Math.min(Math.max(x, 1), 1_000_000));
    const s = make(cfg);
    load(s, data);
    const sorted = Float64Array.from(data).sort();
    for (const q of QS) {
      const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
      const r = s.query(q);
      if (!r.ok) throw new Error();
      const l = layout.value;
      expect(r.value).toBe(l.representative(l.indexOf(exact)));
      const e = Math.abs(r.value - exact);
      if (exact >= (l.subBucketCount / 2) * 1) expect(e / exact).toBeLessThanOrEqual(1 / l.subBucketCount + 1e-12);
      else expect(e).toBeLessThanOrEqual(0.5 + 1e-12);
    }
  });

  it('同じ入力で同じ結果になる', () => {
    const a = make();
    const b = make();
    const data = [3, 9, 27, 81, 243, 2, 4, 8, 16, 32, 64, 128, 256, 512];
    load(a, data);
    load(b, data);
    for (const q of QS) expect(a.query(q)).toEqual(b.query(q));
    expect(a.operationCounts()).toEqual(b.operationCounts());
  });
});

describe('メモリ・reset', () => {
  it('メモリ見積もりは作成時から投入前後で一定', () => {
    const s = make();
    const layout = createHdrLayout(CONFIG);
    if (!layout.ok) throw new Error();
    const expected = (3 + layout.value.totalBuckets + 1) * 8;
    expect(s.memoryBytes()).toBe(expected);
    load(s, Array.from({ length: 5000 }, (_, i) => 1 + (i % 999)));
    expect(s.memoryBytes()).toBe(expected);
  });

  it('reset は件数・操作数を戻し、設定を保つ', () => {
    const s = make();
    load(s, [1, 10, 100]);
    s.reset();
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(s.insert(2000).ok).toBe(false);
    load(s, [7]);
    const r = s.query(0.5);
    expect(r.ok).toBe(true);
  });
});

describe('設定と SketchSpec', () => {
  it('識別子・表示名・パラメータ・扱える値の範囲', () => {
    const spec = hdrSpec(CONFIG);
    if (!spec.ok) throw new Error();
    const layout = createHdrLayout(CONFIG);
    if (!layout.ok) throw new Error();
    expect(spec.value.id).toBe('hdr-d2');
    expect(spec.value.label).toBe('HDR Histogram(有効桁数=2)');
    expect(spec.value.params).toEqual({
      lowest: 1,
      highest: 1000,
      significantDigits: 2,
      subBucketCount: 256,
      totalBuckets: layout.value.totalBuckets,
    });
    expect(spec.value.supportedRange).toEqual({ min: 1, max: 1000 });
    expect(spec.value.create(1)).not.toBe(spec.value.create(1));
  });

  it('識別子は範囲によらず、上書きできる', () => {
    const a = hdrSpec({ lowest: 1, highest: 10, significantDigits: 3 });
    const b = hdrSpec({ lowest: 0.1, highest: 1e9, significantDigits: 3 });
    expect(a.ok && b.ok && a.value.id === b.value.id).toBe(true);
    const c = hdrSpec(CONFIG, { id: 'h', label: 'H' });
    expect(c.ok && [c.value.id, c.value.label]).toEqual(['h', 'H']);
  });

  it('不正な設定は作らずに ConfigError を返す', () => {
    for (const result of [
      createHdrHistogram({ ...CONFIG, lowest: 0 }),
      hdrSpec({ ...CONFIG, significantDigits: 7 }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid-config');
    }
  });
});

describe('inspect', () => {
  it('全項目を返し、件数の合計は総件数、番号は昇順', () => {
    const layout = createHdrLayout(CONFIG);
    if (!layout.ok) throw new Error();
    const l = layout.value;
    const s = make();
    load(s, [1, 1, 150, 999, 1000, 150]);
    const snap = s.inspect();
    expect(snap).toMatchObject({
      kind: 'hdr',
      lowest: 1,
      highest: 1000,
      significantDigits: 2,
      subBucketCount: 256,
      totalBuckets: l.totalBuckets,
      totalCount: 6,
      nonEmptyBuckets: 4,
    });
    expect(snap.buckets.map((b) => b.count)).toEqual([2, 2, 1, 1]);
    expect(snap.buckets.reduce((a, b) => a + b.count, 0)).toBe(snap.totalCount);
    const i150 = l.indexOf(150);
    expect(snap.buckets[1]).toEqual({
      index: i150,
      lower: l.lowerBound(i150),
      upper: l.upperBound(i150),
      representative: l.representative(i150),
      count: 2,
    });
    for (let i = 1; i < snap.buckets.length; i++) {
      expect(snap.buckets[i]!.index).toBeGreaterThan(snap.buckets[i - 1]!.index);
    }
  });

  it('空の観察、観察の前後で操作数・メモリ見積もりが同じ', () => {
    const s = make();
    expect(s.inspect()).toMatchObject({ totalCount: 0, nonEmptyBuckets: 0, buckets: [] });
    load(s, [3, 30, 300]);
    const ops = s.operationCounts();
    const mem = s.memoryBytes();
    s.inspect();
    expect(s.operationCounts()).toEqual(ops);
    expect(s.memoryBytes()).toBe(mem);
  });

  it('観察結果はその後の投入で変わらず、JSON を往復できる', () => {
    const s = make();
    load(s, [2, 20, 200]);
    const snap = s.inspect();
    const frozen = JSON.parse(JSON.stringify(snap));
    expect(frozen).toEqual(snap);
    load(s, [2, 2, 999]);
    expect(snap).toEqual(frozen);
    expect(s.inspect().totalCount).toBe(6);
  });
});
