import { describe, expect, it } from 'vitest';
import { formatBytes, formatInt, formatSig3 } from './format';

describe('数値の書式(7.8)', () => {
  it('有効数字 3 桁', () => {
    expect(formatSig3(0.012345)).toBe('0.0123');
    expect(formatSig3(1234.5)).toBe('1230');
    expect(formatSig3(1.5)).toBe('1.5');
    expect(formatSig3(-0.012345)).toBe('-0.0123');
  });
  it('0 は 0', () => {
    expect(formatSig3(0)).toBe('0');
  });
  it('小さい値と大きい値は指数表記', () => {
    expect(formatSig3(1.23456e-5)).toBe('1.23e-5');
    expect(formatSig3(1234567)).toBe('1.23e6');
    expect(formatSig3(1e6)).toBe('1.00e6');
    expect(formatSig3(999999)).toBe('1.00e6');
    expect(formatSig3(-1.23456e-5)).toBe('-1.23e-5');
  });
  it('境界: 1e-4 は通常表記', () => {
    expect(formatSig3(0.0001)).toBe('0.0001');
  });
  it('有限でない値はそのまま文字にする', () => {
    expect(formatSig3(Number.NaN)).toBe('NaN');
    expect(formatSig3(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
  it('桁区切りの整数', () => {
    expect(formatInt(1_000_000)).toBe('1,000,000');
    expect(formatInt(999)).toBe('999');
    expect(formatInt(1234)).toBe('1,234');
    expect(formatInt(0)).toBe('0');
    expect(formatInt(-1234567)).toBe('-1,234,567');
  });
  it('バイトは桁区切り + バイト', () => {
    expect(formatBytes(1_048_576)).toBe('1,048,576 バイト');
  });
});
