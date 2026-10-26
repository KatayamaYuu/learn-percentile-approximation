// @vitest-environment happy-dom
// 選択(単一は select、複数はチェックボックスの群)(2.1、10.1、10.2)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChoice } from './choice';
import { mount, reasonOf } from './test-helpers';

const choices = [
  { value: 'gk', label: 'GK' },
  { value: 'kll', label: 'KLL' },
  { value: 'tdigest', label: 't-digest' },
] as const;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createChoice 単一', () => {
  it('label で名前が付いた select になり、変更で値が通知される', () => {
    const c = createChoice({ id: 'order', label: '挿入順序', choices, multiple: false }, ['kll']);
    mount(c.element);
    const select = c.element.querySelector('select')!;
    expect(c.element.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('挿入順序');
    expect(select.value).toBe('kll');
    expect(c.value()).toEqual(['kll']);
    const listener = vi.fn();
    c.onChange(listener);
    select.value = 'tdigest';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(listener).toHaveBeenCalledExactlyOnceWith(['tdigest']);
    expect(c.value()).toEqual(['tdigest']);
  });

  it('setValue は表示を変えるが通知しない', () => {
    const c = createChoice({ id: 'o', label: 'x', choices, multiple: false }, ['gk']);
    const listener = vi.fn();
    c.onChange(listener);
    c.setValue(['tdigest']);
    expect(c.element.querySelector('select')!.value).toBe('tdigest');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createChoice 複数', () => {
  it('fieldset と legend で名前が付き、チェックボックスはそれぞれ label を持つ', () => {
    const c = createChoice({ id: 'methods', label: '手法', choices, multiple: true }, ['gk', 'kll']);
    mount(c.element);
    expect(c.element.querySelector('fieldset > legend')?.textContent).toBe('手法');
    const boxes = [...c.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
    for (const b of boxes) {
      expect(c.element.querySelector(`label[for="${b.id}"]`)).not.toBeNull();
      expect(b.disabled).toBe(false);
    }
    expect(c.element.querySelector(`label[for="${boxes[2]!.id}"]`)?.textContent).toBe('t-digest');
  });

  it('チェックの切り替えで、選択肢の並び順の値の配列が通知される', () => {
    const c = createChoice({ id: 'methods', label: '手法', choices, multiple: true }, ['kll']);
    const listener = vi.fn();
    c.onChange(listener);
    const boxes = [...c.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    boxes[0]!.checked = true;
    boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(listener).toHaveBeenLastCalledWith(['gk', 'kll']);
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(listener).toHaveBeenLastCalledWith(['gk']);
    expect(c.value()).toEqual(['gk']);
  });

  it('setIssue で fieldset のそばに理由を出し、null で消す', () => {
    const c = createChoice({ id: 'methods', label: '手法', choices, multiple: true }, []);
    mount(c.element);
    const fs = c.element;
    c.setIssue('手法を 1 つ以上選んでください。');
    expect(reasonOf(fs)).toBe('手法を 1 つ以上選んでください。');
    expect(fs.getAttribute('aria-invalid')).toBe('true');
    c.setIssue(null);
    expect(reasonOf(fs)).toBeNull();
  });
});
