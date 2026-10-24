import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from './sfc32';

function rngOf(seed: number) {
  const r = createRng(seed);
  if (!r.ok) throw new Error(`seed ${seed} should be valid`);
  return r.value;
}

function take(seed: number, n: number): number[] {
  const rng = rngOf(seed);
  return Array.from({ length: n }, () => rng.nextUint32());
}

// 値は scratchpad の独立実装(BigInt による sfc32 + splitmix32 風の混合、先頭 20 個を読み捨て)で生成した。
// 変更する場合は Revalidation Trigger(保存済み実験結果の再現性)として扱う。
const KNOWN_ANSWERS: ReadonlyArray<readonly [number, readonly number[]]> = [
  [0, [3083645593, 1030014670, 3464028545, 2769111392, 4034009536, 1796878516, 597020653, 3103222862]],
  [1, [1114091683, 537224786, 304035747, 1473068338, 2851761308, 172725270, 2398780572, 2976905664]],
  [42, [1996320479, 4256360589, 940062293, 3091916026, 1511325046, 4212796011, 1817745215, 4241329994]],
  [
    4294967295,
    [3381085414, 263921504, 3355230973, 4018407827, 3417630785, 191403142, 3215541180, 3587641905],
  ],
];

describe('createRng: シードの検証', () => {
  it.each([0, 1, 42, 2 ** 32 - 1])('シード %s を受け付ける', (seed) => {
    expect(createRng(seed).ok).toBe(true);
  });
  it.each([-1, 2 ** 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5])(
    'シード %s は invalid-seed',
    (seed) => {
      expect(createRng(seed)).toEqual({ ok: false, error: { kind: 'invalid-seed' } });
    },
  );
  it('number 以外は invalid-seed', () => {
    expect(createRng('1' as unknown as number)).toEqual({ ok: false, error: { kind: 'invalid-seed' } });
  });
});

describe('known-answer', () => {
  it.each(KNOWN_ANSWERS)('シード %s の先頭 8 個が固定されている', (seed, expected) => {
    expect(take(seed, 8)).toEqual(expected);
  });
  it('nextFloat は nextUint32 / 2^32、nextFloatOpen は (nextUint32 + 1) / 2^32', () => {
    const f = rngOf(1);
    expect(f.nextFloat()).toBe(1114091683 / 2 ** 32);
    const o = rngOf(1);
    expect(o.nextFloatOpen()).toBe((1114091683 + 1) / 2 ** 32);
  });
});

describe('再現性と相違', () => {
  it('同じシードは同じ列', () => {
    expect(take(7, 100)).toEqual(take(7, 100));
  });
  it('異なるシードは異なる列', () => {
    expect(take(7, 16)).not.toEqual(take(8, 16));
    expect(take(0, 16)).not.toEqual(take(1, 16));
  });
  it('同じシードの独立した生成器は互いに影響しない', () => {
    const a = rngOf(5);
    const b = rngOf(5);
    a.nextUint32();
    a.nextUint32();
    expect(b.nextUint32()).toBe(take(5, 1)[0]);
  });
});

describe('範囲の性質', () => {
  it('nextUint32 は 0 以上 2^32 未満の整数', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
        for (const x of take(seed, 20)) {
          expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
        }
      }),
      { seed: 20260101, numRuns: 100 },
    );
  });
  it('nextFloat は [0, 1)、nextFloatOpen は (0, 1]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
        const rng = rngOf(seed);
        for (let i = 0; i < 50; i++) {
          const f = rng.nextFloat();
          expect(f >= 0 && f < 1).toBe(true);
          const g = rng.nextFloatOpen();
          expect(g > 0 && g <= 1).toBe(true);
        }
      }),
      { seed: 20260102, numRuns: 100 },
    );
  });
  it('nextIntBelow は [0, bound) の整数', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.integer({ min: 1, max: 2 ** 32 }),
        (seed, bound) => {
          const rng = rngOf(seed);
          for (let i = 0; i < 20; i++) {
            const x = rng.nextIntBelow(bound);
            expect(Number.isInteger(x) && x >= 0 && x < bound).toBe(true);
          }
        },
      ),
      { seed: 20260103, numRuns: 100 },
    );
  });
  it('bound = 1 は常に 0', () => {
    const rng = rngOf(3);
    for (let i = 0; i < 10; i++) expect(rng.nextIntBelow(1)).toBe(0);
  });
  it('nextIntBelow(6) は全ての目が出て、偏りが極端でない', () => {
    const rng = rngOf(99);
    const c = new Array<number>(6).fill(0);
    for (let i = 0; i < 6000; i++) {
      const k = rng.nextIntBelow(6);
      c[k] = (c[k] ?? 0) + 1;
    }
    for (const n of c) expect(n).toBeGreaterThan(800);
  });
  it('bound が範囲外なら RangeError', () => {
    const rng = rngOf(1);
    for (const b of [0, -1, 1.5, 2 ** 32 + 1, Number.NaN]) {
      expect(() => rng.nextIntBelow(b)).toThrow(RangeError);
    }
  });
});
