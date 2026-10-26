// 数値入力(シード、範囲の下限・上限、分布のパラメータなど)。受け付けない値は理由を出し、通知しない(2.5)。
import { createEmitter, parseNumberInput } from './control';
import type { ControlBase } from './control';
import { createFieldReason } from './field-errors';

export interface NumberFieldOptions {
  readonly id: string;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly integer: boolean;
}

export function createNumberField(options: NumberFieldOptions, initial: number): ControlBase<number> {
  const root = document.createElement('div');
  root.className = 'control control-number';

  const label = document.createElement('label');
  label.htmlFor = options.id;
  label.textContent = options.label;

  const input = document.createElement('input');
  input.type = 'number';
  input.id = options.id;
  input.step = options.integer ? '1' : 'any';
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  input.value = String(initial);

  const reason = createFieldReason(options.id, [input]);
  root.append(label, input, reason.element);

  let current = initial;
  const emitter = createEmitter<number>();

  input.addEventListener('input', () => {
    const r = parseNumberInput(input.value, options.label, options);
    if (!r.ok) {
      reason.show(r.reason);
      return;
    }
    reason.show(null);
    current = r.value;
    emitter.emit(current);
  });

  return {
    element: root,
    value: () => current,
    setValue(value) {
      current = value;
      input.value = String(value);
      reason.show(null);
    },
    setIssue: (r) => reason.show(r),
    onChange: emitter.on,
  };
}
