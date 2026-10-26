// @vitest-environment happy-dom
// ChartPanel のテスト。偽の描画層を差し込み、渡る ChartSpec・オプションと DOM を確かめる(7.1、7.3、7.4、10.3、10.4、10.7、10.8)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import { altText, prepareForScale, toTable } from '../../shared/chart-spec';
import { createChartPanel } from './chart-panel';
import type { ChartRenderer } from './chart-renderer';

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    id: 'c1',
    title: 'バケット数と誤差',
    x: { label: 'バケット数', unit: '件', scale: 'log', toggleable: true },
    y: { label: '順位誤差', unit: '', scale: 'linear', toggleable: true },
    series: [
      {
        id: 's1',
        label: '等幅',
        kind: 'line',
        points: [
          { x: 0, y: 5, detail: '零' },
          { x: 10, y: 3 },
          { x: 100, y: 1 },
        ],
      },
    ],
    referenceLines: [],
    notes: ['注記A'],
    summary: '誤差は減る。',
    ...overrides,
  };
}

interface Fake extends ChartRenderer {
  readonly renders: { spec: ChartSpec; animate: boolean; canvas: HTMLCanvasElement }[];
  readonly updates: ChartSpec[];
  readonly updateOptions: ({ animate: boolean } | undefined)[];
  destroyed: number;
}

function fakeRenderer(): Fake {
  const f: Fake = {
    renders: [],
    updates: [],
    updateOptions: [],
    destroyed: 0,
    render(canvas, spec, options) {
      f.renders.push({ spec, animate: options.animate, canvas });
    },
    update(spec, options) {
      f.updates.push(spec);
      f.updateOptions.push(options);
    },
    destroy() {
      f.destroyed += 1;
    },
  };
  return f;
}

function stubMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function buttons(el: HTMLElement, group: string): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>(`[data-axis="${group}"] button`)];
}

