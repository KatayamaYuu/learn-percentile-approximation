import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPARE, DEFAULT_HISTOGRAM, DEFAULT_RELATIVE, DEFAULT_STREAMING } from './conditions';
import type { DataCondition } from './conditions';
import { WORK_LIMIT } from './limits';
import type { JobRequest } from './protocol';
import { estimateWork } from './workload';

const bigData = (count: number): DataCondition => ({
  ...DEFAULT_STREAMING.data,
  count,
});

// 既定のデータ: n = 10,000 → 件数の格子 [100, 1000, 10000]、Σ = 11,100
const histogram: JobRequest = {
  kind: 'histogram',
  condition: DEFAULT_HISTOGRAM,
};
const streaming: JobRequest = {
  kind: 'streaming',
  condition: DEFAULT_STREAMING,
};
const relative: JobRequest = { kind: 'relative', condition: DEFAULT_RELATIVE };
const compare: JobRequest = { kind: 'compare', condition: DEFAULT_COMPARE };

describe('投入の項(hdr なし。3.5)', () => {
  it('ヒストグラムの既定: 10000×(2+2×11) + 11100×(2+2) + 10000×4 = 324,400', () => {
    const e = estimateWork(histogram);
    expect(e.units).toBe(240_000 + 44_400 + 40_000);
    expect(e.includesHdrTerm).toBe(false);
    expect(e.withinLimit).toBe(true);
    expect(e.suggestions).toEqual([]);
  });
  it('ストリーミングの既定: 格子 GK 7 + KLL 9 + t-digest 7 = 23。10000×25 + 11100×5 + 10000×5×3×1 + 10000 = 465,500', () => {
    const e = estimateWork(streaming);
    expect(e.units).toBe(250_000 + 55_500 + 150_000 + 10_000);
    expect(e.withinLimit).toBe(true);
  });
  it('相対誤差型の既定: 10000×(2+2×(7+5)) + 11100×(2+4) + 10000×6 + 10000 = 396,600', () => {
    const e = estimateWork(relative);
    expect(e.units).toBe(260_000 + 66_600 + 60_000 + 10_000);
    expect(e.includesHdrTerm).toBe(false);
  });
  it('横断比較の既定: 7 手法。11100×7 + 10000×7 = 147,700', () => {
    const e = estimateWork(compare);
    expect(e.units).toBe(77_700 + 70_000);
    expect(e.withinLimit).toBe(true);
  });
  it('試行は詳細の項だけを増やす', () => {
    const e = estimateWork({
      kind: 'streaming',
      condition: { ...DEFAULT_STREAMING, trials: 3 },
    });
    expect(e.units).toBe(250_000 + 55_500 + 450_000 + 10_000);
  });
  it('件数 1,000,000・試行 10 のストリーミングは上限超で、件数と試行の案内を持つ', () => {
    const e = estimateWork({
      kind: 'streaming',
      condition: { ...DEFAULT_STREAMING, data: bigData(1_000_000), trials: 10 },
    });
    // 25,000,000 + 1,111,100×5 + 1,000,000×5×3×10 + 1,000,000
    expect(e.units).toBe(25_000_000 + 5_555_500 + 150_000_000 + 1_000_000);
    expect(e.withinLimit).toBe(false);
    expect(e.suggestions.some((s) => s.includes('件数'))).toBe(true);
    expect(e.suggestions.some((s) => s.includes('試行'))).toBe(true);
    expect(e.suggestions.some((s) => s.includes('HDR'))).toBe(false);
  });
  it('上限ちょうどは範囲内(units <= WORK_LIMIT)', () => {
    // 比較: 手法 1 つ(厳密解)で n = 1,000,000 → 1,111,100 + 1,000,000
    const e = estimateWork({
      kind: 'compare',
      condition: {
        ...DEFAULT_COMPARE,
        data: bigData(1_000_000),
        algorithms: [{ kind: 'exact-sort' }],
      },
    });
    expect(e.units).toBe(2_111_100);
    expect(e.units).toBeLessThanOrEqual(WORK_LIMIT);
    expect(e.withinLimit).toBe(true);
  });
  it('比較で対象が多く上限を超えたら、比較の対象を減らす案内を持つ', () => {
    const algorithms = Array.from({ length: 30 }, (_, i) => ({
      kind: 'gk' as const,
      epsilon: 0.001 * (i + 1),
    }));
    const e = estimateWork({
      kind: 'compare',
      condition: { ...DEFAULT_COMPARE, data: bigData(1_000_000), algorithms },
    });
    // 30 × (1,111,100 + 1,000,000)
    expect(e.units).toBe(63_333_000);
    expect(e.withinLimit).toBe(false);
    expect(e.suggestions.some((s) => s.includes('比較の対象'))).toBe(true);
  });
});

