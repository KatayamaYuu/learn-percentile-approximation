import { describe, expect, it } from 'vitest';
import {
  quickselectExactSpec,
  runSweep,
  seriesByAlgorithm,
  sortExactSpec,
  type AlgorithmResult,
  type BenchmarkInput,
  type BenchmarkResult,
  type SketchSpec,
  type SweepResult,
} from '../../core';
import { histogramSpec } from '../../histogram';
import { gkSpec, kllSpec, tdigestSpec } from '../../streaming';
import { ddsketchSpec, hdrSpec } from '../../relative-error';
import {
  allOperations,
  countAxisSeries,
  elapsedMs,
  familyOf,
  groupByAlgorithm,
  insertOperations,
  memoryBytes,
  paramAxisSeries,
  quantileAxisSeries,
  tradeoffSeries,
  unavailableNotes,
  unavailableText,
  variantOf,
} from './series';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 8 種の識別子を、上流の生成仕様で実物として作る */
function realSpecs(): { exactSort: SketchSpec; exactQs: SketchSpec; others: SketchSpec[] } {
  return {
    exactSort: sortExactSpec({ definition: 'nearest-rank' }),
    exactQs: quickselectExactSpec({ definition: 'nearest-rank' }),
    others: [
      must(histogramSpec({ kind: 'equal', lower: 0.5, upper: 200, buckets: 16 })),
      must(histogramSpec({ kind: 'exponential', lower: 0.5, upper: 200, buckets: 16 })),
      must(gkSpec({ epsilon: 0.01 })),
      must(kllSpec({ k: 200 })),
      must(tdigestSpec({ compression: 100, scale: 'k0' })),
      must(tdigestSpec({ compression: 100, scale: 'k1' })),
      must(tdigestSpec({ compression: 100, scale: 'k2' })),
      must(ddsketchSpec({ alpha: 0.01 })),
      must(hdrSpec({ lowest: 0.5, highest: 200, significantDigits: 2 })),
    ],
  };
}

function dataOf(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 1 + ((i * 37) % 97));
}

function input(count: number, sketches: SketchSpec[]): BenchmarkInput {
  return { data: dataOf(count), quantiles: [0.5, 0.9, 0.99], sketches, seed: 7, referenceDefinition: 'nearest-rank' };
}

function makeSweep(counts: readonly number[], sketches: SketchSpec[]): SweepResult {
  return must(runSweep(counts.map((c) => input(c, sketches))));
}

describe('familyOf / variantOf(上流の生成仕様で作った 8 種の識別子)', () => {
  const { exactSort, exactQs, others } = realSpecs();
  const all = [exactSort, exactQs, ...others];

  it('系統を最初の区切りまでの接頭辞の完全一致で決める', () => {
    const got = Object.fromEntries(all.map((s) => [s.id, familyOf(s.id)]));
    expect(got).toEqual({
      'exact-sort-nearest-rank': 'exact',
      'exact-quickselect-nearest-rank': 'exact',
      'histogram-equal-16': 'histogram',
      'histogram-exponential-16': 'histogram',
      'gk-eps-0.01': 'gk',
      'kll-k-200': 'kll',
      'tdigest-k0-c100': 'tdigest',
      'tdigest-k1-c100': 'tdigest',
      'tdigest-k2-c100': 'tdigest',
      'ddsketch-a0.01-m2048': 'ddsketch',
      'hdr-d2': 'hdr',
    });
  });
  it('系列は exact・histogram・tdigest は先頭 2 区切り、他は系統と同じ', () => {
    const got = Object.fromEntries(all.map((s) => [s.id, variantOf(s.id)]));
    expect(got).toEqual({
      'exact-sort-nearest-rank': 'exact-sort',
      'exact-quickselect-nearest-rank': 'exact-quickselect',
      'histogram-equal-16': 'histogram-equal',
      'histogram-exponential-16': 'histogram-exponential',
      'gk-eps-0.01': 'gk',
      'kll-k-200': 'kll',
      'tdigest-k0-c100': 'tdigest-k0',
      'tdigest-k1-c100': 'tdigest-k1',
      'tdigest-k2-c100': 'tdigest-k2',
      'ddsketch-a0.01-m2048': 'ddsketch',
      'hdr-d2': 'hdr',
    });
  });
  it('未知の接頭辞・区切りなし・部分一致は対象外(null)', () => {
    for (const id of ['foo-1', 'hdr', 'gk', '', '-gk-eps-0.1', 'hdrx-d2', 'histogramx-equal-3', 'GK-eps-1', 'hdr_d2']) {
      expect(familyOf(id)).toBeNull();
      expect(variantOf(id)).toBeNull();
    }
  });
  it('hdr と histogram を取り違えない', () => {
    expect(familyOf('hdr-d2')).toBe('hdr');
    expect(familyOf('histogram-equal-4')).toBe('histogram');
  });
  it('2 区切り目がない exact / histogram / tdigest は系列を決められない', () => {
    for (const id of ['exact-', 'exact', 'histogram-', 'tdigest-']) expect(variantOf(id)).toBeNull();
    expect(variantOf('gk-')).toBe('gk');
  });
});

