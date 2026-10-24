import { describe, expect, it } from 'vitest';
import { sortExactSpec } from '../exact/sort-exact';
import { quickselectExactSpec } from '../exact/quickselect-exact';
import { runSweep, seriesByAlgorithm } from './run-sweep';
import type { BenchmarkInput, SweepResult } from './types';

function cond(n: number, extra: Partial<BenchmarkInput> = {}): BenchmarkInput {
  return {
    data: Array.from({ length: n }, (_, i) => ((i * 7) % 13) + 1),
    quantiles: [0.5, 0.99],
    sketches: [sortExactSpec(), quickselectExactSpec()],
    seed: 1,
    ...extra,
  };
}

function sweepOk(conditions: readonly BenchmarkInput[]): SweepResult {
  const r = runSweep(conditions);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('runSweep', () => {
  it('件数を逆順に与えても昇順に並ぶ', () => {
    const s = sweepOk([cond(30), cond(10), cond(20)]);
    expect(s.schemaVersion).toBe(1);
    expect(s.runs.map((r) => r.count)).toEqual([10, 20, 30]);
  });

  it('同じ件数は入力の並びを保つ', () => {
    const s = sweepOk([cond(10, { seed: 1 }), cond(5), cond(10, { seed: 2 })]);
    expect(s.runs.map((r) => [r.count, r.seed])).toEqual([[5, 1], [10, 1], [10, 2]]);
  });

  it('条件が空なら空の結果', () => {
    expect(sweepOk([]).runs).toEqual([]);
  });

  it('途中の条件の入力エラーをそのまま返す', () => {
    const r = runSweep([cond(10), cond(5, { quantiles: [2] }), cond(7, { data: [] })]);
    expect(r).toEqual({ ok: false, error: { kind: 'invalid-quantile' } });
  });

  it('JSON の往復で等しい', () => {
    const s = sweepOk([cond(20), cond(10)]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('seriesByAlgorithm', () => {
  it('アルゴリズムごとに件数順の系列になる', () => {
    const s = sweepOk([cond(30), cond(10), cond(20)]);
    const series = seriesByAlgorithm(s);
    expect(Object.keys(series).sort()).toEqual(['exact-quickselect-linear', 'exact-sort-linear']);
    for (const [id, points] of Object.entries(series)) {
      expect(points.map((p) => p.count)).toEqual([10, 20, 30]);
      for (const p of points) expect(p.result.id).toBe(id);
    }
  });

  it('一部の条件にしかないアルゴリズムはその件数だけを持つ', () => {
    const s = sweepOk([cond(10), cond(20, { sketches: [sortExactSpec()] })]);
    const series = seriesByAlgorithm(s);
    expect(series['exact-sort-linear']!.map((p) => p.count)).toEqual([10, 20]);
    expect(series['exact-quickselect-linear']!.map((p) => p.count)).toEqual([10]);
  });

  it('空の結果なら空の系列', () => {
    expect(seriesByAlgorithm({ schemaVersion: 1, runs: [] })).toEqual({});
  });

  it('JSON の往復で等しい', () => {
    const series = seriesByAlgorithm(sweepOk([cond(20), cond(10)]));
    expect(JSON.parse(JSON.stringify(series))).toEqual(series);
  });
});