describe('HDR の項(3.5)', () => {
  // 有効桁数 1 → 1,000、2 → 2,000。分位点の数: 要約 9、詳細 105
  const hdr = {
    totalBuckets: new Map([
      [1, 1000],
      [2, 2000],
    ]),
  };

  it('相対誤差型: ハーネス T×(1+q) + 再投入 T×2 を 3 回の実験に足す', () => {
    // 掃引: (1000+2000)×12 = 36,000。件数の掃引: 3 件数×2000×12 = 72,000。詳細: 2000×(1+105+2) = 216,000
    const e = estimateWork(relative, hdr);
    expect(e.includesHdrTerm).toBe(true);
    expect(e.units).toBe(396_600 + 36_000 + 72_000 + 216_000);
    expect(e.withinLimit).toBe(true);
  });
  it('内部状態の対象が hdr なら T×2 を足す', () => {
    const e = estimateWork(
      {
        kind: 'relative',
        condition: { ...DEFAULT_RELATIVE, inspectTarget: 'hdr' },
      },
      hdr,
    );
    expect(e.units).toBe(396_600 + 324_000 + 4_000);
  });
  it('横断比較: HDR の手法ごとに T×(1+9)×件数の数 + T×(1+105)', () => {
    // 2000 × (3×10 + 106) = 272,000
    const e = estimateWork(compare, hdr);
    expect(e.units).toBe(147_700 + 272_000);
    expect(e.includesHdrTerm).toBe(true);
  });
  it('横断比較: HDR を選んでいなければ HDR の項は 0 だが、hdr を渡せば includesHdrTerm は true', () => {
    const e = estimateWork(
      {
        kind: 'compare',
        condition: { ...DEFAULT_COMPARE, algorithms: [{ kind: 'exact-sort' }] },
      },
      hdr,
    );
    expect(e.units).toBe(11_100 + 10_000);
    expect(e.includesHdrTerm).toBe(true);
  });
  it('ヒストグラムとストリーミングは hdr を渡しても投入の項のまま', () => {
    expect(estimateWork(histogram, hdr).units).toBe(324_400);
    expect(estimateWork(streaming, hdr).units).toBe(465_500);
  });
  it('総数が大きい HDR で上限を超えると、HDR の案内を持つ', () => {
    const big = { totalBuckets: new Map([[2, 5_000_000]]) };
    // 掃引 5M×12 + 件数 3×5M×12 + 詳細 5M×108 = 60M + 180M + 540M
    const e = estimateWork(relative, big);
    expect(e.units).toBe(396_600 + 780_000_000);
    expect(e.withinLimit).toBe(false);
    expect(e.suggestions.some((s) => s.includes('HDR の有効桁数を下げるか、追跡する範囲を狭める'))).toBe(true);
  });
  it('投入の項だけで超えているときは、HDR の案内を加えない', () => {
    const e = estimateWork(
      {
        kind: 'streaming',
        condition: {
          ...DEFAULT_STREAMING,
          data: bigData(1_000_000),
          trials: 10,
        },
      },
      { totalBuckets: new Map() },
    );
    expect(e.withinLimit).toBe(false);
    expect(e.suggestions.some((s) => s.includes('HDR'))).toBe(false);
  });
});

describe('既定の条件は HDR の項を含めても上限内(3.5)', () => {
  // 既定のデータの自動範囲で、有効桁数 0〜4 の総数は最大でも約 23 万(設計)
  const hdr = {
    totalBuckets: new Map([
      [0, 2_000],
      [1, 7_000],
      [2, 25_000],
      [3, 100_000],
      [4, 230_000],
    ]),
  };
  it('relative と compare', () => {
    expect(estimateWork(relative, hdr).withinLimit).toBe(true);
    expect(estimateWork(compare, hdr).withinLimit).toBe(true);
  });
});