describe('createChartPanel', () => {
  it('見出し・代替テキスト付きの canvas・注記・表を持つ(10.3)', () => {
    stubMotion(false);
    const r = fakeRenderer();
    const spec = makeSpec();
    const panel = createChartPanel(spec, r);
    document.body.append(panel.element);
    expect(panel.element.querySelector('h3')?.textContent).toBe('バケット数と誤差');
    const canvas = panel.element.querySelector('canvas');
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toBe(altText(prepareForScale(spec, { x: 'log', y: 'linear' })));
    expect(panel.element.querySelector('.chart-notes')?.textContent).toContain('注記A');
    const details = panel.element.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('数値の表');
    const model = toTable(spec);
    const heads = [...(details?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent);
    expect(heads).toEqual(model.columns);
    expect(details?.querySelectorAll('tbody tr').length).toBe(2);
    expect(details?.querySelector('caption')?.textContent).toBe(model.caption);
    expect(r.renders).toHaveLength(1);
    expect(r.renders[0]?.canvas).toBe(canvas);
  });

  it('軸の切り替えで描画層に渡る尺度が変わり、対数で 0 以下の点が除かれる(7.1)', () => {
    stubMotion(false);
    const r = fakeRenderer();
    const panel = createChartPanel(makeSpec(), r);
    // 初期は x が対数: x=0 の点は除かれる
    expect(r.renders[0]?.spec.x.scale).toBe('log');
    expect(r.renders[0]?.spec.series[0]?.points).toHaveLength(2);
    const [xLinear, xLog] = buttons(panel.element, 'x');
    expect(xLog?.getAttribute('aria-pressed')).toBe('true');
    expect(xLinear?.getAttribute('aria-pressed')).toBe('false');
    xLinear?.click();
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]?.x.scale).toBe('linear');
    expect(r.updates[0]?.series[0]?.points).toHaveLength(3);
    expect(xLinear?.getAttribute('aria-pressed')).toBe('true');
    const [, yLog] = buttons(panel.element, 'y');
    yLog?.click();
    expect(r.updates[1]?.y.scale).toBe('log');
    expect(r.updates[1]?.x.scale).toBe('linear');
  });

  it('対数で除いた点の注記が出て、表は切り替えに追従する(7.6、10.3)', () => {
    stubMotion(false);
    const r = fakeRenderer();
    const panel = createChartPanel(makeSpec(), r);
    expect(panel.element.querySelector('.chart-notes')?.textContent).toContain('1 個の点を除きました');
    expect(panel.element.querySelectorAll('details tbody tr').length).toBe(2);
    buttons(panel.element, 'x')[0]?.click();
    expect(panel.element.querySelector('.chart-notes')?.textContent).not.toContain('除きました');
    expect(panel.element.querySelectorAll('details tbody tr').length).toBe(3);
  });

  it('toggleable でない軸には切り替えを出さず、尺度は仕様のまま', () => {
    stubMotion(false);
    const r = fakeRenderer();
    const spec = makeSpec({ y: { label: '順位誤差', unit: '', scale: 'linear', toggleable: false } });
    const panel = createChartPanel(spec, r);
    expect(buttons(panel.element, 'y')).toHaveLength(0);
    expect(buttons(panel.element, 'x')).toHaveLength(2);
    expect(r.renders[0]?.spec.y.scale).toBe('linear');
  });

  it('動きを減らす設定では animate: false、そうでなければ true(10.7)', () => {
    stubMotion(true);
    const a = fakeRenderer();
    createChartPanel(makeSpec(), a);
    expect(a.renders[0]?.animate).toBe(false);
    stubMotion(false);
    const b = fakeRenderer();
    createChartPanel(makeSpec(), b);
    expect(b.renders[0]?.animate).toBe(true);
  });

  it('matchMedia がなくても動く', () => {
    vi.stubGlobal('matchMedia', undefined);
    const r = fakeRenderer();
    createChartPanel(makeSpec(), r);
    expect(r.renders[0]?.animate).toBe(true);
  });

  it('update で見出し・代替テキスト・表・注記が更新され、利用者の尺度の選択は保たれる', () => {
    stubMotion(false);
    const r = fakeRenderer();
    const panel = createChartPanel(makeSpec(), r);
    buttons(panel.element, 'y')[1]?.click();
    const next = makeSpec({ title: '新しい題', notes: ['注記B'] });
    panel.update(next);
    expect(panel.element.querySelector('h3')?.textContent).toBe('新しい題');
    expect(panel.element.querySelector('canvas')?.getAttribute('aria-label')).toBe(altText(prepareForScale(next, { x: 'log', y: 'log' })));
    expect(panel.element.querySelector('.chart-notes')?.textContent).toContain('注記B');
    const last = r.updates[r.updates.length - 1];
    expect(last?.y.scale).toBe('log');
    expect(last?.title).toBe('新しい題');
  });

  it('注記がなければ注記の領域を隠す', () => {
    stubMotion(false);
    const panel = createChartPanel(makeSpec({ notes: [] , x: { label: 'x', unit: '', scale: 'linear', toggleable: true } }), fakeRenderer());
    expect((panel.element.querySelector('.chart-notes') as HTMLElement).hidden).toBe(true);
  });

  it('destroy で描画層を破棄する', () => {
    stubMotion(false);
    const r = fakeRenderer();
    const panel = createChartPanel(makeSpec(), r);
    panel.destroy();
    expect(r.destroyed).toBe(1);
    panel.update(makeSpec());
    expect(r.updates).toHaveLength(0);
  });

  it('canvas を囲む枠は幅に合わせる(10.8)', () => {
    stubMotion(false);
    const panel = createChartPanel(makeSpec(), fakeRenderer());
    const frame = panel.element.querySelector('.chart-canvas-frame');
    expect(frame?.querySelector('canvas')).not.toBeNull();
  });

  it('動きを減らす設定の変更に追従し、destroy で購読を外す(10.7)', () => {
    let reduce = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reduce;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
    const r = fakeRenderer();
    const panel = createChartPanel(makeSpec(), r);
    expect(listeners.size).toBe(1);
    reduce = true;
    for (const l of [...listeners]) l();
    expect(r.updateOptions[r.updateOptions.length - 1]).toEqual({ animate: false });
    panel.destroy();
    expect(listeners.size).toBe(0);
  });
});
