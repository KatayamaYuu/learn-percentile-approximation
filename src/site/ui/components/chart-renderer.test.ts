// @vitest-environment happy-dom
// Chart.js 設定の組み立て(canvas なしで確かめられる純粋関数)のテスト(7.3、7.4、10.4、10.7、10.8)。
import { describe, expect, it } from 'vitest';
import type { ChartSpec, SeriesSpec } from '../../shared/chart-spec';
import { SERIES_STYLES } from './chart-styles';
import { buildChartConfig } from './chart-renderer';

function series(id: string, over: Partial<SeriesSpec> = {}): SeriesSpec {
  return {
    id,
    label: `系列${id}`,
    kind: 'line',
    points: [
      { x: 1, y: 2, detail: '条件' },
      { x: 10, y: 4 },
    ],
    ...over,
  };
}

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    id: 'c',
    title: '題',
    x: { label: '件数', unit: '件', scale: 'log', toggleable: true },
    y: { label: '誤差', unit: '', scale: 'linear', toggleable: true },
    series: [series('a'), series('b'), series('c', { kind: 'scatter' }), series('d', { kind: 'bar' })],
    referenceLines: [],
    notes: [],
    summary: '',
    ...over,
  };
}

describe('SERIES_STYLES', () => {
  it('色・破線・点の形の組がすべて異なる(10.4)', () => {
    const keys = SERIES_STYLES.map((s) => JSON.stringify([s.color, s.dash, s.pointStyle]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(SERIES_STYLES.map((s) => s.pointStyle)).size).toBe(SERIES_STYLES.length);
    expect(new Set(SERIES_STYLES.map((s) => s.color)).size).toBe(SERIES_STYLES.length);
  });
});

describe('buildChartConfig', () => {
  it('系列ごとに別のスタイルを割り当て、種類を dataset に写す(10.4)', () => {
    const cfg = buildChartConfig(spec(), true);
    const ds = cfg.data.datasets;
    expect(ds).toHaveLength(4);
    expect(new Set(ds.map((d) => d.borderColor)).size).toBe(4);
    expect(new Set(ds.map((d) => (d as { pointStyle?: unknown }).pointStyle)).size).toBe(4);
    expect(ds.map((d) => d.type)).toEqual(['line', 'line', 'scatter', 'bar']);
    expect(ds[0]?.label).toBe('系列a');
  });

  it('SeriesSpec.dashed の系列は破線になる', () => {
    const cfg = buildChartConfig(spec({ series: [series('a'), series('b', { dashed: true })] }), true);
    const [a, b] = cfg.data.datasets as unknown as { borderDash: number[] }[];
    expect(a?.borderDash).toEqual(SERIES_STYLES[0]?.dash);
    expect((b?.borderDash ?? []).length).toBeGreaterThan(0);
  });

  it('基準線は点のない破線の折れ線として、系列の範囲に渡って描く', () => {
    const cfg = buildChartConfig(
      spec({
        series: [series('a')],
        referenceLines: [
          { axis: 'y', value: 3, label: 'ε' },
          { axis: 'x', value: 5, label: '上限' },
        ],
      }),
      true,
    );
    const ds = cfg.data.datasets as unknown as { label: string; type: string; borderDash: number[]; pointRadius: number; data: { x: number; y: number }[] }[];
    expect(ds).toHaveLength(3);
    const eps = ds[1];
    expect(eps?.label).toBe('ε');
    expect(eps?.type).toBe('line');
    expect(eps?.pointRadius).toBe(0);
    expect((eps?.borderDash ?? []).length).toBeGreaterThan(0);
    expect(eps?.data).toEqual([
      { x: 1, y: 3 },
      { x: 10, y: 3 },
    ]);
    expect(ds[2]?.data).toEqual([
      { x: 5, y: 2 },
      { x: 5, y: 4 },
    ]);
  });

  it('対数軸で 0 以下の基準線は描かない', () => {
    const cfg = buildChartConfig(
      spec({ series: [series('a')], referenceLines: [{ axis: 'x', value: 0, label: 'z' }] }),
      true,
    );
    expect(cfg.data.datasets).toHaveLength(1);
  });

  it('軸の題は「名前(単位)」、尺度は spec に従う(7.1、7.3)', () => {
    const cfg = buildChartConfig(spec(), true);
    const scales = cfg.options?.scales as Record<string, { type: string; title: { text: string } }>;
    expect(scales.x?.type).toBe('logarithmic');
    expect(scales.x?.title.text).toBe('件数(件)');
    expect(scales.y?.type).toBe('linear');
    expect(scales.y?.title.text).toBe('誤差');
  });

  it('x が文字列の系列では category 軸にする', () => {
    const cfg = buildChartConfig(
      spec({ series: [series('a', { points: [{ x: '甲', y: 1 }, { x: '乙', y: 2 }] })], x: { label: '手法', unit: '', scale: 'linear', toggleable: false } }),
      true,
    );
    const scales = cfg.options?.scales as Record<string, { type: string }>;
    expect(scales.x?.type).toBe('category');
  });

  it('animate: false でアニメーションを止める(10.7)、responsive で枠に合わせる(10.8)', () => {
    expect(buildChartConfig(spec(), false).options?.animation).toBe(false);
    expect(buildChartConfig(spec(), true).options?.animation).not.toBe(false);
    const o = buildChartConfig(spec(), true).options;
    expect(o?.responsive).toBe(true);
    expect(o?.maintainAspectRatio).toBe(false);
  });

  it('ツールチップに系列名・x・y・詳細を出す(7.4)', () => {
    const cfg = buildChartConfig(spec(), true);
    const label = cfg.options?.plugins?.tooltip?.callbacks?.label as (ctx: unknown) => string | string[];
    const text = label({
      dataset: { label: '系列a' },
      raw: { x: 1, y: 2, detail: '条件' },
      parsed: { x: 1, y: 2 },
    });
    const joined = Array.isArray(text) ? text.join('\n') : text;
    expect(joined).toContain('系列a');
    expect(joined).toContain('条件');
    expect(joined).toContain('2');
  });

  it('category 軸では全系列の x を最初に現れた順の labels にする(1 系列 1 点でも全項目が出る)', () => {
    const cats = ['甲', '乙', '丙'];
    const cfg = buildChartConfig(
      spec({
        series: cats.map((c, i) => series(`s${i}`, { kind: 'bar', points: [{ x: c, y: i + 1 }] })),
        x: { label: '手法', unit: '', scale: 'linear', toggleable: false },
      }),
      true,
    );
    expect(cfg.data.labels).toEqual(cats);
  });

  it('数値の x では labels を付けない', () => {
    expect(buildChartConfig(spec(), true).data.labels).toBeUndefined();
  });

  it('8 本目の系列は 1 本目と見た目が異なる', () => {
    const many = Array.from({ length: SERIES_STYLES.length + 1 }, (_, i) => series(`m${i}`));
    const ds = buildChartConfig(spec({ series: many }), true).data.datasets as unknown as Record<string, unknown>[];
    const first = ds[0] as Record<string, unknown>;
    const eighth = ds[SERIES_STYLES.length] as Record<string, unknown>;
    expect(first['borderColor']).toBe(eighth['borderColor']);
    expect(first['pointRadius'] !== eighth['pointRadius'] || first['borderWidth'] !== eighth['borderWidth']).toBe(true);
  });
});
