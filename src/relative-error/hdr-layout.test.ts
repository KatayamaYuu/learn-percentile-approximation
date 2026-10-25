import { describe, expect, it } from 'vitest';
import { OperationCounter } from '../core';
import { createHdrLayout, MAX_HDR_BUCKETS, type HdrConfig, type HdrLayout } from './hdr-layout';

function make(config: HdrConfig): HdrLayout {
  const r = createHdrLayout(config);
  if (!r.ok) throw new Error(`layout: ${r.error.field}`);
  return r.value;
}

describe('副バケット数と総数', () => {
  it.each([
    [0, 2],
    [1, 32],
    [2, 256],
    [3, 2048],
    [4, 32768],
    [5, 262144],
  ])('d = %i の S は %i', (d, s) => {
    expect(make({ lowest: 1, highest: 4, significantDigits: d }).subBucketCount).toBe(s);
  });

  it('総数 = S + K × S / 2(H を含む区間まで)', () => {
    // S = 256: u < 256 は区間 0。H = 255 → K = 0 だが highest >= 2L なので H = 300 → u 最大 300 < 512 → K = 1
    expect(make({ lowest: 1, highest: 255, significantDigits: 2 }).totalBuckets).toBe(256);
    expect(make({ lowest: 1, highest: 256, significantDigits: 2 }).totalBuckets).toBe(256 + 128);
    expect(make({ lowest: 1, highest: 511, significantDigits: 2 }).totalBuckets).toBe(256 + 128);
    expect(make({ lowest: 1, highest: 512, significantDigits: 2 }).totalBuckets).toBe(256 + 2 * 128);
    expect(make({ lowest: 1, highest: 3_600_000, significantDigits: 2 }).totalBuckets).toBe(256 + 14 * 128);
    expect(make({ lowest: 0.5, highest: 1000, significantDigits: 1 }).totalBuckets).toBe(32 + 6 * 16);
  });

  it('設定を保つ', () => {
    const l = make({ lowest: 2, highest: 100, significantDigits: 1 });
    expect([l.lowest, l.highest, l.significantDigits]).toEqual([2, 100, 1]);
  });
});

describe('番号・境界・代表値', () => {
  const layout = make({ lowest: 1, highest: 3_600_000, significantDigits: 2 });
  const S = 256;

  it('区間の境目で番号が連続し、境界が隣と一致する', () => {
    const edges = [S - 1, S, S + 1, 2 * S - 2, 2 * S - 1, 2 * S, 4 * S - 1, 4 * S];
    let previous = -1;
    for (const u of edges) {
      const i = layout.indexOf(u);
      expect(i).toBeGreaterThanOrEqual(previous);
      previous = i;
      expect(layout.lowerBound(i)).toBeLessThanOrEqual(u);
      expect(u).toBeLessThan(layout.upperBound(i));
    }
    expect(layout.indexOf(S - 1)).toBe(S - 1);
    expect(layout.indexOf(S)).toBe(S);
    expect(layout.indexOf(2 * S - 1)).toBe(S + 127);
    expect(layout.indexOf(2 * S)).toBe(S + 128);
    for (let i = 0; i < layout.totalBuckets - 1; i++) {
      expect(layout.upperBound(i)).toBe(layout.lowerBound(i + 1));
    }
  });

  it('代表値は中点', () => {
    for (const i of [1, 100, 255, 256, 300, 1000, layout.totalBuckets - 1]) {
      expect(layout.representative(i)).toBe((layout.lowerBound(i) + layout.upperBound(i)) / 2);
    }
  });

  it('L・H・S/2 × L の前後で誤差が上限以下', () => {
    const xs = [1, 1.5, 127.9, 128, 128.4, 255.9, 256, 300, 1000, 150, 100, 1_000_000, 3_600_000];
    for (const x of xs) {
      const i = layout.indexOf(x);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(layout.totalBuckets);
      const rep = layout.representative(i);
      expect(Number.isFinite(rep) && rep > 0).toBe(true);
      const e = Math.abs(rep - x);
      if (x >= 128) expect(e / x).toBeLessThanOrEqual(1 / S + 1e-12);
      else expect(e).toBeLessThanOrEqual(0.5 + 1e-12);
    }
  });

  it('L が 1 でない設定でも誤差の上限が成り立つ', () => {
    const l = make({ lowest: 0.001, highest: 5, significantDigits: 3 });
    for (let x = 0.001; x <= 5; x *= 1.07) {
      const rep = l.representative(l.indexOf(x));
      if (x >= (l.subBucketCount / 2) * 0.001) expect(Math.abs(rep - x) / x).toBeLessThanOrEqual(1 / 2048 + 1e-9);
      else expect(Math.abs(rep - x)).toBeLessThanOrEqual(0.0005 * (1 + 1e-9));
    }
  });

  it('H の番号は総数未満', () => {
    expect(layout.indexOf(3_600_000)).toBeLessThan(layout.totalBuckets);
  });

  it('比較は 4 回以下(計数器があるときだけ数える)', () => {
    const counter = new OperationCounter();
    let max = 0;
    for (let x = 1; x <= 3_600_000; x *= 1.013) {
      const before = counter.snapshot().comparisons;
      layout.indexOf(x, counter);
      max = Math.max(max, counter.snapshot().comparisons - before);
    }
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThanOrEqual(1);
    expect(counter.snapshot().moves).toBe(0);
    expect(layout.indexOf(500)).toBe(layout.indexOf(500));
  });
});

