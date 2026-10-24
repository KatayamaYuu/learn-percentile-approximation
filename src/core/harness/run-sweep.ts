import type { HarnessError } from '../foundation/errors';
import { err, ok, type Result } from '../foundation/result';
import { runBenchmark } from './run-benchmark';
import type { BenchmarkInput, BenchmarkResult, SeriesPoint, SweepResult } from './types';

/**
 * 件数の異なる複数条件を入力の順に実行し、件数の昇順に並べて返す。
 * 同じ件数は入力の並びを保つ。いずれかの条件が入力エラーならそのエラーを返す。
 */
export function runSweep(conditions: readonly BenchmarkInput[]): Result<SweepResult, HarnessError> {
  const runs: BenchmarkResult[] = [];
  for (const condition of conditions) {
    const r = runBenchmark(condition);
    if (!r.ok) return err(r.error);
    runs.push(r.value);
  }
  // Array.prototype.sort は安定
  runs.sort((a, b) => a.count - b.count);
  return ok({ schemaVersion: 1, runs });
}

/** アルゴリズムの識別子ごとに、件数順の系列へ並べ替える。 */
export function seriesByAlgorithm(sweep: SweepResult): Readonly<Record<string, readonly SeriesPoint[]>> {
  const series = new Map<string, SeriesPoint[]>();
  const sortedRuns = [...sweep.runs].sort((a, b) => a.count - b.count);
  for (const run of sortedRuns) {
    for (const result of run.algorithms) {
      let points = series.get(result.id);
      if (points === undefined) {
        points = [];
        series.set(result.id, points);
      }
      points.push({ count: run.count, result });
    }
  }
  return Object.fromEntries(series);
}
