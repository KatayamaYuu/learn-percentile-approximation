// @vitest-environment happy-dom
// StatusBar のテスト: 計算中・失敗・上限超過・完了の文言、aria-busy、再実行、通知(3.2、3.5、3.6、10.6)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputeStatus } from '../compute/compute-client';
import type { JobResult } from '../../shared/protocol';
import { WORK_LIMIT } from '../../shared/limits';
import { createStatusBar } from './status-bar';

afterEach(() => {
  document.body.innerHTML = '';
});

const done: ComputeStatus = { state: 'done', result: { kind: 'histogram' } as unknown as JobResult };

function setup() {
  const region = document.createElement('div');
  const announce = vi.fn<(m: string) => void>();
  const onRetry = vi.fn();
  const bar = createStatusBar({ resultRegion: region, announce, onRetry });
  document.body.append(bar.element, region);
  return { region, announce, onRetry, bar };
}

describe('createStatusBar', () => {
  it('idle では何も出さず、結果の領域は処理中ではない', () => {
    const { bar, region } = setup();
    bar.update({ state: 'idle' });
    expect(bar.element.textContent).toBe('');
    expect(region.hasAttribute('aria-busy')).toBe(false);
  });

  it('計算中は結果の領域を aria-busy にし、直前の条件の結果である旨を出す(3.2)', () => {
    const { bar, region, announce } = setup();
    bar.update({ state: 'pending' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(bar.element.textContent).toContain('計算中');
    expect(bar.element.textContent).toContain('直前の条件の結果');
    expect(announce).not.toHaveBeenCalled();
  });

  it('完了で aria-busy を外し、1 回だけ完了を通知する(10.6)', () => {
    const { bar, region, announce } = setup();
    bar.update({ state: 'pending' });
    bar.update(done);
    expect(region.getAttribute('aria-busy')).toBe('false');
    expect(bar.element.textContent).toBe('');
    expect(announce).toHaveBeenCalledExactlyOnceWith('計算が完了しました。結果を更新しました。');
  });

  it('例外の失敗は理由と再実行ボタンを出し、押すと onRetry を呼び、失敗を通知する(3.6、10.6)', () => {
    const { bar, region, announce, onRetry } = setup();
    bar.update({ state: 'pending' });
    bar.update({ state: 'failed', failure: { kind: 'exception', message: 'Worker が応答しません' } });
    expect(region.getAttribute('aria-busy')).toBe('false');
    expect(bar.element.textContent).toContain('Worker が応答しません');
    const button = bar.element.querySelector('button')!;
    expect(button.textContent).toBe('もう一度計算する');
    expect(button.type).toBe('button');
    button.click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledOnce();
    expect(announce.mock.calls[0]![0]).toContain('失敗');
    expect(announce.mock.calls[0]![0]).toContain('Worker が応答しません');
  });

  it('条件の誤りは項目ごとの理由を出す(再実行ボタンは出さない)', () => {
    const { bar, announce } = setup();
    bar.update({
      state: 'failed',
      failure: { kind: 'invalid-condition', issues: [{ field: 'data.count', reason: '件数は 100 以上で入力してください。' }] },
    });
    expect(bar.element.textContent).toContain('件数は 100 以上で入力してください。');
    expect(bar.element.querySelector('button')).toBeNull();
    expect(announce).toHaveBeenCalledOnce();
  });

  it('上限超過は上限と減らし方を出す(3.5)', () => {
    const { bar, announce } = setup();
    bar.update({
      state: 'failed',
      failure: {
        kind: 'over-limit',
        estimate: { units: WORK_LIMIT * 2, includesHdrTerm: false, withinLimit: false, suggestions: ['件数を減らしてください。', '比較する手法を減らしてください。'] },
      },
    });
    const text = bar.element.textContent ?? '';
    expect(text).toContain('計算量の上限');
    expect(text).toContain('40,000,000');
    expect(text).toContain('件数を減らしてください。');
    expect(text).toContain('比較する手法を減らしてください。');
    expect(bar.element.querySelectorAll('li')).toHaveLength(2);
    expect(announce).toHaveBeenCalledOnce();
  });

  it('同じ状態の再描画では通知を繰り返さない', () => {
    const { bar, announce } = setup();
    bar.update(done);
    bar.update(done);
    expect(announce).toHaveBeenCalledOnce();
  });

  it('失敗の表示は次の計算中・完了で消える', () => {
    const { bar } = setup();
    bar.update({ state: 'failed', failure: { kind: 'exception', message: 'x' } });
    bar.update({ state: 'pending' });
    expect(bar.element.querySelector('button')).toBeNull();
    expect(bar.element.textContent).not.toContain('x。');
  });
});
