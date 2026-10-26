// スライダー: 離散値の列を range の添字で動かし、現在の値を <output> に常に表示する(2.2)。
// 読み上げ用の値は aria-valuetext(整形した値と単位)。許すなら範囲内の任意の値を数値入力でも受け付ける(2.5、10.2)。
import { createEmitter, parseNumberInput } from './control';
import type { ControlBase } from './control';
import { createFieldReason } from './field-errors';

export interface SliderOptions {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  /** 離散値の列(昇順)。スライダーは添字を動かし、数値入力は範囲内の任意の値を受け付ける */
  readonly values: readonly number[];
  readonly allowFreeInput: boolean;
  readonly format: (v: number) => string;
  /** 自由入力の下限。既定は values の先頭 */
  readonly min?: number;
  /** 自由入力の上限。既定は values の末尾 */
  readonly max?: number;
  /** 自由入力を整数に限るか。既定 false */
  readonly integer?: boolean;
}

function nearestIndex(values: readonly number[], v: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]! - v) < Math.abs(values[best]! - v)) best = i;
  }
  return best;
}

export function createSlider(options: SliderOptions, initial: number): ControlBase<number> {
  const { id, values } = options;
  if (values.length === 0) throw new Error('slider: values must not be empty');
  const unit = options.unit ?? '';
  const text = (v: number): string => (unit === '' ? options.format(v) : `${options.format(v)} ${unit}`);

  const root = document.createElement('div');
  root.className = 'control control-slider';

  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = options.label;

  const row = document.createElement('div');
  row.className = 'control-row';

  const range = document.createElement('input');
  range.type = 'range';
  range.id = id;
  range.min = '0';
  range.max = String(values.length - 1);
  range.step = '1';

  const out = document.createElement('output');
  out.setAttribute('for', id);
  row.append(range, out);
  root.append(label, row);

  const targets: HTMLElement[] = [range];
  let num: HTMLInputElement | null = null;
  const lo = options.min ?? values[0]!;
  const hi = options.max ?? values[values.length - 1]!;
  const rule = { min: lo, max: hi, integer: options.integer === true };
  if (options.allowFreeInput) {
    const numLabel = document.createElement('label');
    numLabel.htmlFor = `${id}-number`;
    numLabel.className = 'visually-hidden';
    numLabel.textContent = `${options.label}(数値で入力)`;
    num = document.createElement('input');
    num.type = 'number';
    num.id = `${id}-number`;
    num.min = String(lo);
    num.max = String(hi);
    num.step = rule.integer ? '1' : 'any';
    row.append(numLabel, num);
    targets.push(num);
  }
  const reason = createFieldReason(id, targets);
  root.append(reason.element);

  let current = initial;
  const emitter = createEmitter<number>();

  const render = (): void => {
    range.value = String(nearestIndex(values, current));
    const t = text(current);
    range.setAttribute('aria-valuetext', t);
    out.textContent = t;
    if (num !== null) num.value = String(current);
  };
  render();

  range.addEventListener('input', () => {
    const v = values[Number(range.value)];
    if (v === undefined) return;
    current = v;
    reason.show(null);
    render();
    emitter.emit(current);
  });

  if (num !== null) {
    const numInput = num;
    numInput.addEventListener('input', () => {
      const r = parseNumberInput(numInput.value, options.label, rule);
      if (!r.ok) {
        reason.show(r.reason);
        return;
      }
      reason.show(null);
      current = r.value;
      // 入力途中の文字を書き換えないよう、数値入力以外を更新する
      range.value = String(nearestIndex(values, current));
      const t = text(current);
      range.setAttribute('aria-valuetext', t);
      out.textContent = t;
      emitter.emit(current);
    });
  }

  return {
    element: root,
    value: () => current,
    setValue(value) {
      current = value;
      reason.show(null);
      render();
    },
    setIssue: (r) => reason.show(r),
    onChange: emitter.on,
  };
}
