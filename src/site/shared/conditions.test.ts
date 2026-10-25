import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPARE,
  DEFAULT_DATA,
  DEFAULT_HISTOGRAM,
  DEFAULT_RELATIVE,
  DEFAULT_STREAMING,
  DISTRIBUTION_PRESETS,
  PAGE_DEFAULTS,
} from './conditions';
import { COUNT_RANGE, DEFAULT_MAX_BUCKETS, SEED_RANGE, TRIALS_RANGE } from './limits';

describe('既定の条件(2.1、2.3、2.4)', () => {
  it('共通のデータ条件: 対数正規(0, 1)、件数 10,000、シード 1、順序 random', () => {
    expect(DEFAULT_DATA).toEqual({
      distribution: { kind: 'lognormal', mu: 0, sigma: 1 },
      count: 10_000,
      seed: 1,
      order: 'random',
    });
  });
  it('ヒストグラム', () => {
    expect(DEFAULT_HISTOGRAM.buckets).toBe(32);
    expect(DEFAULT_HISTOGRAM.schemes).toEqual(['equal', 'exponential']);
    expect(DEFAULT_HISTOGRAM.range).toEqual({ kind: 'data-extent' });
    expect(DEFAULT_HISTOGRAM.data).toEqual(DEFAULT_DATA);
  });
  it('ストリーミング', () => {
    expect(DEFAULT_STREAMING).toMatchObject({
      methods: ['gk', 'kll', 'tdigest'],
      epsilon: 0.01,
      k: 200,
      compression: 100,
      scales: ['k1'],
      trials: 1,
      inspectTarget: 'gk',
    });
  });
  it('相対誤差型', () => {
    expect(DEFAULT_RELATIVE).toMatchObject({
      methods: ['ddsketch', 'hdr'],
      alpha: 0.01,
      maxBuckets: DEFAULT_MAX_BUCKETS,
      significantDigits: 2,
      hdrRange: { kind: 'auto' },
      inspectTarget: 'ddsketch',
    });
  });
  it('横断比較: 厳密解(整列)・ヒストグラム(指数幅, 64)・GK・KLL・t-digest・DDSketch・HDR', () => {
    expect(DEFAULT_COMPARE.algorithms).toEqual([
      { kind: 'exact-sort' },
      { kind: 'histogram', scheme: 'exponential', buckets: 64 },
      { kind: 'gk', epsilon: 0.01 },
      { kind: 'kll', k: 200 },
      { kind: 'tdigest', compression: 100, scale: 'k1' },
      { kind: 'ddsketch', alpha: 0.01, maxBuckets: 2048 },
      { kind: 'hdr', significantDigits: 2 },
    ]);
    expect(DEFAULT_COMPARE.hdrRange).toEqual({ kind: 'auto' });
  });
  it('既定の件数・シード・試行は上限の範囲内で、すべて JSON に通る', () => {
    for (const d of Object.values(PAGE_DEFAULTS)) {
      expect(d.data.count).toBeGreaterThanOrEqual(COUNT_RANGE.min);
      expect(d.data.count).toBeLessThanOrEqual(COUNT_RANGE.max);
      expect(d.data.seed).toBeGreaterThanOrEqual(SEED_RANGE.min);
      expect(d.data.seed).toBeLessThanOrEqual(SEED_RANGE.max);
      expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    }
    expect(DEFAULT_STREAMING.trials).toBeGreaterThanOrEqual(TRIALS_RANGE.min);
    expect(Object.keys(PAGE_DEFAULTS).sort()).toEqual(['compare', 'histogram', 'relative', 'streaming']);
  });
});

describe('分布のプリセット(2.3)', () => {
  it('種類ごとの既定のパラメータ', () => {
    expect(DISTRIBUTION_PRESETS.uniform).toEqual({ kind: 'uniform', min: 1, max: 1000 });
    expect(DISTRIBUTION_PRESETS.normal).toEqual({ kind: 'normal', mean: 100, stdDev: 15 });
    expect(DISTRIBUTION_PRESETS.lognormal).toEqual({ kind: 'lognormal', mu: 0, sigma: 1 });
    expect(DISTRIBUTION_PRESETS['heavy-tail']).toEqual({ kind: 'heavy-tail', scale: 1, shape: 1.5 });
    expect(DISTRIBUTION_PRESETS.multimodal).toEqual({
      kind: 'multimodal',
      modes: [
        { weight: 1, mean: 50, stdDev: 5 },
        { weight: 1, mean: 200, stdDev: 20 },
      ],
    });
    expect(DEFAULT_DATA.distribution).toEqual(DISTRIBUTION_PRESETS.lognormal);
  });
});
