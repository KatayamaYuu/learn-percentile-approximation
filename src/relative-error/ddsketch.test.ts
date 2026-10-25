import { describe, expect, it } from 'vitest';
import { exactQuantileSorted, generate, type PercentileSketch } from '../core';
import { createDDSketch, ddsketchSpec, DEFAULT_MAX_BUCKETS, type DDSketch } from './ddsketch';
import { createLogMapping } from './log-mapping';

function make(alpha: number, maxBuckets?: number): DDSketch {
  const r = createDDSketch({ alpha, ...(maxBuckets === undefined ? {} : { maxBuckets }) });
  if (!r.ok) throw new Error('ddsketch');
  return r.value;
}

function load(s: PercentileSketch, data: ArrayLike<number>): void {
  for (let i = 0; i < data.length; i++) {
    const r = s.insert(data[i]!);
    if (!r.ok) throw new Error('insert');
  }
}

const QS = [0, 0.001, 0.01, 0.07, 0.25, 0.5, 0.9, 0.99, 0.999, 1];

describe('推定規則', () => {
  it('推定値は目標順位のバケットの代表値', () => {
    const s = make(0.01);
    load(s, [10, 10, 10, 1000]);
    const m = createLogMapping(0.01);
    if (!m.ok) throw new Error();
    const q50 = s.query(0.5);
    expect(q50.ok && q50.value).toBe(m.value.representative(m.value.indexOf(10)));
    const q100 = s.query(1);
    expect(q100.ok && q100.value).toBe(m.value.representative(m.value.indexOf(1000)));
  });

  it.each([0.001, 0.01, 0.1])('縮約が起きない条件で、最近順位法の厳密値に対する相対誤差が α = %s 以下', (alpha) => {
    const g = generate({ distribution: { kind: 'lognormal', mu: 3, sigma: 2 }, count: 5000, seed: 7 });
    if (!g.ok) throw new Error();
    const s = make(alpha, 100_000);
    load(s, g.value);
    const sorted = Float64Array.from(g.value).sort();
    for (const q of QS) {
      const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
      const est = s.query(q);
      expect(est.ok).toBe(true);
      if (est.ok) expect(Math.abs(est.value - exact) / exact).toBeLessThanOrEqual(alpha * (1 + 1e-9));
    }
  });

  it('極端な値(正の最大値・最小値)を受け付け、有限の正の数を返す', () => {
    const s = make(0.01);
    expect(s.insert(Number.MAX_VALUE).ok).toBe(true);
    expect(s.insert(Number.MIN_VALUE).ok).toBe(true);
    for (const q of [0, 1]) {
      const r = s.query(q);
      expect(r.ok && Number.isFinite(r.value) && r.value > 0).toBe(true);
    }
  });

  it('同じ入力で同じ結果になり、シードに依存しない', () => {
    const spec = ddsketchSpec({ alpha: 0.02, maxBuckets: 64 });
    if (!spec.ok) throw new Error();
    const a = spec.value.create(1);
    const b = spec.value.create(999);
    const data = [5, 1, 9, 3, 7, 1000, 0.5, 2, 2, 2];
    load(a, data);
    load(b, data);
    for (const q of QS) expect(a.query(q)).toEqual(b.query(q));
    expect(a.operationCounts()).toEqual(b.operationCounts());
    expect(a.memoryBytes()).toBe(b.memoryBytes());
  });
});

describe('エラーと状態不変', () => {
  it('不正な値は拒否し、状態・操作数・メモリ見積もりを変えない', () => {
    const s = make(0.01);
    load(s, [1, 2, 3]);
    const q = s.query(0.5);
    const ops = s.operationCounts();
    const mem = s.memoryBytes();
    for (const [v, reason] of [
      [Number.NaN, 'not-a-number'],
      [Number.POSITIVE_INFINITY, 'not-finite'],
      [0, 'not-positive'],
      [-1, 'not-positive'],
    ] as const) {
      expect(s.insert(v)).toEqual({ ok: false, error: { kind: 'invalid-value', reason } });
    }
    expect(s.operationCounts()).toEqual(ops);
    expect(s.memoryBytes()).toBe(mem);
    expect(s.query(0.5)).toEqual(q);
  });

  it('範囲外の分位点・空の問い合わせはエラーで、状態を変えない', () => {
    const s = make(0.01);
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(s.query(-0.1)).toEqual({ ok: false, error: { kind: 'quantile-out-of-range' } });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    load(s, [1, 2]);
    const ops = s.operationCounts();
    const mem = s.memoryBytes();
    for (const q of [-0.0001, 1.0001, Number.NaN]) {
      expect(s.query(q)).toEqual({ ok: false, error: { kind: 'quantile-out-of-range' } });
    }
    expect(s.operationCounts()).toEqual(ops);
    expect(s.memoryBytes()).toBe(mem);
  });
});

