import { describe, expect, it } from 'vitest';
import {
  altText,
  defaultScale,
  prepareForScale,
  toTable,
  type ChartSpec,
} from './chart-spec';

const base: ChartSpec = {
  id: 'c1',
  title: '件数ごとのメモリ',
  x: { label: '件数', unit: '件', scale: 'log', toggleable: true },
  y: { label: 'メモリ', unit: 'バイト', scale: 'log', toggleable: true },
  series: [
    {
      id: 'a',
      label: 'GK',
      kind: 'line',
      points: [
        { x: 100, y: 0 },
        { x: 1000, y: 2.5 },
        { x: 0, y: 4 },
        { x: 10000, y: -1, detail: '負の値' },
      ],
    },
    { id: 'b', label: 'KLL', kind: 'line', points: [{ x: 100, y: 8 }] },
  ],
  referenceLines: [],
  notes: ['既存の注記'],
  summary: '2 つの手法のメモリ',
};

describe('prepareForScale(7.6)', () => {
  it('対数軸では 0 以下の点を除き、注記に足す', () => {
    const out = prepareForScale(base, { x: 'log', y: 'log' });
    expect(out.series[0]!.points.map((p) => p.x)).toEqual([1000]);
    expect(out.series[1]!.points).toHaveLength(1);
    expect(out.notes[0]).toBe('既存の注記');
    expect(out.notes.length).toBe(2);
    expect(out.notes[1]).toContain('GK');
    expect(out.notes[1]).toContain('3');
    expect(out.x.scale).toBe('log');
    expect(out.y.scale).toBe('log');
  });
  it('線形軸では除かない(注記も足さない)', () => {
    const out = prepareForScale(base, { x: 'linear', y: 'linear' });
    expect(out.series[0]!.points).toHaveLength(4);
    expect(out.notes).toEqual(['既存の注記']);
    expect(out.x.scale).toBe('linear');
  });
  it('片方の軸だけが対数なら、その軸の値だけで判定する', () => {
    const out = prepareForScale(base, { x: 'linear', y: 'log' });
    // y が 0 以下: (100, 0) と (10000, -1)
    expect(out.series[0]!.points.map((p) => p.x)).toEqual([1000, 0]);
    const out2 = prepareForScale(base, { x: 'log', y: 'linear' });
    expect(out2.series[0]!.points.map((p) => p.x)).toEqual([100, 1000, 10000]);
  });
  it('元の仕様は変えない', () => {
    prepareForScale(base, { x: 'log', y: 'log' });
    expect(base.series[0]!.points).toHaveLength(4);
    expect(base.notes).toHaveLength(1);
  });
  it('除く点がなければ注記を足さない', () => {
    const clean: ChartSpec = { ...base, series: [base.series[1]!] };
    expect(prepareForScale(clean, { x: 'log', y: 'log' }).notes).toEqual(['既存の注記']);
  });
  it('文字列の x(棒グラフの項目)は x の対数判定で除かない', () => {
    const bar: ChartSpec = {
      ...base,
      series: [{ id: 's', label: 'S', kind: 'bar', points: [{ x: 'random', y: 1 }, { x: 'sorted', y: 0 }] }],
    };
    const out = prepareForScale(bar, { x: 'log', y: 'log' });
    expect(out.series[0]!.points.map((p) => p.x)).toEqual(['random']);
  });
  it('NaN は対数軸でも線形軸でも描けないので除く扱いは対数軸のみ(有限でない値は 0 以下と同様)', () => {
    const nan: ChartSpec = { ...base, series: [{ id: 's', label: 'S', kind: 'line', points: [{ x: 1, y: Number.NaN }, { x: 2, y: 3 }] }] };
    expect(prepareForScale(nan, { x: 'log', y: 'log' }).series[0]!.points).toHaveLength(1);
  });
});

describe('既定の尺度(7.1)', () => {
  it('件数・誤差・操作数・メモリは対数、分位点・処理時間は線形', () => {
    expect(defaultScale('count')).toBe('log');
    expect(defaultScale('error')).toBe('log');
    expect(defaultScale('operations')).toBe('log');
    expect(defaultScale('memory')).toBe('log');
    expect(defaultScale('quantile')).toBe('linear');
    expect(defaultScale('time')).toBe('linear');
  });
});

describe('toTable(10.3)', () => {
  it('行数は点の数に等しい', () => {
    const t = toTable(base);
    expect(t.rows).toHaveLength(5);
    expect(t.caption).toBe('件数ごとのメモリ');
    expect(t.columns[0]).toBe('系列');
    expect(t.columns).toContain('件数(件)');
    expect(t.columns).toContain('メモリ(バイト)');
  });
  it('系列名・整形した数値・詳細が入る', () => {
    const t = toTable(base);
    expect(t.rows[0]).toEqual(['GK', '100', '0', '']);
    expect(t.rows[1]![2]).toBe('2.5');
    expect(t.rows[3]).toEqual(['GK', '10,000', '-1', '負の値']);
    expect(t.rows[4]![0]).toBe('KLL');
  });
  it('単位がない軸は名前だけ、文字列の x はそのまま', () => {
    const spec: ChartSpec = {
      ...base,
      x: { label: '順序', unit: '', scale: 'linear', toggleable: false },
      series: [{ id: 's', label: 'S', kind: 'bar', points: [{ x: 'random', y: 0.123456 }] }],
    };
    const t = toTable(spec);
    expect(t.columns).toContain('順序');
    expect(t.rows[0]).toEqual(['S', 'random', '0.123', '']);
  });
  it('点がなくても列だけ作る', () => {
    expect(toTable({ ...base, series: [] }).rows).toEqual([]);
  });
});

describe('altText(10.3)', () => {
  it('題名・系列名・軸・要約を含む', () => {
    const t = altText(base);
    expect(t).toContain('件数ごとのメモリ');
    expect(t).toContain('GK');
    expect(t).toContain('KLL');
    expect(t).toContain('件数');
    expect(t).toContain('バイト');
    expect(t).toContain('2 つの手法のメモリ');
  });
  it('系列がなければ、その旨を書く', () => {
    expect(altText({ ...base, series: [] })).toContain('系列はありません');
  });
});
