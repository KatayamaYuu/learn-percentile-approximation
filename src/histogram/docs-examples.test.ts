import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exactQuantileSorted } from '../core';
import { buildBoundaries, createHistogram, histogramSpec } from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'histogram');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

const EQUAL = { kind: 'equal', lower: 10, upper: 50, buckets: 4 } as const;

function sketchWith(values: number[]) {
  const h = createHistogram(EQUAL);
  if (!h.ok) throw new Error('histogram');
  for (const v of values) h.value.insert(v);
  return h.value;
}

function estimate(values: number[], q: number): number {
  const r = sketchWith(values).query(q);
  if (!r.ok) throw new Error('query');
  return r.value;
}

function exact(values: number[], q: number): number {
  return exactQuantileSorted(Float64Array.from(values).sort(), q, 'nearest-rank');
}

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string): string[] {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${firstCell} |`));
  if (line === undefined) throw new Error(`row not found: ${firstCell}`);
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

describe('interpolation-and-error.md の例 [15, 25, 25, 35]', () => {
  const doc = readDoc('interpolation-and-error.md');
  const values = [15, 25, 25, 35];

  it.each([
    [0, '1', '[10, 20)', 10, 15, 5],
    [0.25, '1', '[10, 20)', 20, 15, 5],
    [0.5, '2', '[20, 30)', 25, 25, 0],
    [0.75, '3', '[20, 30)', 30, 25, 5],
    [1, '4', '[30, 40)', 40, 35, 5],
  ])('q=%d: 順位 %s、バケット %s、推定値 %d、厳密値 %d、誤差 %d', (q, k, bucket, est, ex, err) => {
    expect(estimate(values, q)).toBeCloseTo(est, 12);
    expect(exact(values, q)).toBe(ex);
    expect(Math.abs(estimate(values, q) - exact(values, q))).toBeCloseTo(err, 12);
    const row = rowOf(doc, String(q));
    expect(row).toEqual([String(q), k, bucket, String(est), String(ex), String(err)]);
  });

  it('バケットの件数は 1、2、1、0 で、境界は 10〜50 の等幅', () => {
    const b = buildBoundaries(EQUAL);
    expect(b.ok && Array.from(b.value)).toEqual([10, 20, 30, 40, 50]);
    expect(doc).toContain('件数は1、2、1、0');
    // 件数の確認: 値 15 だけなら [10, 20) に入る(q=0 が 10、q=1 が 20)
    expect([estimate([15], 0), estimate([15], 1)]).toEqual([10, 20]);
    expect([estimate([35], 0), estimate([35], 1)]).toEqual([30, 40]);
  });

  it('絶対誤差の最大は 5 で、バケット幅 10 以下', () => {
    const errors = [0, 0.25, 0.5, 0.75, 1].map((q) => Math.abs(estimate(values, q) - exact(values, q)));
    expect(Math.max(...errors)).toBe(5);
    expect(doc).toContain('実際の最大は5');
  });
});

describe('interpolation-and-error.md の境界付近のずれ [11, 12, 13, 29]', () => {
  const full = readDoc('interpolation-and-error.md');
  // 同じ分位点の行が前の表にもあるので、この節の表だけを対象にする
  const doc = full.slice(full.indexOf('## 境界付近のずれ'));
  const values = [11, 12, 13, 29];

  it.each([
    [0.75, '3', '[10, 20)', 20, 13, 7],
    [0.76, '4', '[20, 30)', 20.4, 29, 8.6],
  ])('q=%d: 順位 %s、バケット %s、推定値 %d、厳密値 %d、誤差 %d', (q, k, bucket, est, ex, err) => {
    expect(estimate(values, q)).toBeCloseTo(est, 10);
    expect(exact(values, q)).toBe(ex);
    expect(Math.abs(estimate(values, q) - exact(values, q))).toBeCloseTo(err, 10);
    expect(rowOf(doc, String(q))).toEqual([String(q), k, bucket, String(est), String(ex), String(err)]);
  });

  it('件数は 3、1、0、0 になる', () => {
    expect(doc).toContain('件数は3、1、0、0');
    // [10, 20) に 3 件: 3 件目の位置の推定値が上側の境界、4 件目が次のバケット
    expect(estimate(values, 0.75)).toBe(20);
    expect(estimate(values, 1)).toBeGreaterThan(20);
  });
});

describe('interpolation-and-error.md の丸めの例', () => {
  it('0.07 × 100 は 7.000000000000001 で、7 番目のバケットが選ばれる', () => {
    expect(100 * 0.07).toBe(7.000000000000001);
    expect(readDoc('interpolation-and-error.md')).toContain('7.000000000000001');
    const h = createHistogram({ kind: 'custom', boundaries: [1, 2, 3] });
    if (!h.ok) throw new Error('histogram');
    for (let i = 0; i < 7; i++) h.value.insert(1.5);
    for (let i = 0; i < 93; i++) h.value.insert(2.5);
    const r = h.value.query(0.07);
    // 累積件数 7 のバケット [1, 2) の上側の境界 2。次のバケットなら 2 より大きくなる
    expect(r.ok && r.value).toBe(2);
  });
});

describe('bucket-schemes.md の例', () => {
  const doc = readDoc('bucket-schemes.md');

  it('等幅 10〜50(4 バケット)の境界は 10、20、30、40、50', () => {
    const b = buildBoundaries(EQUAL);
    expect(b.ok && Array.from(b.value)).toEqual([10, 20, 30, 40, 50]);
    expect(doc).toContain('境界は10、20、30、40、50になる');
  });

  it('指数幅 1〜1024(10 バケット)の境界は 1、2、4、…、1024 で、比は 2', () => {
    const b = buildBoundaries({ kind: 'exponential', lower: 1, upper: 1024, buckets: 10 });
    if (!b.ok) throw new Error('boundaries');
    for (let i = 0; i < b.value.length; i++) expect(b.value[i]).toBeCloseTo(2 ** i, 9);
    expect(doc).toContain('境界は1、2、4、8、…、1024で、比は常に2である');
  });

  it('値 20 は [20, 30) に、値 50 は最後のバケットに入る', () => {
    expect([estimate([20], 0), estimate([20], 1)]).toEqual([20, 30]);
    expect([estimate([50], 0), estimate([50], 1)]).toEqual([40, 50]);
  });

  it('範囲外の値は拒否される', () => {
    const h = sketchWith([20]);
    for (const v of [9.99, 50.01]) {
      const r = h.insert(v);
      expect(!r.ok && r.error.kind).toBe('unsupported-value');
    }
  });

  it('丸めで境界が区別できない指定はエラー', () => {
    const r = buildBoundaries({ kind: 'equal', lower: 1, upper: 1 + Number.EPSILON, buckets: 4 });
    expect(r.ok).toBe(false);
    expect(doc).toContain('1 + 2.2e-16');
    expect(Number.EPSILON).toBeCloseTo(2.2e-16, 17);
  });

  it('メモリ見積もりは (2 × バケット数 + 2) × 8 バイト', () => {
    const s = histogramSpec(EQUAL);
    if (!s.ok) throw new Error('spec');
    expect(s.value.create(1).memoryBytes()).toBe((2 * 4 + 2) * 8);
    expect(doc).toContain('(2 × バケット数 + 2) × 8');
  });

  it('投入 1 回の移動は 2 回', () => {
    const s = sketchWith([20]);
    expect(s.operationCounts().moves).toBe(2);
  });
});