describe('メモリ・reset', () => {
  it('メモリ見積もりは (保持範囲の長さ + 6) × 8 バイトで、件数に依存しない', () => {
    const s = make(0.01);
    expect(s.memoryBytes()).toBe(48);
    s.insert(100);
    expect(s.memoryBytes()).toBe((1 + 6) * 8);
    for (let i = 0; i < 10_000; i++) s.insert(100);
    expect(s.memoryBytes()).toBe((1 + 6) * 8);
    s.insert(100_000);
    const m = createLogMapping(0.01);
    if (!m.ok) throw new Error();
    const span = m.value.indexOf(100_000) - m.value.indexOf(100) + 1;
    expect(s.memoryBytes()).toBe((span + 6) * 8);
  });

  it('メモリ見積もりは最大でも (m + 6) × 8 バイト', () => {
    const s = make(0.01, 16);
    for (let i = 1; i <= 5000; i++) s.insert(i * 3.7);
    expect(s.memoryBytes()).toBe((16 + 6) * 8);
  });

  it('reset 後は新規作成直後と同じで、設定を保つ', () => {
    const fresh = make(0.01, 8);
    const s = make(0.01, 8);
    load(s, [1, 10, 100, 1000, 10_000, 1e5, 1e6, 1e7, 1e8, 1e9]);
    s.reset();
    expect(s.operationCounts()).toEqual(fresh.operationCounts());
    expect(s.memoryBytes()).toBe(fresh.memoryBytes());
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    load(s, [1, 10, 100, 1000, 10_000, 1e5, 1e6, 1e7, 1e8, 1e9]);
    load(fresh, [1, 10, 100, 1000, 10_000, 1e5, 1e6, 1e7, 1e8, 1e9]);
    for (const q of QS) expect(s.query(q)).toEqual(fresh.query(q));
    expect(s.memoryBytes()).toBe(fresh.memoryBytes());
  });
});

