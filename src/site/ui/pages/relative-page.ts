// 相対誤差型のページ(6.1〜6.8、9.2、9.6)。
// 共通のデータ条件、手法の選択、DDSketch の α とバケット数の上限、HDR の有効桁数と範囲(自動・手動)、内部状態の対象の
// 操作部品を置き、相対誤差型の表示、縮約の通知、HDR の通知、バケットの図と表、解説(DDSketch、HDR Histogram)と手引きを
// PageKit につなぐ。
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { HOME_CONTENT } from '../../content/guides';
import { PAGE_DEFAULTS, type HdrRangeMode, type RelativePageCondition } from '../../shared/conditions';
import { formatInt, formatSig3 } from '../../shared/format';
import { alphaGrid, bucketsGrid, digitsGrid } from '../../shared/grids';
import { ALPHA_BOUNDS, MAX_DD_BUCKETS, SIGNIFICANT_DIGITS_RANGE } from '../../shared/limits';
import type { ErrorSelection } from '../../shared/metric';
import { validateRelativePage, type FieldIssue } from '../../shared/validate';
import { buildRelativeCharts } from '../../shared/views/relative-view';
import { createExplainer } from '../components/explainer';
import { createStateTable } from '../components/state-table';
import { createChoice } from '../controls/choice';
import { createNumberField } from '../controls/number-field';
import { createSlider } from '../controls/slider';
import type { PageModule } from '../page-registry';
import { createDataControls } from './data-controls';
import { mountPageKit, reasonFor, type PageKitDeps, type PageSpec } from './page-kit';

type Method = RelativePageCondition['methods'][number];

const METHOD_CHOICES = [
  { value: 'ddsketch', label: 'DDSketch' },
  { value: 'hdr', label: 'HDR Histogram' },
] as const satisfies readonly { value: Method; label: string }[];

const RANGE_CHOICES = [
  { value: 'auto', label: '自動(データの値の範囲から決める)' },
  { value: 'manual', label: '手動(下限 L と上限 H を指定する)' },
] as const;

/** 手動に切り替えたときの初めの下限 L・上限 H(正の数) */
const DEFAULT_MANUAL_RANGE = { lowest: 0.01, highest: 100_000 } as const;

/** 相対誤差型のページの誤差の選択の初期値は、相対誤差の最大(4.3) */
const RELATIVE_SELECTION: ErrorSelection = { metric: 'relative', pick: { kind: 'max' } };

const RELATIVE_TITLE = HOME_CONTENT.families.find((f) => f.page === 'relative')?.title ?? '相対誤差型の手法';

/** α は 0 < α < 1(両端を含まない)。サイトの検証に加えて、依頼の前に項目のそばへ理由を出す */
function validateRelative(c: RelativePageCondition): readonly FieldIssue[] {
  const issues = [...validateRelativePage(c)];
  if (c.methods.includes('ddsketch') && !(c.alpha > ALPHA_BOUNDS.exclusiveMin && c.alpha < ALPHA_BOUNDS.exclusiveMax)) {
    issues.push({ field: 'alpha', reason: 'α は 0 より大きく 1 より小さい値で入力してください。' });
  }
  return issues;
}

