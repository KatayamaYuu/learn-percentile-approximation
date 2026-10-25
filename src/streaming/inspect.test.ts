import { describe, expect, it } from 'vitest';
import type { OperationCounts, PercentileSketch, SketchSpec } from '../core';
import {
  gkSpec,
  kllSpec,
  tdigestSpec,
  type GkState,
  type KllState,
  type ScaleFunctionKind,
  type TDigestState,
} from './index';

// 内部状態の観察の横断テスト(5.4、5.5、5.6)。3 手法を同じ形で扱う。

type State = GkState | KllState | TDigestState;
type Inspectable = PercentileSketch & { inspect(): State };

interface Target {
  readonly name: string;
  readonly make: () => Inspectable;
  /** 設計の式による要素数(メモリ見積もり ÷ 8)。観察結果だけから求める */
  readonly elements: (state: State) => number;
  /** 観察結果から求めた投入件数(重みの合計 + バッファ件数) */
  readonly weighted: (state: State) => number;
}

function unwrap(
  r: { readonly ok: true; readonly value: SketchSpec } | { readonly ok: false; readonly error: unknown },
) {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function gkOf(state: State): GkState {
  if (state.algorithm !== 'gk') throw new Error('gk 以外の状態');
  return state;
}
function kllOf(state: State): KllState {
  if (state.algorithm !== 'kll') throw new Error('kll 以外の状態');
  return state;
}
function tdigestOf(state: State): TDigestState {
  if (state.algorithm !== 'tdigest') throw new Error('tdigest 以外の状態');
  return state;
}

function target(name: string, spec: SketchSpec, elements: Target['elements'], weighted: Target['weighted']): Target {
  return { name, make: () => spec.create(7) as Inspectable, elements, weighted };
}

const SCALES: readonly ScaleFunctionKind[] = ['k0', 'k1', 'k2'];

const gkElements = (s: State) => 3 * gkOf(s).tuples.length + 1;
const gkWeighted = (s: State) => gkOf(s).tuples.reduce((sum, t) => sum + t.g, 0);
const kllElements = (s: State) =>
  kllOf(s).levels.reduce((sum, l) => sum + l.values.length, 0) + kllOf(s).levels.length + 1;
const kllWeighted = (s: State) => kllOf(s).levels.reduce((sum, l) => sum + l.weight * l.values.length, 0);
const tdElements = (s: State) => 2 * tdigestOf(s).centroids.length + tdigestOf(s).buffered + 3;
const tdWeighted = (s: State) => tdigestOf(s).centroids.reduce((sum, c) => sum + c.weight, 0) + tdigestOf(s).buffered;

const TARGETS: readonly Target[] = [
  target('GK(ε=0.01)', unwrap(gkSpec({ epsilon: 0.01 })), gkElements, gkWeighted),
  target('GK(ε=0.1)', unwrap(gkSpec({ epsilon: 0.1 })), gkElements, gkWeighted),
  target('KLL(k=8)', unwrap(kllSpec({ k: 8 })), kllElements, kllWeighted),
  target('KLL(k=200)', unwrap(kllSpec({ k: 200 })), kllElements, kllWeighted),
  ...SCALES.flatMap((scale) => [
    target(`t-digest(${scale}、δ=100)`, unwrap(tdigestSpec({ compression: 100, scale })), tdElements, tdWeighted),
  ]),
  target('t-digest(k1、δ=10)', unwrap(tdigestSpec({ compression: 10, scale: 'k1' })), tdElements, tdWeighted),
];

const QUANTILES: readonly number[] = [0, 0.01, 0.25, 0.5, 0.75, 0.9, 0.99, 1];
/** 投入の回数。重複値と、広い範囲の値を含む固定の列(乱数は使わない) */
const INSERTS = 700;
/** 投入のたびに問い合わせるのではなく、この回数ごとに問い合わせる(t-digest のバッファが残る状態を作る) */
const QUERY_EVERY = 7;

function valueAt(i: number): number {
  // 37 と 101 は互いに素。重複を含み、i が大きいほど大きな値も出る
  return ((i * 37) % 101) + 1 + (i % 5) * 0.25 + Math.floor(i / 100) * 50;
}

function must<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function estimates(s: PercentileSketch): number[] {
  return QUANTILES.map((q) => must(s.query(q)));
}

interface Observation {
  readonly ops: OperationCounts;
  readonly memory: number;
}
function observe(s: PercentileSketch): Observation {
  return { ops: s.operationCounts(), memory: s.memoryBytes() };
}

/** 値を壊す: 配列は要素を書き換えて足し、オブジェクトは数値と文字列を書き換える(深さを問わず) */
function vandalize(x: unknown): void {
  if (Array.isArray(x)) {
    for (const item of x) vandalize(item);
    x.reverse();
    x.fill(-1);
    x.push(-1);
    x.length = 0;
    return;
  }
  if (typeof x === 'object' && x !== null) {
    const o = x as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (typeof o[key] === 'number') o[key] = -12345;
      else if (typeof o[key] === 'string') o[key] = 'tampered';
      else vandalize(o[key]);
    }
    o['extra'] = 1;
  }
}

