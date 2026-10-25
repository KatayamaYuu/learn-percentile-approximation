import { describe, expect, it } from 'vitest';
import { runConformance, type SketchSpec } from '../core';
import { gkSpec, kllSpec, tdigestSpec, type ScaleFunctionKind } from './index';

function unwrap(
  r: { readonly ok: true; readonly value: SketchSpec } | { readonly ok: false; readonly error: unknown },
) {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

const SCALES: readonly ScaleFunctionKind[] = ['k0', 'k1', 'k2'];

const SPECS: readonly [string, SketchSpec][] = [
  ['GK(ε=0.01)', unwrap(gkSpec({ epsilon: 0.01 }))],
  ['GK(ε=0.1)', unwrap(gkSpec({ epsilon: 0.1 }))],
  ['KLL(k=8)', unwrap(kllSpec({ k: 8 }))],
  ['KLL(k=200)', unwrap(kllSpec({ k: 200 }))],
  ...SCALES.map((scale): [string, SketchSpec] => [
    `t-digest(${scale}、圧縮パラメータ 100)`,
    unwrap(tdigestSpec({ compression: 100, scale })),
  ]),
];

describe('共通規約の適合確認(4.1、4.2、4.3)', () => {
  it.each(SPECS)('%s: 適合確認の失敗が 0 件', (_name, spec) => {
    const report = runConformance(spec);
    expect(report.specId).toBe(spec.id);
    expect(report.failures).toEqual([]);
    // 確認が実際に行われている(空の報告で通らない)
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it.each(SPECS)('%s: 範囲の制限がないので、範囲外の拒否は対象外として扱われる', (_name, spec) => {
    expect(spec.supportedRange).toBeUndefined();
    const report = runConformance(spec);
    const outOfRange = report.checks.find((c) => c.id === 'out-of-range-rejected');
    expect(outOfRange?.passed).toBe(true);
    expect(outOfRange?.detail).toContain('対象外');
  });

  it.each(SPECS)('%s: シードを変えても適合する', (_name, spec) => {
    for (const seed of [2, 123456, 4294967295]) {
      expect(runConformance(spec, { seed }).failures).toEqual([]);
    }
  });
});
