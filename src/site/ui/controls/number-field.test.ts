// @vitest-environment happy-dom
// 数値入力: 受け付けない値(数値でない、範囲外、整数でない)で理由を出し、変更を通知しない(2.5、10.2)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNumberField } from './number-field';
import { mount, reasonOf, typeInto } from './test-helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

function setup(o: { min?: number; max?: number; integer: boolean }, initial: number) {
  const c = createNumberField({ id: 'seed', label: 'シード', ...o }, initial);
  mount(c.element);
  const input = c.element.querySelector<HTMLInputElement>('input[type="number"]')!;
  const listener = vi.fn();
  c.onChange(listener);
  return { c, input, listener };
}

describe('createNumberField', () => {
  it('label で名前が付き、初期値を表示する', () => {
    const { c, input } = setup({ integer: true, min: 0 }, 1);
    expect(c.element.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('シード');
    expect(input.value).toBe('1');
    expect(input.min).toBe('0');
    expect(input.step).toBe('1');
  });

  it('受け付ける値は通知される', () => {
    const { c, input, listener } = setup({ integer: true, min: 0, max: 100 }, 1);
    typeInto(input, '42');
    expect(listener).toHaveBeenCalledExactlyOnceWith(42);
    expect(c.value()).toBe(42);
  });

  it.each([
    ['', /数値/],
    ['101', /0 以上 100 以下/],
    ['-1', /0 以上 100 以下/],
    ['1.5', /整数/],
  ])('受け付けない値 %j は理由を出し、通知しない', (text, reason) => {
    const { c, input, listener } = setup({ integer: true, min: 0, max: 100 }, 1);
    typeInto(input, text);
    expect(reasonOf(input)).toMatch(reason);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(listener).not.toHaveBeenCalled();
    expect(c.value()).toBe(1);
  });

  it('範囲の指定がなければ有限の数なら受け付け、小数も可(integer: false)', () => {
    const { input, listener } = setup({ integer: false }, 1);
    typeInto(input, '-2.5');
    expect(listener).toHaveBeenCalledExactlyOnceWith(-2.5);
    typeInto(input, '1e999');
    expect(reasonOf(input)).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('直すと理由が消える。setValue は通知せず、setIssue で外から理由を出せる', () => {
    const { c, input, listener } = setup({ integer: true, min: 0 }, 1);
    typeInto(input, '-5');
    expect(reasonOf(input)).not.toBeNull();
    typeInto(input, '5');
    expect(reasonOf(input)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    c.setValue(9);
    expect(input.value).toBe('9');
    expect(listener).toHaveBeenCalledTimes(1);
    c.setIssue('上流の理由');
    expect(reasonOf(input)).toBe('上流の理由');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
