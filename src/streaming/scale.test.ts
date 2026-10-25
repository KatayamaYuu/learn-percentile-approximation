import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SCALE_FUNCTIONS, scaleLimit } from './scale';

describe('SCALE_FUNCTIONS', () => {
  it('k0、k1、k2 の 3 種を提供する', () => {
    expect([...SCALE_FUNCTIONS]).toEqual(['k0', 'k1', 'k2']);
  });
});

describe('scaleLimit: k0', () => {
  it('qLeft によらず「左端 + 2 ÷ 圧縮パラメータ」になる', () => {
    for (const qLeft of [0, 0.01, 0.25, 0.5, 0.75]) {
      expect(scaleLimit('k0', qLeft, 100, 1000)).toBeCloseTo(qLeft + 2 / 100, 12);
    }
  });

  it('1 で頭打ちになる', () => {
    expect(scaleLimit('k0', 0.99, 100, 1000)).toBe(1);
    expect(scaleLimit('k0', 1, 100, 1000)).toBe(1);
    expect(scaleLimit('k0', 0.5, 2, 1000)).toBe(1);
  });

  it('総件数に依存しない', () => {
    expect(scaleLimit('k0', 0.3, 50, 1)).toBe(scaleLimit('k0', 0.3, 50, 1_000_000));
  });
});

describe('scaleLimit: k1 と k2', () => {
  for (const kind of ['k1', 'k2'] as const) {
    it(`${kind}: 裾(0、0.01、0.99)の幅が中央(0.5)の幅より小さい`, () => {
      const width = (q: number): number => scaleLimit(kind, q, 100, 10_000) - q;
      const center = width(0.5);
      expect(center).toBeGreaterThan(0);
      for (const q of [0, 0.01, 0.99]) {
        expect(width(q)).toBeLessThan(center);
      }
    });

    it(`${kind}: 中央から離れるほど幅が小さくなる(左半分)`, () => {
      const width = (q: number): number => scaleLimit(kind, q, 100, 10_000) - q;
      expect(width(0.5)).toBeGreaterThan(width(0.2));
      expect(width(0.2)).toBeGreaterThan(width(0.05));
      expect(width(0.05)).toBeGreaterThan(width(0.001));
    });
  }

  it('k2 は左端 0 のとき 0 を返す', () => {
    expect(scaleLimit('k2', 0, 100, 10_000)).toBe(0);
    expect(scaleLimit('k2', 0, 100, 1)).toBe(0);
  });

  it('k1 は左端 0 のとき正の上限を返す(最小値の扱い)', () => {
    const limit = scaleLimit('k1', 0, 100, 10_000);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(0.01);
  });

  it('k1 の上限は k1(右端) − k1(左端) = 1 を満たす(手計算: δ = 100、qLeft = 0.5)', () => {
    // k1(0.5) = 0、k1^-1(1) = (sin(2π / 100) + 1) / 2
    expect(scaleLimit('k1', 0.5, 100, 1000)).toBeCloseTo((Math.sin((2 * Math.PI) / 100) + 1) / 2, 12);
  });

  it('k2 の上限は k2(右端) − k2(左端) = 1 を満たす', () => {
    const delta = 100;
    const total = 10_000;
    const z = 4 * Math.log(Math.max(total / delta, 1)) + 24;
    const k2 = (q: number): number => (delta / z) * Math.log(q / (1 - q));
    const qLeft = 0.3;
    const right = scaleLimit('k2', qLeft, delta, total);
    expect(k2(right) - k2(qLeft)).toBeCloseTo(1, 9);
  });

  it('k2 の正規化は総件数が圧縮パラメータより小さいとき下を抑える(総件数 1 と δ で同じ)', () => {
    expect(scaleLimit('k2', 0.4, 100, 1)).toBe(scaleLimit('k2', 0.4, 100, 100));
    expect(scaleLimit('k2', 0.4, 100, 100)).not.toBe(scaleLimit('k2', 0.4, 100, 100_000));
  });
});

describe('scaleLimit: 共通の性質', () => {
  it('左端 1 は常に 1 を返す', () => {
    for (const kind of SCALE_FUNCTIONS) {
      expect(scaleLimit(kind, 1, 100, 1000)).toBe(1);
    }
  });

  it('同じ入力から同じ値を返す', () => {
    for (const kind of SCALE_FUNCTIONS) {
      expect(scaleLimit(kind, 0.37, 80, 5000)).toBe(scaleLimit(kind, 0.37, 80, 5000));
    }
  });

  it('戻り値は常に有限で、左端以上 1 以下(fast-check、固定シード)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCALE_FUNCTIONS),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 10, max: 1000, noNaN: true }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (kind, qLeft, compression, total) => {
          const limit = scaleLimit(kind, qLeft, compression, total);
          expect(Number.isFinite(limit)).toBe(true);
          expect(limit).toBeGreaterThanOrEqual(qLeft);
          expect(limit).toBeLessThanOrEqual(1);
        },
      ),
      { seed: 20240601, numRuns: 500 },
    );
  });

  it('左端が極端に 1 に近くても範囲に収まる', () => {
    for (const kind of SCALE_FUNCTIONS) {
      for (const qLeft of [1 - Number.EPSILON, 1 - 1e-12, Number.MIN_VALUE, 1e-300]) {
        const limit = scaleLimit(kind, qLeft, 1000, 1_000_000);
        expect(limit).toBeGreaterThanOrEqual(qLeft);
        expect(limit).toBeLessThanOrEqual(1);
      }
    }
  });
});
