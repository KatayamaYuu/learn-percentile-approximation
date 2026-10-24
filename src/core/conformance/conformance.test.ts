import { describe, expect, it } from 'vitest';
import type { ParamRecord, PercentileSketch, SketchSpec, SupportedRange } from '../contract/sketch';
import type { SketchError } from '../foundation/errors';
import { err, ok, type Result } from '../foundation/result';
import { sortExactSpec } from '../exact/sort-exact';
import { quickselectExactSpec } from '../exact/quickselect-exact';
import { runConformance } from './conformance';

interface Violations {
  acceptInvalid?: boolean;
  mutateOnError?: boolean;
  resetKeepsState?: boolean;
  zeroEstimate?: boolean;
  acceptOutOfRange?: boolean;
  rejectInRange?: boolean;
  throwOnInsert?: boolean;
  nondeterministic?: boolean;
  negativeMemory?: boolean;
  decreasingCounts?: boolean;
  acceptBadQuantile?: boolean;
  queryEmptyOk?: boolean;
}

function mockSketch(range: SupportedRange | undefined, v: Violations): PercentileSketch {
  let values: number[] = [];
  let comparisons = 0;
  let moves = 0;
  return {
    insert(value: number): Result<void, SketchError> {
      if (v.throwOnInsert) throw new Error('boom');
      const valid = typeof value === 'number' && Number.isFinite(value) && value > 0;
      if (!valid && !v.acceptInvalid) {
        if (v.mutateOnError) moves += 1;
        const reason = typeof value !== 'number' || Number.isNaN(value)
          ? 'not-a-number' as const
          : !Number.isFinite(value) ? 'not-finite' as const : 'not-positive' as const;
        return err({ kind: 'invalid-value', reason });
      }
      if (valid && range !== undefined && !v.acceptOutOfRange && (value < range.min || value > range.max)) {
        if (v.mutateOnError) moves += 1;
        return err({ kind: 'unsupported-value', detail: 'out of range' });
      }
      if (v.rejectInRange && values.length >= 3) {
        return err({ kind: 'unsupported-value', detail: 'in range but rejected' });
      }
      values.push(value);
      comparisons += 1;
      moves += 1;
      return ok(undefined);
    },
    query(quantile: number): Result<number, SketchError> {
      if (!v.acceptBadQuantile && !(quantile >= 0 && quantile <= 1)) {
        if (v.mutateOnError) moves += 1;
        return err({ kind: 'quantile-out-of-range' });
      }
      if (values.length === 0) {
        if (v.queryEmptyOk) return ok(1);
        return err({ kind: 'empty' });
      }
      if (v.zeroEstimate) return ok(0);
      const sorted = [...values].sort((a, b) => a - b);
      const q = Number.isFinite(quantile) ? Math.min(1, Math.max(0, quantile)) : 0;
      const base = sorted[Math.floor(q * (sorted.length - 1))]!;
      return ok(v.nondeterministic ? base * (1 + Math.random() * 1e-3) : base);
    },
    memoryBytes: () => (v.negativeMemory ? -1 : values.length * 8),
    operationCounts: () => ({
      comparisons: v.decreasingCounts ? 1000 - comparisons : comparisons,
      moves,
    }),
    reset() {
      if (v.resetKeepsState) return;
      values = [];
      comparisons = 0;
      moves = 0;
    },
  };
}

function mockSpec(
  v: Violations = {},
  range?: SupportedRange,
  params: ParamRecord | undefined = { epsilon: 0.01 },
): SketchSpec {
  return {
    id: 'mock',
    label: 'mock',
    ...(params !== undefined ? { params } : {}),
    ...(range !== undefined ? { supportedRange: range } : {}),
    create: () => mockSketch(range, v),
  };
}

function failedRequirements(spec: SketchSpec): string[] {
  return runConformance(spec).failures.map((f) => f.requirement);
}

