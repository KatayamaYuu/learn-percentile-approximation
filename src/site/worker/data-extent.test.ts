import { describe, expect, it } from 'vitest';
import { generate } from '../../core';
import { MAX_HDR_BUCKETS } from '../../relative-error';
import { autoHdrRange, dataExtent, hdrHalf, planHdr, type Extent } from './data-extent';

const AUTO = { kind: 'auto' } as const;

describe('dataExtent', () => {
  it('最小値・最大値・正の値の最小値', () => {
    expect(dataExtent(Float64Array.of(3, 1, 2))).toEqual({ min: 1, max: 3, minPositive: 1 });
    expect(dataExtent(Float64Array.of(-2, 0, 5, 4))).toEqual({ min: -2, max: 5, minPositive: 4 });
  });
  it('正の値がなければ minPositive は null', () => {
    expect(dataExtent(Float64Array.of(-1, 0))).toEqual({ min: -1, max: 0, minPositive: null });
  });
});

describe('hdrHalf', () => {
  it('d = 0..5 で 1, 16, 128, 1024, 16384, 131072', () => {
    expect([0, 1, 2, 3, 4, 5].map(hdrHalf)).toEqual([1, 16, 128, 1024, 16384, 131072]);
  });
});

describe('autoHdrRange', () => {
  it('下限は minPositive / half 以下の 10 の累乗の最大値(手計算)', () => {
    // 5 / 128 = 0.039 → 0.01、上限は 10^ceil(log10(700)) = 1000
    expect(autoHdrRange({ min: 5, max: 700, minPositive: 5 }, 2)).toEqual({ lowest: 0.01, highest: 1000 });
    // 1000 / 1 = 1000 ちょうどは 1000(境界)
    expect(autoHdrRange({ min: 1000, max: 5000, minPositive: 1000 }, 0)).toEqual({ lowest: 1000, highest: 10000 });
  });
  it('上限は下限の 2 倍以上', () => {
    // max = 1 → 10^0 = 1 だが下限 1e-3 の 2 倍より大きい方
    const r = autoHdrRange({ min: 1, max: 1, minPositive: 1 }, 0);
    expect(r.lowest).toBe(1);
    expect(r.highest).toBe(2);
  });
  it('正の値がなければ lowest = 1、highest = 2', () => {
    expect(autoHdrRange({ min: -1, max: 0, minPositive: null }, 3)).toEqual({ lowest: 1, highest: 2 });
  });
  it('値の幅が極端なとき、そのまま(下位桁あふれ・非有限)を返す', () => {
    expect(autoHdrRange({ min: 5e-324, max: 1e300, minPositive: 5e-324 }, 5).lowest).toBe(0);
    expect(autoHdrRange({ min: 1, max: 1.5e308, minPositive: 1 }, 0).highest).toBe(Infinity);
  });
});

