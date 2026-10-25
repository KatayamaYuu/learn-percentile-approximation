// 誤差の指標(絶対・順位・相対)と分位点(または全分位点での最大)の選択(7.2)。
// 変更は通知するだけで、計算は依頼しない。受け取った側が手元の結果からグラフだけを作り直す。
import { SUMMARY_QUANTILES } from '../../shared/grids';
import { metricLabel, type ErrorMetric, type ErrorSelection } from '../../shared/metric';
import { createEmitter, type ControlBase } from '../controls/control';
import { createChoice } from '../controls/choice';

export interface ErrorSelectorOptions {
  /** id の接頭辞。同じ画面に複数置くときは変える。既定 'error-selector' */
  readonly id?: string;
}

const METRICS: readonly ErrorMetric[] = ['absolute', 'rank', 'relative'];
const MAX_VALUE = 'max';

function pickValue(selection: ErrorSelection): string {
  return selection.pick.kind === 'max' ? MAX_VALUE : String(selection.pick.quantile);
}

export function createErrorSelector(initial: ErrorSelection, options: ErrorSelectorOptions = {}): ControlBase<ErrorSelection> {
  const id = options.id ?? 'error-selector';
  const quantiles = [...new Set([...SUMMARY_QUANTILES, ...(initial.pick.kind === 'at' ? [initial.pick.quantile] : [])])].sort(
    (a, b) => a - b,
  );

  const metric = createChoice<ErrorMetric>(
    { id: `${id}-metric`, label: '誤差の指標', choices: METRICS.map((m) => ({ value: m, label: metricLabel(m) })), multiple: false },
    [initial.metric],
  );
  const pick = createChoice<string>(
    {
      id: `${id}-pick`,
      label: '分位点',
      choices: [
        ...quantiles.map((q) => ({ value: String(q), label: String(q) })),
        { value: MAX_VALUE, label: 'すべての分位点での最大' },
      ],
      multiple: false,
    },
    [pickValue(initial)],
  );

  const root = document.createElement('div');
  root.className = 'control control-error-selector';
  root.append(metric.element, pick.element);

  const emitter = createEmitter<ErrorSelection>();
  const read = (): ErrorSelection => {
    const m = metric.value()[0] ?? initial.metric;
    const p = pick.value()[0] ?? MAX_VALUE;
    return { metric: m, pick: p === MAX_VALUE ? { kind: 'max' } : { kind: 'at', quantile: Number(p) } };
  };
  const notify = (): void => emitter.emit(read());
  metric.onChange(notify);
  pick.onChange(notify);

  return {
    element: root,
    value: read,
    setValue(value) {
      metric.setValue([value.metric]);
      pick.setValue([pickValue(value)]);
    },
    setIssue: (reason) => metric.setIssue(reason),
    onChange: emitter.on,
  };
}