describe('groupByAlgorithm は上流の seriesByAlgorithm と同じ結果(11.5)', () => {
  const { exactSort, exactQs, others } = realSpecs();
  const sketches = [exactSort, exactQs, ...others];

  it('件数の昇順・識別子ごとに初出順・同じ値', () => {
    // 件数は入力順を昇順でなくし、同じ件数も含める
    const sweep = makeSweep([500, 50, 200, 50], sketches);
    const mine = groupByAlgorithm(sweep);
    const upstream = seriesByAlgorithm(sweep);
    expect(Object.keys(mine)).toEqual(Object.keys(upstream));
    expect(Object.keys(mine)[0]).toBe('exact-sort-nearest-rank');
    for (const id of Object.keys(upstream)) {
      expect(mine[id]!.map((p) => p.count)).toEqual(upstream[id]!.map((p) => p.count));
      expect(mine[id]!.map((p) => p.result)).toEqual(upstream[id]!.map((p) => p.result));
      // 同じ参照(値を作り直さない)
      mine[id]!.forEach((p, i) => expect(p.result).toBe(upstream[id]![i]!.result));
    }
    expect(mine['gk-eps-0.01']!.map((p) => p.count)).toEqual([50, 50, 200, 500]);
  });
  it('識別子の初出が run によって違っても初出順', () => {
    const a = makeSweep([100], [exactSort, others[2]!]);
    const b = makeSweep([200], [others[3]!, exactSort]);
    const sweep: SweepResult = { schemaVersion: 1, runs: [b.runs[0]!, a.runs[0]!] };
    expect(Object.keys(groupByAlgorithm(sweep))).toEqual(Object.keys(seriesByAlgorithm(sweep)));
    // 入力の runs が降順でも昇順にして集める
    expect(groupByAlgorithm(sweep)['exact-sort-nearest-rank']!.map((p) => p.count)).toEqual([100, 200]);
  });
  it('入力を変更しない', () => {
    const sweep = makeSweep([300, 100], [exactSort]);
    const before = sweep.runs.map((r) => r.count);
    groupByAlgorithm({ schemaVersion: 1, runs: [sweep.runs[1]!, sweep.runs[0]!] });
    expect(sweep.runs.map((r) => r.count)).toEqual(before);
  });
  it('空の掃引は空', () => {
    expect(groupByAlgorithm({ schemaVersion: 1, runs: [] })).toEqual({});
  });
});

