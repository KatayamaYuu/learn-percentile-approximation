import { describe, expect, it } from 'vitest';
import { generate, type Distribution, type GenerateSpec } from './generate';

const DISTS: readonly Distribution[] = [
  { kind: 'uniform', min: 1, max: 10 },
  { kind: 'normal', mean: 50, stdDev: 10 },
  { kind: 'lognormal', mu: 0, sigma: 1 },
  { kind: 'heavy-tail', scale: 1, shape: 1.5 },
  {
    kind: 'multimodal',
    modes: [
      { weight: 1, mean: 10, stdDev: 2 },
      { weight: 3, mean: 100, stdDev: 5 },
    ],
  },
];

function gen(spec: GenerateSpec): Float64Array {
  const r = generate(spec);
  if (!r.ok) throw new Error(`generate failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function errOf(spec: GenerateSpec) {
  const r = generate(spec);
  if (r.ok) throw new Error('expected error');
  return r.error;
}

describe('generate: 5分布の標本', () => {
  for (const distribution of DISTS) {
    it(`${distribution.kind}: 長さ count、全要素が有限の正の数`, () => {
      const v = gen({ distribution, count: 5000, seed: 1 });
      expect(v).toBeInstanceOf(Float64Array);
      expect(v.length).toBe(5000);
      for (const x of v) {
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThan(0);
      }
    });
  }

  it('一様は [min, max) に収まる', () => {
    const v = gen({ distribution: { kind: 'uniform', min: 2, max: 3 }, count: 5000, seed: 2 });
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThan(3);
    }
  });

  it('重い裾は scale 以上', () => {
    const v = gen({ distribution: { kind: 'heavy-tail', scale: 4, shape: 2 }, count: 5000, seed: 3 });
    for (const x of v) expect(x).toBeGreaterThanOrEqual(4);
  });

  it('正規: 平均が 0 に近くても 0 以下が出ない(棄却)', () => {
    const v = gen({ distribution: { kind: 'normal', mean: 0.1, stdDev: 5 }, count: 20000, seed: 4 });
    for (const x of v) expect(x).toBeGreaterThan(0);
  });

  it('多峰: 0 以下が出ない', () => {
    const v = gen({
      distribution: {
        kind: 'multimodal',
        modes: [
          { weight: 1, mean: 0.1, stdDev: 5 },
          { weight: 1, mean: 0.2, stdDev: 5 },
        ],
      },
      count: 20000,
      seed: 5,
    });
    for (const x of v) expect(x).toBeGreaterThan(0);
  });

  it('正規の標本平均・標準偏差が期待に近い', () => {
    const v = gen({ distribution: { kind: 'normal', mean: 100, stdDev: 5 }, count: 50000, seed: 6 });
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    expect(Math.abs(mean - 100)).toBeLessThan(0.2);
    expect(Math.abs(sd - 5)).toBeLessThan(0.2);
  });

  it('多峰は2つの山の周辺に標本が集まる', () => {
    const v = gen({ distribution: DISTS[4]!, count: 20000, seed: 7 });
    const low = v.filter((x) => x < 55).length / v.length;
    expect(Math.abs(low - 0.25)).toBeLessThan(0.02);
  });
});

describe('generate: 再現性と並び順', () => {
  for (const distribution of DISTS) {
    it(`${distribution.kind}: 同条件で完全一致、異なるシードで相違`, () => {
      const a = gen({ distribution, count: 200, seed: 11 });
      const b = gen({ distribution, count: 200, seed: 11 });
      const c = gen({ distribution, count: 200, seed: 12 });
      expect(Array.from(b)).toEqual(Array.from(a));
      expect(Array.from(c)).not.toEqual(Array.from(a));
    });
  }

  it('既定は random(生成順)で、order 指定なしと random が一致する', () => {
    const d = DISTS[1]!;
    expect(Array.from(gen({ distribution: d, count: 100, seed: 3 }))).toEqual(
      Array.from(gen({ distribution: d, count: 100, seed: 3, order: 'random' })),
    );
  });

  it('ascending / descending は random の並べ替えと一致する', () => {
    const d = DISTS[2]!;
    const base = Array.from(gen({ distribution: d, count: 300, seed: 9 })).sort((x, y) => x - y);
    expect(Array.from(gen({ distribution: d, count: 300, seed: 9, order: 'ascending' }))).toEqual(base);
    expect(Array.from(gen({ distribution: d, count: 300, seed: 9, order: 'descending' }))).toEqual(
      [...base].reverse(),
    );
  });

  it('random は整列済みではない', () => {
    const v = Array.from(gen({ distribution: DISTS[0]!, count: 100, seed: 1 }));
    expect(v).not.toEqual([...v].sort((a, b) => a - b));
  });

  it('count=1 が生成できる', () => {
    expect(gen({ distribution: DISTS[0]!, count: 1, seed: 0 }).length).toBe(1);
  });
});

describe('generate: エラー', () => {
  const d = DISTS[0]!;
  it('不正な件数は invalid-count', () => {
    for (const count of [0, -1, 1.5, NaN, Infinity, 10_000_001]) {
      expect(errOf({ distribution: d, count, seed: 1 })).toEqual({ kind: 'invalid-count' });
    }
  });

  it('不正なシードは invalid-seed', () => {
    for (const seed of [-1, 1.5, NaN, 2 ** 32]) {
      expect(errOf({ distribution: d, count: 10, seed })).toEqual({ kind: 'invalid-seed' });
    }
  });

  it('件数の上限 10,000,000 は検証を通る(境界)', () => {
    // 巨大生成は避け、上限ちょうどが invalid-count にならないことだけ確認する
    const r = generate({ distribution: d, count: 10_000_000, seed: 1 });
    expect(r.ok).toBe(true);
  });

  const bad: readonly [string, Distribution, string][] = [
    ['uniform min<=0', { kind: 'uniform', min: 0, max: 1 }, 'min'],
    ['uniform max<=min', { kind: 'uniform', min: 2, max: 2 }, 'max'],
    ['uniform NaN', { kind: 'uniform', min: NaN, max: 2 }, 'min'],
    ['uniform max Infinity', { kind: 'uniform', min: 1, max: Infinity }, 'max'],
    ['normal mean<=0', { kind: 'normal', mean: 0, stdDev: 1 }, 'mean'],
    ['normal stdDev<=0', { kind: 'normal', mean: 1, stdDev: 0 }, 'stdDev'],
    ['lognormal mu not finite', { kind: 'lognormal', mu: Infinity, sigma: 1 }, 'mu'],
    ['lognormal mu NaN', { kind: 'lognormal', mu: NaN, sigma: 1 }, 'mu'],
    ['lognormal sigma<=0', { kind: 'lognormal', mu: 0, sigma: -1 }, 'sigma'],
    ['heavy scale<=0', { kind: 'heavy-tail', scale: 0, shape: 1 }, 'scale'],
    ['heavy shape<=0', { kind: 'heavy-tail', scale: 1, shape: 0 }, 'shape'],
    ['multimodal 1 mode', { kind: 'multimodal', modes: [{ weight: 1, mean: 1, stdDev: 1 }] }, 'modes'],
    [
      'multimodal weight<=0',
      {
        kind: 'multimodal',
        modes: [
          { weight: 1, mean: 1, stdDev: 1 },
          { weight: 0, mean: 1, stdDev: 1 },
        ],
      },
      'modes[1].weight',
    ],
    [
      'multimodal mean<=0',
      {
        kind: 'multimodal',
        modes: [
          { weight: 1, mean: -1, stdDev: 1 },
          { weight: 1, mean: 1, stdDev: 1 },
        ],
      },
      'modes[0].mean',
    ],
  ];
  for (const [name, distribution, field] of bad) {
    it(`不正パラメータ: ${name}`, () => {
      const e = errOf({ distribution, count: 10, seed: 1 });
      expect(e.kind).toBe('invalid-parameter');
      if (e.kind === 'invalid-parameter') {
        expect(e.field).toBe(field);
        expect(e.reason.length).toBeGreaterThan(0);
      }
    });
  }

  it('未知の order は invalid-parameter(order)', () => {
    const e = errOf({ distribution: d, count: 10, seed: 1, order: 'sideways' as never });
    expect(e).toMatchObject({ kind: 'invalid-parameter', field: 'order' });
  });

  it('未知の kind は invalid-parameter(kind)', () => {
    const e = errOf({ distribution: { kind: 'zipf' } as never, count: 10, seed: 1 });
    expect(e).toMatchObject({ kind: 'invalid-parameter', field: 'kind' });
  });

  it('指数のあふれは non-finite-sample(部分列を返さない)', () => {
    const r = generate({ distribution: { kind: 'lognormal', mu: 1000, sigma: 1 }, count: 10, seed: 1 });
    expect(r).toEqual({ ok: false, error: { kind: 'non-finite-sample' } });
  });

  it('指数のアンダーフローは non-finite-sample', () => {
    const r = generate({ distribution: { kind: 'lognormal', mu: -1000, sigma: 1 }, count: 10, seed: 1 });
    expect(r).toEqual({ ok: false, error: { kind: 'non-finite-sample' } });
  });

  it('重い裾の極端な shape で無限大になれば non-finite-sample', () => {
    const r = generate({
      distribution: { kind: 'heavy-tail', scale: 1e300, shape: 0.001 },
      count: 10,
      seed: 1,
    });
    expect(r).toEqual({ ok: false, error: { kind: 'non-finite-sample' } });
  });
});
