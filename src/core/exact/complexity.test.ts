import { describe, expect, it } from 'vitest';
import {
  createQuickselectExact,
  createSortExact,
  generate,
  type PercentileDefinition,
  type PercentileSketch,
} from '../index';

// 計測条件: 一様分布・生成順・固定シード・q = 0.5 を1回だけ問い合わせる。quickselect のシードも固定する。
const DATA_SEED = 20260101;
const QUICKSELECT_SEED = 7;
const QUANTILE = 0.5;
const SIZES = [1_000, 10_000, 100_000] as const;
// lower は補間なし、linear は右側の最小値探索あり
const DEFINITIONS: readonly PercentileDefinition[] = ['lower', 'linear'];

function makeData(count: number): Float64Array {
  const r = generate({ distribution: { kind: 'uniform', min: 1, max: 1000 }, count, seed: DATA_SEED, order: 'random' });
  if (!r.ok) throw new Error(`generate failed: ${r.error.kind}`);
  return r.value;
}

/** 投入後の操作数を差し引き、1回の問い合わせで増えた比較回数だけを返す */
function queryComparisons(sketch: PercentileSketch, data: Float64Array): number {
  for (const x of data) {
    const r = sketch.insert(x);
    if (!r.ok) throw new Error(`insert failed: ${r.error.kind}`);
  }
  const before = sketch.operationCounts().comparisons;
  const q = sketch.query(QUANTILE);
  if (!q.ok) throw new Error(`query failed: ${q.error.kind}`);
  return sketch.operationCounts().comparisons - before;
}

describe('操作数による計算量の実測(2.6, 5.3)', () => {
  for (const definition of DEFINITIONS) {
    for (const n of SIZES) {
      it(`定義 ${definition}, n = ${n}: 整列は n log2 n の 0.5〜1.0 倍、quickselect は 10n 以下`, () => {
        const data = makeData(n);
        const sortCmp = queryComparisons(createSortExact({ definition }), data);
        const qsCmp = queryComparisons(createQuickselectExact(QUICKSELECT_SEED, { definition }), data);

        const nLogN = n * Math.log2(n);
        const sortRatio = sortCmp / nLogN;
        const qsRatio = qsCmp / n;
        console.log(
          `[complexity] ${definition} n=${n}: sort=${sortCmp} (${sortRatio.toFixed(3)} x n log2 n), ` +
            `quickselect=${qsCmp} (${qsRatio.toFixed(2)} x n)`,
        );

        expect(sortCmp).toBeGreaterThanOrEqual(0.5 * nLogN);
        expect(sortCmp).toBeLessThanOrEqual(1.0 * nLogN);
        expect(qsCmp).toBeLessThanOrEqual(10 * n);
      });
    }
  }
});

describe('件数 1,000,000 の所要時間(目安のみ・合否の基準にしない)', () => {
  it('生成と両厳密解の問い合わせにかかった時間を出力する', { timeout: 60_000 }, () => {
    const n = 1_000_000;
    const t0 = performance.now();
    const data = makeData(n);
    const t1 = performance.now();
    const sortCmp = queryComparisons(createSortExact(), data);
    const t2 = performance.now();
    const qsCmp = queryComparisons(createQuickselectExact(QUICKSELECT_SEED), data);
    const t3 = performance.now();
    console.log(
      `[timing] n=${n}: generate=${(t1 - t0).toFixed(0)}ms, sort(insert+query)=${(t2 - t1).toFixed(0)}ms, ` +
        `quickselect(insert+query)=${(t3 - t2).toFixed(0)}ms, total=${(t3 - t0).toFixed(0)}ms`,
    );
    // 時間には閾値を置かない。動作の健全性として比較回数が正であることだけを確認する
    expect(sortCmp).toBeGreaterThan(0);
    expect(qsCmp).toBeGreaterThan(0);
  });
});
