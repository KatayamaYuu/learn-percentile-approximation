// @vitest-environment happy-dom
// PageKit のテスト。偽の ComputeClient と偽の描画層、ごく小さな偽のページ仕様で骨組みの配線を確かめる
// (2.4、2.5、2.6、2.9、3.5、3.7、2.8、7.2)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import type { HistogramPageCondition } from '../../shared/conditions';
import { PAGE_DEFAULTS } from '../../shared/conditions';
import { WORK_LIMIT } from '../../shared/limits';
import type { ErrorSelection } from '../../shared/metric';
import type { JobRequest, JobResult } from '../../shared/protocol';
import { validateHistogramPage } from '../../shared/validate';
import { estimateWork } from '../../shared/workload';
import type { ChartPanel } from '../components/chart-panel';
import type { ComputeClient, ComputeStatus } from '../compute/compute-client';
import { createNumberField } from '../controls/number-field';
import { typeInto } from '../controls/test-helpers';
import { createConditionStore } from '../condition-store';
import type { PageContext } from '../page-registry';
import {
  RESET_LABEL,
  distributionIssues,
  mountPageKit,
  reasonFor,
  type PageSpec,
  type PageView,
} from './page-kit';

afterEach(() => {
  document.body.innerHTML = '';
});

interface FakeClient extends ComputeClient {
  readonly requests: { job: JobRequest; immediate: boolean }[];
  readonly emit: (status: ComputeStatus) => void;
  readonly retry: ReturnType<typeof vi.fn<() => void>>;
  readonly dispose: ReturnType<typeof vi.fn<() => void>>;
}

function fakeClient(): FakeClient {
  const listeners = new Set<(s: ComputeStatus) => void>();
  const requests: { job: JobRequest; immediate: boolean }[] = [];
  return {
    requests,
    request: (job, options) => void requests.push({ job, immediate: options?.immediate === true }),
    retry: vi.fn<() => void>(),
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    dispose: vi.fn<() => void>(),
    emit: (s) => {
      for (const l of [...listeners]) l(s);
    },
  };
}

interface FakePanel extends ChartPanel {
  readonly spec: { current: ChartSpec };
  readonly destroy: ReturnType<typeof vi.fn<() => void>>;
}