describe('件数軸・パラメータ軸・分位点軸・メモリと誤差の系列(上流の値と等しい)', () => {
  const { exactSort, others } = realSpecs();
  // 範囲(0.5〜200)が狭く、データ(1〜97)を覆うので成功する。覆わない範囲は別途失敗として作る
  const narrow = must(histogramSpec({ kind: 'equal', lower: 1, upper: 10, buckets: 4 }));
  const sketches = [exactSort, others[0]!, others[2]!, narrow];
  const sweep = makeSweep([100, 400], sketches);

  it('件数軸: x は件数、y は選んだ値、失敗した手法は系列にしない', () => {
    const series = countAxisSeries(sweep, memoryBytes);
    expect(series.map((s) => s.id)).toEqual(['exact-sort-nearest-rank', 'histogram-equal-16', 'gk-eps-0.01']);
    for (const s of series) {
      expect(s.kind).toBe('line');
      const results = sweep.runs.map((run) => run.algorithms.find((a) => a.id === s.id)!);
      expect(s.points.map((p) => p.x)).toEqual(sweep.runs.map((r) => r.count));
      expect(s.points.map((p) => p.y)).toEqual(
        results.map((r) => (r.status === 'ok' ? r.afterInsertion.memoryBytes : NaN)),
      );
      expect(s.label).toBe(results[0]!.label);
    }
  });
  it('件数軸: filter で系列を絞れる', () => {
    const series = countAxisSeries(sweep, memoryBytes, (id) => familyOf(id) === 'gk');
    expect(series.map((s) => s.id)).toEqual(['gk-eps-0.01']);
  });
  it('件数軸: 一部の件数だけ失敗した手法は、成功した点だけを持つ', () => {
    const mixed: SweepResult = {
      schemaVersion: 1,
      runs: [sweep.runs[0]!, failRun(sweep.runs[1]!, 'gk-eps-0.01')],
    };
    const s = countAxisSeries(mixed, memoryBytes).find((x) => x.id === 'gk-eps-0.01')!;
    expect(s.points.map((p) => p.x)).toEqual([100]);
  });

  it('パラメータ軸: 系列ごとに params の項目の値で昇順、識別子から値を読まない', () => {
    const specs = [4, 16, 8].map((b) => must(histogramSpec({ kind: 'equal', lower: 0.5, upper: 200, buckets: b })));
    const exps = [4, 8].map((b) => must(histogramSpec({ kind: 'exponential', lower: 0.5, upper: 200, buckets: b })));
    const run = must(runSweep([input(200, [...specs, ...exps, sortExactSpec()])])).runs[0]!;
    const out = paramAxisSeries(run, (r) => variantOf(r.id), 'buckets', (r) => r.afterInsertion.memoryBytes);
    // 厳密解は params に buckets がないので点にならず、系列も作らない
    expect(out.map((s) => s.id)).toEqual(['histogram-equal', 'histogram-exponential']);
    expect(out[0]!.points.map((p) => p.x)).toEqual([4, 8, 16]);
    const byId = new Map(run.algorithms.map((a) => [a.id, a]));
    const expected = [4, 8, 16].map((b) => {
      const r = byId.get(`histogram-equal-${b}`)!;
      return r.status === 'ok' ? r.afterInsertion.memoryBytes : NaN;
    });
    expect(out[0]!.points.map((p) => p.y)).toEqual(expected);
    expect(out[1]!.points.map((p) => p.x)).toEqual([4, 8]);
  });
  it('パラメータ軸: groupKey が null の結果、値が null の結果、失敗は除く', () => {
    const run = sweep.runs[0]!;
    const out = paramAxisSeries(
      run,
      (r) => (familyOf(r.id) === 'gk' ? 'GK' : null),
      'epsilon',
      () => null,
    );
    expect(out).toEqual([]);
    const gk = paramAxisSeries(run, (r) => (familyOf(r.id) === 'gk' ? 'GK' : null), 'epsilon', (r) => r.afterInsertion.memoryBytes);
    expect(gk).toHaveLength(1);
    expect(gk[0]!.points[0]!.x).toBe(0.01);
  });

  it('分位点軸: x は分位点、y は上流の誤差の値', () => {
    const run = sweep.runs[1]!;
    for (const metric of ['absolute', 'rank', 'relative'] as const) {
      const out = quantileAxisSeries(run, metric);
      expect(out.map((s) => s.id)).toEqual(['exact-sort-nearest-rank', 'histogram-equal-16', 'gk-eps-0.01']);
      for (const s of out) {
        const r = run.algorithms.find((a) => a.id === s.id)! as Extract<AlgorithmResult, { status: 'ok' }>;
        expect(s.points.map((p) => p.x)).toEqual(r.queries.map((q) => q.quantile));
        const key = { absolute: 'absoluteError', rank: 'rankError', relative: 'relativeError' }[metric] as
          | 'absoluteError'
          | 'rankError'
          | 'relativeError';
        expect(s.points.map((p) => p.y)).toEqual(r.queries.map((q) => q[key]));
      }
    }
    expect(quantileAxisSeries(run, 'rank', (id) => id.startsWith('gk')).map((s) => s.id)).toEqual(['gk-eps-0.01']);
  });

  it('メモリと誤差: 系統ごとに (メモリ, 誤差) の点', () => {
    const run = must(
      runSweep([input(300, [must(gkSpec({ epsilon: 0.1 })), must(gkSpec({ epsilon: 0.01 })), must(kllSpec({ k: 64 })), sortExactSpec()])]),
    ).runs[0]!;
    const sel = { metric: 'rank', pick: { kind: 'max' } } as const;
    const out = tradeoffSeries(run, sel, (r) => familyOf(r.id));
    expect(out.map((s) => s.id)).toEqual(['gk', 'kll', 'exact']);
    const gk = out.find((s) => s.id === 'gk')!;
    expect(gk.points).toHaveLength(2);
    const expected = ['gk-eps-0.1', 'gk-eps-0.01']
      .map((id) => run.algorithms.find((a) => a.id === id)! as Extract<AlgorithmResult, { status: 'ok' }>)
      .map((r) => ({ x: r.afterInsertion.memoryBytes, y: Math.max(...r.queries.map((q) => q.rankError)) }))
      .sort((a, b) => a.x - b.x);
    expect(gk.points.map((p) => ({ x: p.x, y: p.y }))).toEqual(expected);
    // 個別の分位点
    const at = tradeoffSeries(run, { metric: 'absolute', pick: { kind: 'at', quantile: 0.9 } }, (r) => familyOf(r.id));
    const k = at.find((s) => s.id === 'kll')!;
    const kr = run.algorithms.find((a) => a.id === 'kll-k-64')! as Extract<AlgorithmResult, { status: 'ok' }>;
    expect(k.points[0]!.y).toBe(kr.queries.find((q) => q.quantile === 0.9)!.absoluteError);
    // 該当する分位点がなければ点を作らない
    expect(tradeoffSeries(run, { metric: 'rank', pick: { kind: 'at', quantile: 0.123 } }, (r) => familyOf(r.id))).toEqual([]);
  });
});

