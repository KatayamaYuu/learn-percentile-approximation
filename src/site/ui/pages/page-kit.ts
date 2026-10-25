// 4 つの学習ページに共通の骨組み(PageKit)。
// 2 列(操作部品の列、結果の列)、保持した条件の復元(なければ既定値。2.4、2.9)、「既定に戻す」(2.6)、
// 条件の変更 → 検証(2.5)→ 計算量の確認(3.5)→ 計算の依頼、結果の受け取り → 表示の変換 → パネルの更新、
// 誤差の選択の変更でグラフだけの作り直し(7.2)、ページを離れるときの破棄(3.7)を受け持つ。
// 各ページは PageSpec で、操作部品の配置・条件の型への写し・使う表示の変換・解説だけを渡す。
import type { PageConditionMap } from '../../shared/conditions';
import type { ChartSpec } from '../../shared/chart-spec';
import { DEFAULT_ERROR_SELECTION, type ErrorSelection } from '../../shared/metric';
import type { JobRequest, JobResult } from '../../shared/protocol';
import type { FieldIssue } from '../../shared/validate';
import { estimateWork } from '../../shared/workload';
import { createChartPanel, type ChartPanel } from '../components/chart-panel';
import { createConditionSummary } from '../components/condition-summary';
import { createErrorSelector } from '../components/error-selector';
import { createStatusBar } from '../components/status-bar';
import type { ComputeStatus } from '../compute/compute-client';
import type { PageContext, PageInstance } from '../page-registry';

export const RESET_LABEL = '既定に戻す';

export interface PageControlsHost<C> {
  /** 保持した条件、なければ既定の条件(操作部品の初期値に使う) */
  readonly initial: C;
  /** 条件を変える。updater は現在の条件から新しい条件を返す(渡された条件を書き換えない)。待ち合わせのあとで依頼する */
  update(updater: (current: C) => C): void;
}

export interface PageControls<C> {
  /** 操作部品の列に置く要素(上から順) */
  readonly elements: readonly HTMLElement[];
  /** 表示を条件に合わせる(既定に戻すときに呼ばれる)。update は呼ばない */
  setCondition(condition: C): void;
  /** 項目のそばの理由を出す。空の配列で全部消す。FieldIssue.field は検証の項目名(data.distribution. の接頭辞つき) */
  showIssues(issues: readonly FieldIssue[]): void;
}

export interface PageView {
  /** 結果の領域に並べるグラフ(内部状態の図を含めてよい) */
  readonly charts: readonly ChartSpec[];
  /** グラフの下に置く要素(通知、内部状態の表、比較表など)。結果を受け取るたびに作り直す */
  readonly extras?: readonly HTMLElement[];
}

export interface PageSpec<K extends keyof PageConditionMap> {
  readonly id: K;
  readonly defaults: PageConditionMap[K];
  /** 誤差の選択の初期値(ページごとに決める。相対誤差型は相対誤差の最大) */
  readonly defaultSelection?: ErrorSelection;
  /** 誤差の選択部品を結果の領域に置くか。既定は置く */
  readonly errorSelector?: boolean;
  toJob(condition: PageConditionMap[K]): JobRequest;
  /** サイトの検証。問題があれば依頼しない */
  validate(condition: PageConditionMap[K]): readonly FieldIssue[];
  createControls(host: PageControlsHost<PageConditionMap[K]>): PageControls<PageConditionMap[K]>;
  /** 結果と、その結果を作った条件からグラフなどを作る。結果の種類が合わなければ null */
  buildView(result: JobResult, condition: PageConditionMap[K], selection: ErrorSelection): PageView | null;
  /** 結果の領域の下に置く解説と手引き */
  createExplainer?(): HTMLElement;
}

export interface PageKitDeps {
  /** グラフのパネルの作り方。テストでは偽の描画層を渡す */
  readonly createPanel?: (spec: ChartSpec) => ChartPanel;
}

/** FieldIssue の一覧から、指定した項目(接頭辞での一致も可)の最初の理由を取り出す */
export function reasonFor(issues: readonly FieldIssue[], ...fields: readonly string[]): string | null {
  for (const issue of issues) {
    if (fields.some((f) => issue.field === f || issue.field.startsWith(`${f}.`) || issue.field.startsWith(`${f}[`))) {
      return issue.reason;
    }
  }
  return null;
}

/** 分布の項目の理由。分布の操作部品の setParamIssue は接頭辞 data.distribution. を除いた項目名を受ける */
export const DISTRIBUTION_PREFIX = 'data.distribution.';