function notice(tag: 'p' | 'ul', className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

export const relativePageSpec: PageSpec<'relative'> = {
  id: 'relative',
  defaults: PAGE_DEFAULTS.relative,
  defaultSelection: RELATIVE_SELECTION,
  toJob: (condition) => ({ kind: 'relative', condition }),
  validate: validateRelative,
  createControls(host) {
    const initial = host.initial;
    const data = createDataControls({
      idPrefix: 'rel',
      host: { initial: initial.data, update: (fn) => host.update((c) => ({ ...c, data: fn(c.data) })) },
    });
    const methods = createChoice(
      { id: 'rel-methods', label: '表示する手法', choices: METHOD_CHOICES, multiple: true },
      initial.methods,
    );
    const alpha = createSlider(
      {
        id: 'rel-alpha',
        label: 'DDSketch の α(相対誤差の許容値)',
        values: alphaGrid(initial.alpha),
        allowFreeInput: true,
        format: formatSig3,
        min: ALPHA_BOUNDS.exclusiveMin,
        max: ALPHA_BOUNDS.exclusiveMax,
      },
      initial.alpha,
    );
    const maxBuckets = createSlider(
      {
        id: 'rel-max-buckets',
        label: 'DDSketch のバケット数の上限',
        unit: '個',
        values: bucketsGrid(initial.maxBuckets),
        allowFreeInput: true,
        format: formatInt,
        min: 1,
        max: MAX_DD_BUCKETS,
        integer: true,
      },
      initial.maxBuckets,
    );
    const digits = createSlider(
      {
        id: 'rel-digits',
        label: 'HDR Histogram の有効桁数',
        unit: '桁',
        values: digitsGrid(initial.significantDigits),
        allowFreeInput: true,
        format: formatInt,
        min: SIGNIFICANT_DIGITS_RANGE.min,
        max: SIGNIFICANT_DIGITS_RANGE.max,
        integer: true,
      },
      initial.significantDigits,
    );
    const rangeKind = createChoice(
      { id: 'rel-hdr-range-kind', label: 'HDR の追跡する範囲', choices: RANGE_CHOICES, multiple: false },
      [initial.hdrRange.kind],
    );
    const manualInitial = initial.hdrRange.kind === 'manual' ? initial.hdrRange : DEFAULT_MANUAL_RANGE;
    const lowest = createNumberField(
      { id: 'rel-hdr-lowest', label: 'HDR の範囲の下限 L(最小の識別単位)', integer: false },
      manualInitial.lowest,
    );
    const highest = createNumberField(
      { id: 'rel-hdr-highest', label: 'HDR の範囲の上限 H(最大値)', integer: false },
      manualInitial.highest,
    );
    const manualBox = document.createElement('div');
    manualBox.className = 'control-params';
    manualBox.id = 'rel-hdr-range-manual';
    manualBox.setAttribute('role', 'group');
    manualBox.setAttribute('aria-label', 'HDR の手動の範囲');
    manualBox.append(lowest.element, highest.element);
    manualBox.hidden = initial.hdrRange.kind !== 'manual';

    const inspect = createChoice(
      { id: 'rel-inspect', label: '内部状態を表示する手法', choices: METHOD_CHOICES, multiple: false },
      [initial.inspectTarget],
    );

    const manualRange = (): HdrRangeMode => ({ kind: 'manual', lowest: lowest.value(), highest: highest.value() });

    methods.onChange((v) => host.update((c) => ({ ...c, methods: v })));
    alpha.onChange((v) => host.update((c) => ({ ...c, alpha: v })));
    maxBuckets.onChange((v) => host.update((c) => ({ ...c, maxBuckets: v })));
    digits.onChange((v) => host.update((c) => ({ ...c, significantDigits: v })));
    rangeKind.onChange((v) => {
      const hdrRange: HdrRangeMode = v[0] === 'manual' ? manualRange() : { kind: 'auto' };
      manualBox.hidden = hdrRange.kind !== 'manual';
      host.update((c) => ({ ...c, hdrRange }));
    });
    lowest.onChange((v) =>
      host.update((c) =>
        c.hdrRange.kind === 'manual' ? { ...c, hdrRange: { kind: 'manual', lowest: v, highest: c.hdrRange.highest } } : c,
      ),
    );
    highest.onChange((v) =>
      host.update((c) =>
        c.hdrRange.kind === 'manual' ? { ...c, hdrRange: { kind: 'manual', lowest: c.hdrRange.lowest, highest: v } } : c,
      ),
    );
    inspect.onChange((v) => host.update((c) => ({ ...c, inspectTarget: v[0] ?? c.inspectTarget })));

    return {
      elements: [
        ...data.elements,
        methods.element,
        alpha.element,
        maxBuckets.element,
        digits.element,
        rangeKind.element,
        manualBox,
        inspect.element,
      ],
      setCondition(c: RelativePageCondition) {
        data.setValue(c.data);
        methods.setValue(c.methods);
        alpha.setValue(c.alpha);
        maxBuckets.setValue(c.maxBuckets);
        digits.setValue(c.significantDigits);
        rangeKind.setValue([c.hdrRange.kind]);
        const m = c.hdrRange.kind === 'manual' ? c.hdrRange : DEFAULT_MANUAL_RANGE;
        lowest.setValue(m.lowest);
        highest.setValue(m.highest);
        manualBox.hidden = c.hdrRange.kind !== 'manual';
        inspect.setValue([c.inspectTarget]);
      },
      showIssues(issues) {
        data.showIssues(issues);
        methods.setIssue(reasonFor(issues, 'methods'));
        alpha.setIssue(reasonFor(issues, 'alpha'));
        maxBuckets.setIssue(reasonFor(issues, 'maxBuckets'));
        digits.setIssue(reasonFor(issues, 'significantDigits'));
        rangeKind.setIssue(null);
        lowest.setIssue(reasonFor(issues, 'hdrRange.lowest'));
        highest.setIssue(reasonFor(issues, 'hdrRange.highest'));
        inspect.setIssue(reasonFor(issues, 'inspectTarget'));
      },
    };
  },
  buildView(result, condition, selection) {
    if (result.kind !== 'relative') return null;
    const built = buildRelativeCharts(result, condition, { selection });
    const extras: HTMLElement[] = [];

    if (built.hdrNotices.length > 0) {
      const list = notice('ul', 'hdr-notices');
      for (const text of built.hdrNotices) {
        const li = document.createElement('li');
        li.textContent = text;
        list.append(li);
      }
      extras.push(list);
    }
    if (built.collapse !== null) {
      const p = notice('p', built.collapse.collapsed ? 'collapse-notice collapse-notice-collapsed' : 'collapse-notice');
      p.textContent = built.collapse.message;
      extras.push(p);
    }
    const table = createStateTable();
    table.show(built.inspection);
    extras.push(table.element);

    const charts = 'rejected' in built.inspection ? built.charts : [...built.charts, built.inspection.chart];
    return { charts, extras };
  },
  createExplainer: () =>
    createExplainer({
      page: 'relative',
      explainers: ALGORITHM_EXPLAINERS.filter((e) => e.page === 'relative'),
    }),
};

export const relativePage: PageModule = {
  id: 'relative',
  path: '/relative-error',
  title: RELATIVE_TITLE,
  navLabel: RELATIVE_TITLE,
  mount(container, context) {
    return mountPageKit(relativePageSpec, container, context);
  },
};

/** テスト用に、描画層を差し替えて組み立てる */
export function mountRelativePage(container: HTMLElement, context: Parameters<PageModule['mount']>[1], deps: PageKitDeps) {
  return mountPageKit(relativePageSpec, container, context, deps);
}
