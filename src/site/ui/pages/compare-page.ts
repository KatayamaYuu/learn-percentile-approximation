// 横断比較のページ(8.1〜8.8、9.2)。
// 共通のデータ条件、手法の一覧(種類の選択とパラメータの入力による追加・削除)、共通の HDR の範囲の操作部品を置き、
// 横断比較の表示、比較表、処理時間の注記、各学習ページの解説への案内を PageKit につなぐ。
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { HOME_CONTENT } from '../../content/guides';
import {
  PAGE_DEFAULTS,
  type CompareAlgorithm,
  type CompareCondition,
  type HdrRangeMode,
  type PageId,
} from '../../shared/conditions';
import { formatInt, formatSig3 } from '../../shared/format';
import { alphaGrid, bucketsGrid, compressionGrid, digitsGrid, epsilonGrid, kGrid } from '../../shared/grids';
import {
  ALPHA_BOUNDS,
  COMPRESSION_RANGE,
  DEFAULT_MAX_BUCKETS,
  EPSILON_RANGE,
  K_RANGE,
  MAX_BUCKETS,
  MAX_DD_BUCKETS,
  SCALE_FUNCTIONS,
  SIGNIFICANT_DIGITS_RANGE,
} from '../../shared/limits';
import { metricLabel, type ErrorSelection } from '../../shared/metric';
import { validateCompare } from '../../shared/validate';
import { buildCompareCharts, ELAPSED_REFERENCE_NOTE, type ComparisonRow } from '../../shared/views/compare-view';
import { createExplainer } from '../components/explainer';
import { createChoice } from '../controls/choice';
import { createNumberField } from '../controls/number-field';
import { createSlider } from '../controls/slider';
import type { PageModule } from '../page-registry';
import { createDataControls } from './data-controls';
import { mountPageKit, reasonFor, type PageKitDeps, type PageSpec } from './page-kit';

type Kind = CompareAlgorithm['kind'];

const KIND_CHOICES = [
  { value: 'exact-sort', label: '厳密解(整列)' },
  { value: 'exact-quickselect', label: '厳密解(quickselect)' },
  { value: 'histogram', label: 'ヒストグラム' },
  { value: 'gk', label: 'GK' },
  { value: 'kll', label: 'KLL' },
  { value: 'tdigest', label: 't-digest' },
  { value: 'ddsketch', label: 'DDSketch' },
  { value: 'hdr', label: 'HDR Histogram' },
] as const satisfies readonly { value: Kind; label: string }[];

const SCHEME_CHOICES = [
  { value: 'equal', label: '等幅' },
  { value: 'exponential', label: '指数幅' },
] as const;

const SCALE_CHOICES = SCALE_FUNCTIONS.map((s) => ({ value: s, label: s }));

const RANGE_CHOICES = [
  { value: 'auto', label: '自動(データの値の範囲から決める)' },
  { value: 'manual', label: '手動(下限 L と上限 H を指定する)' },
] as const;

/** 手動に切り替えたときの初めの下限 L・上限 H(正の数) */
const DEFAULT_MANUAL_RANGE = { lowest: 0.01, highest: 100_000 } as const;

/** 追加の部品のパラメータの初期値 */
const ADD_DEFAULTS = {
  scheme: 'exponential',
  buckets: 64,
  epsilon: 0.01,
  k: 200,
  compression: 100,
  scale: 'k1',
  alpha: 0.01,
  maxBuckets: DEFAULT_MAX_BUCKETS,
  digits: 2,
} as const;

const COMPARE_TITLE = HOME_CONTENT.families.find((f) => f.page === 'compare')?.title ?? '横断比較';

/** 学習ページへの案内のリンク先(ナビゲーションと同じハッシュ) */
const FAMILY_HREF: Readonly<Record<'histogram' | 'streaming' | 'relative', string>> = {
  histogram: '#/histogram',
  streaming: '#/streaming',
  relative: '#/relative-error',
};

