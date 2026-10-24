import type { GenerateError } from '../foundation/errors';
import { err, ok, type Result } from '../foundation/result';
import { checkPositiveFinite } from '../foundation/validation';
import type { Rng } from '../rng/sfc32';

export interface Mode {
  readonly weight: number;
  readonly mean: number;
  readonly stdDev: number;
}

export type Distribution =
  | { readonly kind: 'uniform'; readonly min: number; readonly max: number }
  | { readonly kind: 'normal'; readonly mean: number; readonly stdDev: number }
  | { readonly kind: 'lognormal'; readonly mu: number; readonly sigma: number }
  | { readonly kind: 'heavy-tail'; readonly scale: number; readonly shape: number }
  | { readonly kind: 'multimodal'; readonly modes: readonly Mode[] };

type ParamError = Extract<GenerateError, { kind: 'invalid-parameter' }>;

const REASON_TEXT = {
  'not-a-number': '数値ではありません',
  'not-finite': '有限の数ではありません',
  'not-positive': '0 より大きい必要があります',
} as const;

function bad(field: string, reason: string): ParamError {
  return { kind: 'invalid-parameter', field, reason };
}

function checkPositive(field: string, value: number): ParamError | undefined {
  const r = checkPositiveFinite(value);
  return r === undefined ? undefined : bad(field, REASON_TEXT[r]);
}

function checkFinite(field: string, value: number): ParamError | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return bad(field, '有限の数である必要があります');
  }
  return undefined;
}

/** パラメータが設計の条件を満たすか検査する。問題があれば最初の1件を返す。 */
export function validateDistribution(d: Distribution): ParamError | undefined {
  switch (d.kind) {
    case 'uniform': {
      const e = checkPositive('min', d.min) ?? checkPositive('max', d.max);
      if (e) return e;
      if (!(d.max > d.min)) return bad('max', 'min より大きい必要があります');
      return undefined;
    }
    case 'normal':
      return checkPositive('mean', d.mean) ?? checkPositive('stdDev', d.stdDev);
    case 'lognormal':
      return checkFinite('mu', d.mu) ?? checkPositive('sigma', d.sigma);
    case 'heavy-tail':
      return checkPositive('scale', d.scale) ?? checkPositive('shape', d.shape);
    case 'multimodal': {
      if (!Array.isArray(d.modes) || d.modes.length < 2) {
        return bad('modes', '2 個以上の山が必要です');
      }
      for (let i = 0; i < d.modes.length; i++) {
        const m = d.modes[i]!;
        const e =
          checkPositive(`modes[${i}].weight`, m.weight) ??
          checkPositive(`modes[${i}].mean`, m.mean) ??
          checkPositive(`modes[${i}].stdDev`, m.stdDev);
        if (e) return e;
      }
      // 重みの合計があふれると正規化できない
      const total = d.modes.reduce((s, m) => s + m.weight, 0);
      if (!Number.isFinite(total)) return bad('modes', '重みの合計が有限ではありません');
      return undefined;
    }
    default:
      return bad('kind', '未知の分布です');
  }
}

/** 標準正規乱数(Box-Muller 法)。乱数を 2 個消費する(u1 は (0, 1])。 */
export function standardNormal(rng: Rng): number {
  const u1 = rng.nextFloatOpen();
  const u2 = rng.nextFloat();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 0 以下の標本を捨てて引き直す正規乱数。mean > 0 なら採用確率は 1/2 以上。 */
export function sampleNormalPositive(rng: Rng, mean: number, stdDev: number): number {
  for (;;) {
    const x = mean + stdDev * standardNormal(rng);
    if (x > 0) return x;
  }
}

/** 分布を検証し、乱数生成器から 1 標本を返す関数を作る。 */
export function createSampler(d: Distribution, rng: Rng): Result<() => number, ParamError> {
  const e = validateDistribution(d);
  if (e) return err(e);
  switch (d.kind) {
    case 'uniform': {
      const { min, max } = d;
      return ok(() => min + (max - min) * rng.nextFloat());
    }
    case 'normal': {
      const { mean, stdDev } = d;
      return ok(() => sampleNormalPositive(rng, mean, stdDev));
    }
    case 'lognormal': {
      const { mu, sigma } = d;
      return ok(() => Math.exp(mu + sigma * standardNormal(rng)));
    }
    case 'heavy-tail': {
      const { scale, shape } = d;
      return ok(() => scale / Math.pow(rng.nextFloatOpen(), 1 / shape));
    }
    case 'multimodal': {
      const modes = d.modes;
      const total = modes.reduce((s, m) => s + m.weight, 0);
      // 累積重み(正規化後)。最後は必ず 1 以上に丸めて取りこぼしを防ぐ
      const cumulative: number[] = [];
      let acc = 0;
      for (const m of modes) {
        acc += m.weight / total;
        cumulative.push(acc);
      }
      return ok(() => {
        const u = rng.nextFloat();
        let idx = cumulative.findIndex((c) => u < c);
        if (idx < 0) idx = modes.length - 1;
        const m = modes[idx]!;
        return sampleNormalPositive(rng, m.mean, m.stdDev);
      });
    }
    default:
      return err(bad('kind', '未知の分布です'));
  }
}
