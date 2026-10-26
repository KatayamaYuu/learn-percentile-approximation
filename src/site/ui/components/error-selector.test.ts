// @vitest-environment happy-dom
// ErrorSelector のテスト: 指標と分位点の選択。変更は通知するだけで再計算しない(7.2)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_QUANTILES } from '../../shared/grids';
import { createErrorSelector } from './error-selector';

afterEach(() => {
  document.body.innerHTML = '';
});

function selects(el: HTMLElement): { metric: HTMLSelectElement; pick: HTMLSelectElement } {
  const [metric, pick] = el.querySelectorAll('select');
  return { metric: metric!, pick: pick! };
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('createErrorSelector', () => {
  it('指標 3 種と、分位点 9 つ + 最大を、label 付きの select で出す', () => {
    const sel = createErrorSelector({ metric: 'rank', pick: { kind: 'max' } });
    document.body.append(sel.element);
    const { metric, pick } = selects(sel.element);
    expect([...metric.options].map((o) => o.textContent)).toEqual(['絶対誤差', '順位誤差', '相対誤差']);
    expect(pick.options).toHaveLength(SUMMARY_QUANTILES.length + 1);
    expect(pick.options[pick.options.length - 1]!.textContent).toBe('すべての分位点での最大');
    for (const s of [metric, pick]) {
      expect(sel.element.querySelector(`label[for="${s.id}"]`)).not.toBeNull();
    }
    expect(metric.value).toBe('rank');
    expect(pick.value).toBe('max');
  });

  it('変更は選択を通知する(再計算の窓口は持たない)', () => {
    const sel = createErrorSelector({ metric: 'rank', pick: { kind: 'max' } });
    document.body.append(sel.element);
    const listener = vi.fn();
    sel.onChange(listener);
    const { metric, pick } = selects(sel.element);
    change(metric, 'relative');
    expect(listener).toHaveBeenLastCalledWith({ metric: 'relative', pick: { kind: 'max' } });
    change(pick, '0.99');
    expect(listener).toHaveBeenLastCalledWith({ metric: 'relative', pick: { kind: 'at', quantile: 0.99 } });
    change(pick, 'max');
    expect(listener).toHaveBeenLastCalledWith({ metric: 'relative', pick: { kind: 'max' } });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(sel.value()).toEqual({ metric: 'relative', pick: { kind: 'max' } });
  });

  it('setValue は表示を合わせるが通知しない', () => {
    const sel = createErrorSelector({ metric: 'rank', pick: { kind: 'max' } });
    document.body.append(sel.element);
    const listener = vi.fn();
    sel.onChange(listener);
    sel.setValue({ metric: 'absolute', pick: { kind: 'at', quantile: 0.5 } });
    const { metric, pick } = selects(sel.element);
    expect(metric.value).toBe('absolute');
    expect(pick.value).toBe('0.5');
    expect(listener).not.toHaveBeenCalled();
    expect(sel.value()).toEqual({ metric: 'absolute', pick: { kind: 'at', quantile: 0.5 } });
  });

  it('初期値が既定の分位点にないときも、その分位点を選択肢に含める', () => {
    const sel = createErrorSelector({ metric: 'relative', pick: { kind: 'at', quantile: 0.95 } });
    document.body.append(sel.element);
    expect(selects(sel.element).pick.value).toBe('0.95');
  });

  it('同じ画面に 2 つ置いても id が衝突しない', () => {
    const a = createErrorSelector({ metric: 'rank', pick: { kind: 'max' } }, { id: 'a' });
    const b = createErrorSelector({ metric: 'rank', pick: { kind: 'max' } }, { id: 'b' });
    document.body.append(a.element, b.element);
    const ids = [...document.querySelectorAll('select')].map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
  });
});