function failRun(run: BenchmarkResult, id: string): BenchmarkResult {
  return {
    ...run,
    algorithms: run.algorithms.map((a) =>
      a.id === id
        ? { status: 'error', id: a.id, label: a.label, params: a.params, stage: 'insert', errorKind: 'unsupported-value', message: 'x' }
        : a,
    ),
  };
}

describe('失敗した手法(7.5, 4.6, 6.7, 8.8)', () => {
  const { exactSort } = realSpecs();
  // データ(1〜97)を覆わない範囲 → 上流が実際に失敗させる
  const tooNarrow = must(histogramSpec({ kind: 'equal', lower: 1, upper: 10, buckets: 4 }));
  const sweep = makeSweep([100, 200], [exactSort, tooNarrow]);

  it('上流の失敗が実際に起きている(前提)', () => {
    const r = sweep.runs[0]!.algorithms.find((a) => a.id === tooNarrow.id)!;
    expect(r.status).toBe('error');
  });
  it('失敗した手法に点がなく、注記がある', () => {
    for (const s of countAxisSeries(sweep, memoryBytes)) expect(s.id).not.toBe(tooNarrow.id);
    for (const s of quantileAxisSeries(sweep.runs[0]!, 'rank')) expect(s.id).not.toBe(tooNarrow.id);
    for (const s of tradeoffSeries(sweep.runs[0]!, { metric: 'rank', pick: { kind: 'max' } }, (r) => familyOf(r.id))) {
      expect(s.id).not.toBe(tooNarrow.id);
    }
    const notes = unavailableNotes(sweep);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(tooNarrow.id);
    expect(notes[0]!.label).toBe(tooNarrow.label);
    expect(notes[0]!.reason).toMatch(/[ぁ-ん]/);
    expect(unavailableText(notes[0]!)).toBe(`${tooNarrow.label}: 計算できませんでした(${notes[0]!.reason})`);
  });
  it('1 つの run からも集められ、同じ識別子は 1 回だけ', () => {
    expect(unavailableNotes(sweep.runs[0]!)).toHaveLength(1);
    expect(unavailableNotes(sweep).map((n) => n.id)).toEqual([tooNarrow.id]);
  });
  it('失敗がなければ空', () => {
    expect(unavailableNotes(makeSweep([100], [exactSort]))).toEqual([]);
  });
  it('理由は段階・種類・説明から日本語で作る', () => {
    const mk = (stage: 'create' | 'insert' | 'query', errorKind: string, message: string): SweepResult => ({
      schemaVersion: 1,
      runs: [
        {
          schemaVersion: 1,
          count: 1,
          seed: 1,
          referenceDefinition: 'nearest-rank',
          meta: {},
          algorithms: [{ status: 'error', id: 'x-1', label: 'X', params: {}, stage, errorKind: errorKind as never, message }],
        },
      ],
    });
    const insert = unavailableNotes(mk('insert', 'unsupported-value', '範囲外'))[0]!.reason;
    expect(insert).toContain('値の投入');
    expect(insert).toContain('範囲外');
    expect(unavailableNotes(mk('query', 'empty', ''))[0]!.reason).toContain('問い合わせ');
    expect(unavailableNotes(mk('create', 'exception', 'boom'))[0]!.reason).toContain('作成');
    expect(unavailableNotes(mk('query', 'invalid-estimate', 'NaN'))[0]!.reason).toContain('推定値');
    expect(unavailableNotes(mk('query', 'something-new', 'm'))[0]!.reason).toContain('something-new');
  });
});

describe('表示用の集計(足し算だけ)', () => {
  const { exactSort } = realSpecs();
  const run = must(runSweep([input(300, [exactSort, must(gkSpec({ epsilon: 0.05 }))])])).runs[0]!;
  const r = run.algorithms[1]! as Extract<AlgorithmResult, { status: 'ok' }>;
  it('操作数は比較 + 移動、問い合わせを足した合計', () => {
    expect(insertOperations(r)).toBe(r.afterInsertion.operations.comparisons + r.afterInsertion.operations.moves);
    const q = r.queries.reduce((s, x) => s + x.operations.comparisons + x.operations.moves, 0);
    expect(allOperations(r)).toBe(insertOperations(r) + q);
  });
  it('メモリは投入後、処理時間は投入 + 問い合わせの合計', () => {
    expect(memoryBytes(r)).toBe(r.afterInsertion.memoryBytes);
    expect(elapsedMs(r)).toBe(r.afterInsertion.elapsedMs + r.queries.reduce((s, x) => s + x.elapsedMs, 0));
  });
});
