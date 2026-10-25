import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OperationCounter, isParamRecord, runConformance } from '../core';
import { SCALE_FUNCTIONS, type ScaleFunctionKind } from './scale';
import { sortValues } from './sort';
import {
  COMPRESSION_RANGE,
  createTDigest,
  tdigestSpec,
  type TDigestSketch,
  type TDigestState,
} from './tdigest';

const RUNS = { numRuns: 100, seed: 20261103 } as const;

function make(compression: number, scale: ScaleFunctionKind = 'k0'): TDigestSketch {
  const r = createTDigest({ compression, scale });
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function insertAll(s: TDigestSketch, values: readonly number[]): void {
  for (const v of values) {
    const r = s.insert(v);
    if (!r.ok) throw new Error(`insert(${v}) failed: ${JSON.stringify(r.error)}`);
  }
}

function q(s: TDigestSketch, quantile: number): number {
  const r = s.query(quantile);
  if (!r.ok) throw new Error(`query(${quantile}) failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** from 以上 to 以下の整数を昇順に並べる */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function weightsOf(state: TDigestState): number[] {
  return state.centroids.map((c) => c.weight);
}

function meansOf(state: TDigestState): number[] {
  return state.centroids.map((c) => c.mean);
}

/** 昇順に並んだ values を共通の整列で並べたときの操作数(整列の部分だけを期待値に使う) */
function sortCost(values: readonly number[]): { comparisons: number; moves: number } {
  const counter = new OperationCounter();
  sortValues(Float64Array.from(values), values.length, counter);
  return counter.snapshot();
}

/*
 * 手計算の基準: 圧縮パラメータ δ = 10、スケール関数 k0。バッファ容量は ⌈5 × 10⌉ = 50。
 *  - k0 の上限は qLeft + 2/δ = qLeft + 0.2。右端 (確定した重み + 現在の重み + 次の重み) / n が上限以下なら加える
 *  - n = 10(1 から 10 を昇順に投入して問い合わせ): 幅 0.2 × 10 = 2 件ずつ。
 *    (1,2) → (3,4) → (5,6) → (7,8) → (9,10)。平均値 1.5、3.5、5.5、7.5、9.5、重みはすべて 2
 *    判定: 2 件目の右端 2/10 = 0.2 ≤ 0.2(等号で加える)、3 件目の右端 3/10 > 0.2(確定)
 *  - n = 49(1 から 49): 幅 0.2 × 49 = 9.8 → 9 件。2 つ目は qLeft = 9/49 から上限 0.3837 × 49 = 18.8 → 合計 18 まで。
 *    以下 27、36、45。重み [9, 9, 9, 9, 9, 4]、平均値 [5, 14, 23, 32, 41, 47.5]
 *  - 折れ線の点(n = 49): (0, 1)、(4.5, 5)、(13.5, 14)、(22.5, 23)、(31.5, 32)、(40.5, 41)、(47, 47.5)、(49, 49)
 */
describe('δ とスケール関数の検証(3.1、3.3)', () => {
  it('許容範囲は 10 以上 10000 以下', () => {
    expect(COMPRESSION_RANGE).toEqual({ min: 10, max: 10000 });
  });

  it.each([10, 10.5, 100, 9999.5, 10000])('境界と内側の δ = %s は作成できる', (compression) => {
    for (const scale of SCALE_FUNCTIONS) {
      expect(createTDigest({ compression, scale }).ok).toBe(true);
      expect(tdigestSpec({ compression, scale }).ok).toBe(true);
    }
  });

  it.each([
    ['下限未満', 9.99],
    ['下限未満(整数)', 9],
    ['上限超過', 10000.5],
    ['上限超過(整数)', 10001],
    ['0', 0],
    ['負', -10],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('%s の δ は compression を原因とする設定の誤りになり、作成しない', (_label, compression) => {
    for (const r of [createTDigest({ compression, scale: 'k1' }), tdigestSpec({ compression, scale: 'k1' })]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('invalid-config');
        expect(r.error.field).toBe('compression');
        expect(r.error.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('数値でない δ(文字列・undefined・null)も compression の設定の誤りになる', () => {
    for (const compression of ['100', undefined, null]) {
      const options = { compression, scale: 'k0' } as unknown as { compression: number; scale: 'k0' };
      for (const r of [createTDigest(options), tdigestSpec(options)]) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.field).toBe('compression');
      }
    }
  });

  it('スケール関数は k0・k1・k2 の 3 種で、それ以外は scale を原因とする設定の誤りになる', () => {
    expect([...SCALE_FUNCTIONS]).toEqual(['k0', 'k1', 'k2']);
    for (const scale of SCALE_FUNCTIONS) {
      expect(createTDigest({ compression: 100, scale }).ok).toBe(true);
    }
    for (const scale of ['k3', 'K0', '', 'k', undefined, null, 0, 1]) {
      const options = { compression: 100, scale } as unknown as { compression: number; scale: 'k0' };
      for (const r of [createTDigest(options), tdigestSpec(options)]) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.kind).toBe('invalid-config');
          expect(r.error.field).toBe('scale');
          expect(r.error.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('δ とスケール関数の両方が不正なら、δ を原因として返す', () => {
    const options = { compression: 9, scale: 'k9' } as unknown as { compression: number; scale: 'k0' };
    for (const r of [createTDigest(options), tdigestSpec(options)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe('compression');
    }
  });
});

describe('投入(3.4、3.5、3.6、6.1)', () => {
  it('作成直後は空で、観察結果は最小値・最大値が null', () => {
    const s = make(10, 'k2');
    expect(s.inspect()).toEqual({
      algorithm: 'tdigest',
      compression: 10,
      scale: 'k2',
      count: 0,
      min: null,
      max: null,
      buffered: 0,
      centroids: [],
    });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
  });

  it('投入した値はバッファに入り、最小値・最大値と投入件数が更新される', () => {
    const s = make(10);
    insertAll(s, [5, 3, 8]);
    expect(s.inspect()).toEqual({
      algorithm: 'tdigest',
      compression: 10,
      scale: 'k0',
      count: 3,
      min: 3,
      max: 8,
      buffered: 3,
      centroids: [],
    });
  });

  it('1 件ごとの操作数: 比較 2、バッファへの書き込み 1、更新した最小値・最大値の書き込みを移動として数える', () => {
    const s = make(10);
    s.insert(5); // 最小値と最大値の両方を更新
    expect(s.operationCounts()).toEqual({ comparisons: 2, moves: 3 });
    s.insert(3); // 最小値だけ更新
    expect(s.operationCounts()).toEqual({ comparisons: 4, moves: 5 });
    s.insert(7); // 最大値だけ更新
    expect(s.operationCounts()).toEqual({ comparisons: 6, moves: 7 });
    s.insert(4); // どちらも更新しない
    expect(s.operationCounts()).toEqual({ comparisons: 8, moves: 8 });
  });

  it('最小値・最大値と等しい値は更新と数えない(移動はバッファへの 1 だけ)', () => {
    const s = make(10);
    insertAll(s, [5, 5]);
    expect(s.operationCounts()).toEqual({ comparisons: 4, moves: 4 });
    expect(s.inspect().min).toBe(5);
    expect(s.inspect().max).toBe(5);
    insertAll(s, [3, 3, 9, 9]);
    // 3 の 2 回目、9 の 2 回目は更新しない: 移動 = バッファ 6 + 最小値 2(5, 3) + 最大値 2(5, 9)
    expect(s.operationCounts()).toEqual({ comparisons: 12, moves: 10 });
  });

  it('範囲の大きな値も受け入れる(値域を制限しない)', () => {
    const s = make(10);
    insertAll(s, [Number.MIN_VALUE, Number.MAX_VALUE, 1]);
    expect(s.inspect().min).toBe(Number.MIN_VALUE);
    expect(s.inspect().max).toBe(Number.MAX_VALUE);
  });

  it('δ = 10 ではバッファ容量 50 で、49 件まではまとめず、50 件目でまとめる(満杯で >=)', () => {
    const s = make(10);
    insertAll(s, range(1, 49));
    expect(s.inspect().buffered).toBe(49);
    expect(s.inspect().centroids).toEqual([]);
    const before = s.operationCounts();
    s.insert(50);
    const state = s.inspect();
    expect(state.buffered).toBe(0);
    expect(state.count).toBe(50);
    // n = 50: 幅 0.2 × 50 = 10 件ずつ
    expect(weightsOf(state)).toEqual([10, 10, 10, 10, 10]);
    expect(meansOf(state)).toEqual([5.5, 15.5, 25.5, 35.5, 45.5]);
    // 50 件目の費用 = 通常の投入(比較 2、移動 2: バッファと最大値)+ 整列 + 判定 49 回の比較 + centroid 5 個の書き出し 10
    const sort = sortCost(range(1, 50));
    const after = s.operationCounts();
    expect(after.comparisons - before.comparisons).toBe(2 + sort.comparisons + 49);
    expect(after.moves - before.moves).toBe(2 + sort.moves + 10);
  });

  it('容量は圧縮パラメータの 5 倍の切り上げ(δ = 10.5 なら 53)', () => {
    const s = make(10.5);
    insertAll(s, range(1, 52));
    expect(s.inspect().buffered).toBe(52);
    expect(s.inspect().centroids).toEqual([]);
    s.insert(53);
    const state = s.inspect();
    expect(state.buffered).toBe(0);
    expect(state.centroids.reduce((a, c) => a + c.weight, 0)).toBe(53);
    const spec = tdigestSpec({ compression: 10.5, scale: 'k0' });
    if (!spec.ok) throw new Error('unexpected');
    expect(spec.value.params).toMatchObject({ bufferCapacity: 53 });
  });

  it('容量の切り上げ: δ = 10.1 なら 51(切り捨てなら 50)', () => {
    const s = make(10.1);
    insertAll(s, range(1, 50));
    expect(s.inspect().buffered).toBe(50);
    s.insert(51);
    expect(s.inspect().buffered).toBe(0);
  });

  it('まとめたあとも新しい値はバッファにたまり、重みの合計 + バッファ件数 = 投入件数', () => {
    const s = make(10);
    insertAll(s, range(1, 50));
    insertAll(s, [60, 61, 62]);
    const state = s.inspect();
    expect(state.buffered).toBe(3);
    expect(state.count).toBe(53);
    expect(state.centroids.reduce((a, c) => a + c.weight, 0) + state.buffered).toBe(53);
    expect(state.max).toBe(62);
  });
});

describe('まとめ(3.4、3.5、6.2)', () => {
  it('n = 10, k0: 2 件ずつ(等号で加え、超える手前で確定する)', () => {
    const s = make(10);
    insertAll(s, range(1, 10));
    expect(s.operationCounts()).toEqual({ comparisons: 20, moves: 21 });
    q(s, 0.5);
    const state = s.inspect();
    expect(state.buffered).toBe(0);
    expect(meansOf(state)).toEqual([1.5, 3.5, 5.5, 7.5, 9.5]);
    expect(weightsOf(state)).toEqual([2, 2, 2, 2, 2]);
  });

  it('問い合わせでまとめる費用は、その問い合わせの操作数に含まれる(整列 + 判定 9 + 書き出し 10 + 調べた点 3)', () => {
    const s = make(10);
    insertAll(s, range(1, 10));
    const sort = sortCost(range(1, 10));
    expect(sort).toEqual({ comparisons: 21, moves: 40 });
    q(s, 0.5);
    // 比較: 投入 20 + 整列 21 + 判定 9(最初の項目は判定なし)+ 点 3(目標位置 5 は 3 つ目の centroid の位置)
    // 移動: 投入 21 + 整列 40 + 書き出し 10
    expect(s.operationCounts()).toEqual({ comparisons: 20 + 21 + 9 + 3, moves: 21 + 40 + 10 });
  });

  it('まとめたあとの問い合わせは、調べた点の比較だけを数え、移動は数えない', () => {
    const s = make(10);
    insertAll(s, range(1, 10));
    q(s, 0.5);
    const base = s.operationCounts();
    q(s, 0.5); // 目標位置 5: 点 3 つ目で到達
    expect(s.operationCounts()).toEqual({ comparisons: base.comparisons + 3, moves: base.moves });
    q(s, 1); // 目標位置 10: centroid 5 つ + 最後の点 = 6
    expect(s.operationCounts()).toEqual({ comparisons: base.comparisons + 3 + 6, moves: base.moves });
    q(s, 0); // 目標位置 0: 最初の centroid で到達
    expect(s.operationCounts()).toEqual({ comparisons: base.comparisons + 3 + 6 + 1, moves: base.moves });
  });

  it('既存の centroid とバッファの値を値の順に合わせる: n = 40, k0 の 2 回目のまとめ', () => {
    // 1 回目: n = 10 で 5 つの centroid(平均値 1.5、3.5、5.5、7.5、9.5、重み 2)
    // 2 回目: 11 から 40 を追加して n = 40。幅 0.2 × 40 = 8
    //   (1.5,2) + (3.5,2) + (5.5,2) + (7.5,2) = 重み 8 → 右端 8/40 = 0.2 で等号 → 平均値 4.5。(9.5,2) を足すと 10/40 > 0.2
    //   qLeft = 8/40 = 0.2、上限 0.4: (9.5,2) + 11〜16 = 重み 8、平均値 (19 + 81) / 8 = 12.5。17 を足すと 17/40 > 0.4
    //   以下 17〜24(20.5)、25〜32(28.5)、33〜40(36.5)
    const s = make(10);
    insertAll(s, range(1, 10));
    q(s, 0.5);
    insertAll(s, range(11, 40));
    expect(s.inspect().buffered).toBe(30);
    expect(weightsOf(s.inspect())).toEqual([2, 2, 2, 2, 2]);
    const before = s.operationCounts();
    expect(before).toEqual({ comparisons: 53 + 60, moves: 71 + 60 });
    q(s, 0.5);
    const state = s.inspect();
    expect(state.buffered).toBe(0);
    expect(weightsOf(state)).toEqual([8, 8, 8, 8, 8]);
    expect(meansOf(state)).toEqual([4.5, 12.5, 20.5, 28.5, 36.5]);
    expect(state.min).toBe(1);
    expect(state.max).toBe(40);
    // 費用: 整列(昇順の 30 件)+ 先頭同士の比較 5(centroid 5 つがすべて 11 以下)
    //   + 判定 34(35 項目のうち最初を除く)+ 調べた点 3(目標位置 20 は 3 つ目の位置)、移動は整列 + 書き出し 10
    const sort = sortCost(range(11, 40));
    const after = s.operationCounts();
    expect(after.comparisons - before.comparisons).toBe(sort.comparisons + 5 + 34 + 3);
    expect(after.moves - before.moves).toBe(sort.moves + 10);
    expect(q(s, 0.5)).toBe(20.5);
  });

  it('先頭同士の比較: 値が小さいほうを先に読む(バッファの値が既存の centroid の間に入る)', () => {
    // n = 10 の centroid(平均値 1.5、3.5、5.5、7.5、9.5)に 2 と 8 を足す: n = 12、幅 0.2 × 12 = 2.4
    //  読む順は 1.5(2)、2(1)、3.5(2)、5.5(2)、7.5(2)、8(1)、9.5(2)
    //  先頭同士の比較: 1.5 対 2、3.5 対 2、3.5 対 8、5.5 対 8、7.5 対 8、9.5 対 8、(バッファが尽きたので以降は比較なし)= 6
    //  貪欲: (1.5,2) + (2,1) = 3/12 = 0.25 > 0.2 → 確定。次の上限 qLeft = 2/12 から
    const s = make(10);
    insertAll(s, range(1, 10));
    q(s, 0.5);
    insertAll(s, [8, 2]);
    const before = s.operationCounts();
    q(s, 0);
    const state = s.inspect();
    // (1.5,2) 確定。qLeft = 2/12 = 0.1667、上限 0.3667(4.4 件)
    //   (2,1) + (3.5,2) = 3 → 右端 5/12 = 0.4167 > 0.3667?  判定は確定した重み 2 + 現在 1 + 次 2 = 5 件 → 超える → (2,1) 確定
    //   qLeft = 3/12 = 0.25、上限 0.45(5.4 件): (3.5,2) + (5.5,2) = 4 → 7/12 = 0.5833 > 0.45 → (3.5,2) 確定
    //   qLeft = 5/12、上限 0.6167(7.4 件): (5.5,2) + (7.5,2) → 9/12 = 0.75 > → (5.5,2) 確定
    //   qLeft = 7/12、上限 0.7833(9.4 件): (7.5,2) + (8,1) = 3 → 10/12 = 0.8333 > → (7.5,2) 確定
    //   qLeft = 9/12 = 0.75、上限 0.95(11.4 件): (8,1) + (9.5,2) → 12/12 = 1 > → (8,1) 確定、(9.5,2) 確定
    expect(meansOf(state)).toEqual([1.5, 2, 3.5, 5.5, 7.5, 8, 9.5]);
    expect(weightsOf(state)).toEqual([2, 1, 2, 2, 2, 1, 2]);
    const sort = sortCost([2, 8]);
    const after = s.operationCounts();
    // 比較: 整列 + 先頭同士 6 + 判定 6(7 項目)+ 調べた点 1(目標位置 0)
    expect(after.comparisons - before.comparisons).toBe(sort.comparisons + 6 + 6 + 1);
    expect(after.moves - before.moves).toBe(sort.moves + 14);
  });

  it('同値の読み順: 既存の centroid を先に、バッファの値を後に読む', () => {
    // n = 10 の centroid に 5.5 を 1 件足す。5.5 は centroid (5.5,2) と同値。n = 11、幅 2.2、qLeft = 4/11 から 0.5636(6.2 件)
    //   (3.5,2) 確定 → (5.5,2) から始め、次の (5.5,1) を足して右端 (4 + 2 + 1) / 11 = 0.636 > 0.5636 で確定
    //   centroid が先: (5.5,2)、(5.5,1)。バッファが先なら (5.5,1)、(5.5,2)
    const s = make(10);
    insertAll(s, range(1, 10));
    q(s, 0.5);
    s.insert(5.5);
    q(s, 0.5);
    expect(meansOf(s.inspect())).toEqual([1.5, 3.5, 5.5, 5.5, 7.5, 9.5]);
    expect(weightsOf(s.inspect())).toEqual([2, 2, 2, 1, 2, 2]);
  });

  it('向きは常に昇順: 大きい値から投入しても、centroid は平均値の昇順で同じ分割になる', () => {
    const asc = make(10);
    const desc = make(10);
    insertAll(asc, range(1, 49));
    insertAll(desc, range(1, 49).reverse());
    q(asc, 0.5);
    q(desc, 0.5);
    expect(desc.inspect()).toEqual(asc.inspect());
    expect(meansOf(desc.inspect())).toEqual([5, 14, 23, 32, 41, 47.5]);
  });

  it('n = 49, k0: 重み [9, 9, 9, 9, 9, 4]、平均値 [5, 14, 23, 32, 41, 47.5]', () => {
    const s = make(10);
    insertAll(s, range(1, 49));
    q(s, 0.5);
    const state = s.inspect();
    expect(weightsOf(state)).toEqual([9, 9, 9, 9, 9, 4]);
    expect(meansOf(state)).toEqual([5, 14, 23, 32, 41, 47.5]);
  });

  it('スケール関数による違い(n = 49, δ = 10): 先頭の centroid の重みは k0 が 9、k1 が 4、k2 が 1', () => {
    // k0: 0.2 × 49 = 9.8 → 9。k1: 上限 sin²(π/10) = 0.0955、× 49 = 4.68 → 4。k2: 左端 0 の上限は 0 なので 1 件だけ
    const firstWeight: Record<ScaleFunctionKind, number> = { k0: 9, k1: 4, k2: 1 };
    const all: Record<ScaleFunctionKind, number[]> = {
      k0: [9, 9, 9, 9, 9, 4],
      k1: [4, 11, 15, 12, 6, 1],
      k2: [1, 13, 29, 5, 1],
    };
    for (const scale of SCALE_FUNCTIONS) {
      const s = make(10, scale);
      insertAll(s, range(1, 49));
      q(s, 0.5);
      const weights = weightsOf(s.inspect());
      expect(weights[0]).toBe(firstWeight[scale]);
      expect(weights).toEqual(all[scale]);
      expect(weights.reduce((a, w) => a + w, 0)).toBe(49);
    }
  });

  it('k2 の上限は、バッファの件数でなく投入件数 n で決まる(既存の centroid があるときの 2 回目のまとめ)', () => {
    // 1 から 60 を投入して 1 回まとめ、61 から 70 を足して 2 回目をまとめる。2 回目は n = 70(バッファは 10 件)。
    // 先頭は左端 0 の上限が 0 なので重み 1。ほかは既存の centroid を分けずに読むので、重みは実装の出力を固定した値
    const s = make(10, 'k2');
    insertAll(s, range(1, 60));
    q(s, 0.5);
    insertAll(s, range(61, 70));
    q(s, 0.5);
    const weights = weightsOf(s.inspect());
    expect(weights).toEqual([1, 13, 46, 9, 1]);
    expect(weights.reduce((a, w) => a + w, 0)).toBe(70);
  });

  it('k0 は裾でも中央でも同じ大きさ、k1 は裾の centroid が中央より小さい', () => {
    const k0 = make(10, 'k0');
    const k1 = make(10, 'k1');
    insertAll(k0, range(1, 49));
    insertAll(k1, range(1, 49));
    q(k0, 0.5);
    q(k1, 0.5);
    const w0 = weightsOf(k0.inspect());
    const w1 = weightsOf(k1.inspect());
    expect(w1[0]!).toBeLessThan(w0[0]!);
    expect(w1[0]!).toBeLessThan(Math.max(...w1));
    expect(w0[0]).toBe(Math.max(...w0.slice(0, -1)));
  });

  it('各 centroid には少なくとも 1 項目が入る: 上限が左端に等しくても処理は進む(k2 の先頭)', () => {
    const s = make(10, 'k2');
    insertAll(s, range(1, 20));
    q(s, 0.5);
    const weights = weightsOf(s.inspect());
    expect(weights[0]).toBe(1);
    expect(weights.every((w) => w >= 1)).toBe(true);
    expect(weights.reduce((a, w) => a + w, 0)).toBe(20);
    expect(meansOf(s.inspect())[0]).toBe(1);
  });

  it('1 件だけの投入でも、問い合わせで重み 1 の centroid が 1 つできる', () => {
    const s = make(10, 'k2');
    s.insert(7);
    expect(q(s, 0.5)).toBe(7);
    expect(s.inspect().centroids).toEqual([{ mean: 7, weight: 1 }]);
  });
});

describe('問い合わせ(3.6、3.7、3.8、4.8)', () => {
  it('重み 1 の centroid だけなら、推定値は実データ(n = 3, δ = 10: 上限 0.6 件)', () => {
    const s = make(10);
    insertAll(s, [30, 10, 20]);
    expect(q(s, 0.5)).toBe(20); // 目標位置 1.5 は 2 つ目の点そのもの
    expect(weightsOf(s.inspect())).toEqual([1, 1, 1]);
    expect(meansOf(s.inspect())).toEqual([10, 20, 30]);
    expect(q(s, 1 / 6)).toBe(10); // 目標位置 0.5
  });

  it('2 点の間の線形補間(点: (0,10)、(0.5,10)、(1.5,20)、(2.5,30)、(3,30))', () => {
    const s = make(10);
    insertAll(s, [30, 10, 20]);
    expect(q(s, 0.25)).toBe(12.5); // 目標位置 0.75: (0.5,10) と (1.5,20) の間 = 10 + 10 × 0.25
    expect(q(s, 0.75)).toBe(27.5); // 目標位置 2.25: (1.5,20) と (2.5,30) の間 = 20 + 10 × 0.75
    expect(q(s, 0.1)).toBe(10); // 目標位置 0.3: (0,10) と (0.5,10) の間
    expect(q(s, 0.9)).toBe(30); // 目標位置 2.7: (2.5,30) と (3,30) の間
  });

  it('目標位置が点の位置と一致するときは、補間せずにその点の平均値をそのまま返す(丸め誤差を入れない)', () => {
    // 0.2 + (0.9 − 0.2) は 0.8999999999999999 になる。点: (0,0.2)、(0.5,0.2)、(1.5,0.9)、(2,0.9)
    const s = make(10);
    insertAll(s, [0.9, 0.2]);
    expect(q(s, 0.75)).toBe(0.9); // 目標位置 1.5
    expect(q(s, 0.25)).toBe(0.2); // 目標位置 0.5
  });

  it('始点 (0, 最小値) と終点 (n, 最大値) を通る: 先頭の centroid より前、末尾の centroid より後の補間', () => {
    // n = 49, k0。点: (0,1)、(4.5,5)、…、(47,47.5)、(49,49)
    const s = make(10);
    insertAll(s, range(1, 49));
    // 目標位置 2.45 = 0.05 × 49: (0,1) と (4.5,5) の間 = 1 + 4 × 2.45 / 4.5
    expect(q(s, 0.05)).toBeCloseTo(1 + (4 * 2.45) / 4.5, 10);
    // 目標位置 48.51 = 0.99 × 49: (47,47.5) と (49,49) の間 = 47.5 + 1.5 × 1.51 / 2
    expect(q(s, 0.99)).toBeCloseTo(47.5 + (1.5 * 1.51) / 2, 10);
  });

  it('centroid の間の補間(n = 49, k0)', () => {
    const s = make(10);
    insertAll(s, range(1, 49));
    // 目標位置 24.5: (22.5,23) と (31.5,32) の間 = 23 + 9 × 2 / 9 = 25
    expect(q(s, 0.5)).toBe(25);
    // 目標位置 12.25: (4.5,5) と (13.5,14) の間 = 5 + 9 × 7.75 / 9 = 12.75
    expect(q(s, 0.25)).toBeCloseTo(12.75, 10);
    // 目標位置 31.5(= 31.5 / 49 × 49)は 4 つ目の点そのもの
    expect(q(s, 31.5 / 49)).toBeCloseTo(32, 10);
  });

  it('分位点 0 は最小値、1 は最大値(バッファに残った値を含む)', () => {
    const s = make(10);
    insertAll(s, [4, 9, 2, 7]);
    expect(q(s, 0)).toBe(2);
    expect(q(s, 1)).toBe(9);
    const t = make(10, 'k1');
    insertAll(t, range(1, 200));
    expect(q(t, 0)).toBe(1);
    expect(q(t, 1)).toBe(200);
  });

  it('分位点 0・1 は小数の値でも最小値・最大値とぴったり等しい', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.001, max: 1000, noNaN: true }), { minLength: 1, maxLength: 200 }),
        fc.constantFrom(...SCALE_FUNCTIONS),
        (vs, scale) => {
          const s = make(10, scale);
          insertAll(s, vs);
          return q(s, 0) === Math.min(...vs) && q(s, 1) === Math.max(...vs);
        },
      ),
      RUNS,
    );
  });

  it('平均値の丸め誤差で最小値・最大値の外に出る場合も、最小値以上・最大値以下に収める', () => {
    // 同じ値 v を 49 件入れた centroid の平均値は、加重平均の丸めで v からずれる
    //   0.1 → 0.09999999999999999(最小値 0.1 より小さい)、0.7 → 0.7000000000000001(最大値 0.7 より大きい)
    for (const v of [0.1, 0.7]) {
      const s = make(10);
      insertAll(s, new Array<number>(49).fill(v));
      q(s, 0.5);
      expect(meansOf(s.inspect()).some((m) => m !== v)).toBe(true);
      for (const x of [0, 0.01, 0.2, 0.5, 0.8, 0.99, 1]) expect(q(s, x)).toBe(v);
    }
  });

  it('目標位置は 分位点 × 投入件数(件数 49 以外でも): n = 4 の重み 1 の centroid', () => {
    const s = make(10);
    insertAll(s, [1, 2, 3, 4]);
    // 点: (0,1)、(0.5,1)、(1.5,2)、(2.5,3)、(3.5,4)、(4,4)
    expect(q(s, 0.5)).toBe(2.5); // 目標位置 2: (1.5,2) と (2.5,3) の間
    expect(q(s, 0.625)).toBe(3); // 目標位置 2.5
    expect(q(s, 0.875)).toBe(4); // 目標位置 3.5
  });

  it('同じ状態に対して、分位点が大きいほど推定値は減らない', () => {
    for (const scale of SCALE_FUNCTIONS) {
      const s = make(10, scale);
      insertAll(s, range(1, 300).map((i) => ((i * 37) % 101) + 1));
      let prev = 0;
      for (let i = 0; i <= 100; i++) {
        const v = q(s, i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('問い合わせても投入済みの値の範囲と件数は変わらない', () => {
    const s = make(10);
    insertAll(s, [4, 9, 2, 7]);
    q(s, 0.5);
    const state = s.inspect();
    expect(state.count).toBe(4);
    expect(state.min).toBe(2);
    expect(state.max).toBe(9);
    expect(state.buffered).toBe(0);
    expect(state.centroids.reduce((a, c) => a + c.weight, 0)).toBe(4);
  });
});

describe('エラーと状態不変(4.4、4.5)', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '不正な値 %s の投入は invalid-value で、状態・操作数・メモリ見積もりを変えない',
    (bad) => {
      const s = make(10);
      insertAll(s, [3, 1, 2]);
      const state = s.inspect();
      const counts = s.operationCounts();
      const memory = s.memoryBytes();
      const r = s.insert(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid-value');
      expect(s.inspect()).toEqual(state);
      expect(s.operationCounts()).toEqual(counts);
      expect(s.memoryBytes()).toBe(memory);
    },
  );

  it('バッファが満杯の手前で不正な値が来ても、まとめない', () => {
    const s = make(10);
    insertAll(s, range(1, 49));
    const state = s.inspect();
    const counts = s.operationCounts();
    expect(s.insert(Number.NaN).ok).toBe(false);
    expect(s.inspect()).toEqual(state);
    expect(s.inspect().buffered).toBe(49);
    expect(s.operationCounts()).toEqual(counts);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '範囲外の分位点 %s は quantile-out-of-range で、バッファが残っていてもまとめず、状態・操作数を変えない',
    (bad) => {
      const s = make(10);
      insertAll(s, [3, 1, 2]);
      const state = s.inspect();
      const counts = s.operationCounts();
      const memory = s.memoryBytes();
      const r = s.query(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('quantile-out-of-range');
      expect(s.inspect()).toEqual(state);
      expect(s.inspect().buffered).toBe(3);
      expect(s.inspect().centroids).toEqual([]);
      expect(s.operationCounts()).toEqual(counts);
      expect(s.memoryBytes()).toBe(memory);
    },
  );

  it('空の状態の問い合わせは empty で、状態・操作数を変えない', () => {
    const s = make(10);
    const state = s.inspect();
    const r = s.query(0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('empty');
    expect(s.inspect()).toEqual(state);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(3 * 8);
  });

  it('検査の順は 分位点の範囲 → 空: 空でも範囲外の分位点は quantile-out-of-range', () => {
    const s = make(10);
    for (const bad of [-1, 2, Number.NaN]) {
      const r = s.query(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('quantile-out-of-range');
    }
    const edge = s.query(0);
    expect(edge.ok).toBe(false);
    if (!edge.ok) expect(edge.error.kind).toBe('empty');
    const top = s.query(1);
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.error.kind).toBe('empty');
  });

  it('境界の分位点 0 と 1 は有効', () => {
    const s = make(10);
    s.insert(5);
    expect(s.query(0).ok).toBe(true);
    expect(s.query(1).ok).toBe(true);
  });
});

describe('メモリ見積もり(5.6、6.3)', () => {
  it('(2 × centroid 数 + バッファ件数 + 3)個の 8 バイト', () => {
    const s = make(10);
    expect(s.memoryBytes()).toBe(3 * 8);
    insertAll(s, [3, 1, 2]);
    expect(s.memoryBytes()).toBe((0 + 3 + 3) * 8); // バッファ 3 件(まとめる前)
    q(s, 0.5);
    expect(s.memoryBytes()).toBe((2 * 3 + 0 + 3) * 8); // centroid 3 つ(n = 3 は上限 0.6 件で各 1)
    insertAll(s, [4, 5]);
    expect(s.memoryBytes()).toBe((2 * 3 + 2 + 3) * 8);
  });

  it('n = 49, k0 は centroid 6 つ: (12 + 0 + 3) × 8', () => {
    const s = make(10);
    insertAll(s, range(1, 49));
    expect(s.memoryBytes()).toBe((0 + 49 + 3) * 8);
    q(s, 0.5);
    expect(s.memoryBytes()).toBe((12 + 3) * 8);
  });

  it('観察結果の centroid 数とバッファ件数から同じ値が求まる', () => {
    const s = make(10, 'k1');
    for (let i = 1; i <= 300; i++) {
      s.insert(((i * 13) % 101) + 1);
      if (i % 37 === 0) q(s, 0.5);
      const state = s.inspect();
      expect(s.memoryBytes()).toBe((2 * state.centroids.length + state.buffered + 3) * 8);
    }
  });
});

describe('観察結果(5.3、5.4、5.5、5.6)', () => {
  it('バッファが残った状態で観察しても、centroid・バッファ件数・操作数・メモリ・推定値が変わらない', () => {
    const s = make(10);
    insertAll(s, range(1, 10));
    q(s, 0.5);
    insertAll(s, [20, 30, 40]);
    const counts = s.operationCounts();
    const memory = s.memoryBytes();
    const first = s.inspect();
    expect(first.buffered).toBe(3);
    expect(first.count).toBe(13);
    expect(first.max).toBe(40);
    expect(meansOf(first)).toEqual([1.5, 3.5, 5.5, 7.5, 9.5]);
    expect(weightsOf(first)).toEqual([2, 2, 2, 2, 2]);
    s.inspect();
    expect(s.inspect()).toEqual(first);
    expect(s.operationCounts()).toEqual(counts);
    expect(s.memoryBytes()).toBe(memory);
    // 観察した場合としなかった場合で、以後の推定値と操作数が同じ
    const other = make(10);
    insertAll(other, range(1, 10));
    q(other, 0.5);
    insertAll(other, [20, 30, 40]);
    expect(q(s, 0.7)).toBe(q(other, 0.7));
    expect(s.operationCounts()).toEqual(other.operationCounts());
    expect(s.inspect()).toEqual(other.inspect());
  });

  it('centroid の一覧は平均値と重みを値の順に、パラメータとともに返す', () => {
    const s = make(10, 'k1');
    insertAll(s, [30, 10, 20]);
    q(s, 0.5);
    expect(s.inspect()).toEqual({
      algorithm: 'tdigest',
      compression: 10,
      scale: 'k1',
      count: 3,
      min: 10,
      max: 30,
      buffered: 0,
      centroids: [
        { mean: 10, weight: 1 },
        { mean: 20, weight: 1 },
        { mean: 30, weight: 1 },
      ],
    });
  });

  it('JSON を往復しても同じ値になり、戻り値を書き換えてもアルゴリズムの状態に影響しない', () => {
    const s = make(10);
    insertAll(s, range(1, 49));
    q(s, 0.5);
    insertAll(s, [60, 70]);
    const state = s.inspect();
    expect(state.buffered).toBe(2);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const estimate = q(s, 0.3); // 問い合わせでまとめるので、観察結果はこのあとのもので比べる
    const expected = JSON.parse(JSON.stringify(s.inspect())) as TDigestState;
    const mutable = s.inspect() as unknown as {
      count: number;
      min: number | null;
      buffered: number;
      centroids: { mean: number; weight: number }[];
    };
    mutable.count = 0;
    mutable.min = -1;
    mutable.buffered = 99;
    mutable.centroids[0]!.mean = -5;
    mutable.centroids[0]!.weight = 1000;
    mutable.centroids.length = 0;
    expect(s.inspect()).toEqual(expected);
    expect(q(s, 0.3)).toBe(estimate);
  });

  it('重みの合計 + バッファ件数 = 投入件数(まとめの前後)', () => {
    const s = make(10, 'k2');
    for (let i = 1; i <= 120; i++) {
      s.insert(i);
      if (i % 29 === 0) q(s, 0.9);
      const state = s.inspect();
      expect(state.centroids.reduce((a, c) => a + c.weight, 0) + state.buffered).toBe(i);
      expect(state.count).toBe(i);
    }
  });
});

describe('初期化(4.6)', () => {
  it('パラメータを保ったまま、centroid・バッファ・最小値・最大値・件数・操作数を作成直後に戻す', () => {
    const s = make(10, 'k1');
    insertAll(s, range(1, 120));
    q(s, 0.5);
    insertAll(s, [200, 300]);
    s.reset();
    expect(s.inspect()).toEqual(make(10, 'k1').inspect());
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(make(10, 'k1').memoryBytes());
    const r = s.query(0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('empty');
  });

  it('初期化のあとは、作り直した場合と同じ結果・同じ操作数になる(バッファ容量も保たれる)', () => {
    const used = make(10.5, 'k2');
    insertAll(used, range(1, 70));
    used.reset();
    const fresh = make(10.5, 'k2');
    insertAll(used, range(1, 52));
    insertAll(fresh, range(1, 52));
    expect(used.inspect().buffered).toBe(52);
    used.insert(53);
    fresh.insert(53);
    expect(used.inspect().buffered).toBe(0);
    expect(used.inspect()).toEqual(fresh.inspect());
    expect(used.operationCounts()).toEqual(fresh.operationCounts());
    expect(q(used, 0.4)).toBe(q(fresh, 0.4));
    expect(used.inspect().scale).toBe('k2');
    expect(used.inspect().compression).toBe(10.5);
  });

  it('初期化のあとの最小値・最大値は前の値に引きずられない', () => {
    const s = make(10);
    insertAll(s, [1, 1000]);
    s.reset();
    insertAll(s, [50, 60]);
    expect(s.inspect().min).toBe(50);
    expect(s.inspect().max).toBe(60);
    expect(q(s, 0)).toBe(50);
    expect(q(s, 1)).toBe(60);
  });
});

describe('同じ入力で同じ結果(3.9)', () => {
  it('乱数を使わず、推定値・操作数・メモリ・観察結果が等しい', () => {
    const data = Array.from({ length: 400 }, (_, i) => ((i * 7919) % 1013) + 1);
    for (const scale of SCALE_FUNCTIONS) {
      const a = make(20, scale);
      const b = make(20, scale);
      insertAll(a, data);
      insertAll(b, data);
      expect(a.inspect()).toEqual(b.inspect());
      expect(a.operationCounts()).toEqual(b.operationCounts());
      expect(q(a, 0.37)).toBe(q(b, 0.37));
      expect(a.memoryBytes()).toBe(b.memoryBytes());
    }
  });
});

describe('生成仕様(4.1、4.3、4.7、5.3)', () => {
  it('識別子・表示名・パラメータ(バッファ容量を含む)を設計どおりに作り、値域は制限しない', () => {
    const r = tdigestSpec({ compression: 100, scale: 'k1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('tdigest-k1-c100');
    expect(r.value.label).toBe('t-digest(k1, δ=100)');
    expect(r.value.params).toEqual({ algorithm: 'tdigest', compression: 100, scale: 'k1', bufferCapacity: 500 });
    expect(Object.keys(r.value.params ?? {})).toEqual(['algorithm', 'compression', 'scale', 'bufferCapacity']);
    expect(isParamRecord(r.value.params)).toBe(true);
    expect(r.value.supportedRange).toBeUndefined();
  });

  it('スケール関数と δ ごとに識別子・表示名・バッファ容量が変わる', () => {
    const a = tdigestSpec({ compression: 10.5, scale: 'k0' });
    const b = tdigestSpec({ compression: 10000, scale: 'k2' });
    if (!a.ok || !b.ok) throw new Error('unexpected');
    expect(a.value.id).toBe('tdigest-k0-c10.5');
    expect(a.value.label).toBe('t-digest(k0, δ=10.5)');
    expect(a.value.params).toEqual({ algorithm: 'tdigest', compression: 10.5, scale: 'k0', bufferCapacity: 53 });
    expect(b.value.id).toBe('tdigest-k2-c10000');
    expect(b.value.label).toBe('t-digest(k2, δ=10000)');
    expect(b.value.params).toEqual({ algorithm: 'tdigest', compression: 10000, scale: 'k2', bufferCapacity: 50000 });
  });

  it('create はシードを使わず、呼ぶたびに独立した空のインスタンスを返す', () => {
    const r = tdigestSpec({ compression: 10, scale: 'k0' });
    if (!r.ok) throw new Error('unexpected');
    const a = r.value.create(1) as TDigestSketch;
    const b = r.value.create(2) as TDigestSketch;
    for (let i = 1; i <= 49; i++) a.insert(i);
    expect(b.query(0.5).ok).toBe(false);
    for (let i = 1; i <= 49; i++) b.insert(i);
    expect(a.inspect()).toEqual(b.inspect());
    const direct = make(10);
    insertAll(direct, range(1, 49));
    expect(a.inspect()).toEqual(direct.inspect());
    expect(a.query(0.5)).toEqual(direct.query(0.5));
    expect(a.operationCounts()).toEqual(direct.operationCounts());
  });

  it.each(SCALE_FUNCTIONS.flatMap((scale) => [10, 100].map((compression) => [scale, compression] as const)))(
    'スケール関数 %s、δ = %s で適合確認の失敗が 0 件(4.1)',
    (scale, compression) => {
      const r = tdigestSpec({ compression, scale });
      if (!r.ok) throw new Error('unexpected');
      expect(runConformance(r.value).failures).toEqual([]);
    },
  );
});

describe('性質テスト(fast-check、シード固定)', () => {
  const values = fc.array(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 400 });
  const params = fc.record({
    compression: fc.integer({ min: 10, max: 40 }),
    scale: fc.constantFrom(...SCALE_FUNCTIONS),
    values,
  });

  it('重みの合計 + バッファ件数 = 投入件数、centroid は平均値の昇順で重みは 1 以上(各投入と問い合わせのあと)', () => {
    fc.assert(
      fc.property(params, ({ compression, scale, values: vs }) => {
        const s = make(compression, scale);
        let n = 0;
        for (const v of vs) {
          s.insert(v);
          n++;
          if (n % 53 === 0) q(s, 0.5);
          const state = s.inspect();
          const total = state.centroids.reduce((a, c) => a + c.weight, 0) + state.buffered;
          if (total !== n || state.count !== n) return false;
          if (state.buffered >= Math.ceil(5 * compression)) return false;
          for (let i = 0; i < state.centroids.length; i++) {
            const c = state.centroids[i]!;
            if (c.weight < 1) return false;
            if (i > 0 && c.mean < state.centroids[i - 1]!.mean) return false;
          }
        }
        return true;
      }),
      RUNS,
    );
  });

  it('推定値は有限の正の数で [最小値, 最大値] に収まり、分位点について単調非減少', () => {
    fc.assert(
      fc.property(params, ({ compression, scale, values: vs }) => {
        const s = make(compression, scale);
        insertAll(s, vs);
        const lo = Math.min(...vs);
        const hi = Math.max(...vs);
        let prev = 0;
        for (let i = 0; i <= 40; i++) {
          const v = q(s, i / 40);
          if (!(Number.isFinite(v) && v > 0 && v >= lo && v <= hi && v >= prev)) return false;
          prev = v;
        }
        return true;
      }),
      RUNS,
    );
  });

  it('同じ入力で、推定値・操作数・メモリ・観察結果が等しい', () => {
    fc.assert(
      fc.property(params, ({ compression, scale, values: vs }) => {
        const a = make(compression, scale);
        const b = make(compression, scale);
        insertAll(a, vs);
        insertAll(b, vs);
        return (
          q(a, 0.5) === q(b, 0.5) &&
          JSON.stringify(a.inspect()) === JSON.stringify(b.inspect()) &&
          JSON.stringify(a.operationCounts()) === JSON.stringify(b.operationCounts()) &&
          a.memoryBytes() === b.memoryBytes()
        );
      }),
      RUNS,
    );
  });
});
