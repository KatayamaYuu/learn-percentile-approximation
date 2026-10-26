// 厳密解とヒストグラムのページ(4.1〜4.6、9.2、9.6)。
// 共通のデータ条件(分布・件数・シード・挿入順序)、バケット数、境界の決め方、範囲の決め方(固定のときは下限・上限)の
// 操作部品を置き、ヒストグラムの表示と解説(厳密解 2 方式、等幅、指数幅)と手引きを PageKit につなぐ。
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { HOME_CONTENT } from '../../content/guides';
import { PAGE_DEFAULTS, type HistogramPageCondition, type HistogramRangeMode } from '../../shared/conditions';
import { bucketsGrid } from '../../shared/grids';
import { MAX_BUCKETS } from '../../shared/limits';
import { formatInt } from '../../shared/format';
import { validateHistogramPage } from '../../shared/validate';
import { buildHistogramCharts } from '../../shared/views/histogram-view';
import { createExplainer } from '../components/explainer';
import { createChoice } from '../controls/choice';
import { createNumberField } from '../controls/number-field';
import { createSlider } from '../controls/slider';
import type { PageModule } from '../page-registry';
import { createDataControls } from './data-controls';
import { mountPageKit, reasonFor, type PageKitDeps, type PageSpec } from './page-kit';

const SCHEME_CHOICES = [
  { value: 'equal', label: '等幅' },
  { value: 'exponential', label: '指数幅' },
] as const;

const RANGE_CHOICES = [
  { value: 'data-extent', label: 'データの最小値から最大値' },
  { value: 'fixed', label: '固定の下限と上限' },
] as const;

/** 固定の範囲に切り替えたときの初めの下限・上限(正の数) */
const DEFAULT_FIXED_RANGE = { lower: 0.01, upper: 10_000 } as const;

const HISTOGRAM_TITLE = HOME_CONTENT.families.find((f) => f.page === 'histogram')?.title ?? '厳密解とヒストグラム';

export const histogramPageSpec: PageSpec<'histogram'> = {
  id: 'histogram',
  defaults: PAGE_DEFAULTS.histogram,
  toJob: (condition) => ({ kind: 'histogram', condition }),
  validate: validateHistogramPage,
  createControls(host) {
    const initial = host.initial;
    const data = createDataControls({
      idPrefix: 'hist',
      host: { initial: initial.data, update: (fn) => host.update((c) => ({ ...c, data: fn(c.data) })) },
    });
    const buckets = createSlider(
      {
        id: 'hist-buckets',
        label: 'バケット数',
        unit: '個',
        values: bucketsGrid(initial.buckets),
        allowFreeInput: true,
        format: formatInt,
        min: 1,
        max: MAX_BUCKETS,
        integer: true,
      },
      initial.buckets,
    );
    const schemes = createChoice(
      { id: 'hist-schemes', label: '境界の決め方', choices: SCHEME_CHOICES, multiple: true },
      initial.schemes,
    );
    const rangeKind = createChoice(
      { id: 'hist-range-kind', label: '範囲の決め方', choices: RANGE_CHOICES, multiple: false },
      [initial.range.kind],
    );
    const fixedInitial = initial.range.kind === 'fixed' ? initial.range : DEFAULT_FIXED_RANGE;
    const lower = createNumberField({ id: 'hist-range-lower', label: '固定の範囲の下限', integer: false }, fixedInitial.lower);
    const upper = createNumberField({ id: 'hist-range-upper', label: '固定の範囲の上限', integer: false }, fixedInitial.upper);

    const fixedBox = document.createElement('div');
    fixedBox.className = 'control-params';
    fixedBox.id = 'hist-range-fixed';
    fixedBox.setAttribute('role', 'group');
    fixedBox.setAttribute('aria-label', '固定の範囲');
    fixedBox.append(lower.element, upper.element);
    const showFixed = (c: HistogramPageCondition): void => {
      fixedBox.hidden = c.range.kind !== 'fixed';
    };
    showFixed(initial);

    /** 現在の下限・上限の入力値で固定の範囲を作る */
    const fixedRange = (): HistogramRangeMode => ({ kind: 'fixed', lower: lower.value(), upper: upper.value() });

    buckets.onChange((v) => host.update((c) => ({ ...c, buckets: v })));
    schemes.onChange((v) => host.update((c) => ({ ...c, schemes: v })));
    rangeKind.onChange((v) => {
      const range: HistogramRangeMode = v[0] === 'fixed' ? fixedRange() : { kind: 'data-extent' };
      fixedBox.hidden = range.kind !== 'fixed';
      host.update((c) => ({ ...c, range }));
    });
    lower.onChange((v) =>
      host.update((c) => (c.range.kind === 'fixed' ? { ...c, range: { kind: 'fixed', lower: v, upper: c.range.upper } } : c)),
    );
    upper.onChange((v) =>
      host.update((c) => (c.range.kind === 'fixed' ? { ...c, range: { kind: 'fixed', lower: c.range.lower, upper: v } } : c)),
    );

    return {
      elements: [...data.elements, buckets.element, schemes.element, rangeKind.element, fixedBox],
      setCondition(c) {
        data.setValue(c.data);
        buckets.setValue(c.buckets);
        schemes.setValue(c.schemes);
        rangeKind.setValue([c.range.kind]);
        if (c.range.kind === 'fixed') {
          lower.setValue(c.range.lower);
          upper.setValue(c.range.upper);
        } else {
          lower.setValue(DEFAULT_FIXED_RANGE.lower);
          upper.setValue(DEFAULT_FIXED_RANGE.upper);
        }
        showFixed(c);
      },
      showIssues(issues) {
        data.showIssues(issues);
        buckets.setIssue(reasonFor(issues, 'buckets'));
        schemes.setIssue(reasonFor(issues, 'schemes'));
        rangeKind.setIssue(issues.find((i) => i.field === 'range')?.reason ?? null);
        lower.setIssue(reasonFor(issues, 'range.lower'));
        upper.setIssue(reasonFor(issues, 'range.upper'));
      },
    };
  },
  buildView(result, condition, selection) {
    if (result.kind !== 'histogram') return null;
    return { charts: buildHistogramCharts(result, condition, { selection }) };
  },
  createExplainer: () =>
    createExplainer({
      page: 'histogram',
      explainers: ALGORITHM_EXPLAINERS.filter((e) => e.page === 'histogram'),
    }),
};

export const histogramPage: PageModule = {
  id: 'histogram',
  path: '/histogram',
  title: HISTOGRAM_TITLE,
  navLabel: HISTOGRAM_TITLE,
  mount(container, context) {
    return mountPageKit(histogramPageSpec, container, context);
  },
};

/** テスト用に、描画層を差し替えて組み立てる */
export function mountHistogramPage(container: HTMLElement, context: Parameters<PageModule['mount']>[1], deps: PageKitDeps) {
  return mountPageKit(histogramPageSpec, container, context, deps);
}
