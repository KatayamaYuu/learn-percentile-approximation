// @vitest-environment happy-dom
// ストリーミング分位点のページのテスト(5.1〜5.9、9.2、9.6)。偽の計算の窓口と、実際のジョブ(runStreamingPage)で作った結果を使う。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import { DEFAULT_STREAMING, PAGE_DEFAULTS, type StreamingPageCondition } from '../../shared/conditions';
import type { JobRequest, StreamingPageResult } from '../../shared/protocol';
import { runStreamingPage } from '../../worker/run-streaming-page';
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { PAGE_GUIDES } from '../../content/guides';
import type { ChartPanel } from '../components/chart-panel';
import type { ComputeClient, ComputeStatus } from '../compute/compute-client';
import { createConditionStore } from '../condition-store';
import { reasonOf, typeInto } from '../controls/test-helpers';
import type { PageContext } from '../page-registry';
import { mountStreamingPage, streamingPage } from './streaming-page';

afterEach(() => {
  document.body.innerHTML = '';
});

const SMALL: StreamingPageCondition = { ...DEFAULT_STREAMING, data: { ...DEFAULT_STREAMING.data, count: 1000 } };

function realResult(condition: StreamingPageCondition): StreamingPageResult {
  const r = runStreamingPage(condition);
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

function setup(initial?: StreamingPageCondition) {
  const client = fakeClient();
  const store = createConditionStore();
  if (initial !== undefined) store.set('streaming', initial);
  const context: PageContext = { store, announce: vi.fn(), createCompute: () => client };
  const container = document.createElement('div');
  document.body.append(container);
  const specs: ChartSpec[] = [];
  const instance = mountStreamingPage(container, context, {
    createPanel: (s) => {
      const element = document.createElement('section');
      element.className = 'chart-panel';
      const render = (c: ChartSpec) => {
        element.textContent = [c.title, ...c.notes, ...c.referenceLines.map((r) => r.label)].join('\n');
        element.dataset.chart = c.id;
        element.dataset.refs = String(c.referenceLines.length);
      };
      render(s);
      specs.push(s);
      return { element, update: render, destroy: () => element.remove() } as unknown as ChartPanel;
    },
  });
  const last = (): StreamingPageCondition => {
    const j = client.requests.at(-1);
    if (j === undefined || j.kind !== 'streaming') throw new Error('no streaming request');
    return j.condition;
  };
  const $ = <T extends HTMLElement>(id: string): T => container.querySelector<T>(`#${id}`)!;
  const boxes = (id: string) => [...$(id).querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const toggle = (box: HTMLInputElement, checked: boolean) => {
    box.checked = checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const chartIds = () => [...container.querySelectorAll<HTMLElement>('.chart-panel')].map((p) => p.dataset.chart);
  return { client, store, container, instance, specs, last, $, boxes, toggle, chartIds };
}

describe('streamingPage', () => {
  it('ページの登録の形(題名・パス)を持つ', () => {
    expect(streamingPage.id).toBe('streaming');
    expect(streamingPage.path).toBe('/streaming');
    expect(streamingPage.title).toBe('ストリーミング分位点');
    expect(streamingPage.navLabel).toBe('ストリーミング分位点');
  });

  it('共通の条件と、手法・ε・k・δ・スケール関数・試行・内部状態の対象の操作部品を置き、既定の条件で依頼する(5.1、5.2)', () => {
    const t = setup();
    for (const id of [
      'distribution-kind', 'stream-count', 'stream-seed', 'stream-order',
      'stream-methods', 'stream-epsilon', 'stream-epsilon-number', 'stream-k', 'stream-k-number',
      'stream-compression', 'stream-compression-number', 'stream-scales', 'stream-trials', 'stream-trials-number',
      'stream-inspect',
    ]) {
      expect(t.$(id), id).not.toBeNull();
    }
    expect(t.client.requests).toHaveLength(1);
    expect(t.last()).toEqual(PAGE_DEFAULTS.streaming);
  });

  it('記録した結果で、グラフ・ε の基準線・内部状態の図と表・条件の表示・解説・手引きが出る(5.3〜5.9、9.2、9.6)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    const ids = t.chartIds();
    for (const id of ['streaming-gk-param-error', 'streaming-kll-param-memory', 'streaming-tradeoff', 'streaming-quantile-error', 'streaming-order-error', 'streaming-inspect-gk']) {
      expect(ids, id).toContain(id);
    }
    // 順位誤差の GK のグラフに ε の基準線(5.9)
    expect(t.container.querySelector<HTMLElement>('[data-chart="streaming-gk-param-error"]')!.dataset.refs).toBe('1');
    expect(t.container.querySelector('.condition-summary')?.textContent).toContain('1,000');
    // 内部状態の表と省略の情報(5.8)
    expect(t.container.querySelector('.state-table table')).not.toBeNull();
    expect(t.container.querySelector('.state-table-facts')?.textContent).toContain('タプル数');
    // 解説: GK・KLL・t-digest
    const articles = [...t.container.querySelectorAll('.explainer-item h3')].map((h) => h.textContent);
    expect(articles).toEqual(ALGORITHM_EXPLAINERS.filter((e) => e.page === 'streaming').map((e) => e.name));
    expect(articles).toHaveLength(3);
    const guide = PAGE_GUIDES.find((g) => g.page === 'streaming')!;
    expect(t.container.querySelector('.explainer-guide')?.textContent).toContain(guide.tryThis[0]);
  });

  it('内部状態の表が長いとき、省略の通知が出る(5.8)', () => {
    const cond: StreamingPageCondition = { ...SMALL, inspectTarget: 'gk', epsilon: 0.0001, data: { ...SMALL.data, count: 5000 } };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    const notice = t.container.querySelector('.state-table-notice');
    expect(notice?.textContent).toContain('先頭');
  });

  it('内部状態の対象を変えると依頼に写り、結果では対象の図に替わる(5.8)', () => {
    const cond: StreamingPageCondition = { ...SMALL, inspectTarget: 'kll' };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    expect(t.chartIds()).toContain('streaming-inspect-kll');
    expect(t.chartIds()).not.toContain('streaming-inspect-gk');
    const sel = t.$<HTMLSelectElement>('stream-inspect');
    sel.value = 'tdigest';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.last().inspectTarget).toBe('tdigest');
  });

  it('試行の回数が 2 以上のとき、KLL の試行のばらつきのグラフが出る(5.7)', () => {
    const cond: StreamingPageCondition = { ...SMALL, trials: 2 };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    expect(t.chartIds()).toContain('streaming-kll-trials');
  });

  it('操作の変更が、待ち合わせのあとの依頼の条件に写る(5.2)', () => {
    const t = setup();
    typeInto(t.$('stream-epsilon-number'), '0.05');
    expect(t.last().epsilon).toBe(0.05);
    typeInto(t.$('stream-k-number'), '64');
    expect(t.last().k).toBe(64);
    typeInto(t.$('stream-compression-number'), '200');
    expect(t.last().compression).toBe(200);
    typeInto(t.$('stream-trials-number'), '5');
    expect(t.last().trials).toBe(5);
    typeInto(t.$('stream-count-number'), '5000');
    expect(t.last().data.count).toBe(5000);
    const scales = t.boxes('stream-scales');
    t.toggle(scales[0]!, true); // k0 を追加
    expect(t.last().scales).toEqual(['k0', 'k1']);
    expect(t.store.get('streaming')?.epsilon).toBe(0.05);
  });

  it('範囲外の値は理由が出て依頼しない(5.2)', () => {
    const t = setup();
    const before = t.client.requests.length;
    typeInto(t.$('stream-epsilon-number'), '0.9');
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('stream-epsilon-number'))).not.toBeNull();
    typeInto(t.$('stream-trials-number'), '11');
    expect(t.client.requests).toHaveLength(before);
  });

  it('手法の選択を 1 つに絞ると依頼に写り、0 件にすると理由が出て依頼しない(5.1)', () => {
    const t = setup();
    const m = t.boxes('stream-methods');
    t.toggle(m[1]!, false);
    t.toggle(m[2]!, false);
    expect(t.last().methods).toEqual(['gk']);
    const before = t.client.requests.length;
    t.toggle(m[0]!, false);
    expect(t.client.requests).toHaveLength(before);
    expect(t.$('stream-methods').textContent).toContain('1 つ以上');
  });

  it('内部状態の対象が選んだ手法に含まれないとき、理由が出て依頼しない(5.8)', () => {
    const t = setup(); // 対象は gk
    const m = t.boxes('stream-methods');
    const before = t.client.requests.length;
    t.toggle(m[0]!, false);
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('stream-inspect'))).toContain('選んだ手法');
  });

  it('スケール関数を 0 件にすると(t-digest が対象のとき)理由が出て依頼しない(5.1)', () => {
    const t = setup();
    const before = t.client.requests.length;
    t.toggle(t.boxes('stream-scales')[1]!, false); // k1 を外す
    expect(t.client.requests).toHaveLength(before);
    expect(t.$('stream-scales').textContent).toContain('スケール関数');
  });

  it('既定に戻すと操作部品と依頼が既定の条件に戻る', () => {
    const t = setup(SMALL);
    typeInto(t.$('stream-epsilon-number'), '0.05');
    const reset = [...t.container.querySelectorAll('button')].find((b) => b.textContent === '既定に戻す')!;
    reset.click();
    expect(t.last()).toEqual(PAGE_DEFAULTS.streaming);
    expect(t.$<HTMLInputElement>('stream-epsilon-number').value).toBe('0.01');
    expect(t.$<HTMLInputElement>('stream-count-number').value).toBe('10000');
  });

  it('離れるとき、グラフを破棄して骨組みを取り除く(3.7)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    expect(t.container.querySelector('.chart-panel')).not.toBeNull();
    t.instance.unmount();
    expect(t.container.querySelector('.page-columns')).toBeNull();
  });
});
