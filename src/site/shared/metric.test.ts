import { describe, expect, it } from 'vitest';
import type { QueryRecord } from '../../core';
import { DEFAULT_ERROR_SELECTION, metricLabel, pickError } from './metric';

const rec = (quantile: number, absoluteError: number, rankError: number, relativeError: number): QueryRecord => ({
  quantile,
  estimate: 0,
  exact: 0,
  absoluteError,
  rankError,
  relativeError,
  operations: {} as QueryRecord['operations'],
  elapsedMs: 0,
});
const queries = [rec(0.5, 1.5, 0.01, 0.2), rec(0.99, 7.25, 0.003, 0.05), rec(0.9, 3, 0.02, 0.1)];

describe('誤差の選択(7.2, 7.7)', () => {
  it('個別の分位点は記録の値をそのまま返す', () => {
    expect(pickError(queries, { metric: 'absolute', pick: { kind: 'at', quantile: 0.99 } })).toBe(7.25);
    expect(pickError(queries, { metric: 'rank', pick: { kind: 'at', quantile: 0.5 } })).toBe(0.01);
    expect(pickError(queries, { metric: 'relative', pick: { kind: 'at', quantile: 0.9 } })).toBe(0.1);
  });
  it('最大は全分位点の最大', () => {
    expect(pickError(queries, { metric: 'absolute', pick: { kind: 'max' } })).toBe(7.25);
    expect(pickError(queries, { metric: 'rank', pick: { kind: 'max' } })).toBe(0.02);
    expect(pickError(queries, { metric: 'relative', pick: { kind: 'max' } })).toBe(0.2);
  });
  it('該当する分位点がなければ null', () => {
    expect(pickError(queries, { metric: 'rank', pick: { kind: 'at', quantile: 0.25 } })).toBeNull();
    expect(pickError([], { metric: 'rank', pick: { kind: 'max' } })).toBeNull();
  });
  it('既定は順位誤差・最大', () => {
    expect(DEFAULT_ERROR_SELECTION).toEqual({ metric: 'rank', pick: { kind: 'max' } });
  });
  it('指標の表示名', () => {
    expect(metricLabel('absolute')).toBe('絶対誤差');
    expect(metricLabel('rank')).toBe('順位誤差');
    expect(metricLabel('relative')).toBe('相対誤差');
  });
});
