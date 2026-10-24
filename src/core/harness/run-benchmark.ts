import { isParamRecord, type ParamRecord, type PercentileSketch, type SketchSpec } from '../contract/sketch';
import type { OperationCounts } from '../cost/op-counter';
import type { HarnessError } from '../foundation/errors';
import { err, ok, type Result } from '../foundation/result';
import { checkPositiveFinite, isQuantile } from '../foundation/validation';
import { absoluteError, rankError, relativeError } from '../metrics/error-metrics';
import { DEFAULT_DEFINITION } from '../quantile/definitions';
import { exactQuantileSorted } from '../quantile/reference';
import type { AlgorithmErrorKind, AlgorithmResult, BenchmarkInput, BenchmarkResult, QueryRecord } from './types';

function validate(input: BenchmarkInput): HarnessError | undefined {
  const { data } = input;
  if (data.length === 0) return { kind: 'invalid-data', reason: 'empty' };
  for (let i = 0; i < data.length; i++) {
    const reason = checkPositiveFinite(data[i]!);
    if (reason !== undefined) return { kind: 'invalid-data', reason };
  }
  for (const q of input.quantiles) {
    if (!isQuantile(q)) return { kind: 'invalid-quantile' };
  }
  if (input.sketches.length === 0) return { kind: 'no-sketches' };
  if (input.meta !== undefined && !isParamRecord(input.meta)) return { kind: 'invalid-params', field: 'meta' };
  for (const spec of input.sketches) {
    if (spec.params !== undefined && !isParamRecord(spec.params)) {
      return { kind: 'invalid-params', field: `params:${spec.id}` };
    }
  }
  return undefined;
}

function snapshot(sketch: PercentileSketch): OperationCounts {
  const c = sketch.operationCounts();
  return { comparisons: c.comparisons, moves: c.moves };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Failure {
  constructor(
    readonly stage: 'insert' | 'query' | 'create',
    readonly errorKind: AlgorithmErrorKind,
    readonly message: string,
  ) {}
}

function runOne(
  spec: SketchSpec,
  input: BenchmarkInput,
  sorted: Float64Array,
  exacts: readonly number[],
  now: () => number,
): AlgorithmResult {
  const params: ParamRecord = { ...(spec.params ?? {}) };
  const fail = (f: Failure): AlgorithmResult => ({
    status: 'error',
    id: spec.id,
    label: spec.label,
    params,
    stage: f.stage,
    errorKind: f.errorKind,
    message: f.message,
  });

  let sketch: PercentileSketch;
  try {
    sketch = spec.create(input.seed);
  } catch (e) {
    return fail(new Failure('create', 'exception', messageOf(e)));
  }

  const t0 = now();
  try {
    for (let i = 0; i < input.data.length; i++) {
      const r = sketch.insert(input.data[i]!);
      if (!r.ok) return fail(new Failure('insert', r.error.kind, `insert failed at index ${i}: ${r.error.kind}`));
    }
  } catch (e) {
    return fail(new Failure('insert', 'exception', messageOf(e)));
  }
  const insertElapsed = now() - t0;
  const afterInsertion = {
    operations: snapshot(sketch),
    memoryBytes: sketch.memoryBytes(),
    elapsedMs: insertElapsed,
  };

  const queries: QueryRecord[] = [];
  try {
    for (let i = 0; i < input.quantiles.length; i++) {
      const quantile = input.quantiles[i]!;
      const exact = exacts[i]!;
      const before = snapshot(sketch);
      const q0 = now();
      const r = sketch.query(quantile);
      const elapsedMs = now() - q0;
      if (!r.ok) return fail(new Failure('query', r.error.kind, `query(${quantile}) failed: ${r.error.kind}`));
      const estimate = r.value;
      const reason = checkPositiveFinite(estimate);
      if (reason !== undefined) {
        return fail(new Failure('query', 'invalid-estimate', `query(${quantile}) returned an invalid estimate: ${reason}`));
      }
      const after = snapshot(sketch);
      const abs = absoluteError(estimate, exact);
      const rel = relativeError(estimate, exact);
      const rank = rankError(sorted, estimate, quantile);
      // 推定値と基準値は検証済みなので到達しない。万一の保険として例外扱いで記録する
      if (!abs.ok || !rel.ok || !rank.ok) {
        return fail(new Failure('query', 'exception', `error metric failed for query(${quantile})`));
      }
      queries.push({
        quantile,
        estimate,
        exact,
        absoluteError: abs.value,
        relativeError: rel.value,
        rankError: rank.value,
        operations: {
          comparisons: after.comparisons - before.comparisons,
          moves: after.moves - before.moves,
        },
        elapsedMs,
      });
    }
  } catch (e) {
    return fail(new Failure('query', 'exception', messageOf(e)));
  }

  return {
    status: 'ok',
    id: spec.id,
    label: spec.label,
    params,
    afterInsertion,
    queries,
    afterQueries: { operations: snapshot(sketch), memoryBytes: sketch.memoryBytes() },
  };
}

/**
 * 1条件の計測。入力が不正なら1つも実行せずにエラーを返す。
 * 各アルゴリズムの失敗はそのアルゴリズムの結果にだけ記録し、残りの実行を続ける。
 */
export function runBenchmark(input: BenchmarkInput): Result<BenchmarkResult, HarnessError> {
  const invalid = validate(input);
  if (invalid) return err(invalid);

  const definition = input.referenceDefinition ?? DEFAULT_DEFINITION;
  const now = input.now ?? (() => performance.now());
  const sorted = Float64Array.from(input.data).sort();
  const exacts = input.quantiles.map((q) => exactQuantileSorted(sorted, q, definition));

  const algorithms = input.sketches.map((spec) => runOne(spec, input, sorted, exacts, now));

  return ok({
    schemaVersion: 1,
    count: input.data.length,
    seed: input.seed,
    referenceDefinition: definition,
    meta: { ...(input.meta ?? {}) },
    algorithms,
  });
}

/** elapsedMs をすべて 0 にした複製。再現性の比較に使う。 */
export function withoutTiming(result: BenchmarkResult): BenchmarkResult {
  return {
    ...result,
    meta: { ...result.meta },
    algorithms: result.algorithms.map((a): AlgorithmResult => {
      if (a.status === 'error') return { ...a, params: { ...a.params } };
      return {
        ...a,
        params: { ...a.params },
        afterInsertion: { ...a.afterInsertion, operations: { ...a.afterInsertion.operations }, elapsedMs: 0 },
        queries: a.queries.map((q) => ({ ...q, operations: { ...q.operations }, elapsedMs: 0 })),
        afterQueries: { ...a.afterQueries, operations: { ...a.afterQueries.operations } },
      };
    }),
  };
}
