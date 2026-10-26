// @vitest-environment happy-dom
// スライダー: ラベルと読み上げ用の値、値の常時表示、キー操作、自由入力と受け付けない値(2.2、2.5、10.1、10.2)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlider } from './slider';
import { mount, reasonOf, typeInto } from './test-helpers';

const opts = {
  id: 'eps',
  label: 'ε(誤差の目安)',
  unit: '',
  values: [0.1, 0.05, 0.01, 0.005].sort((a, b) => a - b),
  allowFreeInput: true,
  format: (v: number) => String(v),
};

function setup(initial = 0.01, o = opts) {
  const c = createSlider(o, initial);
  mount(c.element);
  const range = c.element.querySelector<HTMLInputElement>('input[type="range"]')!;
  const out = c.element.querySelector('output')!;
  const num = c.element.querySelector<HTMLInputElement>('input[type="number"]');
  const listener = vi.fn();
  c.onChange(listener);
  return { c, range, out, num, listener };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createSlider', () => {
  it('ラベルで名前が付き、読み上げ用の値(aria-valuetext)と常時表示の値がある', () => {
    const { c, range, out } = setup(0.01, { ...opts, unit: '件' });
    const label = c.element.querySelector(`label[for="${range.id}"]`);
    expect(label?.textContent).toBe('ε(誤差の目安)');
    expect(range.getAttribute('aria-valuetext')).toBe('0.01 件');
    expect(out.textContent).toBe('0.01 件');
    expect(out.getAttribute('for')).toBe(range.id);
  });

  it('スライダーは離散値の添字を動かす', () => {
    const { range } = setup(0.01);
    expect(range.min).toBe('0');
    expect(range.max).toBe('3');
    expect(range.step).toBe('1');
    expect(range.value).toBe('1'); // 昇順 [0.005, 0.01, 0.05, 0.1] のうち 0.01 は添字 1
  });

  it('矢印キーで 1 段進むと次の離散値になる(input イベント)', () => {
    const { c, range, out, listener } = setup(0.01);
    typeInto(range, String(Number(range.value) + 1));
    expect(c.value()).toBe(0.05);
    expect(out.textContent).toBe('0.05');
    expect(range.getAttribute('aria-valuetext')).toBe('0.05');
    expect(listener).toHaveBeenCalledExactlyOnceWith(0.05);
  });

  it('キーボードで操作できる(無効化も tabindex の除外もない)', () => {
    const { range, num } = setup();
    for (const el of [range, num!]) {
      expect(el.disabled).toBe(false);
      expect(el.getAttribute('tabindex')).toBeNull();
    }
  });

  it('自由入力: 範囲内の値は受け付けて通知し、表示も更新する', () => {
    const { c, num, out, range, listener } = setup();
    typeInto(num!, '0.02');
    expect(c.value()).toBe(0.02);
    expect(listener).toHaveBeenCalledExactlyOnceWith(0.02);
    expect(out.textContent).toBe('0.02');
    expect(range.getAttribute('aria-valuetext')).toBe('0.02');
    expect(reasonOf(num!)).toBeNull();
    expect(num!.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('自由入力: 範囲外・数値でない値は理由を出し、通知せず、値も変えない', () => {
    const { c, num, listener, out } = setup();
    typeInto(num!, '5');
    expect(reasonOf(num!)).toMatch(/以上.*以下/);
    expect(num!.getAttribute('aria-invalid')).toBe('true');
    typeInto(num!, '');
    expect(reasonOf(num!)).not.toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(c.value()).toBe(0.01);
    expect(out.textContent).toBe('0.01');
    // 直すと理由が消える
    typeInto(num!, '0.05');
    expect(reasonOf(num!)).toBeNull();
    expect(num!.getAttribute('aria-invalid')).not.toBe('true');
    expect(listener).toHaveBeenCalledExactlyOnceWith(0.05);
  });

  it('min / max / integer の指定で自由入力の範囲を広げ、整数でない値を拒む', () => {
    const { c, num, listener } = setup(10_000, {
      id: 'count',
      label: 'データ件数',
      unit: '件',
      values: [100, 1_000, 10_000],
      allowFreeInput: true,
      format: (v) => v.toLocaleString('en-US'),
      min: 100,
      max: 1_000_000,
      integer: true,
    } as typeof opts);
    typeInto(num!, '500000');
    expect(c.value()).toBe(500_000);
    typeInto(num!, '1500.5');
    expect(reasonOf(num!)).toMatch(/整数/);
    typeInto(num!, '2000000');
    expect(reasonOf(num!)).toMatch(/1,000,000/);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('allowFreeInput が false なら数値入力を持たない', () => {
    const { num } = setup(0.01, { ...opts, allowFreeInput: false });
    expect(num).toBeNull();
  });

  it('setValue は表示を更新するが通知しない。setIssue で外から理由を出せる', () => {
    const { c, range, out, listener } = setup();
    c.setValue(0.1);
    expect(out.textContent).toBe('0.1');
    expect(range.getAttribute('aria-valuetext')).toBe('0.1');
    expect(listener).not.toHaveBeenCalled();
    c.setIssue('テストの理由');
    expect(reasonOf(range)).toBe('テストの理由');
    expect(range.getAttribute('aria-invalid')).toBe('true');
    c.setIssue(null);
    expect(reasonOf(range)).toBeNull();
  });
});
