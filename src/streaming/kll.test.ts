import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OperationCounter, createRng, isParamRecord, runConformance } from '../core';
import { KLL_SHRINK, K_RANGE, createKll, kllSpec, type KllSketch, type KllState } from './kll';
import { sortWeighted } from './sort';

const RUNS = { numRuns: 100, seed: 20261102 } as const;

function make(k: number, seed?: number): KllSketch {
  const r = createKll(seed === undefined ? { k } : { k, seed });
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function insertAll(s: KllSketch, values: readonly number[]): void {
  for (const v of values) {
    const r = s.insert(v);
    if (!r.ok) throw new Error(`insert(${v}) failed: ${JSON.stringify(r.error)}`);
  }
}

function q(s: KllSketch, quantile: number): number {
  const r = s.query(quantile);
  if (!r.ok) throw new Error(`query(${quantile}) failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** from 以上 to 以下の整数を昇順に並べる */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** 乱数列の最初の n 回の nextIntBelow(2) の値(compaction が引く偶奇の期待値) */
function parities(seed: number, n: number): number[] {
  const r = createRng(seed);
  if (!r.ok) throw new Error('invalid seed');
  return Array.from({ length: n }, () => r.value.nextIntBelow(2));
}

function levelValues(state: KllState): number[][] {
  return state.levels.map((l) => [...l.values]);
}

/*
 * 手計算の基準: k = 8、1 から昇順に投入する。
 *  - 段数 H ごとの容量(上から k, ⌊2k/3⌋, …):
 *      H=1: [8]  H=2: [5, 8]  H=3: [3, 5, 8]  H=4: [2, 3, 5, 8]  H=5: [2, 2, 3, 5, 8](⌊8×16/81⌋ = 1 を下限 2 に引き上げ)
 *  - 乱数列の偶奇: シード 1 は 1,0,1,0,0,0,…  シード 5 は 0,1,0,1,1,1,…  シード 7 は 0,0,1,0,1,1,…
 *  - n = 9: 保持 9 > 容量の合計 8 で最初の compaction。段 0 は 9 個(奇数)→ 最小の 1 を残し、
 *    残り 2..9 の 8 個から 4 個を段 1 へ(偶奇 1 なら 3,5,7,9、偶奇 0 なら 2,4,6,8)。H=2、容量 [5, 8]
 *  - n = 17: 段 0 は 1 + 8 = 9 個、段 1 は 4 個で保持 13 = 容量の合計 13。超えていないので compaction しない
 *  - n = 18: 保持 14 > 13。段 0(10 個 ≥ 5)を compaction。偶数なので全部が対象(1,10,…,18)。
 *    偶奇 0(2 回目)で 1,11,13,15,17 が段 1 へ。段 1 = [3,5,7,9,1,11,13,15,17]
 *  - n = 23: 段 0 = [19..23](5 個 = 容量 5)、段 1 は 9 個(≥ 8)で保持 14 > 13。
 *    容量以上の最も下の段は段 0。奇数なので最小の 19 を残し、20..23 から偶奇 1(3 回目)で 21,23 を段 1 へ
 *  - n = 25: 段 0 = [19,24,25]、段 1 は 11 個で保持 14 > 13。段 0 は 3 < 5、段 1 は 11 ≥ 8 で最上段なので段を足す(H=3)。
 *    段 1 の整列: 1,3,5,7,9,11,13,15,17,21,23。奇数なので最小の 1 を残し、偶奇 0(4 回目)で 3,7,11,15,21 を段 2 へ
 */
describe('k の検証(2.1、2.2)', () => {
  it('許容範囲は 8 以上 65536 以下、縮小率は 2/3', () => {
    expect(K_RANGE).toEqual({ min: 8, max: 65536 });
    expect(KLL_SHRINK).toBe(2 / 3);
  });

  it.each([8, 9, 200, 65535, 65536])('境界と内側の k = %s は作成できる', (k) => {
    expect(createKll({ k }).ok).toBe(true);
    expect(kllSpec({ k }).ok).toBe(true);
  });

  it.each([
    ['下限未満', 7],
    ['上限超過', 65537],
    ['0', 0],
    ['負', -8],
    ['小数', 8.5],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('%s の k は k を原因とする設定の誤りになり、作成しない', (_label, k) => {
    for (const r of [createKll({ k }), kllSpec({ k })]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('invalid-config');
        expect(r.error.field).toBe('k');
        expect(r.error.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('数値でない k(文字列・undefined・null)も k の設定の誤りになる', () => {
    for (const k of ['8', undefined, null]) {
      const r = createKll({ k } as unknown as { k: number });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe('k');
      const s = kllSpec({ k } as unknown as { k: number });
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.error.field).toBe('k');
    }
  });
});

describe('シードの検証(2.2、2.7)', () => {
  it.each([0, 1, 5, 4294967295])('境界と内側のシード %s は作成できる', (seed) => {
    expect(createKll({ k: 8, seed }).ok).toBe(true);
  });

  it.each([
    ['-1', -1],
    ['2^32', 2 ** 32],
    ['2^32 を超える', 2 ** 32 + 5],
    ['小数', 1.5],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('不正なシード(%s)は seed を原因とする設定の誤りになり、作成しない', (_label, seed) => {
    const r = createKll({ k: 8, seed });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid-config');
      expect(r.error.field).toBe('seed');
      expect(r.error.reason.length).toBeGreaterThan(0);
    }
  });

  it('数値でないシード(文字列・null)も seed の設定の誤りになる', () => {
    for (const seed of ['1', null]) {
      const r = createKll({ k: 8, seed } as unknown as { k: number; seed: number });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe('seed');
    }
  });

  it('k とシードの両方が不正なら、k を原因として返す', () => {
    const r = createKll({ k: 7, seed: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('k');
  });

  it('生成仕様の create に不正なシードが渡されると例外を投げる。境界の 0 と 2^32 − 1 は投げない', () => {
    const r = kllSpec({ k: 8 });
    if (!r.ok) throw new Error('unexpected');
    for (const seed of [-1, 2 ** 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => r.value.create(seed)).toThrow();
    }
    expect(() => r.value.create(0)).not.toThrow();
    expect(() => r.value.create(4294967295)).not.toThrow();
  });

  it('省略したシードは 1 と同じ結果になり、5 とは異なる', () => {
    const data = range(1, 9);
    const omitted = make(8);
    const one = make(8, 1);
    const five = make(8, 5);
    insertAll(omitted, data);
    insertAll(one, data);
    insertAll(five, data);
    expect(omitted.inspect()).toEqual(one.inspect());
    expect(omitted.inspect()).not.toEqual(five.inspect());
  });

  it('省略したシードは 1: 長い入力でも 1 と等しく、隣り合うシード 0・2 とは異なる', () => {
    const data = Array.from({ length: 600 }, (_, i) => ((i * 7919) % 1013) + 1);
    const state = (seed?: number): string => {
      const s = make(8, seed);
      insertAll(s, data);
      return JSON.stringify(s.inspect());
    };
    expect(state()).toBe(state(1));
    expect(state()).not.toBe(state(0));
    expect(state()).not.toBe(state(2));
  });
});

describe('段の容量と段の追加(2.1、2.6)', () => {
  it('乱数の偶奇の前提(シード 1 は 1,0,1,0、シード 5 は 0,1,0,1、シード 7 は 0,0,1,0)', () => {
    expect(parities(1, 4)).toEqual([1, 0, 1, 0]);
    expect(parities(5, 4)).toEqual([0, 1, 0, 1]);
    expect(parities(7, 4)).toEqual([0, 0, 1, 0]);
  });

  it('作成直後は段 0 が 1 つだけで、容量は k', () => {
    const state = make(8).inspect();
    expect(state).toEqual({
      algorithm: 'kll',
      k: 8,
      count: 0,
      compactions: 0,
      levels: [{ level: 0, weight: 1, capacity: 8, values: [] }],
    });
  });

  it('保持要素数が容量の合計と等しい間は compaction せず、1 つ超えた投入で最初の compaction が起きる', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 8));
    expect(s.inspect().compactions).toBe(0);
    expect(s.inspect().levels.length).toBe(1);
    expect(levelValues(s.inspect())).toEqual([range(1, 8)]);
    insertAll(s, [9]);
    const state = s.inspect();
    expect(state.compactions).toBe(1);
    expect(state.levels.length).toBe(2);
  });

  it('最上段の compaction で段が足される。容量は足したあとの段数で最上段から数え直す(k = 8、H = 2)', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 9));
    // H = 2: [⌊8×2/3⌋ = 5(切り上げの 6 ではない), 8]
    expect(s.inspect().levels.map((l) => l.capacity)).toEqual([5, 8]);
    expect(s.inspect().levels.map((l) => l.weight)).toEqual([1, 2]);
    expect(s.inspect().levels.map((l) => l.level)).toEqual([0, 1]);
  });

  it('下位の段の compaction では段は足されない(n = 23 で H = 2 のまま、n = 25 で H = 3)', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 23));
    expect(s.inspect().levels.length).toBe(2);
    expect(s.inspect().compactions).toBe(3);
    insertAll(s, range(24, 25));
    expect(s.inspect().levels.length).toBe(3);
    expect(s.inspect().levels.map((l) => l.capacity)).toEqual([3, 5, 8]);
    expect(s.inspect().compactions).toBe(4);
  });

  it('k = 8 の容量の表(H = 1〜6)。切り捨て、下限 2、最上段は k', () => {
    const expected: Record<number, number[]> = {
      1: [8],
      2: [5, 8],
      3: [3, 5, 8],
      4: [2, 3, 5, 8],
      5: [2, 2, 3, 5, 8],
      6: [2, 2, 2, 3, 5, 8],
    };
    const s = make(8, 3);
    const seen = new Set<number>();
    for (let i = 1; i <= 6000 && seen.size < 6; i++) {
      s.insert(((i * 7919) % 6007) + 1);
      const caps = s.inspect().levels.map((l) => l.capacity);
      const h = caps.length;
      if (h <= 6 && !seen.has(h)) {
        seen.add(h);
        expect(caps).toEqual(expected[h]);
      }
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('k = 100 の容量: H = 3 は [44, 66, 100](66.67 の切り上げ 67、44.44 の切り上げ 45 ではない)', () => {
    const s = make(100, 2);
    for (let i = 1; s.inspect().levels.length < 3; i++) s.insert(i);
    expect(s.inspect().levels.map((l) => l.capacity)).toEqual([44, 66, 100]);
  });

  it('k = 65536 の最上段は k、その1つ下は 43690', () => {
    const s = make(65536, 2);
    // 保持 65537 個目で最初の compaction(段が 2 つになる)
    insertAll(s, range(1, 65537));
    expect(s.inspect().levels.map((l) => l.capacity)).toEqual([43690, 65536]);
  });

  it('保持要素数は常に容量の合計以下で、容量の合計は 3k + 2H 以下', () => {
    const s = make(8, 4);
    for (let i = 1; i <= 3000; i++) {
      s.insert(((i * 31) % 997) + 1);
      const state = s.inspect();
      const retained = state.levels.reduce((a, l) => a + l.values.length, 0);
      const caps = state.levels.reduce((a, l) => a + l.capacity, 0);
      expect(retained).toBeLessThanOrEqual(caps);
      expect(caps).toBeLessThanOrEqual(3 * 8 + 2 * state.levels.length);
    }
  });
});

describe('投入と compaction(2.3、2.4)', () => {
  it('段 0 の末尾に投入順に書き、投入件数が増える', () => {
    const s = make(8, 1);
    insertAll(s, [5, 3, 9]);
    const state = s.inspect();
    expect(state.count).toBe(3);
    expect(levelValues(state)).toEqual([[5, 3, 9]]);
  });

  it('奇数個の compaction は最小の要素を残す(降順の投入でも最小の 1 が残る)。シード 1 は偶奇 1', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 9).reverse());
    const state = s.inspect();
    expect(state.compactions).toBe(1);
    // 残りは 2..9 の 8 個。偶奇 1 は 1 番目、3 番目、… = 3,5,7,9
    expect(levelValues(state)).toEqual([[1], [3, 5, 7, 9]]);
  });

  it('偶奇 0(シード 5)は 0 番目、2 番目、… = 2,4,6,8 を送る。最小の 1 は残る', () => {
    const s = make(8, 5);
    insertAll(s, range(1, 9).reverse());
    expect(levelValues(s.inspect())).toEqual([[1], [2, 4, 6, 8]]);
  });

  it('整列してから選ぶ(投入順がばらばらでも昇順の偶数番目・奇数番目を送る)', () => {
    const s = make(8, 1);
    insertAll(s, [4, 9, 1, 7, 3, 8, 2, 6, 5]);
    expect(levelValues(s.inspect())).toEqual([[1], [3, 5, 7, 9]]);
  });

  it('重みの合計が投入件数と等しい(段の重みと要素数の積の合計)', () => {
    const s = make(8, 1);
    for (let i = 1; i <= 200; i++) {
      s.insert(((i * 53) % 211) + 1);
      const state = s.inspect();
      const weighted = state.levels.reduce((a, l) => a + l.weight * l.values.length, 0);
      expect(weighted).toBe(i);
      expect(state.count).toBe(i);
    }
  });

  it('n = 17 までは 2 回目の compaction をしない(合計が容量の合計と等しいだけでは起きない)', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 17));
    const state = s.inspect();
    expect(state.compactions).toBe(1);
    expect(levelValues(state)).toEqual([[1, ...range(10, 17)], [3, 5, 7, 9]]);
  });

  it('n = 18: 偶数個の compaction は全部が対象で、最小の要素も残さない。偶奇 0 の 0, 2, … 番目を送る', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 18));
    const state = s.inspect();
    expect(state.compactions).toBe(2);
    // 段 0 は空。段 1 は送られてきた順に末尾へ(元の 3,5,7,9 のあとに 1,11,13,15,17)
    expect(levelValues(state)).toEqual([[], [3, 5, 7, 9, 1, 11, 13, 15, 17]]);
  });

  it('n = 23: 容量と等しい段 0 が、容量以上の最も下の段として選ばれる(段 1 の 9 個 ≥ 8 より先)', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 23));
    const state = s.inspect();
    expect(state.compactions).toBe(3);
    // 段 0 の 19..23 は奇数個なので 19 が残り、20..23 の偶奇 1 番目から 21, 23 が段 1 の末尾へ
    expect(levelValues(state)).toEqual([[19], [3, 5, 7, 9, 1, 11, 13, 15, 17, 21, 23]]);
  });

  it('n = 25: 段 1(最上段)の compaction で段が足され、最小の 1 が残り、偶奇 0 の 3,7,11,15,21 が段 2 へ', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    const state = s.inspect();
    expect(state.compactions).toBe(4);
    expect(levelValues(state)).toEqual([[19, 24, 25], [1], [3, 7, 11, 15, 21]]);
    expect(state.levels.map((l) => l.weight)).toEqual([1, 2, 4]);
    expect(state.levels.map((l) => l.capacity)).toEqual([3, 5, 8]);
    expect(state.count).toBe(25);
    expect(3 * 1 + 1 * 2 + 5 * 4).toBe(25);
  });
});

describe('問い合わせ(2.5)', () => {
  /** n = 25 の状態: 段 0 = [19,24,25](重み 1)、段 1 = [1](重み 2)、段 2 = [3,7,11,15,21](重み 4) */
  function state25(): KllSketch {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    return s;
  }

  it('重みの累計(2,6,10,14,18,19,23,24,25 で値は 1,3,7,11,15,19,21,24,25)が目標順位以上になる最初の値を返す', () => {
    const s = state25();
    // 目標順位 = nearestRank(25, q)
    expect(q(s, 0)).toBe(1); // 順位 1 → 累計 2 の 1
    expect(q(s, 0.04)).toBe(1); // 順位 1
    expect(q(s, 0.5)).toBe(11); // 順位 13 → 累計 14 の 11
    expect(q(s, 1)).toBe(25); // 順位 25
  });

  it('累計が目標順位とちょうど等しい要素を選ぶ(累計 > 目標順位ではない)', () => {
    const s = state25();
    expect(q(s, 0.08)).toBe(1); // 順位 2、累計 2 の 1
    expect(q(s, 0.24)).toBe(3); // 順位 6、累計 6 の 3
    expect(q(s, 0.72)).toBe(15); // 順位 18、累計 18 の 15
    expect(q(s, 0.76)).toBe(19); // 順位 19、累計 19 の 19(重み 1)
    expect(q(s, 0.92)).toBe(21); // 順位 23、累計 23 の 21
  });

  it('累計が目標順位を1つ超えたところ(順位 = 累計 + 1)は次の要素を選ぶ', () => {
    const s = state25();
    expect(q(s, 0.28)).toBe(7); // 順位 7、累計 6 の次(累計 10 の 7)
    expect(q(s, 0.96)).toBe(24); // 順位 24、累計 24 の 24
  });

  it('重みは 2^段数: 段 2 の要素は重み 4 で数える(重み 1 や 2 では 11 にならない)', () => {
    const s = state25();
    expect(q(s, 0.4)).toBe(7); // 順位 10 → 累計 10 の 7
    expect(q(s, 0.44)).toBe(11); // 順位 11 → 累計 14 の 11
  });

  it('保持している値の中から選ぶ。n = 3 では単純な順位', () => {
    const s = make(8, 1);
    insertAll(s, [3, 1, 2]);
    expect(q(s, 0)).toBe(1);
    expect(q(s, 0.5)).toBe(2);
    expect(q(s, 1)).toBe(3);
  });

  it('1 件だけなら全分位点がその値', () => {
    const s = make(8, 1);
    insertAll(s, [7]);
    for (const x of [0, 0.5, 1]) expect(q(s, x)).toBe(7);
  });

  it('問い合わせは状態を変えない(内部状態・メモリ・以後の推定値)', () => {
    const s = state25();
    const before = s.inspect();
    const memory = s.memoryBytes();
    const answers = [0, 0.3, 0.5, 1].map((x) => q(s, x));
    expect(s.inspect()).toEqual(before);
    expect(s.memoryBytes()).toBe(memory);
    expect([0, 0.3, 0.5, 1].map((x) => q(s, x))).toEqual(answers);
  });

  it('問い合わせは乱数を消費しない(奇数回の問い合わせのあとも同じ compaction になる)', () => {
    const control = make(8, 1);
    insertAll(control, range(1, 25));
    const s = make(8, 1);
    insertAll(s, range(1, 8));
    for (let i = 0; i < 3; i++) q(s, 0.5);
    insertAll(s, range(9, 25));
    expect(s.inspect()).toEqual(control.inspect());
  });

  it('許容幅の中で、k = 200・n = 10,000 の順位誤差が 0.05 以下(固定シード)', () => {
    const n = 10000;
    // 1..n の決定的な並べ替え(n と互いに素な 7919 の倍数)
    const data = Array.from({ length: n }, (_, i) => ((i * 7919) % n) + 1);
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = make(200, seed);
      insertAll(s, data);
      for (const x of [0.01, 0.1, 0.5, 0.9, 0.99]) {
        // 値 = 順位なので、推定値と目標順位 ceil(x × n) の差が順位誤差
        expect(Math.abs(q(s, x) - Math.ceil(x * n)) / n).toBeLessThanOrEqual(0.05);
      }
    }
  });
});

describe('エラーと状態不変(4.4、4.5、2.2)', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '不正な値 %s の投入は invalid-value で、状態・操作数・メモリ見積もりを変えない',
    (bad) => {
      const s = make(8, 1);
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

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    '範囲外の分位点 %s は quantile-out-of-range で、状態・操作数を変えない',
    (bad) => {
      const s = make(8, 1);
      insertAll(s, [3, 1, 2]);
      const state = s.inspect();
      const counts = s.operationCounts();
      const memory = s.memoryBytes();
      const r = s.query(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('quantile-out-of-range');
      expect(s.inspect()).toEqual(state);
      expect(s.operationCounts()).toEqual(counts);
      expect(s.memoryBytes()).toBe(memory);
    },
  );

  it('分位点 0 と 1 は範囲内(境界)として受け付ける', () => {
    const s = make(8, 1);
    insertAll(s, [3, 1, 2]);
    expect(s.query(0).ok).toBe(true);
    expect(s.query(1).ok).toBe(true);
  });

  it('空の問い合わせは empty。分位点の範囲の検査が先で、どちらも操作数 0 のまま', () => {
    const s = make(8, 1);
    const empty = s.query(0.5);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe('empty');
    for (const bad of [2, -1, Number.NaN]) {
      const r = s.query(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('quantile-out-of-range');
    }
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.inspect().count).toBe(0);
  });

  it('拒否された入力・問い合わせ、inspect、memoryBytes は乱数列を進めない', () => {
    const control = make(8, 1);
    insertAll(control, range(1, 25));
    const s = make(8, 1);
    for (let round = 0; round < 3; round++) {
      s.insert(Number.NaN);
      s.insert(-5);
      s.query(2);
      s.query(0.5); // 空
      s.inspect();
      s.memoryBytes();
      s.operationCounts();
    }
    insertAll(s, range(1, 8));
    for (let round = 0; round < 3; round++) {
      s.insert(0);
      s.query(-1);
      s.inspect();
    }
    insertAll(s, range(9, 25));
    for (let round = 0; round < 3; round++) s.insert(Number.POSITIVE_INFINITY);
    expect(s.inspect()).toEqual(control.inspect());
    expect(s.operationCounts()).toEqual(control.operationCounts());
  });

  it('値域は制限しない(非常に小さい値・大きい値を受け付ける)', () => {
    const s = make(8, 1);
    insertAll(s, [Number.MIN_VALUE, 1e308]);
    expect(q(s, 0)).toBe(Number.MIN_VALUE);
    expect(q(s, 1)).toBe(1e308);
  });

  it('推定値は常に有限の正の数', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 300));
    for (const x of [0, 0.001, 0.25, 0.5, 0.999, 1]) {
      const v = q(s, x);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('操作数(6.1、6.2)', () => {
  it('投入は段 0 への書き込みで移動 1。比較は 0', () => {
    const s = make(8, 1);
    s.insert(5);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 1 });
    s.insert(6);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 2 });
  });

  it('n = 9 の compaction: 整列(比較 20、移動 36)+ 送る 4 + 残す最小の書き戻し 1 + 投入 9', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 8));
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 8 });
    s.insert(9);
    // 昇順 9 個の併合整列: 幅 1 で比較 4・移動 9、幅 2 で 4・9、幅 4 で 4・9、幅 8 で 8・9。結果は入力側に戻る
    expect(s.operationCounts()).toEqual({ comparisons: 20, moves: 8 + 1 + 36 + 4 + 1 });
  });

  it('n = 18 の compaction(偶数 10 個): 整列(比較 21、移動 40)+ 送る 5。残す要素の書き戻しはない', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 17));
    expect(s.operationCounts()).toEqual({ comparisons: 20, moves: 50 + 8 });
    s.insert(18);
    expect(s.operationCounts()).toEqual({ comparisons: 20 + 21, moves: 58 + 1 + 40 + 5 });
  });

  it('問い合わせ: 集めて要素ごとに移動 2 + 重み付き整列 + 調べた要素ごとに比較 1(n = 3)', () => {
    const s = make(8, 1);
    insertAll(s, [3, 1, 2]);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 3 });
    // 集める移動 6、整列は比較 3・移動 12(幅 1 で 1・6、幅 2 で 2・6)、q = 0.5 は順位 2 で 2 要素を調べる
    q(s, 0.5);
    expect(s.operationCounts()).toEqual({ comparisons: 3 + 2, moves: 3 + 6 + 12 });
  });

  it('問い合わせの比較は調べた要素数ぶん(n = 4 で q = 1 は 4 要素、q = 0 は 1 要素)', () => {
    const sortCost = new OperationCounter();
    sortWeighted(Float64Array.from([1, 2, 3, 4]), Float64Array.from([1, 1, 1, 1]), 4, sortCost);
    const sorted = sortCost.snapshot();
    for (const [quantile, examined] of [
      [1, 4],
      [0, 1],
      [0.5, 2],
    ] as const) {
      const s = make(8, 1);
      insertAll(s, [1, 2, 3, 4]);
      const base = s.operationCounts();
      q(s, quantile);
      expect(s.operationCounts()).toEqual({
        comparisons: base.comparisons + sorted.comparisons + examined,
        moves: base.moves + 4 * 2 + sorted.moves,
      });
    }
  });

  it('n = 25 の問い合わせ: 集める 9 要素 × 2 + 同じ並びの重み付き整列の費用 + 調べた要素数', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    const base = s.operationCounts();
    q(s, 0.5); // 順位 13、並べ替え後 1,3,7,11 の 4 要素を調べる
    const after = s.operationCounts();
    // 集めた並び(段 0, 1, 2 の順。重みは 1, 2, 4)の整列費用を別の計数器で数える
    const sortCost = new OperationCounter();
    sortWeighted(
      Float64Array.from([19, 24, 25, 1, 3, 7, 11, 15, 21]),
      Float64Array.from([1, 1, 1, 2, 4, 4, 4, 4, 4]),
      9,
      sortCost,
    );
    const sorted = sortCost.snapshot();
    expect(after.comparisons - base.comparisons).toBe(sorted.comparisons + 4);
    expect(after.moves - base.moves).toBe(18 + sorted.moves);
  });

  it('inspect と memoryBytes は操作数に数えず、状態を変えない', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    const counts = s.operationCounts();
    const memory = s.memoryBytes();
    const a = s.inspect();
    expect(s.operationCounts()).toEqual(counts);
    expect(s.memoryBytes()).toBe(memory);
    expect(s.inspect()).toEqual(a);
  });
});

describe('メモリ見積もり(5.6、6.3)', () => {
  it('(保持要素数 + 段数 + 1)個の 8 バイト', () => {
    const s = make(8, 1);
    expect(s.memoryBytes()).toBe((0 + 1 + 1) * 8);
    insertAll(s, [3, 1, 2]);
    expect(s.memoryBytes()).toBe((3 + 1 + 1) * 8);
    // n = 25: 保持 3 + 1 + 5 = 9 個、段数 3
    const t = make(8, 1);
    insertAll(t, range(1, 25));
    expect(t.memoryBytes()).toBe((9 + 3 + 1) * 8);
  });

  it('観察結果の要素数と段数から同じ値が求まり、compaction の回数は含まれない', () => {
    const s = make(8, 2);
    for (let i = 1; i <= 500; i++) {
      s.insert(((i * 13) % 101) + 1);
      const state = s.inspect();
      const retained = state.levels.reduce((a, l) => a + l.values.length, 0);
      expect(s.memoryBytes()).toBe((retained + state.levels.length + 1) * 8);
    }
  });
});

describe('観察結果(5.2、5.4、5.5)', () => {
  it('段ごとの番号・重み・容量・保持順の値と、投入件数・k・compaction の回数', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    expect(s.inspect()).toEqual({
      algorithm: 'kll',
      k: 8,
      count: 25,
      compactions: 4,
      levels: [
        { level: 0, weight: 1, capacity: 3, values: [19, 24, 25] },
        { level: 1, weight: 2, capacity: 5, values: [1] },
        { level: 2, weight: 4, capacity: 8, values: [3, 7, 11, 15, 21] },
      ],
    });
  });

  it('観察結果を書き換えても内部状態と以後の推定値に影響しない', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    const answers = [0, 0.5, 1].map((x) => q(s, x));
    const state = s.inspect() as unknown as {
      count: number;
      levels: { values: number[]; capacity: number }[];
    };
    state.levels[0]!.values[0] = 999;
    state.levels[2]!.values.pop();
    state.levels.pop();
    state.levels[0]!.capacity = 1000;
    state.count = 0;
    const fresh = s.inspect();
    expect(fresh.count).toBe(25);
    expect(levelValues(fresh)).toEqual([[19, 24, 25], [1], [3, 7, 11, 15, 21]]);
    expect(fresh.levels[0]!.capacity).toBe(3);
    expect([0, 0.5, 1].map((x) => q(s, x))).toEqual(answers);
    // 書き換えのあとの投入も、書き換えていない場合と同じ
    const control = make(8, 1);
    insertAll(control, range(1, 25));
    insertAll(s, range(26, 60));
    insertAll(control, range(26, 60));
    expect(s.inspect()).toEqual(control.inspect());
  });

  it('JSON を通しても等しい', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    expect(JSON.parse(JSON.stringify(s.inspect()))).toEqual(s.inspect());
  });

  it('観察結果で 重み × 要素数 の合計が投入件数に等しい', () => {
    const s = make(8, 6);
    insertAll(s, Array.from({ length: 777 }, (_, i) => ((i * 97) % 389) + 1));
    const state = s.inspect();
    expect(state.levels.reduce((a, l) => a + l.weight * l.values.length, 0)).toBe(777);
    expect(state.count).toBe(777);
  });
});

describe('同じシードと違うシード(2.7、2.8)', () => {
  const data = Array.from({ length: 400 }, (_, i) => ((i * 7919) % 1013) + 1);

  it('同じ k・シード・入力で、推定値・操作数・メモリ・内部状態がすべて等しい', () => {
    const a = make(8, 42);
    const b = make(8, 42);
    insertAll(a, data);
    insertAll(b, data);
    expect(a.inspect()).toEqual(b.inspect());
    expect(a.operationCounts()).toEqual(b.operationCounts());
    expect(a.memoryBytes()).toBe(b.memoryBytes());
    expect([0, 0.25, 0.5, 0.9, 1].map((x) => q(a, x))).toEqual([0, 0.25, 0.5, 0.9, 1].map((x) => q(b, x)));
  });

  it('シードだけを変えると、選ばれる要素(内部状態)が変わる(シード 1 と 5 は最初の偶奇が違う)', () => {
    const a = make(8, 1);
    const b = make(8, 5);
    insertAll(a, range(1, 9));
    insertAll(b, range(1, 9));
    expect(levelValues(a.inspect())).toEqual([[1], [3, 5, 7, 9]]);
    expect(levelValues(b.inspect())).toEqual([[1], [2, 4, 6, 8]]);
    // 重みの合計と段の構造は同じ
    expect(a.inspect().levels.map((l) => l.values.length)).toEqual(b.inspect().levels.map((l) => l.values.length));
  });

  it('シードを変えると長い入力でも内部状態が異なる', () => {
    const states = [1, 2, 3, 4, 5].map((seed) => {
      const s = make(8, seed);
      insertAll(s, data);
      return JSON.stringify(s.inspect());
    });
    expect(new Set(states).size).toBeGreaterThan(1);
  });
});

describe('初期化(4.6)', () => {
  it('reset で k を保ったまま空・操作数 0 に戻る', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25));
    s.reset();
    expect(s.inspect()).toEqual({
      algorithm: 'kll',
      k: 8,
      count: 0,
      compactions: 0,
      levels: [{ level: 0, weight: 1, capacity: 8, values: [] }],
    });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(16);
    const e = s.query(0.5);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.kind).toBe('empty');
  });

  it('reset で乱数列も同じシードで作り直され、同じ入力で作成直後と同じ結果になる', () => {
    const s = make(8, 1);
    insertAll(s, range(1, 25)); // 4 回の偶奇を引く
    const first = {
      state: s.inspect(),
      counts: s.operationCounts(),
      memory: s.memoryBytes(),
      answers: [0, 0.5, 1].map((x) => q(s, x)),
    };
    s.reset();
    insertAll(s, range(1, 25));
    expect({
      state: s.inspect(),
      counts: s.operationCounts(),
      memory: s.memoryBytes(),
      answers: [0, 0.5, 1].map((x) => q(s, x)),
    }).toEqual(first);
    // 偶奇の消費が 1 回ぶん(奇数回)ずれても検出できるよう、途中で reset する場合も確かめる
    const t = make(8, 1);
    insertAll(t, range(1, 9)); // 偶奇を 1 回引いた(1)
    t.reset();
    insertAll(t, range(1, 9));
    expect(levelValues(t.inspect())).toEqual([[1], [3, 5, 7, 9]]);
  });

  it('reset のあとの結果は、別のインスタンスと同じ', () => {
    const data = Array.from({ length: 300 }, (_, i) => ((i * 31) % 211) + 1);
    const a = make(8, 9);
    insertAll(a, data);
    a.reset();
    insertAll(a, data);
    const b = make(8, 9);
    insertAll(b, data);
    expect(a.inspect()).toEqual(b.inspect());
    expect(a.operationCounts()).toEqual(b.operationCounts());
  });
});

describe('生成仕様(4.1、4.3、4.7)', () => {
  it('識別子・表示名・パラメータを設計どおりに作り、値域は制限しない', () => {
    const r = kllSpec({ k: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('kll-k-200');
    expect(r.value.label).toBe('KLL(k=200)');
    expect(r.value.params).toEqual({ algorithm: 'kll', k: 200, c: 2 / 3 });
    expect(Object.keys(r.value.params ?? {})).toEqual(['algorithm', 'k', 'c']);
    expect(isParamRecord(r.value.params)).toBe(true);
    expect(r.value.supportedRange).toBeUndefined();
  });

  it('create(seed) はシードごとに createKll と同じ振る舞いで、呼ぶたびに独立した空のインスタンスを返す', () => {
    const r = kllSpec({ k: 8 });
    if (!r.ok) throw new Error('unexpected');
    const a = r.value.create(5);
    const b = r.value.create(5);
    const direct = make(8, 5);
    insertAll(direct, range(1, 9));
    for (let i = 1; i <= 9; i++) a.insert(i);
    expect((a as KllSketch).inspect()).toEqual(direct.inspect());
    expect(b.query(0.5).ok).toBe(false);
    const c = r.value.create(1) as KllSketch;
    for (let i = 1; i <= 9; i++) c.insert(i);
    expect(levelValues(c.inspect())).toEqual([[1], [3, 5, 7, 9]]);
    expect(levelValues((a as KllSketch).inspect())).toEqual([[1], [2, 4, 6, 8]]);
  });

  it.each([8, 200, 65536])('k = %s で適合確認の失敗が 0 件(4.1)', (k) => {
    const r = kllSpec({ k });
    if (!r.ok) throw new Error('unexpected');
    expect(runConformance(r.value).failures).toEqual([]);
  });
});

describe('性質テスト(fast-check、シード固定)', () => {
  const values = fc.array(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 600 });
  const params = fc.record({
    k: fc.integer({ min: 8, max: 64 }),
    seed: fc.integer({ min: 0, max: 4294967295 }),
    values,
  });

  it('重みの合計 = 投入件数、保持要素数 ≤ 容量の合計 ≤ 3k + 2H(各投入のあと)', () => {
    fc.assert(
      fc.property(params, ({ k, seed, values: vs }) => {
        const s = make(k, seed);
        let n = 0;
        for (const v of vs) {
          s.insert(v);
          n++;
          const state = s.inspect();
          const weighted = state.levels.reduce((a, l) => a + l.weight * l.values.length, 0);
          const retained = state.levels.reduce((a, l) => a + l.values.length, 0);
          const caps = state.levels.reduce((a, l) => a + l.capacity, 0);
          if (weighted !== n || state.count !== n) return false;
          if (retained > caps || caps > 3 * k + 2 * state.levels.length) return false;
        }
        return true;
      }),
      RUNS,
    );
  });

  it('推定値は投入済みの値のいずれかで、分位点について単調非減少、最小・最大の範囲内', () => {
    fc.assert(
      fc.property(params, ({ k, seed, values: vs }) => {
        const s = make(k, seed);
        insertAll(s, vs);
        const set = new Set(vs);
        let prev = 0;
        for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          const v = q(s, x);
          if (!set.has(v) || v < prev) return false;
          prev = v;
        }
        return true;
      }),
      RUNS,
    );
  });

  it('同じ入力と同じシードで、推定値・操作数・メモリ・観察結果が等しい', () => {
    fc.assert(
      fc.property(params, ({ k, seed, values: vs }) => {
        const a = make(k, seed);
        const b = make(k, seed);
        insertAll(a, vs);
        insertAll(b, vs);
        return (
          JSON.stringify(a.inspect()) === JSON.stringify(b.inspect()) &&
          JSON.stringify(a.operationCounts()) === JSON.stringify(b.operationCounts()) &&
          a.memoryBytes() === b.memoryBytes() &&
          q(a, 0.5) === q(b, 0.5)
        );
      }),
      RUNS,
    );
  });
});
