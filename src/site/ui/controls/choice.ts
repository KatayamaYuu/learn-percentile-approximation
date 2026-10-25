// 選択: 単一は <select>、複数は <fieldset> + チェックボックスの群(2.1、10.1、10.2)。
import { createEmitter } from './control';
import type { ControlBase } from './control';
import { createFieldReason } from './field-errors';

export interface ChoiceOptions<T extends string> {
  readonly id: string;
  readonly label: string;
  readonly choices: readonly { readonly value: T; readonly label: string }[];
  readonly multiple: boolean;
}

export function createChoice<T extends string>(
  options: ChoiceOptions<T>,
  initial: readonly T[],
): ControlBase<readonly T[]> {
  const { id, choices } = options;
  const emitter = createEmitter<readonly T[]>();
  let current: readonly T[] = [...initial];

  if (!options.multiple) {
    const root = document.createElement('div');
    root.className = 'control control-choice';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = options.label;
    const select = document.createElement('select');
    select.id = id;
    for (const c of choices) {
      const o = document.createElement('option');
      o.value = c.value;
      o.textContent = c.label;
      select.append(o);
    }
    select.value = current[0] ?? choices[0]?.value ?? '';
    const reason = createFieldReason(id, [select]);
    root.append(label, select, reason.element);
    select.addEventListener('change', () => {
      current = [select.value as T];
      emitter.emit(current);
    });
    return {
      element: root,
      value: () => current,
      setValue(value) {
        current = [...value];
        select.value = current[0] ?? '';
      },
      setIssue: (r) => reason.show(r),
      onChange: emitter.on,
    };
  }

  const fieldset = document.createElement('fieldset');
  fieldset.className = 'control control-choice';
  fieldset.id = id;
  const legend = document.createElement('legend');
  legend.textContent = options.label;
  fieldset.append(legend);
  const boxes: { readonly value: T; readonly box: HTMLInputElement }[] = [];
  for (const [i, c] of choices.entries()) {
    const item = document.createElement('span');
    item.className = 'control-option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `${id}-${i}`;
    box.value = c.value;
    box.checked = current.includes(c.value);
    const l = document.createElement('label');
    l.htmlFor = box.id;
    l.textContent = c.label;
    item.append(box, l);
    fieldset.append(item);
    boxes.push({ value: c.value, box });
  }
  const reason = createFieldReason(id, [fieldset]);
  fieldset.append(reason.element);
  const read = (): readonly T[] => boxes.filter((b) => b.box.checked).map((b) => b.value);
  fieldset.addEventListener('change', () => {
    current = read();
    emitter.emit(current);
  });
  return {
    element: fieldset,
    value: () => current,
    setValue(value) {
      current = [...value];
      for (const b of boxes) b.box.checked = current.includes(b.value);
    },
    setIssue: (r) => reason.show(r),
    onChange: emitter.on,
  };
}
