// 4 つの学習ページに共通のデータ条件の操作部品(分布・件数・シード・挿入順序。2.1、2.2、2.5)。
// 構築、変更の通知、表示の更新、項目のそばの理由(分布のパラメータの古い理由の消去を含む)を受け持つ。
import type { DataOrder } from '../../../core';
import type { DataCondition } from '../../shared/conditions';
import { formatInt } from '../../shared/format';
import { countGrid } from '../../shared/grids';
import { COUNT_RANGE, SEED_RANGE } from '../../shared/limits';
import type { FieldIssue } from '../../shared/validate';
import { createChoice } from '../controls/choice';
import { createDistributionEditor } from '../controls/distribution-editor';
import { createNumberField } from '../controls/number-field';
import { createSlider } from '../controls/slider';
import { distributionIssues, reasonFor } from './page-kit';

const ORDER_CHOICES: readonly { readonly value: DataOrder; readonly label: string }[] = [
  { value: 'random', label: 'ランダム' },
  { value: 'ascending', label: '昇順' },
  { value: 'descending', label: '降順' },
];

export interface DataControlsOptions {
  /** 要素の id の接頭辞。件数 `${idPrefix}-count`、シード `${idPrefix}-seed`、順序 `${idPrefix}-order`。分布の編集は既定の `distribution-*` */
  readonly idPrefix: string;
  readonly host: {
    readonly initial: DataCondition;
    /** データ条件を変える。updater は現在のデータ条件から新しいものを返す */
    update(updater: (current: DataCondition) => DataCondition): void;
  };
}

export interface DataControls {
  /** 操作部品の列に置く要素(上から順: 分布、件数、シード、挿入順序) */
  readonly elements: readonly HTMLElement[];
  /** 表示を条件に合わせる。update は呼ばない */
  setValue(data: DataCondition): void;
  /** 項目のそばの理由を出す(FieldIssue.field は data.* の検証の項目名)。空の配列で全部消す。以前の分布の理由は消える */
  showIssues(issues: readonly FieldIssue[]): void;
}

export function createDataControls(options: DataControlsOptions): DataControls {
  const { idPrefix, host } = options;
  const initial = host.initial;
  const distribution = createDistributionEditor(initial.distribution);
  const count = createSlider(
    {
      id: `${idPrefix}-count`,
      label: 'データ件数',
      unit: '件',
      values: countGrid(COUNT_RANGE.max),
      allowFreeInput: true,
      format: formatInt,
      min: COUNT_RANGE.min,
      max: COUNT_RANGE.max,
      integer: true,
    },
    initial.count,
  );
  const seed = createNumberField(
    { id: `${idPrefix}-seed`, label: 'シード', min: SEED_RANGE.min, max: SEED_RANGE.max, integer: true },
    initial.seed,
  );
  const order = createChoice({ id: `${idPrefix}-order`, label: '挿入順序', choices: ORDER_CHOICES, multiple: false }, [
    initial.order,
  ]);

  distribution.onChange((d) => host.update((c) => ({ ...c, distribution: d })));
  count.onChange((v) => host.update((c) => ({ ...c, count: v })));
  seed.onChange((v) => host.update((c) => ({ ...c, seed: v })));
  order.onChange((v) => host.update((c) => ({ ...c, order: v[0] ?? c.order })));

  let shownParamKeys: string[] = [];

  return {
    elements: [distribution.element, count.element, seed.element, order.element],
    setValue(data) {
      distribution.setValue(data.distribution);
      count.setValue(data.count);
      seed.setValue(data.seed);
      order.setValue([data.order]);
    },
    showIssues(issues) {
      for (const key of shownParamKeys) distribution.setParamIssue(key, null);
      shownParamKeys = [];
      for (const issue of distributionIssues(issues)) {
        distribution.setParamIssue(issue.field, issue.reason);
        shownParamKeys.push(issue.field);
      }
      count.setIssue(reasonFor(issues, 'data.count'));
      seed.setIssue(reasonFor(issues, 'data.seed'));
      order.setIssue(reasonFor(issues, 'data.order'));
    },
  };
}