describe.each(TARGETS)('$name', (t) => {
  it('空の状態でも観察でき、JSON を往復して同じ値になり、式と要素数が一致する(5.5、5.6)', () => {
    const s = t.make();
    const state = s.inspect();
    expect(state.count).toBe(0);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(s.memoryBytes()).toBe(t.elements(state) * 8);
    expect(t.weighted(state)).toBe(0);
  });

  it('投入と問い合わせを交互に行う間、観察の前後で操作数・メモリ見積もり・推定値が同じ(5.4)', () => {
    const observed = t.make();
    const control = t.make(); // 観察しない対照。同じ操作列を実行する
    let sawBuffered = false;
    let sawCompaction = false;
    for (let i = 0; i < INSERTS; i++) {
      must(observed.insert(valueAt(i)));
      must(control.insert(valueAt(i)));
      if (i % QUERY_EVERY === 0 || i === INSERTS - 1) {
        // 投入直後(t-digest ではバッファが残っている状態)で観察する
        const before = observe(observed);
        const first = observed.inspect();
        expect(observe(observed)).toEqual(before);
        const second = observed.inspect();
        expect(second).toEqual(first);
        if (first.algorithm === 'tdigest' && first.buffered > 0) sawBuffered = true;
        if (first.algorithm === 'kll' && first.compactions > 0) sawCompaction = true;
        // 観察が以後の操作に影響しない: 観察しない対照と、状態・操作数・メモリが同じ
        expect(observe(observed)).toEqual(observe(control));
        expect(first).toEqual(control.inspect());
        // 問い合わせの結果も、操作数も、対照と同じ(観察が乱数や整列済みの状態を動かしていない)
        expect(estimates(observed)).toEqual(estimates(control));
        expect(observe(observed)).toEqual(observe(control));
        // 問い合わせの後の観察でも同じ
        expect(observed.inspect()).toEqual(control.inspect());
      }
    }
    // 検証が空振りでないこと
    if (t.name.startsWith('t-digest')) expect(sawBuffered).toBe(true);
    if (t.name === 'KLL(k=8)') expect(sawCompaction).toBe(true);
  });

  it('観察の結果は JSON を往復して同じ値になる(5.5)', () => {
    const s = t.make();
    for (let i = 0; i < INSERTS; i++) {
      must(s.insert(valueAt(i)));
      if (i % 50 === 0) {
        const state = s.inspect();
        expect(JSON.parse(JSON.stringify(state))).toEqual(state);
        must(s.query(0.5));
        const after = s.inspect();
        expect(JSON.parse(JSON.stringify(after))).toEqual(after);
      }
    }
  });

  it('戻り値を書き換えても、以後の観察と推定値・操作数・メモリ見積もりが変わらない(5.5)', () => {
    const tampered = t.make();
    const control = t.make();
    for (let i = 0; i < INSERTS; i++) {
      must(tampered.insert(valueAt(i)));
      must(control.insert(valueAt(i)));
      if (i % 25 === 0) {
        const snapshot = JSON.stringify(control.inspect());
        const state = tampered.inspect();
        vandalize(state);
        // 書き換えは確かに効いている(対照実験)
        expect(JSON.stringify(state)).not.toBe(snapshot);
        // 書き換えた後に取り直した観察は、書き換える前と同じ
        expect(JSON.stringify(tampered.inspect())).toBe(snapshot);
        expect(observe(tampered)).toEqual(observe(control));
        expect(estimates(tampered)).toEqual(estimates(control));
        expect(JSON.stringify(tampered.inspect())).toBe(JSON.stringify(control.inspect()));
      }
    }
    // 書き換えたまま同じ操作を続けても、最後まで対照と同じ
    expect(observe(tampered)).toEqual(observe(control));
    expect(tampered.inspect()).toEqual(control.inspect());
  });

  it('2 回の観察は互いに独立した複製である(片方の書き換えがもう片方に届かない)(5.5)', () => {
    const s = t.make();
    for (let i = 0; i < 120; i++) must(s.insert(valueAt(i)));
    const a = s.inspect();
    const b = s.inspect();
    const expected = JSON.stringify(b);
    vandalize(a);
    expect(JSON.stringify(b)).toBe(expected);
    expect(JSON.stringify(s.inspect())).toBe(expected);
  });

  it('メモリ見積もりの式と観察結果の要素数が、投入と問い合わせの途中でも一致する(5.6)', () => {
    const s = t.make();
    for (let i = 0; i < INSERTS; i++) {
      must(s.insert(valueAt(i)));
      if (i % 11 === 0) {
        const state = s.inspect();
        expect(s.memoryBytes()).toBe(t.elements(state) * 8);
        // 同じ時点の状態として、重みの合計も投入件数と合う
        expect(state.count).toBe(i + 1);
        expect(t.weighted(state)).toBe(i + 1);
      }
      if (i % QUERY_EVERY === 0) {
        must(s.query(0.9));
        const state = s.inspect();
        expect(s.memoryBytes()).toBe(t.elements(state) * 8);
        expect(t.weighted(state)).toBe(i + 1);
      }
    }
  });

  it('リセット後の観察は作成直後と同じで、式との整合も保たれる(5.4、5.6)', () => {
    const s = t.make();
    const fresh = JSON.stringify(s.inspect());
    for (let i = 0; i < 200; i++) must(s.insert(valueAt(i)));
    s.reset();
    expect(JSON.stringify(s.inspect())).toBe(fresh);
    expect(s.memoryBytes()).toBe(t.elements(s.inspect()) * 8);
  });
});