export function distributionIssues(issues: readonly FieldIssue[]): readonly FieldIssue[] {
  return issues
    .filter((i) => i.field.startsWith(DISTRIBUTION_PREFIX))
    .map((i) => ({ field: i.field.slice(DISTRIBUTION_PREFIX.length), reason: i.reason }));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

export function mountPageKit<K extends keyof PageConditionMap>(
  spec: PageSpec<K>,
  container: HTMLElement,
  context: PageContext,
  deps: PageKitDeps = {},
): PageInstance {
  type C = PageConditionMap[K];
  const makePanel = deps.createPanel ?? ((s: ChartSpec) => createChartPanel(s));
  const defaultSelection = spec.defaultSelection ?? DEFAULT_ERROR_SELECTION;

  // --- 骨組み ---
  const columns = el('div', 'page-columns');
  const controlsColumn = el('div', 'page-controls');
  const resultsColumn = el('div', 'page-results');
  columns.append(controlsColumn, resultsColumn);

  const client = context.createCompute();
  const statusBar = createStatusBar({ resultRegion: resultsColumn, announce: context.announce, onRetry: () => client.retry() });
  const summary = createConditionSummary();
  const chartsHost = el('div', 'page-charts');
  const extrasHost = el('div', 'page-extras');

  let current: C = context.store.get(spec.id) ?? spec.defaults;
  let selection: ErrorSelection = defaultSelection;
  let lastJob: JobRequest | null = null;
  let lastResult: JobResult | null = null;
  let lastResultCondition: C | null = null;
  /** 検証の問題・上限超過で依頼しない状態。この間は、前の依頼の応答を表示に反映しない */
  let blocked = false;
  let blockedKey = '';
  let panels: { readonly ids: readonly string[]; readonly list: ChartPanel[] } = { ids: [], list: [] };
  let unmounted = false;

  // --- 操作部品 ---
  const controls = spec.createControls({
    initial: current,
    update(updater) {
      if (unmounted) return;
      apply(updater(current), false);
    },
  });
  controlsColumn.append(...controls.elements);

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = RESET_LABEL;
  resetButton.addEventListener('click', () => {
    if (unmounted) return;
    const fresh = structuredClone(spec.defaults);
    controls.setCondition(fresh);
    if (selector !== null) selector.setValue(defaultSelection);
    selection = defaultSelection;
    apply(fresh, true);
    rebuildView();
  });
  const resetWrap = el('div', 'page-reset');
  resetWrap.append(resetButton);
  controlsColumn.append(resetWrap);

  const selector = spec.errorSelector === false ? null : createErrorSelector(defaultSelection);
  selector?.onChange((value) => {
    selection = value;
    rebuildView();
  });

  resultsColumn.append(statusBar.element, summary.element);
  if (selector !== null) resultsColumn.append(selector.element);
  resultsColumn.append(chartsHost, extrasHost);
  const explainer = spec.createExplainer?.();
  if (explainer !== undefined) resultsColumn.append(explainer);
  container.append(columns);

  // --- 配線 ---
  function block(status: ComputeStatus & { readonly state: 'failed' }): void {
    blocked = true;
    const key = JSON.stringify(status.failure);
    if (key === blockedKey) return;
    blockedKey = key;
    statusBar.update(status);
  }

  /** 条件を採用して保存し、検証 → 計算量の確認 → 依頼を行う */
  function apply(next: C, immediate: boolean): void {
    current = next;
    context.store.set(spec.id, next);
    const issues = spec.validate(next);
    controls.showIssues(issues);
    if (issues.length > 0) {
      block({ state: 'failed', failure: { kind: 'invalid-condition', issues } });
      return;
    }
    const job = spec.toJob(next);
    const estimate = estimateWork(job);
    if (!estimate.withinLimit) {
      block({ state: 'failed', failure: { kind: 'over-limit', estimate } });
      return;
    }
    if (blocked) {
      // 理由の表示を消して計算中にする。依頼前から進行中の計算があると client は pending を再配送しないため、ここで示す(3.2)
      blocked = false;
      blockedKey = '';
      statusBar.update({ state: 'pending' });
    }
    lastJob = job;
    client.request(job, immediate ? { immediate: true } : undefined);
  }

  function destroyPanels(): void {
    for (const p of panels.list) p.destroy();
    panels = { ids: [], list: [] };
    chartsHost.replaceChildren();
  }

  function renderCharts(charts: readonly ChartSpec[]): void {
    const ids = charts.map((c) => c.id);
    const same = ids.length === panels.ids.length && ids.every((id, i) => id === panels.ids[i]);
    if (same) {
      charts.forEach((c, i) => panels.list[i]!.update(c));
      return;
    }
    destroyPanels();
    const list = charts.map((c) => makePanel(c));
    chartsHost.append(...list.map((p) => p.element));
    panels = { ids, list };
  }

  /** 手元の結果から、グラフなどだけを作り直す(再計算しない) */
  function rebuildView(): void {
    if (lastResult === null || lastResultCondition === null) return;
    const view = spec.buildView(lastResult, lastResultCondition, selection);
    if (view === null) return;
    renderCharts(view.charts);
    extrasHost.replaceChildren(...(view.extras ?? []));
  }

  const unsubscribe = client.subscribe((status) => {
    if (unmounted || blocked) return;
    statusBar.update(status);
    // Worker が返した条件の誤りは、項目に対応づけて項目のそばに出す。次の計算中・完了で消す
    if (status.state === 'failed' && status.failure.kind === 'invalid-condition') controls.showIssues(status.failure.issues);
    else if (status.state !== 'failed') controls.showIssues([]);
    if (status.state !== 'done' || lastJob === null) return;
    lastResult = status.result;
    lastResultCondition = current;
    // 条件の表示は結果の受け取り時に更新する(2.8)。応答は最後の依頼のものだけが届く
    summary.show(lastJob, status.result);
    rebuildView();
  });

  apply(current, true);

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      unsubscribe();
      client.dispose();
      destroyPanels();
      columns.remove();
    },
  };
}
