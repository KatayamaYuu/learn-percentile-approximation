import { describe, expect, it } from 'vitest';
import { generate } from '../../core';
import {
  fromConfigError,
  fromExperimentError,
  fromGenerateError,
  fromHarnessError,
  histogramFieldMap,
  relativeFieldMap,
  streamingFieldMap,
} from './error-map';

describe('fromGenerateError (2.5)', () => {
  it('invalid-parameter は接頭辞つきの分布の項目に対応する', () => {
    expect(fromGenerateError({ kind: 'invalid-parameter', field: 'sigma', reason: 'σ は正' }, 'data.distribution')).toEqual({
      field: 'data.distribution.sigma',
      reason: 'σ は正',
    });
    expect(
      fromGenerateError({ kind: 'invalid-parameter', field: 'modes[1].stdDev', reason: 'x' }, 'data.distribution').field,
    ).toBe('data.distribution.modes[1].stdDev');
  });
  it('invalid-count と invalid-seed は件数とシードの項目に対応する', () => {
    expect(fromGenerateError({ kind: 'invalid-count' }, 'data.distribution').field).toBe('data.count');
    expect(fromGenerateError({ kind: 'invalid-seed' }, 'data.distribution').field).toBe('data.seed');
    expect(fromGenerateError({ kind: 'invalid-count' }, 'data.distribution').reason).not.toBe('');
  });
  it('non-finite-sample は分布の項目と日本語の理由になる', () => {
    const i = fromGenerateError({ kind: 'non-finite-sample' }, 'data.distribution');
    expect(i.field).toBe('data.distribution');
    expect(i.reason).toBe(
      'この分布のパラメータでは、正の有限の数にならない値ができました。パラメータ(σ など)を小さくしてください',
    );
  });
  it('実際の generate のエラー(sigma: -1、指数のあふれ)が対応する', () => {
    const r = generate({ distribution: { kind: 'lognormal', mu: 0, sigma: -1 }, count: 100, seed: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(fromGenerateError(r.error, 'data.distribution').field).toBe('data.distribution.sigma');
    const r2 = generate({ distribution: { kind: 'lognormal', mu: 0, sigma: 1e6 }, count: 100, seed: 1 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(fromGenerateError(r2.error, 'data.distribution').field).toBe('data.distribution');
  });
});

describe('fromHarnessError', () => {
  it('対応のないものは general の項目で、理由は空でない', () => {
    for (const e of [
      { kind: 'invalid-data', reason: 'empty' },
      { kind: 'invalid-quantile' },
      { kind: 'no-sketches' },
      { kind: 'invalid-params', field: 'x' },
    ] as const) {
      const i = fromHarnessError(e);
      expect(i.field).toBe('general');
      expect(i.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('相対誤差型の項目名の対応 (2.5, 6.4)', () => {
  const cfg = (field: string) => fromConfigError({ kind: 'invalid-config', field, reason: `r-${field}` }, relativeFieldMap);
  it('設定の 5 項目', () => {
    expect(cfg('alpha')).toEqual({ field: 'alpha', reason: 'r-alpha' });
    expect(cfg('maxBuckets').field).toBe('maxBuckets');
    expect(cfg('significantDigits').field).toBe('significantDigits');
    expect(cfg('lowest').field).toBe('hdrRange.lowest');
    expect(cfg('highest').field).toBe('hdrRange.highest');
  });
  const exp = (field: string) =>
    fromExperimentError({ kind: 'invalid-experiment', field, reason: `r-${field}` }, relativeFieldMap);
  it('実験の 6 項目', () => {
    expect(exp('alphas').field).toBe('alpha');
    expect(exp('maxBucketsList').field).toBe('maxBuckets');
    expect(exp('significantDigitsList').field).toBe('significantDigits');
    expect(exp('cases').field).toBe('general');
    expect(exp('counts').field).toBe('general');
    expect(exp('quantiles').field).toBe('general');
  });
  it('invalid-config は実験のエラーとしても設定の項目名で対応する', () => {
    expect(
      fromExperimentError({ kind: 'invalid-config', field: 'lowest', reason: 'x' }, relativeFieldMap).field,
    ).toBe('hdrRange.lowest');
  });
  it('完全一致だけ(接頭辞・添字つきや別名は general)', () => {
    expect(cfg('lower').field).toBe('general');
    expect(cfg('sketches[0].alpha').field).toBe('general');
  });
});

describe('他の系統の項目名の対応', () => {
  it('ストリーミング: sketches[i].項目 を設定の項目に', () => {
    const f = (field: string) =>
      fromExperimentError({ kind: 'invalid-config', field, reason: 'x' }, streamingFieldMap).field;
    expect(f('sketches[2].epsilon')).toBe('epsilon');
    expect(f('sketches[0].k')).toBe('k');
    expect(f('sketches[1].compression')).toBe('compression');
    expect(f('sketches[1].scale')).toBe('scales');
    expect(f('epsilon')).toBe('epsilon');
    expect(f('sketches[0].seed')).toBe('general');
    expect(f('orders')).toBe('general');
  });
  it('ヒストグラム: buckets / lower / upper', () => {
    const f = (field: string) =>
      fromExperimentError({ kind: 'invalid-scheme', field, reason: 'x' }, histogramFieldMap).field;
    expect(f('buckets')).toBe('buckets');
    expect(f('lower')).toBe('range.lower');
    expect(f('upper')).toBe('range.upper');
    expect(f('boundaries')).toBe('general');
  });
  it('generate / harness の実験エラーは対応する項目になる', () => {
    expect(
      fromExperimentError({ kind: 'generate', error: { kind: 'invalid-seed' } }, relativeFieldMap).field,
    ).toBe('data.seed');
    expect(
      fromExperimentError({ kind: 'generate', error: { kind: 'non-finite-sample' } }, relativeFieldMap).field,
    ).toBe('data.distribution');
    expect(
      fromExperimentError({ kind: 'harness', error: { kind: 'no-sketches' } }, relativeFieldMap).field,
    ).toBe('general');
  });
});
