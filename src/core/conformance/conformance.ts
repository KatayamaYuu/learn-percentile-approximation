import type { PercentileSketch, SketchSpec } from '../contract/sketch';
import { isParamRecord } from '../contract/sketch';
import type { Result } from '../foundation/result';
import type { SketchError } from '../foundation/errors';

export interface ConformanceCheck {
  readonly id: string;
  /** 対応する要件 ID(例: '1.5') */
  readonly requirement: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly specId: string;
  readonly checks: readonly ConformanceCheck[];
  readonly failures: readonly ConformanceCheck[];
}

const DEFAULT_SEED = 1;
const INPUT_COUNT = 20;
const QUANTILES: readonly number[] = [0, 0.25, 0.5, 0.9, 1];

interface Outcome {
  readonly passed: boolean;
  readonly detail: string;
}

const pass = (detail: string): Outcome => ({ passed: true, detail });
const fail = (detail: string): Outcome => ({ passed: false, detail });

/** 範囲内に収まる固定の入力列(乱数は使わない)。範囲なしは 1 以上 1000 以下。 */
function fixedInputs(spec: SketchSpec): number[] {
  const range = spec.supportedRange;
  const lo = range === undefined ? 1 : range.min;
  const hi = range === undefined ? 1000 : Number.isFinite(range.max) ? range.max : range.min * 1000;
  const values: number[] = [];
  for (let i = 0; i < INPUT_COUNT; i++) {
    // 7 は 20 と互いに素なので、昇順でも降順でもない並びで全点を一度ずつ通る
    const k = (i * 7) % INPUT_COUNT;
    const v = lo + ((hi - lo) * k) / (INPUT_COUNT - 1);
    values.push(Math.min(hi, Math.max(lo, v)));
  }
  return values;
}

function describeResult(r: Result<unknown, SketchError>): string {
  return JSON.stringify(r);
}

function insertAll(sketch: PercentileSketch, values: readonly number[]): string | undefined {
  for (const v of values) {
    const r = sketch.insert(v);
    if (!r.ok) return `値 ${v} の投入が ${r.error.kind} で拒否された`;
  }
  return undefined;
}

function observe(sketch: PercentileSketch): string {
  return JSON.stringify({
    counts: sketch.operationCounts(),
    memory: sketch.memoryBytes(),
    answers: QUANTILES.map((q) => describeResult(sketch.query(q))),
  });
}

function readCost(sketch: PercentileSketch): string {
  return JSON.stringify({ counts: sketch.operationCounts(), memory: sketch.memoryBytes() });
}

function readAnswers(sketch: PercentileSketch): string {
  return JSON.stringify(QUANTILES.map((q) => describeResult(sketch.query(q))));
}

/**
 * 拒否されるべき操作を行い、期待したエラー種別と状態不変を確かめる。
 * 問い合わせは操作数を増やしうるので、操作数とメモリ見積もりは拒否の直前と直後に読み、
 * 問い合わせ結果はその外側で比べる。
 */
function checkRejection(
  sketch: PercentileSketch,
  label: string,
  run: () => Result<unknown, SketchError>,
  expectedKind: SketchError['kind'],
): string | undefined {
  const answersBefore = readAnswers(sketch);
  const costBefore = readCost(sketch);
  const r = run();
  const costAfter = readCost(sketch);
  const answersAfter = readAnswers(sketch);
  if (r.ok) return `${label} が受け入れられた`;
  if (r.error.kind !== expectedKind) {
    return `${label} のエラー種別が ${r.error.kind}(期待: ${expectedKind})`;
  }
  if (costBefore !== costAfter || answersBefore !== answersAfter) {
    return `${label} の拒否後に状態が変わった`;
  }
  return undefined;
}

function firstProblem(problems: readonly (string | undefined)[]): Outcome {
  const found = problems.filter((p): p is string => p !== undefined);
  return found.length === 0 ? pass('問題なし') : fail(found.join(' / '));
}

const INVALID_VALUES: readonly unknown[] = [0, -1, -0.5, NaN, Infinity, -Infinity, '5', null, undefined, true];
const BAD_QUANTILES: readonly number[] = [-0.1, 1.1, NaN, Infinity, -Infinity];

/**
 * 任意の SketchSpec が共通の操作規約に従うかを確認する。テストフレームワークに依存しない。
 * 例外は投げず、アルゴリズムが投げた例外は該当項目の失敗として記録する。
 * 乱数は使わず、supportedRange に収まる固定の入力列で実行する。
 */
