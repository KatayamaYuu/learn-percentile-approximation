import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHdrLayout, createLogMapping } from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'relative-error');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

/** 有効数字 n 桁に丸めた数を、文書に書く形(指数表記にしない)の文字列にする */
const sig = (x: number, n = 6): string => String(Number(x.toPrecision(n)));

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string, width?: number): string[] {
  for (const line of doc.split('\n')) {
    if (!line.startsWith(`| ${firstCell} |`)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (width === undefined || cells.length === width) return cells;
  }
  throw new Error(`row not found: ${firstCell}`);
}

describe('ddsketch.md の数値例', () => {
  const doc = readDoc('ddsketch.md');
  const mapping = createLogMapping(0.01);
  if (!mapping.ok) throw new Error('mapping');
  const m = mapping.value;

  it('α = 0.01 の γ と ln γ', () => {
    expect(rowOf(doc, 'γ')).toEqual(['γ', sig(m.gamma)]);
    expect(rowOf(doc, 'ln γ')).toEqual(['ln γ', sig(Math.log(m.gamma))]);
  });

  it.each([100, 100000])('値 %i の番号・境界・代表値・相対誤差', (x) => {
    const i = m.indexOf(x);
    const rep = m.representative(i);
    expect(rowOf(doc, String(x))).toEqual([
      String(x),
      String(i),
      sig(m.lowerBound(i)),
      sig(m.upperBound(i)),
      sig(rep),
      sig(Math.abs(rep - x) / x, 3),
    ]);
    expect(Math.abs(rep - x) / x).toBeLessThanOrEqual(0.01);
  });

  it('10 倍ごとの番号の進みと、値 1・1,000・1,000,000 の番号', () => {
    expect(sig(Math.log(10) / Math.log(m.gamma), 4)).toBe('115.1');
    expect(doc).toContain('約 115.1 進む');
    const [i1, i1000, i1e6] = [1, 1000, 1_000_000].map((x) => m.indexOf(x)) as [number, number, number];
    expect([i1, i1000, i1e6]).toEqual([0, 346, 691]);
    expect([i1000 - i1, i1e6 - i1000]).toEqual([346, 345]);
    expect(doc).toContain('値 1 の番号は 0、値 1,000 の番号は 346、値 1,000,000 の番号は 691 で、差は 346 と 345');
  });

  it('縮約が起きない範囲の目安 γ^m', () => {
    const lg = Math.log(m.gamma);
    expect(Number(Math.exp(2048 * lg).toPrecision(3))).toBe(6.16e17);
    expect(doc).toContain('γ^2048 ≈ 6.16e17');
    expect(Number(Math.exp(64 * lg).toPrecision(3))).toBe(3.6);
    expect(doc).toContain('γ^64 ≈ 3.60');
  });
});

describe('hdr-histogram.md の数値例', () => {
  const doc = readDoc('hdr-histogram.md');
  const layoutOf = (significantDigits: number) => {
    const r = createHdrLayout({ lowest: 1, highest: 3_600_000, significantDigits });
    if (!r.ok) throw new Error('layout');
    return r.value;
  };

  it.each([0, 1, 2, 3, 4, 5])('d = %i の S、総数、メモリ見積もり', (d) => {
    const l = layoutOf(d);
    expect(rowOf(doc, String(d), 2)).toEqual([String(d), String(l.subBucketCount)]);
    expect(doc).toContain(`| ${d} | ${l.subBucketCount} | ${l.totalBuckets} | ${(3 + l.totalBuckets + 1) * 8} |`);
  });

  it('d = 2 の S と総数', () => {
    const l = layoutOf(2);
    expect(rowOf(doc, 'S')).toEqual(['S', String(l.subBucketCount)]);
    expect(rowOf(doc, 'バケットの総数')).toEqual(['バケットの総数', String(l.totalBuckets)]);
    expect(l.totalBuckets).toBe(256 + 14 * 128);
    expect(doc).toContain('`256 + 14 × 128 = 2048`');
  });

  it.each([1, 100, 150, 1_000_000])('値 %i の番号・境界・代表値', (x) => {
    const l = layoutOf(2);
    const i = l.indexOf(x);
    expect(rowOf(doc, String(x), 5)).toEqual([
      String(x),
      String(i),
      sig(l.lowerBound(i), 10),
      sig(l.upperBound(i), 10),
      sig(l.representative(i), 10),
    ]);
  });

  it('本文中の誤差の数値', () => {
    const l = layoutOf(2);
    const rep = l.representative(l.indexOf(1_000_000));
    expect(rep - 1_000_000).toBe(1472);
    expect(sig(Math.abs(rep - 1_000_000) / 1_000_000, 2)).toBe('0.0015');
    expect(sig(Math.abs(l.representative(l.indexOf(100)) - 100) / 100, 2)).toBe('0.005');
    expect(sig(1 / l.subBucketCount, 2)).toBe('0.0039');
    expect(l.upperBound(l.indexOf(1_000_000)) - l.lowerBound(l.indexOf(1_000_000))).toBe(4096);
  });
});
