// @vitest-environment happy-dom
// 共通のデータ条件の操作部品のテスト(2.1、2.2、2.5)。
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATA, DISTRIBUTION_PRESETS, type DataCondition } from '../../shared/conditions';
import { mount, typeInto } from '../controls/test-helpers';
import { createDataControls } from './data-controls';

afterEach(() => {
  document.body.innerHTML = '';
});

function setup(initial: DataCondition = DEFAULT_DATA) {
  let data = initial;
  const dc = createDataControls({
    idPrefix: 'x',
    host: { initial, update: (fn) => void (data = fn(data)) },
  });
  const root = document.createElement('div');
  root.append(...dc.elements);
  mount(root);
  return { dc, root, get: () => data, $: <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)! };
}

describe('createDataControls', () => {
  it('分布・件数・シード・順序の 4 つの要素を、接頭辞つきの id で置く', () => {
    const t = setup();
    expect(t.dc.elements).toHaveLength(4);
    for (const id of ['distribution-kind', 'x-count', 'x-count-number', 'x-seed', 'x-order']) expect(t.$(id), id).not.toBeNull();
  });

  it('操作がデータ条件の更新として通知される', () => {
    const t = setup();
    typeInto(t.$('x-count-number'), '2500');
    expect(t.get().count).toBe(2500);
    typeInto(t.$('x-seed'), '9');
    expect(t.get().seed).toBe(9);
    const order = t.$<HTMLSelectElement>('x-order');
    order.value = 'descending';
    order.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.get().order).toBe('descending');
    const kind = t.$<HTMLSelectElement>('distribution-kind');
    kind.value = 'normal';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.get().distribution.kind).toBe('normal');
  });

  it('範囲外の件数は受け付けず通知しない', () => {
    const t = setup();
    typeInto(t.$('x-count-number'), '5');
    expect(t.get().count).toBe(DEFAULT_DATA.count);
  });

  it('setValue は表示を合わせるが通知しない', () => {
    const t = setup();
    t.dc.setValue({ ...DEFAULT_DATA, count: 300, seed: 4, order: 'ascending', distribution: DISTRIBUTION_PRESETS.normal });
    expect(t.$<HTMLInputElement>('x-count-number').value).toBe('300');
    expect(t.$<HTMLInputElement>('x-seed').value).toBe('4');
    expect(t.$<HTMLSelectElement>('x-order').value).toBe('ascending');
    expect(t.$<HTMLSelectElement>('distribution-kind').value).toBe('normal');
    expect(t.get()).toBe(DEFAULT_DATA);
  });

  it('showIssues は項目のそばに理由を出し、前回の分布の理由は消す', () => {
    const t = setup({ ...DEFAULT_DATA, distribution: DISTRIBUTION_PRESETS.lognormal });
    t.dc.showIssues([
      { field: 'data.distribution.sigma', reason: 'σは正の数にしてください。' },
      { field: 'data.count', reason: '件数の理由' },
      { field: 'data.seed', reason: 'シードの理由' },
    ]);
    expect(t.root.textContent).toContain('σは正の数にしてください。');
    expect(t.root.textContent).toContain('件数の理由');
    expect(t.root.textContent).toContain('シードの理由');
    t.dc.showIssues([{ field: 'data.count', reason: '件数の理由' }]);
    expect(t.root.textContent).not.toContain('σは正の数にしてください。');
    expect(t.root.textContent).not.toContain('シードの理由');
    expect(t.root.textContent).toContain('件数の理由');
    t.dc.showIssues([]);
    expect(t.root.textContent).not.toContain('件数の理由');
  });
});