export function runConformance(
  spec: SketchSpec,
  options?: { readonly seed?: number },
): ConformanceReport {
  const seed = options?.seed ?? DEFAULT_SEED;
  const inputs = fixedInputs(spec);
  const checks: ConformanceCheck[] = [];

  function check(id: string, requirement: string, body: () => Outcome): void {
    let outcome: Outcome;
    try {
      outcome = body();
    } catch (e) {
      outcome = fail(`例外: ${e instanceof Error ? e.message : String(e)}`);
    }
    checks.push({ id, requirement, passed: outcome.passed, detail: outcome.detail });
  }

  const filled = (): PercentileSketch => {
    const s = spec.create(seed);
    const problem = insertAll(s, inputs);
    if (problem !== undefined) throw new Error(problem);
    return s;
  };

  check('invalid-values-rejected', '1.5', () => {
    const s = filled();
    return firstProblem(
      INVALID_VALUES.map((v) =>
        checkRejection(s, `不正な値 ${String(v)}`, () => s.insert(v as number), 'invalid-value'),
      ),
    );
  });

  check('invalid-values-state-unchanged', '1.5', () => {
    const s = spec.create(seed);
    const before = JSON.stringify([s.operationCounts(), s.memoryBytes()]);
    for (const v of INVALID_VALUES) s.insert(v as number);
    const afterEmpty = JSON.stringify([s.operationCounts(), s.memoryBytes()]);
    return before === afterEmpty
      ? pass('空の状態で不正値を投入しても状態が変わらない')
      : fail('空の状態で不正値を投入すると操作数またはメモリ見積もりが変わった');
  });

  check('quantile-out-of-range', '1.4', () => {
    const s = filled();
    return firstProblem(
      BAD_QUANTILES.map((q) =>
        checkRejection(s, `範囲外の分位点 ${q}`, () => s.query(q), 'quantile-out-of-range'),
      ),
    );
  });

  check('empty-query', '1.6', () => {
    const s = spec.create(seed);
    const r = s.query(0.5);
    if (r.ok) return fail('空の状態の問い合わせが成功した');
    return r.error.kind === 'empty' ? pass('empty エラー') : fail(`エラー種別が ${r.error.kind}`);
  });

  check('query-positive-finite', '1.3', () => {
    const s = filled();
    const problems = QUANTILES.map((q) => {
      const r = s.query(q);
      if (!r.ok) return `分位点 ${q} の問い合わせが ${r.error.kind} で失敗した`;
      return Number.isFinite(r.value) && r.value > 0
        ? undefined
        : `分位点 ${q} の推定値 ${r.value} が有限の正の数でない`;
    });
    return firstProblem(problems);
  });

  check('in-range-accepted', '1.2', () => {
    const s = spec.create(seed);
    const problem = insertAll(s, inputs);
    return problem === undefined ? pass(`${inputs.length} 個の値を受け入れた`) : fail(problem);
  });

  check('out-of-range-rejected', '1.5', () => {
    const range = spec.supportedRange;
    if (range === undefined) return pass('supportedRange の指定なし(対象外)');
    const s = filled();
    const outside = [range.min / 2];
    if (Number.isFinite(range.max)) outside.push(range.max * 2);
    return firstProblem(
      outside.map((v) =>
        checkRejection(s, `範囲外の値 ${v}`, () => s.insert(v), 'unsupported-value'),
      ),
    );
  });

  check('params-json', '6.3', () => {
    if (spec.params === undefined) return pass('params の指定なし');
    return isParamRecord(spec.params)
      ? pass('JSON にできる値だけを含む')
      : fail('params に有限の数・文字列・真偽値以外の値が含まれる');
  });

  check('reset-restores-initial-state', '1.7', () => {
    const used = filled();
    used.query(0.5);
    used.reset();
    const fresh = spec.create(seed);
    const a = observe(used);
    const b = observe(fresh);
    if (a !== b) return fail('reset 後の観測結果が新規作成直後と異なる');
    // 乱数列も戻っていること: 同じ入力列を入れ直して新規作成と同じ結果になる
    insertAll(used, inputs);
    insertAll(fresh, inputs);
    return observe(used) === observe(fresh)
      ? pass('reset 後が新規作成直後と同じ')
      : fail('reset 後に同じ入力を投入した結果が新規作成と異なる');
  });

  check('reproducible-with-same-seed', '1.8', () => {
    const a = filled();
    const b = filled();
    const sa = observe(a);
    return sa === observe(b)
      ? pass('同じシードと入力で同じ結果')
      : fail('同じシードと入力で結果が異なる');
  });

  check('same-seed-same-counts', '5.4', () => {
    const a = filled();
    const b = filled();
    a.query(0.5);
    b.query(0.5);
    return JSON.stringify(a.operationCounts()) === JSON.stringify(b.operationCounts())
      ? pass('同じシードと入力で操作数が同じ')
      : fail('同じシードと入力で操作数が異なる');
  });

  check('operation-counts', '5.3', () => {
    const s = spec.create(seed);
    let prev = s.operationCounts();
    const problems: (string | undefined)[] = [];
    const verify = (stage: string): void => {
      const c = s.operationCounts();
      for (const key of ['comparisons', 'moves'] as const) {
        const v = c[key];
        if (!Number.isInteger(v) || v < 0) problems.push(`${stage}: ${key}=${v} が非負の整数でない`);
        if (v < prev[key]) problems.push(`${stage}: ${key} が ${prev[key]} から ${v} に減った`);
      }
      prev = c;
    };
    verify('作成直後');
    for (const v of inputs) {
      s.insert(v);
      verify('投入後');
    }
    for (const q of QUANTILES) {
      s.query(q);
      verify('問い合わせ後');
    }
    s.reset();
    const after = s.operationCounts();
    if (after.comparisons !== 0 || after.moves !== 0) {
      problems.push(`reset 後の操作数が 0 でない(${JSON.stringify(after)})`);
    }
    return firstProblem([...new Set(problems)].slice(0, 3));
  });

  check('memory-estimate', '5.5', () => {
    const s = spec.create(seed);
    const problems: (string | undefined)[] = [];
    const verify = (stage: string): void => {
      const m = s.memoryBytes();
      if (!Number.isFinite(m) || m < 0) problems.push(`${stage}: メモリ見積もり ${m} が非負の有限数でない`);
    };
    verify('作成直後');
    for (const v of inputs) {
      s.insert(v);
      verify('投入後');
    }
    s.reset();
    verify('reset 後');
    return firstProblem([...new Set(problems)].slice(0, 3));
  });

  return { specId: spec.id, checks, failures: checks.filter((c) => !c.passed) };
}
