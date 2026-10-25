import { describe, expect, it } from 'vitest';
import { runConformance } from '../core';
import { histogramSpec } from './histogram';
import type { BucketScheme } from './boundaries';

const SCHEMES: readonly [string, BucketScheme][] = [
  ['等幅', { kind: 'equal', lower: 10, upper: 50, buckets: 4 }],
  ['指数幅', { kind: 'exponential', lower: 1, upper: 1024, buckets: 10 }],
  ['任意境界', { kind: 'custom', boundaries: [1, 2, 5, 10, 100] }],
  ['等幅(1バケット)', { kind: 'equal', lower: 3, upper: 4, buckets: 1 }],
  ['指数幅(多数のバケット)', { kind: 'exponential', lower: 0.001, upper: 1e9, buckets: 2000 }],
];

describe('共通規約の適合確認', () => {
  it.each(SCHEMES)('%s: 失敗が 0 件', (_name, scheme) => {
    const spec = histogramSpec(scheme);
    if (!spec.ok) throw new Error('spec');
    const report = runConformance(spec.value);
    expect(report.failures).toEqual([]);
    // 範囲外の拒否の確認も実際に行われている
    const outOfRange = report.checks.find((c) => c.id === 'out-of-range-rejected');
    expect(outOfRange?.passed).toBe(true);
    expect(outOfRange?.detail).not.toContain('対象外');
  });

  it('シードを変えても適合する', () => {
    const spec = histogramSpec(SCHEMES[0]![1]);
    if (!spec.ok) throw new Error('spec');
    expect(runConformance(spec.value, { seed: 123456 }).failures).toEqual([]);
  });
});
