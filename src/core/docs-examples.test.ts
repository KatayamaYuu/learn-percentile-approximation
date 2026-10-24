import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  absoluteError,
  exactQuantileSorted,
  nearestRank,
  rankError,
  relativeError,
  resolvePosition,
  type PercentileDefinition,
} from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'core');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

const sorted = (xs: number[]): Float64Array => Float64Array.from(xs);
const value = (r: { ok: boolean; value?: number }): number => {
  if (!r.ok) throw new Error('unexpected error result');
  return r.value as number;
};

describe('docs/core/percentile-definitions.md の例', () => {
  const doc = readDoc('percentile-definitions.md');
  const data = sorted([10, 20, 30, 40]);
  const expected: Record<PercentileDefinition, number> = {
    'nearest-rank': 20,
    linear: 22,
    lower: 20,
    higher: 30,
    midpoint: 25,
  };

  it.each(Object.entries(expected))('[10,20,30,40], q=0.4, %s は %d', (definition, want) => {
    expect(exactQuantileSorted(data, 0.4, definition as PercentileDefinition)).toBe(want);
    // 文書の表に定義名と値が同じ行で載っている
    const row = doc.split('\n').find((l) => l.includes(`| ${definition} |`));
    expect(row).toBeDefined();
    expect(row).toContain(`| ${want} |`);
  });

  it('位置の解決例: n=4, q=0.4 は h=1.2 で lo=1, hi=2, frac が約 0.2', () => {
    const p = resolvePosition(4, 0.4, 'linear');
    expect(p.lo).toBe(1);
    expect(p.hi).toBe(2);
    expect(p.frac).toBeCloseTo(0.2, 12);
    expect(doc).toContain('h = 1.2');
    expect(nearestRank(4, 0.4)).toBe(2);
    expect(doc).toContain('ceil(1.6) = 2');
  });

  it('丸め処理の例: 100 × 0.07 は 7 に丸まり、最近順位は 7 番目', () => {
    expect(100 * 0.07).toBe(7.000000000000001);
    expect(Math.ceil(100 * 0.07)).toBe(8);
    expect(nearestRank(100, 0.07)).toBe(7);
    expect(doc).toContain('7.000000000000001');
    expect(doc).toContain('7番目');
    const p = resolvePosition(101, 0.07, 'linear');
    expect(p).toEqual({ lo: 7, hi: 7, frac: 0 });
  });

  it('NumPy の nearest との違い: [10,20,30,40], q=0.5 で nearest-rank は 20、h は 1.5', () => {
    expect(doc).toContain('numpy.percentile');
    expect(doc).toContain('nearest');
    expect(resolvePosition(4, 0.5, 'linear').frac).toBe(0.5);
    expect(exactQuantileSorted(data, 0.5, 'nearest-rank')).toBe(20);
    expect(doc).toContain('h = 1.5');
    expect(doc).toContain('x[2] = 30');
  });
});

describe('docs/core/error-metrics.md の例', () => {
  const doc = readDoc('error-metrics.md');

  it('絶対誤差と相対誤差: 推定値 22、厳密値 20 で 2 と 0.1', () => {
    expect(value(absoluteError(22, 20))).toBe(2);
    expect(value(relativeError(22, 20))).toBeCloseTo(0.1, 12);
    expect(doc).toContain('推定値22、厳密値20');
    expect(doc).toContain('絶対誤差は2');
    expect(doc).toContain('相対誤差は0.1');
  });

  it('データにない推定値: [10,20,30,40], q=0.5, 推定値 25 は順位誤差 0、35 は 0.25', () => {
    const d = sorted([10, 20, 30, 40]);
    expect(nearestRank(4, 0.5)).toBe(2);
    expect(value(rankError(d, 25, 0.5))).toBe(0);
    expect(value(rankError(d, 35, 0.5))).toBe(0.25);
    expect(doc).toContain('推定値25の順位は2');
    expect(doc).toContain('推定値35の順位は3');
    expect(doc).toContain('0.25');
  });

  it('同値がある場合: [10,20,20,20,30] の推定値 20 は q=0.5 で 0、q=0.9 で 0.2', () => {
    const d = sorted([10, 20, 20, 20, 30]);
    expect(nearestRank(5, 0.5)).toBe(3);
    expect(nearestRank(5, 0.9)).toBe(5);
    expect(value(rankError(d, 20, 0.5))).toBe(0);
    expect(value(rankError(d, 20, 0.9))).toBeCloseTo(0.2, 12);
    expect(doc).toContain('[10, 20, 20, 20, 30]');
    expect(doc).toContain('2番目から4番目');
    expect(doc).toContain('目標順位は3');
    expect(doc).toContain('目標順位は5');
    expect(doc).toContain('順位誤差は0.2');
  });
});