const KIND_LABEL: ReadonlyMap<Kind, string> = new Map(KIND_CHOICES.map((c) => [c.value, c.label]));

/** 一覧に出す手法の名前とパラメータ */
export function describeAlgorithm(a: CompareAlgorithm): string {
  switch (a.kind) {
    case 'exact-sort':
    case 'exact-quickselect':
      return KIND_LABEL.get(a.kind) ?? a.kind;
    case 'histogram':
      return `ヒストグラム(${a.scheme === 'equal' ? '等幅' : '指数幅'}、バケット数 ${formatInt(a.buckets)})`;
    case 'gk':
      return `GK(ε = ${formatSig3(a.epsilon)})`;
    case 'kll':
      return `KLL(k = ${formatInt(a.k)})`;
    case 'tdigest':
      return `t-digest(δ = ${formatSig3(a.compression)}、スケール ${a.scale})`;
    case 'ddsketch':
      return `DDSketch(α = ${formatSig3(a.alpha)}、バケット数の上限 ${formatInt(a.maxBuckets)})`;
    case 'hdr':
      return `HDR Histogram(有効桁数 ${a.significantDigits})`;
  }
}

/** 同じ種類・同じパラメータなら同じキー(キーの順序によらない) */
function algorithmKey(a: CompareAlgorithm): string {
  return JSON.stringify(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== undefined) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function selectionText(selection: ErrorSelection): string {
  const q = selection.pick.kind === 'max' ? '全分位点の最大' : `分位点 ${selection.pick.quantile}`;
  return `${metricLabel(selection.metric)}(${q})`;
}

const COLUMNS = [
  '手法',
  null, // 誤差(選択に合わせて見出しを作る)
  'メモリ見積もり(バイト)',
  '投入の操作数(回)',
  '問い合わせの操作数(回)',
  '処理時間(ミリ秒、参考値)',
] as const;

/** 比較表。値は結果の値をそのまま整形する。計算できなかった手法・除いた HDR は理由を 1 つの欄に出す(8.8) */
function createComparisonTable(rows: readonly ComparisonRow[], selection: ErrorSelection): HTMLElement {
  const wrap = el('div', 'compare-table-scroll');
  const table = el('table', 'compare-table');
  table.append(el('caption', undefined, `手法ごとの比較表(誤差は${selectionText(selection)})`));
  const headRow = el('tr');
  for (const c of COLUMNS) {
    const th = el('th', undefined, c ?? `誤差(${selectionText(selection)})`);
    th.scope = 'col';
    headRow.append(th);
  }
  const head = el('thead');
  head.append(headRow);
  table.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const th = el('th', undefined, row.label);
    th.scope = 'row';
    tr.append(th);
    if (row.status === 'ok') {
      const cell = (v: number | null, f: (n: number) => string): HTMLElement => el('td', undefined, v === null ? '—' : f(v));
      tr.append(
        cell(row.error, formatSig3),
        cell(row.memoryBytes, formatInt),
        cell(row.insertOperations, formatInt),
        cell(row.queryOperations, formatInt),
        cell(row.elapsedMs, formatSig3),
      );
    } else {
      const td = el('td', 'compare-table-reason', `計算できませんでした: ${row.reason ?? ''}`);
      td.colSpan = COLUMNS.length - 1;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

/** 解説の領域の末尾に置く、各学習ページの解説への案内 */
function createFamilyLinks(): HTMLElement {
  const section = el('div', 'explainer-links');
  section.append(el('h2', undefined, '各手法の解説は学習ページにあります'));
  const list = el('ul');
  for (const family of HOME_CONTENT.families) {
    if (family.page === 'compare') continue;
    const page = family.page as keyof typeof FAMILY_HREF;
    const li = el('li');
    const a = el('a', undefined, family.title);
    a.href = FAMILY_HREF[page];
    const names = ALGORITHM_EXPLAINERS.filter((e) => e.page === (page as PageId)).map((e) => e.name);
    li.append(a, el('span', undefined, `(${names.join('、')}の定義・保証・計算量・向き不向き)`));
    list.append(li);
  }
  section.append(list);
  return section;
}

export const comparePageSpec: PageSpec<'compare'> = {
  id: 'compare',
  defaults: PAGE_DEFAULTS.compare,
  toJob: (condition) => ({ kind: 'compare', condition }),
  validate: validateCompare,
  createControls(host) {
    const initial = host.initial;
    const data = createDataControls({
      idPrefix: 'cmp',
      host: { initial: initial.data, update: (fn) => host.update((c) => ({ ...c, data: fn(c.data) })) },
    });

    // --- 手法の一覧 ---
    let list: readonly CompareAlgorithm[] = [...initial.algorithms];
    const listGroup = el('div', 'compare-algorithms');
    listGroup.id = 'cmp-algorithms';
    listGroup.setAttribute('role', 'group');
    listGroup.setAttribute('aria-labelledby', 'cmp-algorithms-title');
    const listTitle = el('h3', 'compare-algorithms-title', '比較する手法');
    listTitle.id = 'cmp-algorithms-title';
    const listEl = el('ul', 'compare-algorithm-list');
    const listReason = el('p', 'field-reason compare-algorithms-reason');
    listReason.id = 'cmp-algorithms-reason';
    listGroup.append(listTitle, listEl, listReason);

    function renderList(): void {
      listEl.replaceChildren();
      list.forEach((a, i) => {
        const li = el('li', 'compare-algorithm-item');
        const name = describeAlgorithm(a);
        li.append(el('span', 'compare-algorithm-name', name));
        const remove = el('button', 'compare-remove', '外す');
        remove.type = 'button';
        remove.setAttribute('aria-label', `${name}を外す`);
        remove.addEventListener('click', () => {
          list = list.filter((_, j) => j !== i);
          renderList();
          const next = list;
          host.update((c) => ({ ...c, algorithms: next }));
        });
        li.append(remove, el('span', 'field-reason compare-algorithm-reason'));
        listEl.append(li);
      });
    }

    // --- 手法の追加 ---
    const addGroup = el('div', 'compare-add');
    addGroup.setAttribute('role', 'group');
    addGroup.setAttribute('aria-label', '手法の追加');
    const kind = createChoice({ id: 'cmp-add-kind', label: '追加する手法', choices: KIND_CHOICES, multiple: false }, ['gk']);
    const scheme = createChoice(
      { id: 'cmp-add-scheme', label: 'ヒストグラムのバケットの幅', choices: SCHEME_CHOICES, multiple: false },
      [ADD_DEFAULTS.scheme],
    );
    const buckets = createSlider(
      {
        id: 'cmp-add-buckets',
        label: 'ヒストグラムのバケット数',
        unit: '個',
        values: bucketsGrid(ADD_DEFAULTS.buckets),
        allowFreeInput: true,
        format: formatInt,
        min: 1,
        max: MAX_BUCKETS,
        integer: true,
      },
      ADD_DEFAULTS.buckets,
    );
    const epsilon = createSlider(
      {
        id: 'cmp-add-epsilon',
        label: 'GK の ε(許容する順位誤差)',
        values: epsilonGrid(ADD_DEFAULTS.epsilon),
        allowFreeInput: true,
        format: formatSig3,
        min: EPSILON_RANGE.min,
        max: EPSILON_RANGE.max,
      },
      ADD_DEFAULTS.epsilon,
    );
    const k = createSlider(
      {
        id: 'cmp-add-k',
        label: 'KLL の k(容量の基準)',
        values: kGrid(ADD_DEFAULTS.k),
        allowFreeInput: true,
        format: formatInt,
        min: K_RANGE.min,
        max: K_RANGE.max,
        integer: true,
      },
      ADD_DEFAULTS.k,
    );
    const compression = createSlider(
      {
        id: 'cmp-add-compression',
        label: 't-digest の δ(圧縮度)',
        values: compressionGrid(ADD_DEFAULTS.compression),
        allowFreeInput: true,
        format: formatSig3,
        min: COMPRESSION_RANGE.min,
        max: COMPRESSION_RANGE.max,
      },
      ADD_DEFAULTS.compression,
    );
    const scale = createChoice(
      { id: 'cmp-add-scale', label: 't-digest のスケール関数', choices: SCALE_CHOICES, multiple: false },
      [ADD_DEFAULTS.scale],
    );
    const alpha = createSlider(
      {
        id: 'cmp-add-alpha',
        label: 'DDSketch の α(相対誤差の許容値)',
        values: alphaGrid(ADD_DEFAULTS.alpha),
        allowFreeInput: true,
        format: formatSig3,
        min: ALPHA_BOUNDS.exclusiveMin,
        max: ALPHA_BOUNDS.exclusiveMax,
      },
      ADD_DEFAULTS.alpha,
    );
    const maxBuckets = createSlider(
      {
        id: 'cmp-add-max-buckets',
        label: 'DDSketch のバケット数の上限',
        unit: '個',
        values: bucketsGrid(ADD_DEFAULTS.maxBuckets),
        allowFreeInput: true,
        format: formatInt,
        min: 1,
        max: MAX_DD_BUCKETS,
        integer: true,
      },
      ADD_DEFAULTS.maxBuckets,
    );
    const digits = createSlider(
      {
        id: 'cmp-add-digits',
        label: 'HDR Histogram の有効桁数',
        unit: '桁',
        values: digitsGrid(ADD_DEFAULTS.digits),
        allowFreeInput: true,
        format: formatInt,
        min: SIGNIFICANT_DIGITS_RANGE.min,
        max: SIGNIFICANT_DIGITS_RANGE.max,
        integer: true,
      },
      ADD_DEFAULTS.digits,
    );

    const paramGroups = new Map<Kind, HTMLElement>();
    const paramGroup = (target: Kind, ...controls: readonly HTMLElement[]): void => {
      const box = el('div', 'control-params');
      box.id = `cmp-add-params-${target}`;
      box.append(...controls);
      paramGroups.set(target, box);
    };
    paramGroup('histogram', scheme.element, buckets.element);
    paramGroup('gk', epsilon.element);
    paramGroup('kll', k.element);
    paramGroup('tdigest', compression.element, scale.element);
    paramGroup('ddsketch', alpha.element, maxBuckets.element);
    paramGroup('hdr', digits.element);
    const showParams = (): void => {
      const selected = kind.value()[0] ?? 'gk';
      for (const [target, box] of paramGroups) box.hidden = target !== selected;
    };
    showParams();
    kind.onChange(() => {
      addReason.textContent = '';
      showParams();
    });

    const addButton = el('button', 'compare-add-button', '手法を追加');
    addButton.type = 'button';
    addButton.id = 'cmp-add';
    const addReason = el('p', 'field-reason compare-add-reason');
    addReason.id = 'cmp-add-reason';
    addReason.setAttribute('role', 'status');

    function chosen(): CompareAlgorithm {
      switch (kind.value()[0] ?? 'gk') {
        case 'exact-sort':
          return { kind: 'exact-sort' };
        case 'exact-quickselect':
          return { kind: 'exact-quickselect' };
        case 'histogram':
          return { kind: 'histogram', scheme: scheme.value()[0] ?? ADD_DEFAULTS.scheme, buckets: buckets.value() };
        case 'gk':
          return { kind: 'gk', epsilon: epsilon.value() };
        case 'kll':
          return { kind: 'kll', k: k.value() };
        case 'tdigest':
          return { kind: 'tdigest', compression: compression.value(), scale: scale.value()[0] ?? ADD_DEFAULTS.scale };
        case 'ddsketch':
          return { kind: 'ddsketch', alpha: alpha.value(), maxBuckets: maxBuckets.value() };
        case 'hdr':
          return { kind: 'hdr', significantDigits: digits.value() };
      }
    }

    addButton.addEventListener('click', () => {
      const a = chosen();
      if (list.some((x) => algorithmKey(x) === algorithmKey(a))) {
        addReason.textContent = `${describeAlgorithm(a)}は既に選ばれています。パラメータを変えてから追加してください。`;
        return;
      }
      addReason.textContent = '';
      list = [...list, a];
      renderList();
      const next = list;
      host.update((c) => ({ ...c, algorithms: next }));
    });
    addGroup.append(kind.element, ...paramGroups.values(), addButton, addReason);

    // --- 共通の HDR の範囲 ---
    const rangeKind = createChoice(
      { id: 'cmp-hdr-range-kind', label: 'HDR の追跡する範囲(HDR のすべてに共通)', choices: RANGE_CHOICES, multiple: false },
      [initial.hdrRange.kind],
    );
    const manualInitial = initial.hdrRange.kind === 'manual' ? initial.hdrRange : DEFAULT_MANUAL_RANGE;
    const lowest = createNumberField(
      { id: 'cmp-hdr-lowest', label: 'HDR の範囲の下限 L(最小の識別単位)', integer: false },
      manualInitial.lowest,
    );
    const highest = createNumberField(
      { id: 'cmp-hdr-highest', label: 'HDR の範囲の上限 H(最大値)', integer: false },
      manualInitial.highest,
    );
    const manualBox = el('div', 'control-params');
    manualBox.id = 'cmp-hdr-range-manual';
    manualBox.setAttribute('role', 'group');
    manualBox.setAttribute('aria-label', 'HDR の手動の範囲');
    manualBox.append(lowest.element, highest.element);
    manualBox.hidden = initial.hdrRange.kind !== 'manual';
    const manualRange = (): HdrRangeMode => ({ kind: 'manual', lowest: lowest.value(), highest: highest.value() });

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

    renderList();
    return {
      elements: [...data.elements, listGroup, addGroup, rangeKind.element, manualBox],
      setCondition(c: CompareCondition) {
        data.setValue(c.data);
        list = [...c.algorithms];
        renderList();
        addReason.textContent = '';
        rangeKind.setValue([c.hdrRange.kind]);
        const m = c.hdrRange.kind === 'manual' ? c.hdrRange : DEFAULT_MANUAL_RANGE;
        lowest.setValue(m.lowest);
        highest.setValue(m.highest);
        manualBox.hidden = c.hdrRange.kind !== 'manual';
      },
      showIssues(issues) {
        data.showIssues(issues);
        // 0 件・重複は一覧全体の理由、手法ごとの設定の誤り(algorithms[i].項目)はその手法のそばに出す
        listReason.textContent = issues.find((i) => i.field === 'algorithms')?.reason ?? '';
        listEl.querySelectorAll<HTMLElement>('.compare-algorithm-reason').forEach((span, i) => {
          span.textContent = reasonFor(issues, `algorithms[${i}]`) ?? '';
        });
        rangeKind.setIssue(null);
        lowest.setIssue(reasonFor(issues, 'hdrRange.lowest'));
        highest.setIssue(reasonFor(issues, 'hdrRange.highest'));
      },
    };
  },
  buildView(result, condition, selection) {
    if (result.kind !== 'compare') return null;
    const built = buildCompareCharts(result, condition, { selection });
    const note = el('p', 'compare-note', ELAPSED_REFERENCE_NOTE);
    return { charts: built.charts, extras: [note, createComparisonTable(built.rows, selection)] };
  },
  createExplainer() {
    const root = createExplainer({ page: 'compare', explainers: [] });
    root.append(createFamilyLinks());
    return root;
  },
};

export const comparePage: PageModule = {
  id: 'compare',
  path: '/compare',
  title: COMPARE_TITLE,
  navLabel: COMPARE_TITLE,
  mount(container, context) {
    return mountPageKit(comparePageSpec, container, context);
  },
};

/** テスト用に、描画層を差し替えて組み立てる */
export function mountComparePage(container: HTMLElement, context: Parameters<PageModule['mount']>[1], deps: PageKitDeps) {
  return mountPageKit(comparePageSpec, container, context, deps);
}
