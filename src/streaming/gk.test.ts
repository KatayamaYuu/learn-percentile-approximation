import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isParamRecord, rankError, runConformance } from '../core';
import { EPSILON_RANGE, createGk, gkSpec, type GkSketch } from './gk';

const RUNS = { numRuns: 200, seed: 20261101 } as const;

function make(epsilon: number): GkSketch {
  const r = createGk({ epsilon });
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function insertAll(s: GkSketch, values: readonly number[]): void {
  for (const v of values) {
    const r = s.insert(v);
    if (!r.ok) throw new Error(`insert(${v}) failed: ${JSON.stringify(r.error)}`);
  }
}

function q(s: GkSketch, quantile: number): number {
  const r = s.query(quantile);
  if (!r.ok) throw new Error(`query(${quantile}) failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** ε = 0.25 では圧縮の周期が 2、閾値が floor(n / 2) になる */
const SMALL_EPS = 0.25;

describe('ε の検証(1.1、1.2)', () => {
  it('許容範囲は 0.0001 以上 0.5 以下', () => {
    expect(EPSILON_RANGE).toEqual({ min: 0.0001, max: 0.5 });
  });

  it.each([0.0001, 0.001, 0.25, 0.5])('境界と内側の値 %s は作成できる', (epsilon) => {
    expect(createGk({ epsilon }).ok).toBe(true);
    expect(gkSpec({ epsilon }).ok).toBe(true);
  });

  it.each([
    ['下限未満', 0.00009],
    ['上限超過', 0.51],
    ['0', 0],
    ['負', -0.1],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('%s の ε は epsilon を原因とする設定の誤りになり、作成しない', (_label, epsilon) => {
    for (const r of [createGk({ epsilon }), gkSpec({ epsilon })]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('invalid-config');
        expect(r.error.field).toBe('epsilon');
        expect(r.error.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('数値でない ε(文字列・undefined)も epsilon の設定の誤りになる', () => {
    for (const epsilon of ['0.1', undefined, null]) {
      const r = createGk({ epsilon } as unknown as { epsilon: number });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe('epsilon');
    }
  });
});

describe('投入: 挿入時の順位の幅(1.3)', () => {
  it('両端への挿入は順位の幅 0、内側は後続タプルの g + 順位の幅 − 1', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [10, 20, 15, 12]);
    // 12 の挿入後の圧縮で 15 が 20 に併合される
    expect(s.inspect().tuples).toEqual([
      { value: 10, g: 1, delta: 0 },
      { value: 12, g: 1, delta: 0 },
      { value: 20, g: 2, delta: 0 },
    ]);
    // 15 は後続 20(g=2, Δ=0)の前に入るので Δ = 2 + 0 − 1 = 1。圧縮の周期ではない(n = 5)
    insertAll(s, [15]);
    expect(s.inspect().tuples).toEqual([
      { value: 10, g: 1, delta: 0 },
      { value: 12, g: 1, delta: 0 },
      { value: 15, g: 1, delta: 1 },
      { value: 20, g: 2, delta: 0 },
    ]);
  });

  it('同値は既存の同値の後ろに入る', () => {
    const s = make(0.0001);
    insertAll(s, [5, 7, 5]);
    // 後ろに入るので、新しい 5 の後続は 7(g=1, Δ=0)で Δ = 0
    expect(s.inspect().tuples.map((t) => t.value)).toEqual([5, 5, 7]);
    insertAll(s, [7]);
    // 新しい 7 は最大値の後ろ(末尾)なので Δ = 0
    expect(s.inspect().tuples).toEqual([
      { value: 5, g: 1, delta: 0 },
      { value: 5, g: 1, delta: 0 },
      { value: 7, g: 1, delta: 0 },
      { value: 7, g: 1, delta: 0 },
    ]);
  });

  it('値が既存のタプルと等しいとき、等しいタプルの後ろに入り、後続のタプルから順位の幅を決める', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [10, 20, 15, 12, 15]);
    // 状態は [10, 12, 15(Δ=1), 20(g=2)]。n = 5 は圧縮の周期ではない
    // 12 を足すと、既存の 12 の後ろ(15 の前)に入り、Δ = 15 の g + Δ − 1 = 1。
    // 前に入る(既存の 12 の前)なら Δ = 12 の g + Δ − 1 = 0 になって区別できる
    insertAll(s, [12]);
    // n = 6 の圧縮: 20 に 15 を併合(1+2+0 ≤ 3)、新しい 12 は 3 < 4 で併合できず、
    // 古い 12 を新しい 12 に併合(1+1+1 ≤ 3)
    expect(s.inspect().tuples).toEqual([
      { value: 10, g: 1, delta: 0 },
      { value: 12, g: 2, delta: 1 },
      { value: 20, g: 3, delta: 0 },
    ]);
  });

  it('観察結果に投入件数と ε が入る', () => {
    const s = make(SMALL_EPS);
    expect(s.inspect()).toEqual({ algorithm: 'gk', epsilon: SMALL_EPS, count: 0, tuples: [] });
    insertAll(s, [3, 1, 2]);
    const state = s.inspect();
    expect(state.algorithm).toBe('gk');
    expect(state.epsilon).toBe(SMALL_EPS);
    expect(state.count).toBe(3);
  });
});

describe('圧縮(1.5)', () => {
  it('周期ごとに右から左へ併合され、先頭は併合されない', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [10, 20, 15, 12, 15, 30]);
    // n = 6、閾値 3: 30 に 20 が併合(2+1+0 ≤ 3)、15 に 12 が併合(1+1+1 ≤ 3)
    expect(s.inspect().tuples).toEqual([
      { value: 10, g: 1, delta: 0 },
      { value: 15, g: 2, delta: 1 },
      { value: 30, g: 3, delta: 0 },
    ]);
  });

  it('圧縮でタプル数が投入件数より少なくなる', () => {
    const s = make(0.1);
    insertAll(s, Array.from({ length: 200 }, (_, i) => i + 1));
    const state = s.inspect();
    expect(state.count).toBe(200);
    expect(state.tuples.length).toBeLessThan(200);
    expect(state.tuples.reduce((a, t) => a + t.g, 0)).toBe(200);
  });

  it('周期は ⌊1/(2ε)⌋ で、切り上げではない(ε = 0.3 は毎回、ε = 0.5 も毎回)', () => {
    const s = make(0.3);
    const sizes: number[] = [];
    for (const v of [1, 2, 3, 4, 5]) {
      insertAll(s, [v]);
      sizes.push(s.inspect().tuples.length);
    }
    // ⌊1/0.6⌋ = 1 なので毎回圧縮する。n = 4(閾値 2)で 3 が 4 に併合、n = 5(閾値 3)で 4 が 5 に併合。
    // 切り上げの 2 なら n = 5 は圧縮されず、タプル数は 4 になる
    expect(sizes).toEqual([1, 2, 3, 3, 3]);
    expect(s.inspect().tuples).toEqual([
      { value: 1, g: 1, delta: 0 },
      { value: 2, g: 1, delta: 0 },
      { value: 5, g: 3, delta: 0 },
    ]);
    // ε = 0.5 では 1/(2ε) = 1 で、n = 3(閾値 3)でも圧縮する(周期は 1 未満にならない)
    const half = make(0.5);
    const halfSizes: number[] = [];
    for (const v of [1, 2, 3, 4]) {
      insertAll(half, [v]);
      halfSizes.push(half.inspect().tuples.length);
    }
    expect(halfSizes).toEqual([1, 2, 2, 2]);
  });

  it('併合の閾値は ⌊2εn⌋ で、2εn が小数のとき切り上げた値までは併合しない', () => {
    const s = make(0.3);
    insertAll(s, [1, 2, 3]);
    // n = 3 では 2εn = 1.8、閾値 1。候補(2 を 3 に併合)の和は 1 + 1 + 0 = 2 で、切り上げた 2 に等しい。
    // 併合してはならない
    expect(s.inspect().tuples).toEqual([
      { value: 1, g: 1, delta: 0 },
      { value: 2, g: 1, delta: 0 },
      { value: 3, g: 1, delta: 0 },
    ]);
    insertAll(s, [4]);
    // n = 4 では 2εn = 2.4、閾値 2。3 を 4 に併合できるが、続く 2 の候補の和は 1 + 2 + 0 = 3(切り上げ値)で併合しない
    expect(s.inspect().tuples).toEqual([
      { value: 1, g: 1, delta: 0 },
      { value: 2, g: 1, delta: 0 },
      { value: 4, g: 2, delta: 0 },
    ]);
  });

  it('周期より前では圧縮しない', () => {
    const s = make(0.01);
    insertAll(s, Array.from({ length: 49 }, (_, i) => i + 1));
    expect(s.inspect().tuples.length).toBe(49);
  });
});

describe('問い合わせ(1.3、1.4)', () => {
  it('分位点 0 は最小値、1 は最大値', () => {
    const s = make(0.1);
    insertAll(s, [8, 3, 9, 1, 7, 5, 2, 6, 4, 10, 11, 12, 13]);
    expect(q(s, 0)).toBe(1);
    expect(q(s, 1)).toBe(13);
  });

  it('圧縮後のタプルから、最大順位が目標順位 + εn を超える最初のタプルの1つ前の値を返す', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [10, 20, 15, 12, 15, 30]);
    // 目標順位 3、εn = 1.5。タプル 15 の最大順位 4 ≤ 4.5、タプル 30 の最大順位 6 > 4.5
    expect(q(s, 0.5)).toBe(15);
    expect(q(s, 1)).toBe(30);
  });

  it('最大順位がちょうど 目標順位 + εn のタプルは超過とみなさず、その先まで進む', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [1, 2, 3, 4]);
    // 状態は [1(g=1), 2(g=1), 4(g=2)]、εn = 1。
    // 分位点 0.25: 目標順位 1、上限 2。値 2 の最大順位 2 は超過ではない(超過は 4 の最大順位 4)ので 2 を返す
    expect(q(s, 0.25)).toBe(2);
    // 分位点 0.75: 目標順位 3、上限 4。値 4 の最大順位 4 も超過ではないので、末尾まで進んで 4 を返す
    expect(q(s, 0.75)).toBe(4);
    const t = make(SMALL_EPS);
    insertAll(t, [1, 2, 3, 4, 5, 6, 7, 8]);
    // εn = 2。分位点 0.25 の目標順位 2、上限 4。値 4 の最大順位がちょうど 4
    expect(q(t, 0.25)).toBe(4);
  });

  it('単一の値では全分位点がその値', () => {
    const s = make(0.1);
    insertAll(s, [42]);
    for (const quantile of [0, 0.3, 1]) expect(q(s, quantile)).toBe(42);
  });

  it('問い合わせは調べたタプルごとに比較 1、移動は 0、分位点 0 は比較 0', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [10, 20, 15, 12, 15, 30]);
    const before = s.operationCounts();
    expect(q(s, 0)).toBe(10);
    expect(s.operationCounts()).toEqual(before);
    q(s, 0.5);
    // 先頭・15・30 の 3 タプルを調べる
    expect(s.operationCounts()).toEqual({ comparisons: before.comparisons + 3, moves: before.moves });
  });

  it('許容幅の中で、任意の ε・データ・挿入順序の順位誤差が ε 以下で、推定値は投入済みの値(property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0.5, 0.25, 0.1, 0.05, 0.01, 0.001),
        fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 400 }),
        (epsilon, data) => {
          const s = make(epsilon);
          insertAll(s, data);
          const sorted = Float64Array.from(data).sort();
          const set = new Set(data);
          let sum = 0;
          const state = s.inspect();
          for (const t of state.tuples) sum += t.g;
          expect(sum).toBe(data.length);
          const limit = Math.max(1, Math.floor(2 * epsilon * data.length));
          for (const t of state.tuples) expect(t.g + t.delta).toBeLessThanOrEqual(limit);
          expect(state.tuples[0]!.delta).toBe(0);
          expect(state.tuples[state.tuples.length - 1]!.delta).toBe(0);
          for (const quantile of [0, 0.01, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
            const estimate = q(s, quantile);
            expect(set.has(estimate)).toBe(true);
            const e = rankError(sorted, estimate, quantile);
            expect(e.ok).toBe(true);
            if (e.ok) expect(e.value).toBeLessThanOrEqual(epsilon);
          }
        },
      ),
      RUNS,
    );
  });
});

describe('エラーと状態不変(4.4、4.5)', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '不正な値 %s の投入は invalid-value で、状態も操作数も変えない',
    (bad) => {
      const s = make(SMALL_EPS);
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

  it('値域は制限しない(非常に小さい値・大きい値を受け付ける)', () => {
    const s = make(0.1);
    insertAll(s, [Number.MIN_VALUE, 1e308]);
    expect(q(s, 0)).toBe(Number.MIN_VALUE);
    expect(q(s, 1)).toBe(1e308);
  });

  it.each([-0.1, 1.1, Number.NaN])('範囲外の分位点 %s は quantile-out-of-range で、状態を変えない', (bad) => {
    const s = make(SMALL_EPS);
    insertAll(s, [3, 1, 2]);
    const state = s.inspect();
    const counts = s.operationCounts();
    const r = s.query(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('quantile-out-of-range');
    expect(s.inspect()).toEqual(state);
    expect(s.operationCounts()).toEqual(counts);
  });

  it('空の問い合わせは empty。分位点の範囲の検査が先', () => {
    const s = make(SMALL_EPS);
    const r = s.query(0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('empty');
    const bad = s.query(2);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe('quantile-out-of-range');
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
  });
});

describe('操作数(6.1、6.2)', () => {
  it('探索の比較、ずらし・書き込みの移動(タプルあたり3)、圧縮の比較と移動を数える', () => {
    const s = make(SMALL_EPS);
    s.insert(10);
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 3 });
    s.insert(20);
    // 探索の比較 1、書き込み 3。n = 2 で圧縮するが併合の候補はない
    expect(s.operationCounts()).toEqual({ comparisons: 1, moves: 6 });
    s.insert(15);
    // 探索の比較 2、20 のずらし 3、書き込み 3
    expect(s.operationCounts()).toEqual({ comparisons: 3, moves: 12 });
    s.insert(12);
    // 探索の比較 2、ずらし 6、書き込み 3、圧縮: 判定 2 回(比較 2)、併合で g を書き換え 1、詰め 3
    expect(s.operationCounts()).toEqual({ comparisons: 7, moves: 25 });
  });

  it('容量の拡張で、複製したタプルごとに移動 3 を数える', () => {
    const s = make(EPSILON_RANGE.min);
    // 初期容量 16 の間は拡張なし。昇順なので探索の末尾に書くだけで移動は件数 × 3
    insertAll(s, Array.from({ length: 16 }, (_, i) => i + 1));
    expect(s.operationCounts().moves).toBe(16 * 3);
    s.insert(17);
    // 17 件目で 16 タプルを複製(48)し、書き込み 3
    expect(s.operationCounts().moves).toBe(16 * 3 + 16 * 3 + 3);
  });

  it('inspect は操作数に数えず、状態を変えない', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [3, 1, 2, 5, 4]);
    const counts = s.operationCounts();
    const memory = s.memoryBytes();
    const a = s.inspect();
    expect(s.operationCounts()).toEqual(counts);
    expect(s.memoryBytes()).toBe(memory);
    expect(s.inspect()).toEqual(a);
  });
});

describe('メモリ見積もり(5.6、6.3)', () => {
  it('タプル数の 3 倍 + 1 個の 8 バイト', () => {
    const s = make(SMALL_EPS);
    expect(s.memoryBytes()).toBe(8);
    insertAll(s, [10, 20, 15, 12, 15, 30]);
    const tuples = s.inspect().tuples.length;
    expect(tuples).toBe(3);
    expect(s.memoryBytes()).toBe((tuples * 3 + 1) * 8);
  });
});

describe('観察結果は複製(5.5)', () => {
  it('観察結果を書き換えても内部状態に影響しない', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [3, 1, 2]);
    const state = s.inspect() as unknown as { tuples: { value: number; g: number; delta: number }[] };
    state.tuples[0]!.value = 999;
    state.tuples.pop();
    expect(s.inspect().tuples.map((t) => t.value)).toEqual([1, 2, 3]);
    expect(q(s, 0)).toBe(1);
  });

  it('JSON を通しても等しい', () => {
    const s = make(SMALL_EPS);
    insertAll(s, [3, 1, 2]);
    expect(JSON.parse(JSON.stringify(s.inspect()))).toEqual(s.inspect());
  });
});

describe('初期化と決定性(4.6、1.6)', () => {
  it('reset で ε を保ったまま空・操作数 0 に戻り、同じ入力で同じ結果になる', () => {
    const data = Array.from({ length: 120 }, (_, i) => ((i * 37) % 101) + 1);
    const s = make(0.05);
    insertAll(s, data);
    const first = {
      state: s.inspect(),
      counts: s.operationCounts(),
      memory: s.memoryBytes(),
      answers: [0, 0.5, 0.9, 1].map((x) => q(s, x)),
    };
    s.reset();
    expect(s.inspect()).toEqual({ algorithm: 'gk', epsilon: 0.05, count: 0, tuples: [] });
    expect(s.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    expect(s.memoryBytes()).toBe(8);
    const empty = s.query(0.5);
    expect(empty.ok).toBe(false);
    insertAll(s, data);
    expect({
      state: s.inspect(),
      counts: s.operationCounts(),
      memory: s.memoryBytes(),
      answers: [0, 0.5, 0.9, 1].map((x) => q(s, x)),
    }).toEqual(first);
  });

  it('別のインスタンスに同じ入力列を投入しても、同じ結果になる(乱数を使わない)', () => {
    const data = Array.from({ length: 300 }, (_, i) => ((i * 7919) % 1009) + 1);
    const a = make(0.02);
    const b = make(0.02);
    insertAll(a, data);
    insertAll(b, data);
    expect(a.inspect()).toEqual(b.inspect());
    expect(a.operationCounts()).toEqual(b.operationCounts());
    expect(a.memoryBytes()).toBe(b.memoryBytes());
    expect(q(a, 0.5)).toBe(q(b, 0.5));
  });
});

describe('生成仕様(4.1、4.3、4.7)', () => {
  it('識別子・表示名・パラメータを設計どおりに作り、値域は制限しない', () => {
    const r = gkSpec({ epsilon: 0.01 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('gk-eps-0.01');
    expect(r.value.label).toBe('GK(ε=0.01)');
    expect(r.value.params).toEqual({ algorithm: 'gk', epsilon: 0.01 });
    expect(isParamRecord(r.value.params)).toBe(true);
    expect(r.value.supportedRange).toBeUndefined();
  });

  it('create はシードを使わず、呼ぶたびに独立した空のインスタンスを返す', () => {
    const r = gkSpec({ epsilon: 0.1 });
    if (!r.ok) throw new Error('unexpected');
    const a = r.value.create(1);
    const b = r.value.create(999);
    a.insert(5);
    expect(b.query(0.5).ok).toBe(false);
    b.insert(5);
    expect(b.operationCounts()).toEqual(a.operationCounts());
  });

  it.each([0.1, 0.01, 0.0001, 0.5])('ε = %s で適合確認の失敗が 0 件(4.1)', (epsilon) => {
    const r = gkSpec({ epsilon });
    if (!r.ok) throw new Error('unexpected');
    expect(runConformance(r.value).failures).toEqual([]);
  });
});
