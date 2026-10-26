// @vitest-environment happy-dom
// 分布の種類とパラメータの入力(多峰は 2 山を編集)(2.1、2.5、10.2)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISTRIBUTION_PRESETS } from '../../shared/conditions';
import { createDistributionEditor } from './distribution-editor';
import { mount, reasonOf, typeInto } from './test-helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

function setup(initial = DISTRIBUTION_PRESETS.lognormal as import('../../../core').Distribution) {
  const c = createDistributionEditor(initial);
  mount(c.element);
  const kind = c.element.querySelector<HTMLSelectElement>('select')!;
  const numbers = () => [...c.element.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  const listener = vi.fn();
  c.onChange(listener);
  return { c, kind, numbers, listener };
}

describe('createDistributionEditor', () => {
  it('分布の種類の select は 5 種を持ち、各パラメータはラベル付きの数値入力', () => {
    const { c, kind, numbers } = setup();
    expect([...kind.options].map((o) => o.value)).toEqual(['uniform', 'normal', 'lognormal', 'heavy-tail', 'multimodal']);
    expect(c.element.querySelector(`label[for="${kind.id}"]`)?.textContent).toBe('分布の種類');
    expect(kind.value).toBe('lognormal');
    const inputs = numbers();
    expect(inputs).toHaveLength(2);
    for (const i of inputs) {
      expect(c.element.querySelector(`label[for="${i.id}"]`)?.textContent).toBeTruthy();
    }
    expect(inputs.map((i) => i.value)).toEqual(['0', '1']);
  });

  it('パラメータの変更が分布の値として通知される', () => {
    const { c, numbers, listener } = setup();
    typeInto(numbers()[1]!, '0.5');
    expect(listener).toHaveBeenCalledExactlyOnceWith({ kind: 'lognormal', mu: 0, sigma: 0.5 });
    expect(c.value()).toEqual({ kind: 'lognormal', mu: 0, sigma: 0.5 });
  });

  it('種類を変えると既定のパラメータの入力に替わり、その分布が通知される', () => {
    const { c, kind, numbers, listener } = setup();
    kind.value = 'normal';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(listener).toHaveBeenCalledExactlyOnceWith(DISTRIBUTION_PRESETS.normal);
    expect(c.value()).toEqual(DISTRIBUTION_PRESETS.normal);
    expect(numbers().map((i) => i.value)).toEqual(['100', '15']);
  });

  it('多峰は 2 山(重み・平均・標準偏差)を編集できる', () => {
    const { c, kind, numbers, listener } = setup(DISTRIBUTION_PRESETS.multimodal);
    expect(kind.value).toBe('multimodal');
    expect(numbers()).toHaveLength(6);
    typeInto(numbers()[4]!, '300'); // 2 山目の平均
    expect(listener).toHaveBeenCalledTimes(1);
    expect(c.value()).toEqual({
      kind: 'multimodal',
      modes: [
        { weight: 1, mean: 50, stdDev: 5 },
        { weight: 1, mean: 300, stdDev: 20 },
      ],
    });
  });

  it('数値でないパラメータは理由を出し、通知せず、値も変えない', () => {
    const { c, numbers, listener } = setup();
    const target = numbers()[1]!;
    typeInto(target, '');
    expect(reasonOf(target)).toMatch(/数値/);
    expect(target.getAttribute('aria-invalid')).toBe('true');
    expect(listener).not.toHaveBeenCalled();
    expect(c.value()).toEqual(DISTRIBUTION_PRESETS.lognormal);
  });

  it('setParamIssue で項目ごとに、setIssue で全体に理由を出せる', () => {
    const { c, numbers } = setup();
    c.setParamIssue('sigma', 'σ は正の数にしてください。');
    expect(reasonOf(numbers()[1]!)).toBe('σ は正の数にしてください。');
    expect(reasonOf(numbers()[0]!)).toBeNull();
    c.setParamIssue('sigma', null);
    expect(reasonOf(numbers()[1]!)).toBeNull();
    c.setIssue('全体の理由');
    expect(c.element.textContent).toContain('全体の理由');
  });

  it('setValue は種類とパラメータの表示を更新するが通知しない', () => {
    const { c, kind, numbers, listener } = setup();
    c.setValue(DISTRIBUTION_PRESETS.uniform);
    expect(kind.value).toBe('uniform');
    expect(numbers().map((i) => i.value)).toEqual(['1', '1000']);
    expect(listener).not.toHaveBeenCalled();
  });

  it("上流の書式 'modes[1].stdDev' の理由は、その入力のそばだけに出て、null で消える", () => {
    const { c, numbers } = setup(DISTRIBUTION_PRESETS.multimodal);
    c.setParamIssue('modes[1].stdDev', '標準偏差は正の数にしてください。');
    const inputs = numbers();
    expect(reasonOf(inputs[5]!)).toBe('標準偏差は正の数にしてください。');
    expect(inputs.slice(0, 5).map((i) => reasonOf(i))).toEqual([null, null, null, null, null]);
    c.setParamIssue('modes[1].stdDev', null);
    expect(reasonOf(inputs[5]!)).toBeNull();
  });

  it("山の全体の 'modes' の理由は分布全体(fieldset)のそばに出る", () => {
    const { c } = setup(DISTRIBUTION_PRESETS.multimodal);
    c.setParamIssue('modes', '2 個以上の山が必要です。');
    expect(reasonOf(c.element)).toBe('2 個以上の山が必要です。');
    c.setParamIssue('modes', null);
    expect(reasonOf(c.element)).toBeNull();
  });
});
