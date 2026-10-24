import { describe, expect, it } from 'vitest';
import type { SketchError } from './errors';
import { checkPositiveFinite, isQuantile } from './validation';

describe('checkPositiveFinite', () => {
  it('数値でない値は not-a-number', () => {
    for (const v of ['1', null, undefined, {}, true, 1n] as unknown[]) {
      expect(checkPositiveFinite(v as number)).toBe('not-a-number');
    }
  });
  it('NaN は not-a-number', () => {
    expect(checkPositiveFinite(Number.NaN)).toBe('not-a-number');
  });
  it('±Infinity は not-finite', () => {
    expect(checkPositiveFinite(Infinity)).toBe('not-finite');
    expect(checkPositiveFinite(-Infinity)).toBe('not-finite');
  });
  it('0、-0、負の値は not-positive', () => {
    expect(checkPositiveFinite(0)).toBe('not-positive');
    expect(checkPositiveFinite(-0)).toBe('not-positive');
    expect(checkPositiveFinite(-1)).toBe('not-positive');
    expect(checkPositiveFinite(-Number.MIN_VALUE)).toBe('not-positive');
    expect(checkPositiveFinite(-Number.MAX_VALUE)).toBe('not-positive');
  });
  it('正の最小値と正の有限値は undefined', () => {
    expect(checkPositiveFinite(Number.MIN_VALUE)).toBeUndefined();
    expect(checkPositiveFinite(1)).toBeUndefined();
    expect(checkPositiveFinite(Number.MAX_VALUE)).toBeUndefined();
  });
});

describe('isQuantile', () => {
  it('0 と 1 を含む閉区間を受け付ける', () => {
    expect(isQuantile(0)).toBe(true);
    expect(isQuantile(1)).toBe(true);
    expect(isQuantile(0.5)).toBe(true);
    expect(isQuantile(Number.MIN_VALUE)).toBe(true);
    expect(isQuantile(1 - Number.EPSILON / 2)).toBe(true);
  });
  it('境界の直前直後を拒否する', () => {
    expect(isQuantile(-Number.MIN_VALUE)).toBe(false);
    expect(isQuantile(-Number.EPSILON)).toBe(false);
    expect(isQuantile(1 + Number.EPSILON)).toBe(false);
  });
  it('NaN、無限大、数値でない値を拒否する', () => {
    expect(isQuantile(Number.NaN)).toBe(false);
    expect(isQuantile(Infinity)).toBe(false);
    expect(isQuantile(-Infinity)).toBe(false);
    expect(isQuantile('0.5' as unknown as number)).toBe(false);
    expect(isQuantile(null as unknown as number)).toBe(false);
  });
});

describe('errors', () => {
  it('SketchError は invalid-value と unsupported-value を区別する', () => {
    const a: SketchError = { kind: 'invalid-value', reason: 'not-positive' };
    const b: SketchError = { kind: 'unsupported-value', detail: '追跡上限を超える' };
    expect(a.kind).not.toBe(b.kind);
  });
});