describe('設定と SketchSpec', () => {
  it('既定の m は 2048', () => {
    const spec = ddsketchSpec({ alpha: 0.01 });
    expect(spec.ok && spec.value.params).toMatchObject({ maxBuckets: DEFAULT_MAX_BUCKETS });
  });

  it('識別子・表示名・パラメータは α と m から作り、値域を宣言しない', () => {
    const spec = ddsketchSpec({ alpha: 0.01, maxBuckets: 2048 });
    if (!spec.ok) throw new Error();
    expect(spec.value.id).toBe('ddsketch-a0.01-m2048');
    expect(spec.value.label).toBe('DDSketch(α=0.01, m=2048)');
    expect(spec.value.params).toEqual({ alpha: 0.01, gamma: 1.01 / 0.99, maxBuckets: 2048 });
    expect(spec.value.supportedRange).toBeUndefined();
    expect(spec.value.create(1)).not.toBe(spec.value.create(1));
  });

  it('識別子と表示名を上書きできる', () => {
    const spec = ddsketchSpec({ alpha: 0.05 }, { id: 'dd', label: 'DD' });
    expect(spec.ok && [spec.value.id, spec.value.label]).toEqual(['dd', 'DD']);
  });

  it.each([
    ['0', 0],
    ['小数', 1.5],
    ['負', -3],
    ['NaN', Number.NaN],
    ['上限超過', 100_001],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('不正な m(%s)は field がちょうど maxBuckets の invalid-config', (_n, m) => {
    for (const result of [createDDSketch({ alpha: 0.01, maxBuckets: m }), ddsketchSpec({ alpha: 0.01, maxBuckets: m })]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect([result.error.kind, result.error.field]).toEqual(['invalid-config', 'maxBuckets']);
    }
  });

  it('m の上限ちょうど・下限ちょうどは受け付ける', () => {
    expect(createDDSketch({ alpha: 0.01, maxBuckets: 1 }).ok).toBe(true);
    expect(createDDSketch({ alpha: 0.01, maxBuckets: 100_000 }).ok).toBe(true);
  });

  it('α と m が両方不正なら alpha を返す', () => {
    const r = createDDSketch({ alpha: 2, maxBuckets: 0 });
    expect(!r.ok && r.error.field).toBe('alpha');
  });
});

describe('inspect', () => {
  it('全項目を返す(縮約なし)', () => {
    const s = make(0.01, 1000);
    load(s, [10, 10, 10, 1000]);
    const snap = s.inspect();
    const m = createLogMapping(0.01);
    if (!m.ok) throw new Error();
    const i10 = m.value.indexOf(10);
    const i1000 = m.value.indexOf(1000);
    expect(snap).toMatchObject({
      kind: 'ddsketch',
      alpha: 0.01,
      gamma: m.value.gamma,
      maxBuckets: 1000,
      totalCount: 4,
      span: i1000 - i10 + 1,
      nonEmptyBuckets: 2,
      collapsed: false,
      collapsedUpperBound: null,
      collapseCount: 0,
    });
    expect(snap.buckets).toEqual([
      {
        index: i10,
        lower: m.value.lowerBound(i10),
        upper: m.value.upperBound(i10),
        representative: m.value.representative(i10),
        count: 3,
      },
      {
        index: i1000,
        lower: m.value.lowerBound(i1000),
        upper: m.value.upperBound(i1000),
        representative: m.value.representative(i1000),
        count: 1,
      },
    ]);
  });

  it('件数の合計が総件数と一致し、番号は昇順', () => {
    const g = generate({ distribution: { kind: 'lognormal', mu: 2, sigma: 1.5 }, count: 3000, seed: 3 });
    if (!g.ok) throw new Error();
    for (const m of [8, 64, 2048]) {
      const s = make(0.02, m);
      load(s, g.value);
      const snap = s.inspect();
      expect(snap.buckets.reduce((a, b) => a + b.count, 0)).toBe(snap.totalCount);
      expect(snap.totalCount).toBe(3000);
      expect(snap.span).toBeLessThanOrEqual(m);
      expect(snap.nonEmptyBuckets).toBe(snap.buckets.length);
      for (let i = 1; i < snap.buckets.length; i++) {
        expect(snap.buckets[i]!.index).toBeGreaterThan(snap.buckets[i - 1]!.index);
      }
    }
  });

  it('観察の前後で状態・操作数・メモリ見積もりが同じ', () => {
    const s = make(0.01, 16);
    load(s, [1, 5, 50, 500, 5000, 5e4, 5e5, 5e6]);
    const ops = s.operationCounts();
    const mem = s.memoryBytes();
    const q = s.query(0.3);
    const ops2 = s.operationCounts();
    s.inspect();
    s.inspect();
    expect(s.operationCounts()).toEqual(ops2);
    expect(ops2.comparisons).toBeGreaterThan(ops.comparisons);
    expect(s.memoryBytes()).toBe(mem);
    expect(s.query(0.3)).toEqual(q);
  });

  it('観察結果はその後の投入で変わらず、JSON を往復できる', () => {
    const s = make(0.01, 4);
    load(s, [1, 2, 3, 100, 1e6, 1e9]);
    const snap = s.inspect();
    const frozen = JSON.parse(JSON.stringify(snap));
    expect(frozen).toEqual(snap);
    load(s, [7, 7, 7, 1e12, 5]);
    expect(snap).toEqual(frozen);
    expect(s.inspect()).not.toEqual(frozen);
  });

  it('m を小さくして縮約を起こすと、影響の上限より上の推定は相対誤差 α 以下', () => {
    const alpha = 0.02;
    const g = generate({ distribution: { kind: 'lognormal', mu: 3, sigma: 2.5 }, count: 20_000, seed: 11 });
    if (!g.ok) throw new Error();
    const s = make(alpha, 40);
    load(s, g.value);
    const snap = s.inspect();
    expect(snap.collapsed).toBe(true);
    expect(snap.collapseCount).toBeGreaterThan(0);
    expect(snap.collapsedUpperBound).not.toBeNull();
    const bound = snap.collapsedUpperBound!;
    const sorted = Float64Array.from(g.value).sort();
    let above = 0;
    let broken = 0;
    for (let k = 0; k <= 1000; k++) {
      const q = k / 1000;
      const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
      const est = s.query(q);
      if (!est.ok) throw new Error();
      const rel = Math.abs(est.value - exact) / exact;
      if (est.value > bound) {
        above++;
        expect(rel).toBeLessThanOrEqual(alpha * (1 + 1e-9));
      } else if (rel > alpha) broken++;
    }
    expect(above).toBeGreaterThan(0);
    // 低い分位点では保証が破れる(縮約の影響が見える)
    expect(broken).toBeGreaterThan(0);
  });
});
