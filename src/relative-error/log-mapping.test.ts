import { describe, expect, it } from 'vitest';
import { OperationCounter } from '../core';
import { createLogMapping, type LogMapping } from './log-mapping';

function make(alpha: number): LogMapping {
  const r = createLogMapping(alpha);
  if (!r.ok) throw new Error('mapping');
  return r.value;
}

describe('createLogMapping: 設定', () => {
  it('α = 0.01 の γ は (1 + α) / (1 − α)', () => {
    const m = make(0.01);
    expect(m.gamma).toBeCloseTo(1.01 / 0.99, 14);
    expect(m.alpha).toBe(0.01);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['0', 0],
    ['負', -0.1],
    ['1', 1],
    ['1 超', 1.5],
    ['文字列', '0.01' as unknown as number],
    ['γ が 1 に丸められる極小', 1e-300],
  ])('不正な α(%s)は field がちょうど alpha の invalid-config', (_name, alpha) => {
    const r = createLogMapping(alpha);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid-config');
      expect(r.error.field).toBe('alpha');
      expect(r.error.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('indexOf と境界', () => {
  const samples = [1, 2, 3.7, 100, 100_000, 0.001, 1e-9, 1e9, 1e100, 1e-100, 1e300, 1e-300, 2 ** -1022];

  it.each([0.001, 0.01, 0.1, 0.5, 0.9])('α = %s: 任意の値で lowerBound(i) < x <= upperBound(i)', (alpha) => {
    const m = make(alpha);
    for (const x of samples) {
      const i = m.indexOf(x);
      expect(m.lowerBound(i)).toBeLessThan(x);
      expect(x).toBeLessThanOrEqual(m.upperBound(i));
    }
  });

  it('区間の両端で、代表値の相対誤差が α に一致する', () => {
    const m = make(0.01);
    for (const i of [-1000, -1, 0, 1, 50, 1000]) {
      const rep = m.representative(i);
      const upper = m.upperBound(i);
      const lower = m.lowerBound(i);
      expect(Math.abs(rep - upper) / upper).toBeCloseTo(0.01, 9);
      expect(Math.abs(rep - lower) / lower).toBeCloseTo(0.01, 9);
    }
  });

  it('区間内の任意の値で、代表値の相対誤差が α 以下', () => {
    const m = make(0.02);
    for (let x = 0.5; x < 5000; x *= 1.0137) {
      const rep = m.representative(m.indexOf(x));
      expect(Math.abs(rep - x) / x).toBeLessThanOrEqual(0.02 * (1 + 1e-9));
    }
  });

  it('正の最大値・正の最小値で番号が定まり、境界と代表値が有限の正の数', () => {
    const m = make(0.01);
    for (const x of [Number.MAX_VALUE, Number.MIN_VALUE]) {
      const i = m.indexOf(x);
      expect(m.lowerBound(i)).toBeLessThan(x);
      expect(x).toBeLessThanOrEqual(m.upperBound(i));
      for (const v of [m.upperBound(i), m.representative(i)]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      expect(Number.isFinite(m.lowerBound(i))).toBe(true);
      expect(m.lowerBound(i)).toBeGreaterThanOrEqual(0);
    }
    expect(m.upperBound(10 ** 6)).toBe(Number.MAX_VALUE);
    expect(m.representative(10 ** 6)).toBe(Number.MAX_VALUE);
    expect(m.representative(-(10 ** 6))).toBe(Number.MIN_VALUE);
  });

  it('γ の累乗そのものの値でも包含が成り立つ', () => {
    const m = make(0.05);
    for (let i = -300; i <= 300; i += 7) {
      const x = m.upperBound(i);
      const j = m.indexOf(x);
      expect(m.lowerBound(j)).toBeLessThan(x);
      expect(x).toBeLessThanOrEqual(m.upperBound(j));
      expect(Math.abs(j - i)).toBeLessThanOrEqual(1);
    }
  });

  it('桁を 10 倍するたびに番号が一定の幅だけ進む(値の比だけで決まる)', () => {
    const m = make(0.01);
    const step = Math.log(10) / Math.log(m.gamma);
    for (const x of [1, 3.3, 250]) {
      const d = m.indexOf(x * 1000) - m.indexOf(x);
      expect(Math.abs(d - 3 * step)).toBeLessThanOrEqual(1);
    }
  });
});

describe('補正の比較の数え方', () => {
  it('計数器があるときだけ数え、1 回の番号の計算は 3 回以下', () => {
    for (const alpha of [0.001, 0.01, 0.3]) {
      const m = make(alpha);
      const counter = new OperationCounter();
      let max = 0;
      for (let k = 0; k < 4000; k++) {
        const x = Math.exp((k - 2000) * 0.35) * (1 + (k % 7) * 0.013);
        const before = counter.snapshot().comparisons;
        m.indexOf(x, counter);
        const used = counter.snapshot().comparisons - before;
        max = Math.max(max, used);
        expect(used).toBeGreaterThanOrEqual(2);
      }
      expect(max).toBeLessThanOrEqual(3);
      expect(counter.snapshot().moves).toBe(0);
    }
  });

  it('計数器を渡さなくても動く', () => {
    expect(make(0.01).indexOf(5)).toBe(make(0.01).indexOf(5));
  });
});
