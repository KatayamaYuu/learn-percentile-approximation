import { describe, expect, it } from 'vitest';
import { generate, sortExactSpec, type DataOrder, type PercentileSketch } from '../core';
import { createDDSketch, type DDSketch } from './ddsketch';
import { createHdrHistogram, type HdrHistogram } from './hdr-histogram';

function dd(alpha: number, maxBuckets: number): DDSketch {
  const r = createDDSketch({ alpha, maxBuckets });
  if (!r.ok) throw new Error();
  return r.value;
}
function hdr(significantDigits: number, highest = 1e7): HdrHistogram {
  const r = createHdrHistogram({ lowest: 0.001, highest, significantDigits });
  if (!r.ok) throw new Error();
  return r.value;
}
function data(count: number, order: DataOrder = 'random', sigma = 2): Float64Array {
  const g = generate({ distribution: { kind: 'lognormal', mu: 3, sigma }, count, seed: 4, order });
  if (!g.ok) throw new Error();
  // HDR の範囲に収める
  return g.value.map((x) => Math.min(Math.max(x, 0.001), 1e7));
}

/** 投入ごとの操作数の増分 */
function insertDeltas(s: PercentileSketch, values: Float64Array): { comparisons: number; moves: number }[] {
  const out: { comparisons: number; moves: number }[] = [];
  let prev = s.operationCounts();
  for (const x of values) {
    if (!s.insert(x).ok) throw new Error('insert');
    const now = s.operationCounts();
    out.push({ comparisons: now.comparisons - prev.comparisons, moves: now.moves - prev.moves });
    prev = now;
  }
  return out;
}

describe('DDSketch の投入の操作数', { timeout: 60_000 }, () => {
  const cases: [number, number][] = [
    [1000, 64],
    [1000, 2048],
    [100_000, 64],
    [100_000, 2048],
  ];

  it.each(cases)('件数 %i, m = %i: 範囲内の投入は比較 5 回以下・移動 2 回、拡張・縮約は移動 m + 1 回以下', (count, m) => {
    for (const order of ['random', 'ascending', 'descending'] as const) {
      const deltas = insertDeltas(dd(0.01, m), data(count, order));
      let inRange = 0;
      for (const d of deltas) {
        expect(d.comparisons).toBeLessThanOrEqual(5);
        if (d.moves === 2) inRange++;
        else expect(d.moves).toBeLessThanOrEqual(m + 1);
      }
      expect(inRange).toBeGreaterThan(0);
    }
  });
});

describe('HDR の投入の操作数', { timeout: 60_000 }, () => {
  it.each([1000, 100_000])('件数 %i: 有効桁数を変えても比較 4 回以下・移動 2 回', (count) => {
    const values = data(count);
    for (const d of [0, 1, 2, 3, 4]) {
      for (const delta of insertDeltas(hdr(d), values)) {
        expect(delta.comparisons).toBeLessThanOrEqual(4);
        expect(delta.moves).toBe(2);
      }
    }
  });
});

describe('問い合わせの操作数', () => {
  it('比較は保持バケット数以下で、件数を変えても増えない', () => {
    for (const count of [1000, 100_000]) {
      const s = dd(0.01, 256);
      const h = hdr(2);
      for (const x of data(count)) {
        s.insert(x);
        h.insert(x);
      }
      const spanBound = s.inspect().span;
      const hdrBound = h.inspect().totalBuckets;
      for (const q of [0, 0.5, 0.99, 1]) {
        for (const [sketch, bound] of [[s, spanBound], [h, hdrBound]] as const) {
          const before = sketch.operationCounts();
          expect(sketch.query(q).ok).toBe(true);
          const after = sketch.operationCounts();
          expect(after.comparisons - before.comparisons).toBeLessThanOrEqual(bound);
          expect(after.moves).toBe(before.moves);
        }
      }
      expect(spanBound).toBeLessThanOrEqual(256);
    }
  });
});

describe('メモリ見積もり', () => {
  it('件数で変わらず、DDSketch は (m + 6) × 8 バイト以下、HDR は作成時から一定、厳密解は件数に比例して増える', () => {
    const m = 128;
    const exact = (): PercentileSketch => sortExactSpec().create(1);
    const small = { dd: dd(0.05, m), hdr: hdr(2), exact: exact() };
    const large = { dd: dd(0.05, m), hdr: hdr(2), exact: exact() };
    const hdrInitial = small.hdr.memoryBytes();
    for (const x of data(2000)) for (const s of Object.values(small)) s.insert(x);
    for (const x of data(200_000)) for (const s of Object.values(large)) s.insert(x);
    expect(small.dd.memoryBytes()).toBeLessThanOrEqual((m + 6) * 8);
    expect(large.dd.memoryBytes()).toBeLessThanOrEqual((m + 6) * 8);
    expect(large.dd.memoryBytes()).toBe(small.dd.memoryBytes());
    expect(small.hdr.memoryBytes()).toBe(hdrInitial);
    expect(large.hdr.memoryBytes()).toBe(hdrInitial);
    expect(large.exact.memoryBytes() / small.exact.memoryBytes()).toBeGreaterThan(50);
  });
});

describe('設定による増え方', () => {
  it('α を小さくするとバケット数とメモリ見積もりが増える', () => {
    const values = data(5000);
    let previous = { span: 0, memory: 0 };
    for (const alpha of [0.2, 0.1, 0.05, 0.01, 0.002]) {
      const s = dd(alpha, 100_000);
      for (const x of values) s.insert(x);
      const now = { span: s.inspect().span, memory: s.memoryBytes() };
      expect(now.span).toBeGreaterThan(previous.span);
      expect(now.memory).toBeGreaterThan(previous.memory);
      previous = now;
    }
  });

  it('有効桁数を大きくするとバケット数とメモリ見積もりが増える', () => {
    let previous = { total: 0, memory: 0 };
    for (const d of [0, 1, 2, 3, 4]) {
      const h = hdr(d);
      const now = { total: h.inspect().totalBuckets, memory: h.memoryBytes() };
      expect(now.total).toBeGreaterThan(previous.total);
      expect(now.memory).toBeGreaterThan(previous.memory);
      previous = now;
    }
  });
});