function makeSetup(options: { errorSelector?: boolean; defaultSelection?: ErrorSelection } = {}) {
  const client = fakeClient();
  const announce = vi.fn<(m: string) => void>();
  const store = createConditionStore();
  const context: PageContext = { store, announce, createCompute: () => client };
  const panels: FakePanel[] = [];
  const builds: { condition: HistogramPageCondition; selection: ErrorSelection }[] = [];
  let countField: ReturnType<typeof createNumberField> | null = null;
  const shown = { issues: [] as readonly unknown[], set: [] as HistogramPageCondition[] };

  const spec: PageSpec<'histogram'> = {
    id: 'histogram',
    defaults: PAGE_DEFAULTS.histogram,
    errorSelector: options.errorSelector,
    defaultSelection: options.defaultSelection,
    // 偽のページ仕様: 件数が 1,000,000 以上のときは、計算量が上限を超える条件(試行 10 のストリーミング)に写す
    toJob: (condition) =>
      condition.data.count >= 1_000_000
        ? { kind: 'streaming', condition: { ...PAGE_DEFAULTS.streaming, data: condition.data, trials: 10 } }
        : { kind: 'histogram', condition },
    validate: validateHistogramPage,
    createControls(host) {
      const count = createNumberField({ id: 'count', label: '件数', integer: false }, host.initial.data.count);
      countField = count;
      count.onChange((v) => host.update((c) => ({ ...c, data: { ...c.data, count: v } })));
      return {
        elements: [count.element],
        setCondition(c) {
          shown.set.push(c);
          count.setValue(c.data.count);
        },
        showIssues(issues) {
          shown.issues = issues;
          count.setIssue(reasonFor(issues, 'data.count'));
        },
      };
    },
    buildView(result, condition, selection): PageView | null {
      if (result.kind !== 'histogram') return null;
      builds.push({ condition, selection });
      const chart = (id: string): ChartSpec => ({
        id,
        title: `グラフ ${id}`,
        x: { label: 'x', unit: '', scale: 'linear', toggleable: false },
        y: { label: 'y', unit: '', scale: 'linear', toggleable: false },
        series: [],
        referenceLines: [],
        notes: [],
        summary: id,
      });
      const extra = document.createElement('p');
      extra.className = 'state-table-notice';
      extra.textContent = `件数 ${condition.data.count}`;
      return { charts: [chart('a'), chart('b')], extras: [extra] };
    },
    createExplainer() {
      const e = document.createElement('section');
      e.className = 'explainer';
      e.textContent = '解説';
      return e;
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const mount = () =>
    mountPageKit(spec, container, context, {
      createPanel: (s) => {
        const element = document.createElement('section');
        element.className = 'chart-panel';
        element.dataset.chart = s.id;
        const spec = { current: s };
        const panel = {
          element,
          spec,
          update: (n: ChartSpec) => void (spec.current = n),
          destroy: vi.fn<() => void>(),
        } satisfies FakePanel;
        panels.push(panel);
        return panel;
      },
    });
  return { client, announce, store, container, panels, builds, mount, shown, field: () => countField! };
}

const RESULT = { kind: 'histogram' } as unknown as JobResult;
const done: ComputeStatus = { state: 'done', result: RESULT };

describe('mountPageKit', () => {
  it('2 列の骨組みを作り、初回に既定の条件で即時に依頼する(2.4)', () => {
    const s = makeSetup();
    s.mount();
    expect(s.container.querySelector('.page-columns > .page-controls')).not.toBeNull();
    expect(s.container.querySelector('.page-columns > .page-results')).not.toBeNull();
    expect(s.container.querySelector('.page-controls input')).not.toBeNull();
    expect(s.container.querySelector('.page-results .explainer')).not.toBeNull();
    expect(s.client.requests).toHaveLength(1);
    expect(s.client.requests[0]!.immediate).toBe(true);
    expect(s.client.requests[0]!.job).toEqual({ kind: 'histogram', condition: PAGE_DEFAULTS.histogram });
  });

  it('保持した条件があれば復元して依頼し、条件の変更を保存する(2.9)', () => {
    const s = makeSetup();
    const kept: HistogramPageCondition = { ...PAGE_DEFAULTS.histogram, data: { ...PAGE_DEFAULTS.histogram.data, count: 500 } };
    s.store.set('histogram', kept);
    s.mount();
    expect(s.client.requests[0]!.job).toEqual({ kind: 'histogram', condition: kept });
    expect((s.container.querySelector('input') as HTMLInputElement).value).toBe('500');
    typeInto(s.container.querySelector('input')!, '700');
    expect(s.store.get('histogram')!.data.count).toBe(700);
    expect(kept.data.count).toBe(500); // 保存した条件を書き換えない
  });

  it('条件の変更は待ち合わせの依頼(即時でない)で、新しい条件を送る', () => {
    const s = makeSetup();
    s.mount();
    typeInto(s.container.querySelector('input')!, '2000');
    expect(s.client.requests).toHaveLength(2);
    expect(s.client.requests[1]!.immediate).toBe(false);
    expect((s.client.requests[1]!.job as { condition: HistogramPageCondition }).condition.data.count).toBe(2000);
  });

  it('既定に戻すと、操作部品を既定に合わせて既定の条件で即時に依頼する(2.6)', () => {
    const s = makeSetup();
    s.mount();
    typeInto(s.container.querySelector('input')!, '2000');
    const reset = [...s.container.querySelectorAll('button')].find((b) => b.textContent === RESET_LABEL)!;
    reset.click();
    const last = s.client.requests.at(-1)!;
    expect(last.immediate).toBe(true);
    expect(last.job).toEqual({ kind: 'histogram', condition: PAGE_DEFAULTS.histogram });
    expect(s.shown.set).toEqual([PAGE_DEFAULTS.histogram]);
    expect((s.container.querySelector('input') as HTMLInputElement).value).toBe('10000');
    expect(s.store.get('histogram')).toEqual(PAGE_DEFAULTS.histogram);
  });

  it('検証の問題があれば依頼せず、項目のそばと状態表示に理由を出す。直ると依頼する(2.5)', () => {
    const s = makeSetup();
    s.mount();
    typeInto(s.container.querySelector('input')!, '99');
    expect(s.client.requests).toHaveLength(1);
    const input = s.container.querySelector('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(s.container.querySelector('.field-reason')!.textContent).toContain('100');
    expect(s.container.querySelector('.status-bar')!.textContent).toContain('条件に誤りがあるため計算しませんでした');
    typeInto(input, '100');
    expect(s.client.requests).toHaveLength(2);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(s.container.querySelector('.status-bar')!.textContent).not.toContain('誤り');
  });

  it('計算量が上限を超えるときは依頼せず、上限と減らし方を出す。収まれば依頼する(3.5)', () => {
    const s = makeSetup();
    s.mount();
    const input = s.container.querySelector('input')!;
    const over: JobRequest = {
      kind: 'streaming',
      condition: { ...PAGE_DEFAULTS.streaming, data: { ...PAGE_DEFAULTS.streaming.data, count: 1_000_000 }, trials: 10 },
    };
    expect(estimateWork(over).withinLimit).toBe(false); // テストの前提
    typeInto(input, '1000000');
    expect(s.client.requests).toHaveLength(1);
    const text = s.container.querySelector('.status-bar')!.textContent!;
    expect(text).toContain('上限');
    expect(text).toContain(WORK_LIMIT.toLocaleString('en-US'));
    expect(s.container.querySelectorAll('.status-bar li').length).toBeGreaterThan(0);
    typeInto(input, '10000');
    expect(s.client.requests).toHaveLength(2);
    expect(s.container.querySelector('.status-bar')!.textContent).not.toContain('上限');
  });

  it('依頼しない状態になったあとに届く前の依頼の応答は、表示に反映しない', () => {
    const s = makeSetup();
    s.mount();
    typeInto(s.container.querySelector('input')!, '99');
    s.client.emit(done);
    expect(s.panels).toHaveLength(0);
    expect(s.container.querySelector('.condition-summary')!.hasAttribute('hidden')).toBe(true);
  });

  it('検証の問題から直した直後も、進行中の計算があれば計算中の表示になる(client が pending を再配送しなくても。3.2)', () => {
    const s = makeSetup();
    s.mount();
    s.client.emit({ state: 'pending' }); // 初回の依頼で計算中
    const input = s.container.querySelector('input')!;
    typeInto(input, '99');
    typeInto(input, '200'); // client は pending を再配送しない
    const region = s.container.querySelector('.page-results')!;
    expect(s.container.querySelector('.status-bar .status-pending')).not.toBeNull();
    expect(region.getAttribute('aria-busy')).toBe('true');
  });

  it('Worker が返した条件の誤りは項目のそばに出し、次の計算中・完了で消す(2.5)', () => {
    const s = makeSetup();
    s.mount();
    s.client.emit({
      state: 'failed',
      failure: { kind: 'invalid-condition', issues: [{ field: 'data.count', reason: 'Worker: 件数が不正です' }] },
    });
    const input = s.container.querySelector('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(s.container.querySelector('.field-reason')!.textContent).toBe('Worker: 件数が不正です');
    s.client.emit({ state: 'pending' });
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    s.client.emit({
      state: 'failed',
      failure: { kind: 'invalid-condition', issues: [{ field: 'data.count', reason: 'again' }] },
    });
    s.client.emit(done);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('計算中は結果の領域が処理中になり、前の結果を残す(3.2)。受け取りで条件の表示とグラフを更新する(2.8)', () => {
    const s = makeSetup();
    s.mount();
    const region = s.container.querySelector('.page-results')!;
    s.client.emit({ state: 'pending' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    s.client.emit(done);
    expect(region.getAttribute('aria-busy')).toBe('false');
    expect(s.panels.map((p) => p.element.dataset.chart)).toEqual(['a', 'b']);
    expect(s.container.querySelectorAll('.page-charts > .chart-panel')).toHaveLength(2);
    expect(s.container.querySelector('.page-extras')!.textContent).toBe('件数 10000');
    const summary = s.container.querySelector('.condition-summary')!;
    expect(summary.hasAttribute('hidden')).toBe(false);
    expect(summary.textContent).toContain('10,000');
    expect(s.announce).toHaveBeenCalledWith('計算が完了しました。結果を更新しました。');

    // 新しい条件の依頼中(結果はまだ前の条件のもの)は、条件の表示を変えない
    typeInto(s.container.querySelector('input')!, '2000');
    s.client.emit({ state: 'pending' });
    expect(summary.textContent).toContain('10,000');
    expect(s.panels).toHaveLength(2);
    s.client.emit(done);
    expect(summary.textContent).toContain('2,000');
    // 同じ構成のグラフはパネルを作り直さず update で差し替える
    expect(s.panels).toHaveLength(2);
    expect(s.panels[0]!.destroy).not.toHaveBeenCalled();
    expect(s.builds.at(-1)!.condition.data.count).toBe(2000);
  });

  it('失敗では前の結果を消さず、再実行ボタンが client.retry を呼ぶ(3.6)', () => {
    const s = makeSetup();
    s.mount();
    s.client.emit(done);
    s.client.emit({ state: 'failed', failure: { kind: 'exception', message: '壊れた' } });
    expect(s.panels).toHaveLength(2);
    expect(s.panels[0]!.destroy).not.toHaveBeenCalled();
    const retry = [...s.container.querySelectorAll('.status-bar button')][0] as HTMLButtonElement;
    retry.click();
    expect(s.client.retry).toHaveBeenCalledOnce();
  });

  it('誤差の選択の変更は再計算せず、手元の結果からグラフだけを作り直す(7.2)', () => {
    const s = makeSetup({ defaultSelection: { metric: 'relative', pick: { kind: 'max' } } });
    s.mount();
    s.client.emit(done);
    expect(s.builds.at(-1)!.selection).toEqual({ metric: 'relative', pick: { kind: 'max' } });
    const before = s.client.requests.length;
    const metric = s.container.querySelector<HTMLSelectElement>('.control-error-selector select')!;
    metric.value = 'absolute';
    metric.dispatchEvent(new Event('change', { bubbles: true }));
    expect(s.client.requests).toHaveLength(before);
    expect(s.builds.at(-1)!.selection.metric).toBe('absolute');
    expect(s.builds).toHaveLength(2);
    expect(s.panels).toHaveLength(2);
  });

  it('errorSelector: false なら誤差の選択部品を置かない', () => {
    const s = makeSetup({ errorSelector: false });
    s.mount();
    expect(s.container.querySelector('.control-error-selector')).toBeNull();
  });

  it('ページを離れると client.dispose とグラフの破棄が呼ばれ、以後の応答や操作は無視される(3.7)', () => {
    const s = makeSetup();
    const page = s.mount();
    s.client.emit(done);
    const input = s.container.querySelector('input')!;
    page.unmount();
    expect(s.client.dispose).toHaveBeenCalledOnce();
    expect(s.panels.every((p) => p.destroy.mock.calls.length === 1)).toBe(true);
    expect(s.container.querySelector('.page-columns')).toBeNull();
    typeInto(input, '3000');
    s.client.emit(done);
    expect(s.client.requests).toHaveLength(1);
    expect(s.panels).toHaveLength(2);
  });

  it('離れて戻ると保持した条件で再開する(2.9)', () => {
    const s = makeSetup();
    const page = s.mount();
    typeInto(s.container.querySelector('input')!, '3000');
    page.unmount();
    s.mount();
    expect((s.client.requests.at(-1)!.job as { condition: HistogramPageCondition }).condition.data.count).toBe(3000);
  });
});

describe('補助関数', () => {
  it('reasonFor は項目名の完全一致と接頭辞の一致で最初の理由を返す', () => {
    const issues = [
      { field: 'data.distribution.modes[1].stdDev', reason: 'A' },
      { field: 'data.count', reason: 'B' },
    ];
    expect(reasonFor(issues, 'data.count')).toBe('B');
    expect(reasonFor(issues, 'data.distribution')).toBe('A');
    expect(reasonFor(issues, 'schemes')).toBeNull();
  });
  it('distributionIssues は接頭辞 data.distribution. を外す', () => {
    expect(
      distributionIssues([
        { field: 'data.distribution.sigma', reason: 'X' },
        { field: 'data.count', reason: 'Y' },
      ]),
    ).toEqual([{ field: 'sigma', reason: 'X' }]);
  });
});
