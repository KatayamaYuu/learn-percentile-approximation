import { describe, expect, it } from 'vitest';
import { createSortExact, generate, type OperationCounts, type PercentileSketch } from '../core';
import {
  createGk,
  createKll,
  createTDigest,
  type GkSketch,
  type GkTuple,
  type KllSketch,
  type TDigestSketch,
} from './index';

// 費用のテスト(6.1〜6.5)。操作数の単調性と引き起こした操作の増分、メモリ見積もりの増え方と式を確かめる。
// 期待値は本体のコードを使わず、設計の文言(GK の圧縮、KLL の compaction、t-digest のまとめ)から求める。
// 整列の移動の期待値は、設計と Implementation Notes に書いた数え方(書き戻しの移動も数える)に依存する。
// 数え方そのものを変えたときは、ここも合わせて直す。

function unwrap<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function uniform(count: number, seed = 11): Float64Array {
  return unwrap(generate({ distribution: { kind: 'uniform', min: 1, max: 1000 }, count, seed }));
}

function insertAll(sketch: PercentileSketch, data: Float64Array): void {
  for (const v of data) unwrap(sketch.insert(v));
}

/**
 * ボトムアップ併合整列の移動の数(データによらず決まる): 段ごとに全要素を 1 回ずつ書き、
 * 段数が奇数で結果が作業領域に残るときは書き戻しでもう 1 回書く。
 */
function sortMoves(length: number): number {
  let passes = 0;
  for (let width = 1; width < length; width *= 2) passes++;
  return length * passes + (passes % 2 === 1 ? length : 0);
}

/** ボトムアップ併合整列の比較の数(同値は左を先にする)。データから直接数える */
function sortComparisons(input: readonly number[]): number {
  let src = [...input];
  let comparisons = 0;
  for (let width = 1; width < src.length; width *= 2) {
    const dst: number[] = [];
    for (let start = 0; start < src.length; start += 2 * width) {
      const mid = Math.min(start + width, src.length);
      const end = Math.min(start + 2 * width, src.length);
      let i = start;
      let j = mid;
      while (i < mid && j < end) {
        comparisons++;
        dst.push(src[j]! < src[i]! ? src[j++]! : src[i++]!);
      }
      while (i < mid) dst.push(src[i++]!);
      while (j < end) dst.push(src[j++]!);
    }
    src = dst;
  }
  return comparisons;
}

function diff(now: OperationCounts, prev: OperationCounts): OperationCounts {
  return { comparisons: now.comparisons - prev.comparisons, moves: now.moves - prev.moves };
}

/** 操作数が非負の整数で、前より減っていないこと */
function expectCountsAdvance(prev: OperationCounts, now: OperationCounts): void {
  for (const key of ['comparisons', 'moves'] as const) {
    expect(Number.isInteger(now[key])).toBe(true);
    expect(now[key]).toBeGreaterThanOrEqual(0);
    expect(now[key]).toBeGreaterThanOrEqual(prev[key]);
  }
}

// ---------------------------------------------------------------------------
// 6.1: 操作数は非負の整数で減らない
// ---------------------------------------------------------------------------