describe('不正な設定', () => {
  const base: HdrConfig = { lowest: 1, highest: 1000, significantDigits: 2 };
  const fieldOf = (c: HdrConfig): [string, string] | undefined => {
    const r = createHdrLayout(c);
    return r.ok ? undefined : [r.error.kind, r.error.field];
  };

  it.each<[string, HdrConfig, string]>([
    ['L が 0', { ...base, lowest: 0 }, 'lowest'],
    ['L が負', { ...base, lowest: -1 }, 'lowest'],
    ['L が NaN', { ...base, lowest: Number.NaN }, 'lowest'],
    ['L が Infinity', { ...base, lowest: Number.POSITIVE_INFINITY }, 'lowest'],
    ['H が 0', { ...base, highest: 0 }, 'highest'],
    ['H が Infinity', { ...base, highest: Number.POSITIVE_INFINITY }, 'highest'],
    ['H が 2L 未満', { ...base, highest: 1.5 }, 'highest'],
    ['比が有限でない', { lowest: 1e-300, highest: 1e300, significantDigits: 2 }, 'highest'],
    ['d が負', { ...base, significantDigits: -1 }, 'significantDigits'],
    ['d が 6', { ...base, significantDigits: 6 }, 'significantDigits'],
    ['d が小数', { ...base, significantDigits: 1.5 }, 'significantDigits'],
    ['d が NaN', { ...base, significantDigits: Number.NaN }, 'significantDigits'],
    ['総数の超過', { lowest: 1, highest: 1e15, significantDigits: 5 }, 'significantDigits'],
  ])('%s → invalid-config / %s', (_name, config, field) => {
    expect(fieldOf(config)).toEqual(['invalid-config', field]);
  });

  it('検証は L → H → 比 → d → 総数の順で最初の 1 件を返す', () => {
    expect(fieldOf({ lowest: 0, highest: 0, significantDigits: 9 })?.[1]).toBe('lowest');
    expect(fieldOf({ lowest: 1, highest: 0, significantDigits: 9 })?.[1]).toBe('highest');
    expect(fieldOf({ lowest: 1, highest: 5, significantDigits: 9 })?.[1]).toBe('significantDigits');
  });

  it('総数の上限ちょうどは受け付ける', () => {
    // d = 5: S = 262144、half = 131072。K = 30 で 4,194,304 = 2^22
    const l = make({ lowest: 1, highest: 262144 * 2 ** 30 - 1, significantDigits: 5 });
    expect(l.totalBuckets).toBe(MAX_HDR_BUCKETS);
    expect(fieldOf({ lowest: 1, highest: 262144 * 2 ** 30, significantDigits: 5 })).toEqual([
      'invalid-config',
      'significantDigits',
    ]);
  });
});
