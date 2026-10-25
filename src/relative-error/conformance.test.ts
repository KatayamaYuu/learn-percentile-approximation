import { describe, expect, it } from 'vitest';
import { runConformance, type SketchSpec } from '../core';
import { ddsketchSpec } from './ddsketch';
import { hdrSpec } from './hdr-histogram';

function spec(r: { ok: true; value: SketchSpec } | { ok: false }): SketchSpec {
  if (!r.ok) throw new Error('spec');
  return r.value;
}

const CASES: readonly [string, SketchSpec][] = [
  ['DDSketch(α=0.01, m=2048, 縮約なし)', spec(ddsketchSpec({ alpha: 0.01, maxBuckets: 2048 }))],
  ['DDSketch(α=0.01, m=8, 適合確認の入力で縮約が起きる)', spec(ddsketchSpec({ alpha: 0.01, maxBuckets: 8 }))],
  ['HDR(L=1, H=1000, d=1)', spec(hdrSpec({ lowest: 1, highest: 1000, significantDigits: 1 }))],
  ['HDR(L=1, H=1000, d=2)', spec(hdrSpec({ lowest: 1, highest: 1000, significantDigits: 2 }))],
  ['HDR(L=1, H=1000, d=3)', spec(hdrSpec({ lowest: 1, highest: 1000, significantDigits: 3 }))],
];

describe('共通規約の適合確認', () => {
  it.each(CASES)('%s: 失敗が 0 件', (_name, s) => {
    const report = runConformance(s);
    expect(report.failures).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('HDR は範囲外の拒否も実際に確かめられる', () => {
    const report = runConformance(CASES[3]![1]);
    const check = report.checks.find((c) => c.id === 'out-of-range-rejected');
    expect(check?.passed).toBe(true);
    expect(check?.detail).not.toContain('対象外');
  });

  it('シードを変えても適合する', () => {
    for (const [, s] of CASES) expect(runConformance(s, { seed: 987654 }).failures).toEqual([]);
  });
});