describe('runConformance: 準拠する模擬実装', () => {
  it('範囲指定なしでは失敗が 0 件', () => {
    const report = runConformance(mockSpec());
    expect(report.specId).toBe('mock');
    expect(report.failures).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(c.id).not.toBe('');
      expect(c.requirement).toMatch(/^\d+\.\d+$/);
      expect(c.passed).toBe(true);
    }
  });

  it('範囲指定ありでも失敗が 0 件で、範囲外の確認が行われる', () => {
    const report = runConformance(mockSpec({}, { min: 10, max: 100 }));
    expect(report.failures).toEqual([]);
    expect(report.checks.some((c) => c.id === 'out-of-range-rejected' && c.passed)).toBe(true);
  });

  it('max が無限大の範囲でも失敗が 0 件', () => {
    expect(runConformance(mockSpec({}, { min: 5, max: Infinity })).failures).toEqual([]);
  });

  it('params なしでも失敗が 0 件', () => {
    expect(runConformance(mockSpec({}, undefined, undefined)).failures).toEqual([]);
  });

  it('設計に挙げた全要件 ID を確認項目に含む', () => {
    const ids = new Set(runConformance(mockSpec()).checks.map((c) => c.requirement));
    for (const r of ['1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '5.3', '5.4', '5.5', '6.3']) {
      expect(ids.has(r)).toBe(true);
    }
  });

  it('failures は checks の不合格だけを同じ順で含む', () => {
    const report = runConformance(mockSpec({ zeroEstimate: true }));
    expect(report.failures).toEqual(report.checks.filter((c) => !c.passed));
  });

  it('seed を指定しても同じ結果で、結果は JSON にできる', () => {
    const a = runConformance(mockSpec(), { seed: 7 });
    const b = runConformance(mockSpec(), { seed: 7 });
    expect(JSON.parse(JSON.stringify(a))).toEqual(b);
  });

  it('実装済みの厳密解 2 方式も規約に適合する', () => {
    expect(runConformance(sortExactSpec()).failures).toEqual([]);
    expect(runConformance(quickselectExactSpec()).failures).toEqual([]);
  });
});

describe('runConformance: 規約違反の模擬実装の検出', () => {
  it('不正値の受け入れ', () => {
    const f = failedRequirements(mockSpec({ acceptInvalid: true }));
    expect(f).toContain('1.5');
  });

  it('エラー時の状態変更(不正値)', () => {
    const report = runConformance(mockSpec({ mutateOnError: true }));
    expect(report.failures.some((c) => c.id === 'invalid-values-state-unchanged')).toBe(true);
    expect(report.failures.some((c) => c.id === 'quantile-out-of-range')).toBe(true);
  });

  it('初期化で戻さない', () => {
    expect(failedRequirements(mockSpec({ resetKeepsState: true }))).toContain('1.7');
  });

  it('推定値 0', () => {
    const f = failedRequirements(mockSpec({ zeroEstimate: true }));
    expect(f).toContain('1.3');
  });

  it('受け付け範囲の外の受け入れ', () => {
    const report = runConformance(mockSpec({ acceptOutOfRange: true }, { min: 10, max: 100 }));
    expect(report.failures.map((c) => c.id)).toContain('out-of-range-rejected');
  });

  it('受け付け範囲の内の値の拒否', () => {
    const report = runConformance(mockSpec({ rejectInRange: true }, { min: 10, max: 100 }));
    expect(report.failures.map((c) => c.id)).toContain('in-range-accepted');
  });

  it('NaN を含むパラメータ', () => {
    const report = runConformance(mockSpec({}, undefined, { epsilon: NaN }));
    expect(report.failures.map((c) => c.id)).toContain('params-json');
    expect(report.failures.find((c) => c.id === 'params-json')?.requirement).toBe('6.3');
  });

  it('範囲外の分位点の受け入れ', () => {
    expect(failedRequirements(mockSpec({ acceptBadQuantile: true }))).toContain('1.4');
  });

  it('空の状態での問い合わせの成功', () => {
    expect(failedRequirements(mockSpec({ queryEmptyOk: true }))).toContain('1.6');
  });

  it('同じシードで再現しない', () => {
    expect(failedRequirements(mockSpec({ nondeterministic: true }))).toContain('1.8');
  });

  it('操作数が単調増加でない', () => {
    expect(failedRequirements(mockSpec({ decreasingCounts: true }))).toContain('5.3');
  });

  it('メモリ見積もりが負', () => {
    expect(failedRequirements(mockSpec({ negativeMemory: true }))).toContain('5.5');
  });

  it('例外は失敗項目として報告され、報告自体は例外を投げない', () => {
    const report = runConformance(mockSpec({ throwOnInsert: true }));
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.some((c) => c.detail.includes('boom'))).toBe(true);
  });

  it('create が例外を投げても報告する', () => {
    const spec: SketchSpec = {
      id: 'broken',
      label: 'broken',
      create: () => {
        throw new Error('no create');
      },
    };
    const report = runConformance(spec);
    expect(report.specId).toBe('broken');
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.checks.length).toBeGreaterThan(0);
  });
});