describe('planHdr: 自動の範囲 (6.2, 6.3)', () => {
  it('対数正規(0, 1)・件数 10,000 で、すべての値が保証が始まる値以上', () => {
    const g = generate({ distribution: { kind: 'lognormal', mu: 0, sigma: 1 }, count: 10_000, seed: 42 });
    if (!g.ok) throw new Error('generate');
    const extent = dataExtent(g.value);
    const r = planHdr(AUTO, extent, [0, 1, 2, 3, 4, 5]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value;
    expect(p.mode).toBe('auto');
    expect(p.lowestClamped).toBe(false);
    expect(p.range.lowest).toBeLessThanOrEqual(extent.min);
    expect(p.range.highest).toBeGreaterThanOrEqual(extent.max);
    expect(p.range.highest).toBeGreaterThanOrEqual(2 * p.range.lowest);
    const ref = p.referenceDigits!;
    expect(ref).toBeLessThanOrEqual(5);
    for (const info of p.included.filter((i) => i.significantDigits <= ref)) {
      expect(extent.minPositive!).toBeGreaterThanOrEqual(info.guaranteeFrom);
    }
    // 下限は 10 の累乗
    expect(Math.abs(Math.log10(p.range.lowest) % 1)).toBe(0);
  });
  it('included は副バケット数・総数・保証が始まる値を持つ(手計算)', () => {
    const r = planHdr(AUTO, { min: 5, max: 700, minPositive: 5 }, [2]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.range).toEqual({ lowest: 0.01, highest: 1000 });
    expect(r.value.referenceDigits).toBe(2);
    // d = 2: S = 256(2×10^2 = 200 以上の 2 のべき乗)、half = 128、保証は 128 × 0.01 = 1.28
    // maxUnits = 1000 / 0.01 = 100000: 256 × 2^k <= 100000 → k = 0..8 の 9 区間未満... 256×2^8 = 65536 <= 1e5, 256×2^9 = 131072 > 1e5 → 区間 9 個
    expect(r.value.included).toEqual([
      { significantDigits: 2, subBucketCount: 256, totalBuckets: 256 + 9 * 128, guaranteeFrom: 1.28 },
    ]);
    expect(r.value.excluded).toEqual([]);
  });
  it('基準の有効桁数は digits の 0〜5 の整数の最大値から始まる', () => {
    const r = planHdr(AUTO, { min: 5, max: 700, minPositive: 5 }, [1, 3]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.referenceDigits).toBe(3);
    expect(r.value.range.lowest).toBe(0.001); // 5 / 1024 = 0.0049 → 0.001
  });
  it('0〜5 の整数がない一覧([2.5])では基準が 2 から始まり、2.5 は除かれない', () => {
    const r = planHdr(AUTO, { min: 5, max: 700, minPositive: 5 }, [2.5]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.referenceDigits).toBe(2);
    expect(r.value.range.lowest).toBe(0.01);
    expect(r.value.excluded).toEqual([]);
    expect(r.value.included).toEqual([]);
  });
  it('基準の有効桁数で総数の上限を超えると基準が下がる', () => {
    // minPositive 1、max 1e12。d=5 は下限 1e-6 で比 1e18 → 総数 6M 超。d=4 は下限 1e-5、比 1e17 → 約 72 万
    const extent: Extent = { min: 1, max: 1e12, minPositive: 1 };
    const r = planHdr(AUTO, extent, [4, 5]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.referenceDigits).toBe(4);
    expect(r.value.range).toEqual({ lowest: 1e-5, highest: 1e12 });
    expect(r.value.lowestClamped).toBe(false);
    expect(r.value.included.map((i) => i.significantDigits)).toEqual([4]);
    // 基準 d=4 の範囲で d=5 は 262144 + 39 × 131072 > 上限
    expect(r.value.excluded.map((e) => e.significantDigits)).toEqual([5]);
    expect(r.value.excluded[0]!.reason).toContain(String(MAX_HDR_BUCKETS));
  });
  it('正の値がないデータ(防御)で下限が 1 になる', () => {
    const r = planHdr(AUTO, { min: -1, max: 0, minPositive: null }, [2]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.range).toEqual({ lowest: 1, highest: 2 });
    expect(r.value.lowestClamped).toBe(false);
  });
});

describe('planHdr: 値の幅が極端なデータ (6.7, 8.8)', () => {
  for (const [name, extent] of [
    ['1e-300 〜 1e300', { min: 1e-300, max: 1e300, minPositive: 1e-300 }],
    ['max が 1e308 を超える', { min: 1e-10, max: 1.5e308, minPositive: 1e-10 }],
  ] as [string, Extent][]) {
    it(`${name}: 下限が切り詰められ、有効桁数 0 の構造が作れる`, () => {
      const r = planHdr(AUTO, extent, [0, 2]);
      if (!r.ok) throw new Error('plan');
      const { range } = r.value;
      expect(r.value.lowestClamped).toBe(true);
      expect(r.value.referenceDigits).toBe(0);
      expect(Number.isFinite(range.lowest) && range.lowest > 0).toBe(true);
      expect(Number.isFinite(range.highest) && range.highest > 0).toBe(true);
      expect(range.highest / range.lowest).toBeLessThanOrEqual(1e300);
      expect(r.value.included.some((i) => i.significantDigits === 0)).toBe(true);
    });
  }
  it('1e-300 〜 1e300 の切り詰め後の範囲は 1 〜 1e300', () => {
    const r = planHdr(AUTO, { min: 1e-300, max: 1e300, minPositive: 1e-300 }, [0]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.range.highest).toBe(1e300);
    expect(r.value.range.lowest).toBeCloseTo(1, 12);
  });
});

describe('planHdr: 手動の範囲 (6.4)', () => {
  const extent: Extent = { min: 1, max: 100, minPositive: 1 };
  it('範囲は指定のまま、referenceDigits は null、lowestClamped は偽', () => {
    const r = planHdr({ kind: 'manual', lowest: 0.5, highest: 200 }, extent, [2]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.mode).toBe('manual');
    expect(r.value.range).toEqual({ lowest: 0.5, highest: 200 });
    expect(r.value.referenceDigits).toBeNull();
    expect(r.value.lowestClamped).toBe(false);
  });
  it('highest < 2 × lowest は hdrRange.highest の失敗', () => {
    const r = planHdr({ kind: 'manual', lowest: 10, highest: 15 }, extent, [2]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('hdrRange.highest');
      expect(r.error.reason.length).toBeGreaterThan(0);
    }
  });
  it('lowest が正でないときは hdrRange.lowest の失敗', () => {
    const r = planHdr({ kind: 'manual', lowest: 0, highest: 15 }, extent, [2]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('hdrRange.lowest');
  });
  it('比が有限でない範囲は hdrRange.highest の失敗', () => {
    const r = planHdr({ kind: 'manual', lowest: 1e-300, highest: 1e300 }, extent, [2]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('hdrRange.highest');
  });
  it('極端に広い範囲では、総数の上限を超える有効桁数だけが除かれる', () => {
    // 比 1e200: d=3 は 2048 + (約 654) × 1024 ≈ 67 万で収まり、d=4 は約 1060 万で超える
    const r = planHdr({ kind: 'manual', lowest: 1e-100, highest: 1e100 }, extent, [0, 1, 2, 3, 4, 5]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.included.map((i) => i.significantDigits)).toEqual([0, 1, 2, 3]);
    expect(r.value.excluded.map((e) => e.significantDigits)).toEqual([4, 5]);
    for (const e of r.value.excluded) expect(e.reason.length).toBeGreaterThan(0);
  });
  it('0〜5 の整数でない有効桁数は除かない(上流の失敗として扱う)', () => {
    const r = planHdr({ kind: 'manual', lowest: 0.5, highest: 200 }, extent, [2, 2.5, 7]);
    if (!r.ok) throw new Error('plan');
    expect(r.value.excluded).toEqual([]);
    expect(r.value.included.map((i) => i.significantDigits)).toEqual([2]);
  });
});
