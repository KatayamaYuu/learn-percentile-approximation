// @vitest-environment happy-dom
// 厳密解とヒストグラムのページのテスト(4.1〜4.6、9.2、9.6)。偽の計算の窓口と、実際のジョブ(runHistogramPage)で作った結果を使う。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import { PAGE_DEFAULTS, type HistogramPageCondition } from '../../shared/conditions';
import type { HistogramPageResult, JobRequest } from '../../shared/protocol';
import { runHistogramPage } from '../../worker/run-histogram-page';
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { PAGE_GUIDES } from '../../content/guides';
import type { ChartPanel } from '../components/chart-panel';
import type { ComputeClient, ComputeStatus } from '../compute/compute-client';
import { createConditionStore } from '../condition-store';
import { reasonOf, typeInto } from '../controls/test-helpers';
import type { PageContext } from '../page-registry';
import { histogramPage, mountHistogramPage } from './histogram-page';

afterEach(() => {
  document.body.innerHTML = '';
});

const SMALL: HistogramPageCondition = { ...PAGE_DEFAULTS.histogram, data: { ...PAGE_DEFAULTS.histogram.data, count: 1000 } };

function realResult(condition: HistogramPageCondition): HistogramPageResult {
  const r = runHistogramPage(condition);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

interface FakeClient extends ComputeClient {
  readonly requests: JobRequest[];
  readonly emit: (s: ComputeStatus) => void;
}

function fakeClient(): FakeClient {
  const listeners = new Set<(s: ComputeStatus) => void>();
  const requests: JobRequest[] = [];
  return {
    requests,
    request: (job) => void requests.push(job),
    retry: () => {},
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    dispose: () => {},
    emit: (s) => {
      for (const l of [...listeners]) l(s);
    },
  };
}

function setup(initial?: HistogramPageCondition) {
  const client = fakeClient();
  const store = createConditionStore();
  if (initial !== undefined) store.set('histogram', initial);
  const context: PageContext = { store, announce: vi.fn(), createCompute: () => client };
  const container = document.createElement('div');
  document.body.append(container);
  const specs: ChartSpec[] = [];
  const instance = mountHistogramPage(container, context, {
    createPanel: (s) => {
      const element = document.createElement('section');
      element.className = 'chart-panel';
      const render = (c: ChartSpec) => {
        element.textContent = [c.title, ...c.notes].join('\n');
        element.dataset.chart = c.id;
      };
      render(s);
      specs.push(s);
      return { element, update: render, destroy: () => element.remove() } as unknown as ChartPanel;
    },
  });
  const last = (): HistogramPageCondition => {
    const j = client.requests.at(-1);
    if (j === undefined || j.kind !== 'histogram') throw new Error('no histogram request');
    return j.condition;
  };
  const $ = <T extends HTMLElement>(id: string): T => container.querySelector<T>(`#${id}`)!;
  return { client, store, container, instance, specs, last, $ };
}

describe('histogramPage', () => {
  it('ページの登録の形(題名・パス)を持つ', () => {
    expect(histogramPage.id).toBe('histogram');
    expect(histogramPage.path).toBe('/histogram');
    expect(histogramPage.title).toBe('厳密解とヒストグラム');
    expect(histogramPage.navLabel).toBe('厳密解とヒストグラム');
  });

  it('共通の条件・バケット数・境界・範囲の操作部品を置き、既定の条件で依頼する(4.2)', () => {
    const t = setup();
    for (const id of ['distribution-kind', 'hist-count', 'hist-count-number', 'hist-seed', 'hist-order', 'hist-buckets', 'hist-buckets-number', 'hist-schemes', 'hist-range-kind']) {
      expect(t.$(id), id).not.toBeNull();
    }
    expect(t.client.requests).toHaveLength(1);
    expect(t.last()).toEqual(PAGE_DEFAULTS.histogram);
    // 範囲が「データ」のとき、下限・上限の欄は隠れている
    expect((t.$('hist-range-fixed')).hidden).toBe(true);
  });

  it('記録した結果で、グラフ・条件の表示・注記・解説・手引きが出る(4.3〜4.5、9.2、9.6)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    const ids = [...t.container.querySelectorAll<HTMLElement>('.chart-panel')].map((p) => p.dataset.chart);
    expect(ids).toContain('histogram-buckets-error');
    expect(ids).toContain('histogram-count-operations');
    expect(ids).toContain('histogram-count-memory');
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(t.container.querySelector('.condition-summary')?.textContent).toContain('1,000');
    // 解説: 厳密解 2 方式とヒストグラムの手法すべて
    const articles = [...t.container.querySelectorAll('.explainer-item h3')].map((h) => h.textContent);
    const expected = ALGORITHM_EXPLAINERS.filter((e) => e.page === 'histogram').map((e) => e.name);
    expect(expected.length).toBeGreaterThanOrEqual(4);
    expect(articles).toEqual(expected);
    // 手引き
    const guide = PAGE_GUIDES.find((g) => g.page === 'histogram')!;
    expect(t.container.querySelector('.explainer-guide')?.textContent).toContain(guide.tryThis[0]);
  });

  it('固定の範囲がデータを覆わないとき、失敗の理由を注記に出し、ほかの結果は表示する(4.6)', () => {
    const cond: HistogramPageCondition = { ...SMALL, range: { kind: 'fixed', lower: 1000, upper: 2000 } };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    const err = t.container.querySelector<HTMLElement>('[data-chart="histogram-buckets-error"]');
    expect(err).not.toBeNull();
    expect(err!.textContent!.split('\n').length).toBeGreaterThan(1); // タイトル + 注記
    expect(t.container.querySelector('[data-chart="histogram-count-memory"]')).not.toBeNull();
  });

  it('操作の変更が、待ち合わせのあとの依頼の条件に写る(4.2)', () => {
    const t = setup();
    const n0 = t.client.requests.length;
    typeInto(t.$('hist-buckets-number'), '100');
    expect(t.last().buckets).toBe(100);
    typeInto(t.$('hist-count-number'), '5000');
    expect(t.last().data.count).toBe(5000);
    typeInto(t.$('hist-seed'), '7');
    expect(t.last().data.seed).toBe(7);
    typeInto(t.$('hist-order'), 'ascending');
    t.$('hist-order').dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.last().data.order).toBe('ascending');
    const kind = t.$<HTMLSelectElement>('distribution-kind');
    kind.value = 'normal';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.last().data.distribution.kind).toBe('normal');
    expect(t.client.requests.length).toBeGreaterThan(n0);
    // 保存した条件にも写る
    expect(t.store.get('histogram')?.buckets).toBe(100);
  });

  it('境界の決め方を 1 つに絞ると依頼に写り、0 件にすると理由が出て依頼しない', () => {
    const t = setup();
    const boxes = [...t.$('hist-schemes').querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    boxes[0]!.checked = false;
    boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.last().schemes).toEqual(['exponential']);
    const before = t.client.requests.length;
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.client.requests).toHaveLength(before);
    expect(t.$('hist-schemes').textContent).toContain('1 つ以上');
  });

  it('範囲を固定にすると下限・上限の欄が出て、入力が依頼に写る。不正な範囲は理由が出て依頼しない(4.2)', () => {
    const t = setup();
    const params = t.$('hist-range-fixed');
    const kind = t.$<HTMLSelectElement>('hist-range-kind');
    kind.value = 'fixed';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(params.hidden).toBe(false);
    expect(t.last().range.kind).toBe('fixed');
    typeInto(t.$('hist-range-lower'), '0.5');
    typeInto(t.$('hist-range-upper'), '900');
    expect(t.last().range).toEqual({ kind: 'fixed', lower: 0.5, upper: 900 });
    const before = t.client.requests.length;
    typeInto(t.$('hist-range-lower'), '2000');
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('hist-range-lower'))).toContain('より小さい');
    // データの範囲に戻す
    kind.value = 'data-extent';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(params.hidden).toBe(true);
    expect(t.last().range).toEqual({ kind: 'data-extent' });
  });

  it('分布のパラメータの誤りは該当の欄のそばに理由を出し、依頼しない', () => {
    const t = setup();
    const kind = t.$<HTMLSelectElement>('distribution-kind');
    kind.value = 'multimodal';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    const before = t.client.requests.length;
    // Worker が返した条件の誤り(上流の項目名)を、項目に対応づけて出す
    t.client.emit({
      state: 'failed',
      failure: { kind: 'invalid-condition', issues: [{ field: 'data.distribution.modes[1].stdDev', reason: '標準偏差は正の数にしてください。' }] },
    });
    expect(t.container.textContent).toContain('標準偏差は正の数にしてください。');
    expect(t.client.requests).toHaveLength(before);
  });

  it('既定に戻すと操作部品と依頼が既定の条件に戻る', () => {
    const t = setup(SMALL);
    typeInto(t.$('hist-buckets-number'), '100');
    const reset = [...t.container.querySelectorAll('button')].find((b) => b.textContent === '既定に戻す')!;
    reset.click();
    expect(t.last()).toEqual(PAGE_DEFAULTS.histogram);
    expect(t.$<HTMLInputElement>('hist-buckets-number').value).toBe('32');
    expect(t.$<HTMLInputElement>('hist-count-number').value).toBe('10000');
  });

  it('離れるとき、グラフを破棄して骨組みを取り除く(3.7)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    expect(t.container.querySelector('.chart-panel')).not.toBeNull();
    t.instance.unmount();
    expect(t.container.querySelector('.page-columns')).toBeNull();
  });
});
