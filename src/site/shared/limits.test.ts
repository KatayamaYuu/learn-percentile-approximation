import { describe, expect, it } from 'vitest';
import { MAX_BUCKETS } from '../../histogram';
import { MAX_DD_BUCKETS, DEFAULT_MAX_BUCKETS, MAX_HDR_BUCKETS } from '../../relative-error';
import { COMPRESSION_RANGE, EPSILON_RANGE, K_RANGE, SCALE_FUNCTIONS } from '../../streaming';
import {
  ALPHA_BOUNDS,
  COUNT_RANGE,
  SEED_RANGE,
  SIGNIFICANT_DIGITS_RANGE,
  TRIALS_RANGE,
  UPSTREAM_COPY,
  WORK_LIMIT,
} from './limits';

describe('サイトの上限(2.1、2.3、2.4)', () => {
  it('件数・シード・試行・計算量の上限は設計の値である', () => {
    expect(COUNT_RANGE).toEqual({ min: 100, max: 1_000_000 });
    expect(SEED_RANGE).toEqual({ min: 0, max: 2 ** 32 - 1 });
    expect(TRIALS_RANGE).toEqual({ min: 1, max: 10 });
    expect(WORK_LIMIT).toBe(40_000_000);
    expect(SIGNIFICANT_DIGITS_RANGE).toEqual({ min: 0, max: 5 });
    expect(ALPHA_BOUNDS).toEqual({ exclusiveMin: 0, exclusiveMax: 1 });
  });
});

describe('上流の定数の書き写しが上流の公開入口の値と等しい(11.5)', () => {
  it('ε・k・圧縮度・尺度関数', () => {
    expect(UPSTREAM_COPY.EPSILON_RANGE).toEqual(EPSILON_RANGE);
    expect(UPSTREAM_COPY.K_RANGE).toEqual(K_RANGE);
    expect(UPSTREAM_COPY.COMPRESSION_RANGE).toEqual(COMPRESSION_RANGE);
    expect(UPSTREAM_COPY.SCALE_FUNCTIONS).toEqual(SCALE_FUNCTIONS);
  });
  it('バケット数の上限と既定値', () => {
    expect(UPSTREAM_COPY.MAX_BUCKETS).toBe(MAX_BUCKETS);
    expect(UPSTREAM_COPY.DEFAULT_MAX_BUCKETS).toBe(DEFAULT_MAX_BUCKETS);
    expect(UPSTREAM_COPY.MAX_DD_BUCKETS).toBe(MAX_DD_BUCKETS);
    expect(UPSTREAM_COPY.MAX_HDR_BUCKETS).toBe(MAX_HDR_BUCKETS);
  });
  it('個別の export も同じ値を指す', async () => {
    const m = await import('./limits');
    expect(m.EPSILON_RANGE).toEqual(EPSILON_RANGE);
    expect(m.K_RANGE).toEqual(K_RANGE);
    expect(m.COMPRESSION_RANGE).toEqual(COMPRESSION_RANGE);
    expect(m.SCALE_FUNCTIONS).toEqual(SCALE_FUNCTIONS);
    expect(m.MAX_BUCKETS).toBe(MAX_BUCKETS);
    expect(m.DEFAULT_MAX_BUCKETS).toBe(DEFAULT_MAX_BUCKETS);
    expect(m.MAX_DD_BUCKETS).toBe(MAX_DD_BUCKETS);
    expect(m.MAX_HDR_BUCKETS).toBe(MAX_HDR_BUCKETS);
  });
});
