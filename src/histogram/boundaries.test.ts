import { describe, expect, it } from 'vitest';
import { MAX_BUCKETS, buildBoundaries, type BucketScheme } from './boundaries';

function build(scheme: BucketScheme): Float64Array {
  const r = buildBoundaries(scheme);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function fieldOf(scheme: unknown): string {
  const r = buildBoundaries(scheme as BucketScheme);
  if (r.ok) throw new Error('expected an error');
  expect(r.error.kind).toBe('invalid-scheme');
  return r.error.field;
}

describe('等幅', () => {
  it('先頭と末尾が指定値で、幅が一定', () => {
    const b = build({ kind: 'equal', lower: 10, upper: 50, buckets: 4 });
    expect(Array.from(b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('1バケットなら下限と上限だけ', () => {
    expect(Array.from(build({ kind: 'equal', lower: 1, upper: 2, buckets: 1 }))).toEqual([1, 2]);
  });

  it('割り切れない幅でも端点は指定値そのもので、狭義単調増加', () => {
    const b = build({ kind: 'equal', lower: 0.1, upper: 0.7, buckets: 7 });
    expect(b.length).toBe(8);
    expect(b[0]).toBe(0.1);
    expect(b[7]).toBe(0.7);
    for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThan(b[i - 1]!);
  });
});

describe('指数幅', () => {
  it('先頭と末尾が指定値で、隣り合う境界の比が一定', () => {
    const b = build({ kind: 'exponential', lower: 1, upper: 1024, buckets: 10 });
    expect(b.length).toBe(11);
    expect(b[0]).toBe(1);
    expect(b[10]).toBe(1024);
    for (let i = 1; i < b.length; i++) {
      expect(b[i]! / b[i - 1]!).toBeCloseTo(2, 10);
    }
  });

  it('比がオーバーフローするほど広い範囲でも有限の境界を作る', () => {
    const b = build({ kind: 'exponential', lower: 1e-300, upper: 1e300, buckets: 4 });
    for (const x of b) expect(Number.isFinite(x) && x > 0).toBe(true);
    expect(b[0]).toBe(1e-300);
    expect(b[4]).toBe(1e300);
  });
});

describe('任意境界', () => {
  it('指定の列をそのまま使い、複製して保持する', () => {
    const src = [1, 2, 5, 10];
    const b = build({ kind: 'custom', boundaries: src });
    expect(Array.from(b)).toEqual([1, 2, 5, 10]);
    src[0] = 99;
    expect(b[0]).toBe(1);
  });

  it('境界が2個ならバケットは1つ', () => {
    expect(build({ kind: 'custom', boundaries: [3, 4] }).length).toBe(2);
  });
});

describe('不正な指定', () => {
  it('等幅・指数幅の下限と上限が有限の正の数でない', () => {
    for (const kind of ['equal', 'exponential'] as const) {
      for (const bad of [0, -1, NaN, Infinity, '1']) {
        expect(fieldOf({ kind, lower: bad, upper: 10, buckets: 4 })).toBe('lower');
        expect(fieldOf({ kind, lower: 1, upper: bad, buckets: 4 })).toBe('upper');
      }
    }
  });

  it('下限が上限以上', () => {
    for (const kind of ['equal', 'exponential'] as const) {
      expect(fieldOf({ kind, lower: 5, upper: 5, buckets: 4 })).toBe('upper');
      expect(fieldOf({ kind, lower: 6, upper: 5, buckets: 4 })).toBe('upper');
    }
  });

  it('バケット数が1以上かつ上限以下の整数でない', () => {
    for (const kind of ['equal', 'exponential'] as const) {
      for (const bad of [0, -1, 1.5, NaN, Infinity, MAX_BUCKETS + 1, '4']) {
        expect(fieldOf({ kind, lower: 1, upper: 10, buckets: bad })).toBe('buckets');
      }
    }
  });

  it('バケット数の上限ちょうどは受け付ける', () => {
    const b = build({ kind: 'equal', lower: 1, upper: 2, buckets: MAX_BUCKETS });
    expect(b.length).toBe(MAX_BUCKETS + 1);
  });

  it('丸めで隣り合う境界が区別できない', () => {
    expect(fieldOf({ kind: 'equal', lower: 1, upper: 1 + Number.EPSILON, buckets: 4 })).toBe('buckets');
    expect(fieldOf({ kind: 'exponential', lower: 1, upper: 1 + Number.EPSILON, buckets: 4 })).toBe('buckets');
  });

  it('任意境界が2個未満', () => {
    expect(fieldOf({ kind: 'custom', boundaries: [] })).toBe('boundaries');
    expect(fieldOf({ kind: 'custom', boundaries: [1] })).toBe('boundaries');
  });

  it('任意境界が配列でない', () => {
    expect(fieldOf({ kind: 'custom', boundaries: 'abc' })).toBe('boundaries');
    expect(fieldOf({ kind: 'custom' })).toBe('boundaries');
  });

  it('任意境界に有限の正の数でない値がある', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(fieldOf({ kind: 'custom', boundaries: [1, bad, 3] })).toBe('boundaries');
    }
  });

  it('任意境界が狭義単調増加でない', () => {
    expect(fieldOf({ kind: 'custom', boundaries: [1, 3, 2] })).toBe('boundaries');
    expect(fieldOf({ kind: 'custom', boundaries: [1, 2, 2, 3] })).toBe('boundaries');
  });

  it('任意境界のバケット数が上限を超える', () => {
    const boundaries = Array.from({ length: MAX_BUCKETS + 2 }, (_, i) => i + 1);
    expect(fieldOf({ kind: 'custom', boundaries })).toBe('boundaries');
  });

  it('未知の種類', () => {
    expect(fieldOf({ kind: 'log', lower: 1, upper: 2, buckets: 2 })).toBe('kind');
    expect(fieldOf(null)).toBe('kind');
  });
});
