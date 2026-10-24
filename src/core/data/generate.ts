import { err, ok, type Result } from '../foundation/result';
import type { GenerateError } from '../foundation/errors';
import { createRng } from '../rng/sfc32';
import { createSampler, type Distribution } from './distributions';

export type { Distribution } from './distributions';

export type DataOrder = 'random' | 'ascending' | 'descending';

export interface GenerateSpec {
  readonly distribution: Distribution;
  readonly count: number;
  readonly seed: number;
  readonly order?: DataOrder;
}

export const MIN_COUNT = 1;
export const MAX_COUNT = 10_000_000;

const ORDERS: readonly DataOrder[] = ['random', 'ascending', 'descending'];

/**
 * 分布・件数・シード・並び順から、正の有限数の列を作る。
 * 乱数の消費順序は仕様の一部(標本ごとに順に消費し、並べ替えでは消費しない)。
 * 検証は 件数 → シード → 並び順 → 分布パラメータ の順に行う。
 */
export function generate(spec: GenerateSpec): Result<Float64Array, GenerateError> {
  const { distribution, count, seed } = spec;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return err({ kind: 'invalid-count' });
  }
  const rngResult = createRng(seed);
  if (!rngResult.ok) return err({ kind: 'invalid-seed' });
  const order = spec.order ?? 'random';
  if (!ORDERS.includes(order)) {
    return err({ kind: 'invalid-parameter', field: 'order', reason: 'random / ascending / descending のいずれかです' });
  }
  const sampler = createSampler(distribution, rngResult.value);
  if (!sampler.ok) return err(sampler.error);

  const sample = sampler.value;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const x = sample();
    // 途中で不正な標本が出たら、部分的な列は返さない
    if (!Number.isFinite(x) || x <= 0) return err({ kind: 'non-finite-sample' });
    out[i] = x;
  }
  if (order === 'ascending') out.sort();
  else if (order === 'descending') out.sort().reverse();
  return ok(out);
}
