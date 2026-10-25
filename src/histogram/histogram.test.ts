import { describe, expect, it } from 'vitest';
import { isParamRecord, type PercentileSketch } from '../core';
import { buildBoundaries, type BucketScheme } from './boundaries';
import { createHistogram, histogramSpec } from './histogram';

const EQUAL: BucketScheme = { kind: 'equal', lower: 10, upper: 50, buckets: 4 };
const EXPONENTIAL: BucketScheme = { kind: 'exponential', lower: 1, upper: 1024, buckets: 10 };
const CUSTOM: BucketScheme = { kind: 'custom', boundaries: [1, 2, 5, 10, 100] };

function make(scheme: BucketScheme): PercentileSketch {
  const r = createHistogram(scheme);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function insertAll(s: PercentileSketch, values: number[]): void {
  for (const v of values) {
    const r = s.insert(v);
    if (!r.ok) throw new Error(`insert(${v}) failed: ${JSON.stringify(r.error)}`);
  }
}

function q(s: PercentileSketch, quantile: number): number {
  const r = s.query(quantile);
  if (!r.ok) throw new Error(`query(${quantile}) failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('区間の包含(等幅 10〜50、4バケット)', () => {
  it('下側の境界の値は、その境界から始まるバケットに入る', () => {
    const s = make(EQUAL);
    insertAll(s, [20]);
    // バケット [20, 30) に入っていれば、分位点 0 はその下側の境界 20
    expect(q(s, 0)).toBe(20);
  });

  it('内側の境界の値は、上側のバケットに入る', () => {
    const s = make(EQUAL);
    insertAll(s, [30]);
    expect(q(s, 0)).toBe(30);
    expect(q(s, 1)).toBe(40);
  });

  it('全体の下限の値は最初のバケットに入る', () => {
    const s = make(EQUAL);
    insertAll(s, [10]);
    expect(q(s, 0)).toBe(10);
    expect(q(s, 1)).toBe(20);
  });

  it('全体の上限の値は最後のバケットに入る(両端を含む)', () => {
    const s = make(EQUAL);
    insertAll(s, [50]);
    expect(q(s, 0)).toBe(40);
    expect(q(s, 1)).toBe(50);
  });

  it.each([
    ['等幅', { kind: 'equal', lower: 0.1, upper: 7.3, buckets: 37 } as BucketScheme],
    ['指数幅', { kind: 'exponential', lower: 0.01, upper: 1e6, buckets: 61 } as BucketScheme],
    ['任意境界', { kind: 'custom', boundaries: [0.3, 0.31, 1, 1.5, 9, 9.5, 20] } as BucketScheme],
  ])('%s: すべての内側の境界の値が、その境界から始まるバケットに入る', (_name, scheme) => {
    const b = buildBoundaries(scheme);
    if (!b.ok) throw new Error('boundaries');
    const bounds = b.value;
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = make(scheme);
      insertAll(s, [bounds[i]!]);
      expect(q(s, 0)).toBe(bounds[i]);
    }
    const s = make(scheme);
    insertAll(s, [bounds[bounds.length - 1]!]);
    expect(q(s, 1)).toBe(bounds[bounds.length - 1]);
    expect(q(s, 0)).toBe(bounds[bounds.length - 2]);
  });
});

describe('投入と問い合わせ', () => {
  it('範囲内の投入が問い合わせの結果に反映される', () => {
    const s = make(EQUAL);
    insertAll(s, [15, 25, 25, 35]);
    expect([0, 0.25, 0.5, 0.75, 1].map((x) => q(s, x))).toEqual([10, 20, 25, 30, 40]);
    insertAll(s, [45, 45, 45, 45]);
    expect(q(s, 1)).toBe(50);
  });

  it('不正な値は invalid-value で拒否し、状態を変えない', () => {
    const s = make(EQUAL);
    insertAll(s, [15, 25]);
    const answer = q(s, 0.5);
    const counts = s.operationCounts();
    const memory = s.memoryBytes();
    for (const bad of [NaN, Infinity, -Infinity, 0, -5, '20', null, undefined]) {
      const r = s.insert(bad as number);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid-value');
    }
    expect(s.operationCounts()).toEqual(counts);
    expect(s.memoryBytes()).toBe(memory);
    expect(q(s, 0.5)).toBe(answer);
  });

  it('範囲外の値は unsupported-value で拒否し、状態・操作数・メモリ見積もりを変えない', () => {
    const s = make(EQUAL);
    insertAll(s, [15, 25, 35]);
    const counts = s.operationCounts();
    const memory = s.memoryBytes();
    const answers = [0, 0.5, 1].map((x) => q(s, x));
    const afterQueries = s.operationCounts();
    for (const v of [9.999, 50.001, 1, 1e9]) {
      const r = s.insert(v);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('unsupported-value');
      }
    }
    expect(s.operationCounts()).toEqual(afterQueries);
    expect(counts.moves).toBe(afterQueries.moves);
    expect(s.memoryBytes()).toBe(memory);
    expect([0, 0.5, 1].map((x) => q(s, x))).toEqual(answers);
  });

  it('空の問い合わせは empty、範囲外の分位点は quantile-out-of-range(空でも先に検査する)', () => {
    const s = make(EQUAL);
    const empty = s.query(0.5);
    expect(!empty.ok && empty.error.kind).toBe('empty');
    for (const bad of [-0.1, 1.1, NaN, Infinity]) {
      const r = s.query(bad);
      expect(!r.ok && r.error.kind).toBe('quantile-out-of-range');
    }
    insertAll(s, [20]);
    const counts = s.operationCounts();
    const r = s.query(2);
    expect(!r.ok && r.error.kind).toBe('quantile-out-of-range');
    expect(s.operationCounts()).toEqual(counts);
  });

  it('投入1回の移動は2回、比較は等幅・指数幅で3回以下', () => {
    for (const scheme of [EQUAL, EXPONENTIAL]) {
      const s = make(scheme);
      const b = buildBoundaries(scheme);
      if (!b.ok) throw new Error('boundaries');
      let prev = s.operationCounts();
      for (const v of [b.value[0]!, b.value[b.value.length - 1]!, (b.value[0]! + b.value[1]!) / 2]) {
        insertAll(s, [v]);
        const now = s.operationCounts();
        expect(now.moves - prev.moves).toBe(2);
        expect(now.comparisons - prev.comparisons).toBeLessThanOrEqual(3);
        prev = now;
      }
    }
  });
});

describe('再現性と初期化', () => {
  const values = [12, 18, 25, 25, 33, 41, 49, 50, 10];

  it('同じ入力で同じ推定値・操作数・メモリ見積もり', () => {
    const a = make(EQUAL);
    const b = make(EQUAL);
    insertAll(a, values);
    insertAll(b, values);
    expect([0, 0.3, 0.5, 0.99, 1].map((x) => q(a, x))).toEqual([0, 0.3, 0.5, 0.99, 1].map((x) => q(b, x)));
    expect(a.operationCounts()).toEqual(b.operationCounts());
    expect(a.memoryBytes()).toBe(b.memoryBytes());
  });

  it('シードに依存しない', () => {
    const r = histogramSpec(EQUAL);
    if (!r.ok) throw new Error('spec');
    const a = r.value.create(1);
    const b = r.value.create(987654321);
    insertAll(a, values);
    insertAll(b, values);
    expect(q(a, 0.5)).toBe(q(b, 0.5));
    expect(a.operationCounts()).toEqual(b.operationCounts());
  });

  it('初期化すると、境界を保ったまま新規作成直後の状態に戻る', () => {
    for (const scheme of [EQUAL, EXPONENTIAL, CUSTOM]) {
      const used = make(scheme);
      const fresh = make(scheme);
      const b = buildBoundaries(scheme);
      if (!b.ok) throw new Error('boundaries');
      const sample = [b.value[0]!, b.value[1]!, b.value[b.value.length - 1]!];
      insertAll(used, sample);
      used.query(0.5);
      used.reset();
      expect(used.operationCounts()).toEqual({ comparisons: 0, moves: 0 });
      expect(used.memoryBytes()).toBe(fresh.memoryBytes());
      const r = used.query(0.5);
      expect(!r.ok && r.error.kind).toBe('empty');
      insertAll(used, sample);
      insertAll(fresh, sample);
      expect(q(used, 0.5)).toBe(q(fresh, 0.5));
      expect(used.operationCounts()).toEqual(fresh.operationCounts());
    }
  });

  it('メモリ見積もりは境界とカウンタの個数だけで決まり、件数に依存しない', () => {
    const s = make(EQUAL);
    // 境界 5 個 + カウンタ(4 バケット + 総数)5 個 = 10 個 × 8 バイト
    expect(s.memoryBytes()).toBe(80);
    insertAll(s, [15, 25, 25, 35]);
    expect(s.memoryBytes()).toBe(80);
    for (let i = 0; i < 1000; i++) insertAll(s, [20]);
    expect(s.memoryBytes()).toBe(80);
  });
});

describe('生成仕様', () => {
  it('等幅の識別子・表示名・パラメータ・扱える範囲', () => {
    const r = histogramSpec(EQUAL);
    if (!r.ok) throw new Error('spec');
    expect(r.value.id).toBe('histogram-equal-4');
    expect(r.value.label).toContain('等幅');
    expect(r.value.params).toEqual({ scheme: 'equal', buckets: 4, lower: 10, upper: 50 });
    expect(r.value.supportedRange).toEqual({ min: 10, max: 50 });
    expect(isParamRecord(r.value.params)).toBe(true);
  });

  it('指数幅・任意境界の識別子とパラメータ', () => {
    const e = histogramSpec(EXPONENTIAL);
    const c = histogramSpec(CUSTOM);
    if (!e.ok || !c.ok) throw new Error('spec');
    expect(e.value.id).toBe('histogram-exponential-10');
    expect(c.value.id).toBe('histogram-custom-4');
    expect(c.value.params).toEqual({ scheme: 'custom', buckets: 4, lower: 1, upper: 100 });
    expect(c.value.supportedRange).toEqual({ min: 1, max: 100 });
  });

  it('識別子は範囲を含まない(範囲が違っても同じ種類・同じバケット数なら同じ識別子)', () => {
    const a = histogramSpec({ kind: 'equal', lower: 1, upper: 10, buckets: 4 });
    const b = histogramSpec({ kind: 'equal', lower: 5, upper: 99, buckets: 4 });
    if (!a.ok || !b.ok) throw new Error('spec');
    expect(a.value.id).toBe(b.value.id);
  });

  it('識別子と表示名を上書きできる', () => {
    const r = histogramSpec(EQUAL, { id: 'h-a', label: 'A' });
    if (!r.ok) throw new Error('spec');
    expect(r.value.id).toBe('h-a');
    expect(r.value.label).toBe('A');
  });

  it('create は互いに独立したインスタンスを返す', () => {
    const r = histogramSpec(EQUAL);
    if (!r.ok) throw new Error('spec');
    const a = r.value.create(1);
    const b = r.value.create(1);
    insertAll(a, [15]);
    expect(b.query(0.5).ok).toBe(false);
  });
});

describe('不正な境界の指定', () => {
  it('作成も生成仕様もエラーになり、アルゴリズムを作らない', () => {
    const bad: BucketScheme = { kind: 'equal', lower: 5, upper: 5, buckets: 3 };
    const a = createHistogram(bad);
    const b = histogramSpec(bad);
    expect(!a.ok && a.error.kind).toBe('invalid-scheme');
    expect(!b.ok && b.error.kind).toBe('invalid-scheme');
  });
});
