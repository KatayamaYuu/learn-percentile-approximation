import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHdrLayout, createLogMapping } from './index';

const docsDir = join(__dirname, '..', '..', 'docs', 'relative-error');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

/** 有効数字 n 桁に丸めた数を、文書に書く形(指数表記にしない)の文字列にする */
const sig = (x: number, n = 6): string => String(Number(x.toPrecision(n)));

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string): string[] {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${firstCell} |`));
  if (line === undefined) throw new Error(`row not found: ${firstCell}`);
  return line.split('|').slice(1, -1).map((c) => c.trim());
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
