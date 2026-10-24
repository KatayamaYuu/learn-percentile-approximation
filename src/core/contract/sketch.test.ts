import { describe, expect, it } from 'vitest';
import { OperationCounter } from '../cost/op-counter';
import { estimateBytes } from '../cost/memory-model';
import { err, ok } from '../foundation/result';
import type { Result } from '../foundation/result';
import type { SketchError } from '../foundation/errors';
import { checkPositiveFinite, isQuantile } from '../foundation/validation';
import { isParamRecord } from './sketch';
import type { ParamRecord, PercentileSketch, SketchSpec, SupportedRange } from './sketch';

describe('isParamRecord', () => {
  it('有限の数・文字列・真偽値だけの記録を受け入れる', () => {
    expect(isParamRecord({})).toBe(true);
    expect(isParamRecord({ eps: 0.01, name: 'a', flag: false, zero: 0, neg: -1.5 })).toBe(true);
  });
  it('NaN と ±無限大を拒否する', () => {
    expect(isParamRecord({ a: Number.NaN })).toBe(false);
    expect(isParamRecord({ a: Infinity })).toBe(false);
    expect(isParamRecord({ a: -Infinity })).toBe(false);
  });
  it('入れ子の値(オブジェクト・配列)を拒否する', () => {
    expect(isParamRecord({ a: { b: 1 } })).toBe(false);
    expect(isParamRecord({ a: [1, 2] })).toBe(false);
  });
  it('null・undefined・関数・bigint・symbol の値を拒否する', () => {
    for (const v of [null, undefined, () => 1, 1n, Symbol('s')]) {
      expect(isParamRecord({ a: v })).toBe(false);
    }
  });
  it('記録そのものがオブジェクトでなければ拒否する', () => {
    for (const v of [null, undefined, 1, 'x', true, [1], [] ]) {
      expect(isParamRecord(v)).toBe(false);
    }
  });
  it('1 つでも不正な値があれば拒否する', () => {
    expect(isParamRecord({ ok: 1, bad: Number.NaN })).toBe(false);
  });
});

// 契約を満たす最小の模擬実装。型チェック(npm run typecheck)が契約への適合を確かめる。
function createMock(_seed: number): PercentileSketch {
  const counter = new OperationCounter();
  let values: number[] = [];
  return {
    insert(value: number): Result<void, SketchError> {
      const reason = checkPositiveFinite(value);
      if (reason !== undefined) return err({ kind: 'invalid-value', reason });
      values.push(value);
      counter.move();
      return ok(undefined);
    },
    query(quantile: number): Result<number, SketchError> {
      if (!isQuantile(quantile)) return err({ kind: 'quantile-out-of-range' });
      if (values.length === 0) return err({ kind: 'empty' });
      return ok(values[values.length - 1] as number);
    },
    memoryBytes: () => estimateBytes({ numbers: values.length, counters: 0 }),
    operationCounts: () => counter.snapshot(),
    reset(): void {
      values = [];
      counter.reset();
    },
  };
}

describe('SketchSpec の模擬実装', () => {
  const params: ParamRecord = { definition: 'type7' };
  const supportedRange: SupportedRange = { min: 1, max: Infinity };
  const spec: SketchSpec = { id: 'mock', label: 'Mock', params, supportedRange, create: createMock };
  const minimal: SketchSpec = { id: 'min', label: 'Min', create: createMock };

  it('params と supportedRange は省略できる', () => {
    expect(minimal.params).toBeUndefined();
    expect(isParamRecord(spec.params)).toBe(true);
  });
  it('契約の操作が動く', () => {
    const s = spec.create(1);
    expect(s.query(0.5)).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(s.insert(3)).toEqual({ ok: true, value: undefined });
    expect(s.insert(Number.NaN).ok).toBe(false);
    expect(s.query(0.5)).toEqual({ ok: true, value: 3 });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 1 });
    expect(s.memoryBytes()).toBeGreaterThan(0);
    s.reset();
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.query(0.5).ok).toBe(false);
  });
});
