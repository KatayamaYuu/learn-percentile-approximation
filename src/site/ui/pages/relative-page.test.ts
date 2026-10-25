// @vitest-environment happy-dom
// 相対誤差型のページのテスト(6.1〜6.8、9.2、9.6)。偽の計算の窓口と、実際のジョブ(runRelativePage)で作った結果を使う。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import { DEFAULT_RELATIVE, PAGE_DEFAULTS, type RelativePageCondition } from '../../shared/conditions';
import type { JobRequest, RelativePageResult } from '../../shared/protocol';
import { runRelativePage } from '../../worker/run-relative-page';
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { PAGE_GUIDES } from '../../content/guides';
import type { ChartPanel } from '../components/chart-panel';
import type { ComputeClient, ComputeStatus } from '../compute/compute-client';
import { createConditionStore } from '../condition-store';
import { reasonOf, typeInto } from '../controls/test-helpers';
import type { PageContext } from '../page-registry';
import { mountRelativePage, relativePage } from './relative-page';

afterEach(() => {
  document.body.innerHTML = '';
});

const SMALL: RelativePageCondition = { ...DEFAULT_RELATIVE, data: { ...DEFAULT_RELATIVE.data, count: 1000 } };

function realResult(condition: RelativePageCondition): RelativePageResult {
  const r = runRelativePage(condition);
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

function setup(initial?: RelativePageCondition) {
  const client = fakeClient();
  const store = createConditionStore();
  if (initial !== undefined) store.set('relative', initial);
  const context: PageContext = { store, announce: vi.fn(), createCompute: () => client };
  const container = document.createElement('div');
  document.body.append(container);
  const instance = mountRelativePage(container, context, {
    createPanel: (s) => {
      const element = document.createElement('section');
      element.className = 'chart-panel';
      const render = (c: ChartSpec) => {
        element.textContent = [c.title, ...c.notes, ...c.referenceLines.map((r) => r.label)].join('\n');
        element.dataset.chart = c.id;
        element.dataset.refs = String(c.referenceLines.length);
      };
      render(s);
      return { element, update: render, destroy: () => element.remove() } as unknown as ChartPanel;
    },
  });
  const last = (): RelativePageCondition => {
    const j = client.requests.at(-1);
    if (j === undefined || j.kind !== 'relative') throw new Error('no relative request');
    return j.condition;
  };
  const $ = <T extends HTMLElement>(id: string): T => container.querySelector<T>(`#${id}`)!;
  const boxes = (id: string) => [...$(id).querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const toggle = (box: HTMLInputElement, checked: boolean) => {
    box.checked = checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const select = (id: string, value: string) => {
    const sel = $<HTMLSelectElement>(id);
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const chart = (id: string) => container.querySelector<HTMLElement>(`[data-chart="${id}"]`);
  const chartIds = () => [...container.querySelectorAll<HTMLElement>('.chart-panel')].map((p) => p.dataset.chart);
  return { client, store, container, instance, last, $, boxes, toggle, select, chart, chartIds };
}

describe('relativePage', () => {
  it('ページの登録の形(題名・パス)を持つ', () => {
    expect(relativePage.id).toBe('relative');
    expect(relativePage.path).toBe('/relative-error');
    expect(relativePage.title).toBe(relativePage.navLabel);
    expect(relativePage.title.length).toBeGreaterThan(0);
  });

  it('共通の条件と、手法・α・バケット数の上限・有効桁数・HDR の範囲・内部状態の対象の操作部品を置き、既定の条件で依頼する(6.1、6.2)', () => {
    const t = setup();
    for (const id of [
      'distribution-kind', 'rel-count', 'rel-seed', 'rel-order',
      'rel-methods', 'rel-alpha', 'rel-alpha-number', 'rel-max-buckets', 'rel-max-buckets-number',
      'rel-digits', 'rel-digits-number', 'rel-hdr-range-kind', 'rel-hdr-lowest', 'rel-hdr-highest', 'rel-inspect',
    ]) {
      expect(t.$(id), id).not.toBeNull();
    }
    expect(t.client.requests).toHaveLength(1);
    expect(t.last()).toEqual(PAGE_DEFAULTS.relative);
    // 自動のときは下限・上限の入力を隠す
    expect(t.$('rel-hdr-range-manual').hidden).toBe(true);
  });

  it('記録した結果で、グラフ・α と 1/S の基準線・内部状態の図と表・条件の表示・解説・手引きが出る(6.3、6.4、6.6、6.8、9.2、9.6)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    const ids = t.chartIds();
    for (const id of ['relative-quantile-error', 'relative-alpha-error', 'relative-digits-buckets', 'relative-count-memory', 'relative-count-operations', 'relative-inspect-ddsketch']) {
      expect(ids, id).toContain(id);
    }
    // 相対誤差の既定の選択で、α と 1/S の 2 本の基準線(6.3)
    expect(t.chart('relative-quantile-error')!.dataset.refs).toBe('2');
    expect(t.chart('relative-quantile-error')!.textContent).toContain('α = 0.01');
    expect(t.chart('relative-quantile-error')!.textContent).toContain('1/S');
    expect(t.container.querySelector('.condition-summary')?.textContent).toContain('1,000');
    expect(t.container.querySelector('.state-table table')).not.toBeNull();
    expect(t.container.querySelector('.state-table-facts')?.textContent).toContain('バケット数の上限');
    const articles = [...t.container.querySelectorAll('.explainer-item h3')].map((h) => h.textContent);
    expect(articles).toEqual(ALGORITHM_EXPLAINERS.filter((e) => e.page === 'relative').map((e) => e.name));
    expect(articles).toHaveLength(2);
    const guide = PAGE_GUIDES.find((g) => g.page === 'relative')!;
    expect(t.container.querySelector('.explainer-guide')?.textContent).toContain(guide.tryThis[0]);
    // 誤差の選択の既定は相対誤差の最大
    expect(t.container.querySelector<HTMLSelectElement>('.control-error-selector select')?.value).toBe('relative');
  });

  it('縮約が起きたとき、縮約の通知(回数と影響の上限)が出る。起きていないときは起きていないと出る(6.5)', () => {
    const t0 = setup(SMALL);
    t0.client.emit({ state: 'done', result: realResult(SMALL) });
    expect(t0.container.querySelector('.collapse-notice')?.textContent).toContain('縮約は起きていません');

    const cond: RelativePageCondition = { ...SMALL, maxBuckets: 8 };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    const notice = t.container.querySelector('.collapse-notice');
    expect(notice?.textContent).toContain('縮約が起きました');
    expect(notice?.classList.contains('collapse-notice-collapsed')).toBe(true);
    // 縮約の影響の上限の基準線が内部状態の図に出る
    expect(t.chart('relative-inspect-ddsketch')!.dataset.refs).toBe('1');
  });

  it('HDR だけを観察しているとき、縮約の通知は出ない(6.5)', () => {
    const cond: RelativePageCondition = { ...SMALL, inspectTarget: 'hdr' };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    expect(t.container.querySelector('.collapse-notice')).toBeNull();
    expect(t.chartIds()).toContain('relative-inspect-hdr');
  });

  it('除いた有効桁数が、理由つきで通知と注記に出る(6.4)', () => {
    const cond: RelativePageCondition = {
      ...SMALL,
      hdrRange: { kind: 'manual', lowest: 1e-60, highest: 1e60 },
    };
    const result = realResult(cond);
    expect(result.hdrPlan.excluded.length).toBeGreaterThan(0);
    const t = setup(cond);
    t.client.emit({ state: 'done', result });
    const notices = t.container.querySelector('.hdr-notices');
    expect(notices?.textContent).toContain('除きました');
    expect(notices?.textContent).toContain('有効桁数 4');
    expect(t.chart('relative-digits-error')!.textContent).toContain('除きました');
  });

  it('データの値の幅が広すぎるとき、下限を切り詰めた通知が出る(6.4)', () => {
    const base: RelativePageCondition = { ...SMALL, data: { ...SMALL.data, distribution: { kind: 'lognormal', mu: 0, sigma: 175 } } };
    const result = realResult(base);
    expect(result.hdrPlan.lowestClamped).toBe(true);
    const t = setup(base);
    t.client.emit({ state: 'done', result });
    expect(t.container.querySelector('.hdr-notices')?.textContent).toContain('切り詰めました');
  });

  it('HDR の範囲がデータを覆わないとき、HDR の失敗の注記と観察できなかった理由が出て、DDSketch の結果は残る(6.7)', () => {
    const cond: RelativePageCondition = {
      ...SMALL,
      inspectTarget: 'hdr',
      hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 },
    };
    const t = setup(cond);
    t.client.emit({ state: 'done', result: realResult(cond) });
    expect(t.chart('relative-quantile-error')!.textContent).toContain('HDR');
    expect(t.chart('relative-quantile-error')!.textContent).toMatch(/計算できません|失敗|覆/);
    const rejected = t.container.querySelector('.state-table-rejected');
    expect(rejected?.textContent?.length).toBeGreaterThan(0);
    expect(t.chartIds()).not.toContain('relative-inspect-hdr');
    expect(t.chartIds()).toContain('relative-quantile-error');
  });

  it('HDR の範囲を手動にすると下限・上限の入力が出て、依頼に写る(6.2)', () => {
    const t = setup(SMALL);
    t.select('rel-hdr-range-kind', 'manual');
    expect(t.$('rel-hdr-range-manual').hidden).toBe(false);
    expect(t.last().hdrRange.kind).toBe('manual');
    typeInto(t.$('rel-hdr-lowest'), '0.5');
    typeInto(t.$('rel-hdr-highest'), '5000');
    expect(t.last().hdrRange).toEqual({ kind: 'manual', lowest: 0.5, highest: 5000 });
    t.select('rel-hdr-range-kind', 'auto');
    expect(t.last().hdrRange).toEqual({ kind: 'auto' });
    expect(t.$('rel-hdr-range-manual').hidden).toBe(true);
  });

  it('下限が上限以上のときは理由が出て依頼しない(6.2)', () => {
    const t = setup(SMALL);
    t.select('rel-hdr-range-kind', 'manual');
    const before = t.client.requests.length;
    typeInto(t.$('rel-hdr-lowest'), '99999999');
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('rel-hdr-lowest')) ?? reasonOf(t.$('rel-hdr-highest'))).not.toBeNull();
  });

  it('HDR を選んでいなければ、HDR の範囲が不正でも依頼する(6.2)', () => {
    const t = setup({ ...SMALL, methods: ['ddsketch'], hdrRange: { kind: 'manual', lowest: 10, highest: 1 } });
    expect(t.last().methods).toEqual(['ddsketch']);
  });

  it('操作の変更が、待ち合わせのあとの依頼の条件に写る(6.2)', () => {
    const t = setup();
    typeInto(t.$('rel-alpha-number'), '0.05');
    expect(t.last().alpha).toBe(0.05);
    typeInto(t.$('rel-max-buckets-number'), '64');
    expect(t.last().maxBuckets).toBe(64);
    typeInto(t.$('rel-digits-number'), '3');
    expect(t.last().significantDigits).toBe(3);
    typeInto(t.$('rel-count-number'), '5000');
    expect(t.last().data.count).toBe(5000);
    expect(t.store.get('relative')?.alpha).toBe(0.05);
  });

  it('範囲外の値は理由が出て依頼しない(6.2)', () => {
    const t = setup();
    const before = t.client.requests.length;
    typeInto(t.$('rel-alpha-number'), '1');
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('rel-alpha-number'))).not.toBeNull();
    typeInto(t.$('rel-digits-number'), '6');
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('rel-digits-number'))).not.toBeNull();
  });

  it('手法の選択を 1 つに絞ると依頼に写り、0 件にすると理由が出て依頼しない(6.1)', () => {
    const t = setup();
    const m = t.boxes('rel-methods');
    t.toggle(m[1]!, false); // hdr を外す
    expect(t.last().methods).toEqual(['ddsketch']);
    const before = t.client.requests.length;
    t.toggle(m[0]!, false);
    expect(t.client.requests).toHaveLength(before);
    expect(t.$('rel-methods').textContent).toContain('1 つ以上');
  });

  it('内部状態の対象が選んだ手法に含まれないとき、理由が出て依頼しない(6.6)', () => {
    const t = setup(); // 対象は ddsketch
    const before = t.client.requests.length;
    t.toggle(t.boxes('rel-methods')[0]!, false);
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('rel-inspect'))).toContain('選んだ手法');
  });

  it('内部状態の対象を変えると依頼に写る(6.6)', () => {
    const t = setup(SMALL);
    t.select('rel-inspect', 'hdr');
    expect(t.last().inspectTarget).toBe('hdr');
  });

  it('Worker が返した HDR の範囲・有効桁数の誤りが、項目のそばに出る(6.2)', () => {
    const t = setup({ ...SMALL, hdrRange: { kind: 'manual', lowest: 0.5, highest: 5000 } });
    t.client.emit({
      state: 'failed',
      failure: {
        kind: 'invalid-condition',
        issues: [
          { field: 'hdrRange.lowest', reason: '下限が小さすぎます' },
          { field: 'significantDigits', reason: '有効桁数が大きすぎます' },
        ],
      },
    });
    expect(reasonOf(t.$('rel-hdr-lowest'))).toBe('下限が小さすぎます');
    expect(reasonOf(t.$('rel-digits-number'))).toBe('有効桁数が大きすぎます');
  });

  it('誤差の選択を絶対誤差に変えると、α と 1/S の基準線は消える(6.3)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    const sel = t.container.querySelector<HTMLSelectElement>('.control-error-selector select')!;
    sel.value = 'absolute';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.chart('relative-quantile-error')!.dataset.refs).toBe('0');
  });

  it('既定に戻すと操作部品と依頼が既定の条件に戻る', () => {
    const t = setup(SMALL);
    typeInto(t.$('rel-alpha-number'), '0.05');
    const reset = [...t.container.querySelectorAll('button')].find((b) => b.textContent === '既定に戻す')!;
    reset.click();
    expect(t.last()).toEqual(PAGE_DEFAULTS.relative);
    expect(t.$<HTMLInputElement>('rel-alpha-number').value).toBe('0.01');
    expect(t.$<HTMLInputElement>('rel-count-number').value).toBe('10000');
  });

  it('離れるとき、グラフを破棄して骨組みを取り除く(3.7)', () => {
    const t = setup(SMALL);
    t.client.emit({ state: 'done', result: realResult(SMALL) });
    expect(t.container.querySelector('.chart-panel')).not.toBeNull();
    t.instance.unmount();
    expect(t.container.querySelector('.page-columns')).toBeNull();
  });
});