describe('操作数は非負の整数で、投入と問い合わせのたびに減らない', () => {
  const makers: ReadonlyArray<readonly [string, () => PercentileSketch]> = [
    ['GK', () => unwrap(createGk({ epsilon: 0.05 }))],
    ['KLL', () => unwrap(createKll({ k: 8, seed: 3 }))],
    ['t-digest', () => unwrap(createTDigest({ compression: 10, scale: 'k1' }))],
  ];

  it.each(makers)('%s は作成直後 0 から、投入と問い合わせのたびに減らない', (_name, make) => {
    const sketch = make();
    let prev = sketch.operationCounts();
    expect(prev).toEqual({ comparisons: 0, moves: 0 });
    const quantiles = [0, 0.25, 0.5, 0.99, 1];
    let queries = 0;
    let grew = 0;
    for (const [i, v] of Array.from(uniform(1500)).entries()) {
      unwrap(sketch.insert(v));
      let now = sketch.operationCounts();
      expectCountsAdvance(prev, now);
      if (now.moves > prev.moves) grew++;
      prev = now;
      if (i % 7 === 0) {
        unwrap(sketch.query(quantiles[queries++ % quantiles.length]!));
        now = sketch.operationCounts();
        expectCountsAdvance(prev, now);
        prev = now;
      }
    }
    // 投入のたびに移動が増えている(少なくとも書き込み 1)
    expect(grew).toBe(1500);
  });

  it.each(makers)('%s は拒否された投入・問い合わせで操作数が変わらない', (_name, make) => {
    const sketch = make();
    insertAll(sketch, uniform(30));
    const before = sketch.operationCounts();
    expect(sketch.insert(-1).ok).toBe(false);
    expect(sketch.insert(Number.NaN).ok).toBe(false);
    expect(sketch.query(1.5).ok).toBe(false);
    expect(sketch.operationCounts()).toEqual(before);
  });

  it.each(makers)('%s の初期化で操作数は 0 に戻り、その後は再び増える', (_name, make) => {
    const sketch = make();
    insertAll(sketch, uniform(100));
    sketch.reset();
    expect(sketch.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
    insertAll(sketch, uniform(5));
    expect(sketch.operationCounts().moves).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6.2: 整列・圧縮・まとめ・compaction の費用が、引き起こした操作の増分に現れる
// ---------------------------------------------------------------------------

describe('GK: 圧縮の周期の投入に、圧縮の費用が現れる', () => {
  /** 設計の圧縮の規則を、タプル列の上で直接たどって費用を数える(右から左へ、判定ごとに比較 1) */
  function compressCost(tuples: readonly GkTuple[], epsilon: number, count: number) {
    const gs = tuples.map((t) => t.g);
    const deltas = tuples.map((t) => t.delta);
    const threshold = Math.floor(2 * epsilon * count);
    let comparisons = 0;
    let moves = 0;
    let merges = 0;
    for (let i = gs.length - 2; i >= 1; i--) {
      comparisons++;
      if (gs[i]! + gs[i + 1]! + deltas[i + 1]! > threshold) continue;
      gs[i + 1]! += gs[i]!;
      moves += 1; // 書き換えた g
      moves += 3 * (gs.length - 1 - i); // 削除で詰めたタプルごとに 3
      gs.splice(i, 1);
      deltas.splice(i, 1);
      merges++;
    }
    return { comparisons, moves, merges, size: gs.length };
  }

  function run(epsilon: number, total: number) {
    const sketch: GkSketch = unwrap(createGk({ epsilon }));
    const period = Math.max(1, Math.floor(1 / (2 * epsilon)));
    let capacity = 16;
    let periodInsertions = 0;
    let mergingInsertions = 0;
    for (const [i, v] of Array.from(uniform(total, 5)).entries()) {
      const before = sketch.inspect().tuples;
      const s = before.length;
      const prev = sketch.operationCounts();
      unwrap(sketch.insert(v));
      const d = diff(sketch.operationCounts(), prev);
      const n = i + 1;

      // 挿入だけの費用: 二分探索の比較、ずらした分 + 新しいタプルの移動 3、容量拡張なら複製したタプルごとに 3
      const at = before.filter((t) => t.value <= v).length;
      let insertMoves = 3 * (s - at) + 3;
      if (s === capacity) {
        insertMoves += 3 * s;
        capacity *= 2;
      }
      const searchMax = s === 0 ? 0 : Math.ceil(Math.log2(s + 1));
      const searchMin = s === 0 ? 0 : 1;

      if (n % period === 0) {
        periodInsertions++;
        // 圧縮は、挿入後のタプル列(長さ s + 1)に対して行う
        // 挿入後・圧縮前のタプル列を再現する(新しいタプルは g = 1、Δ は設計どおり)
        const delta = at === 0 || at === s ? 0 : before[at]!.g + before[at]!.delta - 1;
        const tuples: GkTuple[] = [...before.slice(0, at), { value: v, g: 1, delta }, ...before.slice(at)];
        const c = compressCost(tuples, epsilon, n);
        expect(sketch.inspect().tuples.length).toBe(c.size);
        expect(d.moves).toBe(insertMoves + c.moves);
        expect(d.comparisons - c.comparisons).toBeGreaterThanOrEqual(searchMin);
        expect(d.comparisons - c.comparisons).toBeLessThanOrEqual(searchMax);
        if (c.merges > 0) mergingInsertions++;
        if (s >= 30) {
          // 圧縮の比較(s - 1 回)は二分探索の上限より大きく、投入の費用に確かに上乗せされている
          expect(d.comparisons).toBeGreaterThan(searchMax);
        }
      } else {
        expect(d.moves).toBe(insertMoves);
        expect(d.comparisons).toBeGreaterThanOrEqual(searchMin);
        expect(d.comparisons).toBeLessThanOrEqual(searchMax);
      }
    }
    return { periodInsertions, mergingInsertions };
  }

  it.each([0.05, 0.1, 0.01, 0.03])(
    'ε = %s: すべての投入の増分が、挿入の費用 + 周期なら圧縮の費用に一致する',
    (epsilon) => {
      const { periodInsertions, mergingInsertions } = run(epsilon, 1500);
      expect(periodInsertions).toBeGreaterThan(0);
      // 併合が起きる周期の投入が実際にあり、移動の増分に併合の費用が含まれている
      expect(mergingInsertions).toBeGreaterThan(0);
    },
  );

  it('圧縮の周期は ⌊1/(2ε)⌋: ε = 0.05 では 10 件目の投入が、9 件目より大きな増分になる', () => {
    const sketch = unwrap(createGk({ epsilon: 0.05 }));
    // 20 件を投入して状態を育てる(周期は 10 件ごと)
    insertAll(sketch, uniform(19, 9));
    const prev = sketch.operationCounts();
    unwrap(sketch.insert(500));
    const d = diff(sketch.operationCounts(), prev);
    // 20 件目が周期の投入: 挿入前のタプル数 s = 19 以下に対して圧縮の比較 s - 1 回以上が加わる
    expect(d.comparisons).toBeGreaterThanOrEqual(18);
  });
});

describe('KLL: compaction を起こした投入に、その費用が現れる', () => {
  it('compaction のない投入は比較 0・移動 1、compaction を起こす投入は整列と書き込みの費用が増分に現れる', () => {
    const sketch: KllSketch = unwrap(createKll({ k: 8, seed: 3 }));
    let compactingInsertions = 0;
    let plainInsertions = 0;
    for (const v of uniform(2000, 7)) {
      const before = sketch.inspect();
      const prev = sketch.operationCounts();
      unwrap(sketch.insert(v));
      const after = sketch.inspect();
      const d = diff(sketch.operationCounts(), prev);

      if (after.compactions === before.compactions) {
        plainInsertions++;
        expect(d).toEqual({ comparisons: 0, moves: 1 });
        continue;
      }
      expect(after.compactions).toBe(before.compactions + 1);
      compactingInsertions++;
      // compaction した段 h: 挿入後、要素数が容量以上の最も下の段(段数は挿入前のもので判定)
      const levels = before.levels.map((l, h) => ({ size: l.values.length + (h === 0 ? 1 : 0), cap: l.capacity }));
      const h = levels.findIndex((l) => l.size >= l.cap);
      expect(h).toBeGreaterThanOrEqual(0);
      const m = levels[h]!.size;
      const start = m % 2;
      // 挿入 1 + 整列の書き込み + 上の段へ送る (m - start) / 2 + 残す要素の書き戻し start
      expect(d.moves).toBe(1 + sortMoves(m) + (m - start) / 2 + start);
      // 整列の比較(併合整列は少なくとも ⌊m / 2⌋ 回)
      expect(m).toBeGreaterThanOrEqual(2);
      expect(d.comparisons).toBeGreaterThanOrEqual(Math.floor(m / 2));
      expect(d.comparisons).toBeGreaterThan(0);
    }
    expect(compactingInsertions).toBeGreaterThan(20);
    expect(plainInsertions).toBeGreaterThan(0);
  });

  it('問い合わせの増分は、全段の要素を集める移動 2 × 保持要素数 以上と、重みつき整列・走査の比較を含む', () => {
    const sketch = unwrap(createKll({ k: 8, seed: 3 }));
    insertAll(sketch, uniform(500, 2));
    const retained = sketch.inspect().levels.reduce((sum, l) => sum + l.values.length, 0);
    const prev = sketch.operationCounts();
    unwrap(sketch.query(0.5));
    const d = diff(sketch.operationCounts(), prev);
    // 集める書き込み(要素ごとに移動 2)と、値と重みの組を整列する書き込み(要素ごとに移動 2)
    expect(d.moves).toBe(2 * retained + 2 * sortMoves(retained));
    // 整列の比較(少なくとも ⌊m / 2⌋)に加え、重みの累計を調べる比較が少なくとも 1
    expect(d.comparisons).toBeGreaterThanOrEqual(Math.floor(retained / 2) + 1);
    // 状態は変わらないので、同じ問い合わせは同じ増分になる
    const prev2 = sketch.operationCounts();
    unwrap(sketch.query(0.5));
    expect(diff(sketch.operationCounts(), prev2)).toEqual(d);
  });
});

describe('t-digest: まとめの費用が、引き起こした投入または問い合わせの増分に現れる', () => {
  const COMPRESSION = 10;
  const CAPACITY = Math.ceil(5 * COMPRESSION);

  it('投入は比較 2・移動 1 + 更新した境界の数。バッファが満杯になった投入だけ、まとめの費用が加わる', () => {
    const sketch: TDigestSketch = unwrap(createTDigest({ compression: COMPRESSION, scale: 'k1' }));
    let mergingInsertions = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const [i, v] of Array.from(uniform(1000, 4)).entries()) {
      const cBefore = sketch.inspect().centroids.length;
      const prev = sketch.operationCounts();
      unwrap(sketch.insert(v));
      const d = diff(sketch.operationCounts(), prev);
      const updates = (v < min ? 1 : 0) + (v > max ? 1 : 0);
      min = Math.min(min, v);
      max = Math.max(max, v);
      if (i === 0) expect(d).toEqual({ comparisons: 2, moves: 3 });
      if ((i + 1) % CAPACITY === 0) {
        mergingInsertions++;
        expect(sketch.inspect().buffered).toBe(0);
        // 整列の比較(少なくとも ⌊容量 / 2⌋)と書き込み(少なくとも容量)、centroid の書き出し(移動 2 × 個数)
        const c = sketch.inspect().centroids.length;
        expect(d.comparisons).toBeGreaterThanOrEqual(2 + Math.floor(CAPACITY / 2) + (cBefore + CAPACITY - 1));
        expect(d.moves).toBe(1 + updates + sortMoves(CAPACITY) + 2 * c);
      } else {
        expect(d.comparisons).toBe(2);
        expect(d.moves).toBe(1 + updates);
      }
    }
    expect(mergingInsertions).toBe(Math.floor(1000 / CAPACITY));
  });

  it('バッファが残った状態の最初の問い合わせにまとめの費用が含まれ、2 回目以降は走査だけになる', () => {
    const sketch = unwrap(createTDigest({ compression: COMPRESSION, scale: 'k1' }));
    const input = uniform(CAPACITY * 3 + 17, 6);
    insertAll(sketch, input);
    const buffered = sketch.inspect().buffered;
    const meansBefore = sketch.inspect().centroids.map((c) => c.mean);
    const centroidsBefore = meansBefore.length;
    expect(buffered).toBe(17);

    const p0 = sketch.operationCounts();
    unwrap(sketch.query(0.9));
    const p1 = sketch.operationCounts();
    unwrap(sketch.query(0.9));
    const p2 = sketch.operationCounts();
    unwrap(sketch.query(0.9));
    const p3 = sketch.operationCounts();
    expect(sketch.inspect().buffered).toBe(0);
    const centroids = sketch.inspect().centroids.length;

    const first = diff(p1, p0);
    const second = diff(p2, p1);
    const third = diff(p3, p2);
    // 2 回目以降はバッファが空で、走査の比較だけ(移動なし)
    expect(second.moves).toBe(0);
    expect(second.comparisons).toBeGreaterThan(0);
    expect(second.comparisons).toBeLessThanOrEqual(centroids + 1);
    expect(third).toEqual(second);
    // 最初の問い合わせは、走査に加えてまとめの比較と移動(整列 buffered 以上 + centroid の書き出し 2 × 個数)を含む
    // まとめの比較: バッファの整列 + 先頭同士の比較(どちらかが尽きるまで 1 項目ごとに 1)+ 上限に収まるかの判定(項目数 - 1 回)
    const sortedBuffer = input.slice(input.length - buffered).sort();
    let c = 0;
    let b = 0;
    let interleave = 0;
    while (c < centroidsBefore && b < buffered) {
      interleave++;
      if (meansBefore[c]! <= sortedBuffer[b]!) c++;
      else b++;
    }
    const mergeComparisons =
      sortComparisons(Array.from(input.slice(input.length - buffered))) + interleave + (centroidsBefore + buffered - 1);
    expect(first.comparisons - second.comparisons).toBe(mergeComparisons);
    expect(first.moves).toBe(sortMoves(buffered) + 2 * centroids);
  });

  it('バッファが空の状態の問い合わせは、まとめず、移動を数えない', () => {
    const sketch = unwrap(createTDigest({ compression: COMPRESSION, scale: 'k1' }));
    insertAll(sketch, uniform(CAPACITY * 2, 8));
    expect(sketch.inspect().buffered).toBe(0);
    const prev = sketch.operationCounts();
    unwrap(sketch.query(0.5));
    expect(diff(sketch.operationCounts(), prev).moves).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6.4: 件数に対するメモリ見積もりの増え方
// ---------------------------------------------------------------------------

describe('件数 1,000 → 100,000 でのメモリ見積もり', () => {
  const SMALL = 1_000;
  const LARGE = 100_000;
  const data = uniform(LARGE, 21);

  function memoryAt(make: () => PercentileSketch): { small: number; large: number } {
    const sketch = make();
    for (let i = 0; i < SMALL; i++) unwrap(sketch.insert(data[i]!));
    const small = sketch.memoryBytes();
    for (let i = SMALL; i < LARGE; i++) unwrap(sketch.insert(data[i]!));
    return { small, large: sketch.memoryBytes() };
  }

  it('厳密解のメモリ見積もりは件数に比例して 100 倍になる', () => {
    const { small, large } = memoryAt(() => createSortExact());
    expect(small).toBe(SMALL * 8);
    expect(large).toBe(LARGE * 8);
    expect(large / small).toBe(100);
  });

  it.each([
    ['GK(ε=0.01)', () => unwrap(createGk({ epsilon: 0.01 }))],
    ['KLL(k=200)', () => unwrap(createKll({ k: 200, seed: 1 }))],
    ['t-digest(k1, δ=100)', () => unwrap(createTDigest({ compression: 100, scale: 'k1' }))],
  ] as ReadonlyArray<readonly [string, () => PercentileSketch]>)('%s は 10 倍未満にとどまる', (_name, make) => {
    const { small, large } = memoryAt(make);
    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThan(10);
    // 厳密解(100 倍)よりはるかに小さい絶対量でもある
    expect(large).toBeLessThan(LARGE * 8 * 0.1);
  });
});

// ---------------------------------------------------------------------------
// 6.5: パラメータに対するメモリ見積もりの増え方
// ---------------------------------------------------------------------------

describe('パラメータとメモリ見積もり', () => {
  const data = uniform(20_000, 31);

  function memory(sketch: PercentileSketch, queryAfter = false): number {
    insertAll(sketch, data);
    // t-digest はバッファを使用中の件数で数えるので、まとめてから比べる
    if (queryAfter) unwrap(sketch.query(0.5));
    return sketch.memoryBytes();
  }

  it('GK は ε を小さくするとメモリ見積もりが増える', () => {
    const sizes = [0.1, 0.03, 0.01, 0.003].map((epsilon) => memory(unwrap(createGk({ epsilon }))));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
  });

  it('KLL は k を大きくするとメモリ見積もりが増える', () => {
    const sizes = [16, 64, 256, 1024].map((k) => memory(unwrap(createKll({ k, seed: 1 }))));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
  });

  it.each(['k0', 'k1', 'k2'] as const)('t-digest(%s) は圧縮パラメータを大きくするとメモリ見積もりが増える', (scale) => {
    const sizes = [10, 30, 100, 300].map((compression) => memory(unwrap(createTDigest({ compression, scale })), true));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
  });
});

// ---------------------------------------------------------------------------
// 6.3: メモリ見積もりは設計の式どおり
// ---------------------------------------------------------------------------

describe('メモリ見積もりの式', () => {
  const BYTES = 8;

  it('GK: (値 s + g と Δ の 2s + 件数 1) × 8 = (3s + 1) × 8', () => {
    const sketch = unwrap(createGk({ epsilon: 0.01 }));
    expect(sketch.memoryBytes()).toBe(1 * BYTES);
    // 周期は 50 件なので、10 件では圧縮されず s = 10
    for (const v of [5, 3, 8, 1, 9, 2, 7, 4, 6, 10]) unwrap(sketch.insert(v));
    expect(sketch.inspect().tuples).toHaveLength(10);
    expect(sketch.memoryBytes()).toBe((3 * 10 + 1) * BYTES);
    expect(sketch.memoryBytes()).toBe(248);
  });

  it('GK: 圧縮でタプルが減ると、その分だけ式の値も減る', () => {
    const sketch = unwrap(createGk({ epsilon: 0.1 }));
    insertAll(sketch, uniform(1000, 13));
    const s = sketch.inspect().tuples.length;
    expect(s).toBeLessThan(1000);
    expect(sketch.memoryBytes()).toBe((3 * s + 1) * BYTES);
  });

  it('KLL: (保持要素数 m + 段ごとの要素数 H + 件数 1) × 8', () => {
    const sketch = unwrap(createKll({ k: 8, seed: 1 }));
    expect(sketch.memoryBytes()).toBe((0 + 1 + 1) * BYTES);
    // 5 件では容量 8 を超えず、1 段のまま
    insertAll(sketch, uniform(5, 3));
    expect(sketch.inspect().levels).toHaveLength(1);
    expect(sketch.memoryBytes()).toBe((5 + 1 + 1) * BYTES);
    expect(sketch.memoryBytes()).toBe(56);
  });

  it('KLL: compaction で保持要素数が減り段が増えても式どおり', () => {
    const sketch = unwrap(createKll({ k: 8, seed: 1 }));
    insertAll(sketch, uniform(3000, 3));
    const state = sketch.inspect();
    const retained = state.levels.reduce((sum, l) => sum + l.values.length, 0);
    expect(state.levels.length).toBeGreaterThan(3);
    expect(retained).toBeLessThan(3000);
    expect(sketch.memoryBytes()).toBe((retained + state.levels.length + 1) * BYTES);
  });

  it('t-digest: (centroid 数 c の 2 倍 + バッファ件数 b + 3) × 8', () => {
    const sketch = unwrap(createTDigest({ compression: 10, scale: 'k1' }));
    expect(sketch.memoryBytes()).toBe(3 * BYTES);
    // バッファ容量は 50 なので、7 件はバッファに残る(c = 0、b = 7)
    insertAll(sketch, uniform(7, 5));
    expect(sketch.inspect().buffered).toBe(7);
    expect(sketch.memoryBytes()).toBe((2 * 0 + 7 + 3) * BYTES);
    expect(sketch.memoryBytes()).toBe(80);
    // 問い合わせでまとめると b = 0 になり、c 個の centroid で式どおり
    unwrap(sketch.query(0.5));
    const c = sketch.inspect().centroids.length;
    expect(c).toBeGreaterThan(0);
    expect(sketch.inspect().buffered).toBe(0);
    expect(sketch.memoryBytes()).toBe((2 * c + 0 + 3) * BYTES);
  });

  it('t-digest: centroid とバッファが両方ある状態でも式どおり(バッファは使用中の件数)', () => {
    const sketch = unwrap(createTDigest({ compression: 10, scale: 'k2' }));
    insertAll(sketch, uniform(50 * 4 + 13, 6));
    const state = sketch.inspect();
    expect(state.buffered).toBe(13);
    expect(state.centroids.length).toBeGreaterThan(0);
    expect(sketch.memoryBytes()).toBe((2 * state.centroids.length + 13 + 3) * BYTES);
  });
});