describe('手法ごとの観察の内容(5.1、5.2、5.3 の形)が往復後も保たれる', () => {
  it('GK は ε と投入件数を、KLL は k・圧縮の回数・段を、t-digest は δ・スケール関数・最小値・最大値を持つ', () => {
    const gk = unwrap(gkSpec({ epsilon: 0.1 })).create(1) as Inspectable;
    const kll = unwrap(kllSpec({ k: 8 })).create(1) as Inspectable;
    const td = unwrap(tdigestSpec({ compression: 100, scale: 'k2' })).create(1) as Inspectable;
    for (let i = 0; i < 300; i++) for (const s of [gk, kll, td]) must(s.insert(valueAt(i)));
    const g = JSON.parse(JSON.stringify(gk.inspect())) as GkState;
    expect(g.epsilon).toBe(0.1);
    expect(g.count).toBe(300);
    const k = JSON.parse(JSON.stringify(kll.inspect())) as KllState;
    expect(k.k).toBe(8);
    expect(k.compactions).toBeGreaterThan(0);
    expect(k.levels.map((l) => l.weight)).toEqual(k.levels.map((_, h) => 2 ** h));
    const d = JSON.parse(JSON.stringify(td.inspect())) as TDigestState;
    expect(d.compression).toBe(100);
    expect(d.scale).toBe('k2');
    expect(d.min).toBe(Math.min(...Array.from({ length: 300 }, (_, i) => valueAt(i))));
    expect(d.max).toBe(Math.max(...Array.from({ length: 300 }, (_, i) => valueAt(i))));
  });

  it('空の t-digest の最小値・最大値は JSON を往復しても同じ(null)', () => {
    const td = unwrap(tdigestSpec({ compression: 100, scale: 'k1' })).create(1) as Inspectable;
    const state = td.inspect() as TDigestState;
    expect(state.min).toBeNull();
    expect(state.max).toBeNull();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
