// 計算の状態の表示(3.2、3.5、3.6、10.6)。
// 計算中は結果の領域を aria-busy にして「直前の条件の結果」と伝え、失敗と上限超過は理由と対処を出し、
// 完了と失敗はライブリージョン(announce)で支援技術に通知する。この要素自体は aria-live にしない(二重に読み上げないため)。
import { formatInt } from '../../shared/format';
import { WORK_LIMIT } from '../../shared/limits';
import type { ComputeStatus } from '../compute/compute-client';

export interface StatusBarOptions {
  /** 結果を表示する領域。計算中は aria-busy を付ける */
  readonly resultRegion: HTMLElement;
  /** ライブリージョンへの通知(PageContext.announce) */
  readonly announce: (message: string) => void;
  /** 「もう一度計算する」ボタンの動作(ComputeClient.retry) */
  readonly onRetry: () => void;
}

export interface StatusBar {
  readonly element: HTMLElement;
  update(status: ComputeStatus): void;
}

export const RETRY_LABEL = 'もう一度計算する';

function paragraph(text: string, className?: string): HTMLParagraphElement {
  const p = document.createElement('p');
  if (className !== undefined) p.className = className;
  p.textContent = text;
  return p;
}

function list(items: readonly string[]): HTMLUListElement {
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.append(li);
  }
  return ul;
}

export function createStatusBar(options: StatusBarOptions): StatusBar {
  const { resultRegion, announce, onRetry } = options;
  const element = document.createElement('div');
  element.className = 'status-bar';
  let last: ComputeStatus | null = null;

  const show = (...nodes: Node[]): void => {
    element.replaceChildren(...nodes);
  };

  function update(status: ComputeStatus): void {
    const changed = status !== last;
    last = status;
    switch (status.state) {
      case 'idle':
        resultRegion.removeAttribute('aria-busy');
        show();
        return;
      case 'pending':
        resultRegion.setAttribute('aria-busy', 'true');
        show(paragraph('計算中です。表示中の結果は直前の条件の結果です。', 'status-pending'));
        return;
      case 'done':
        resultRegion.setAttribute('aria-busy', 'false');
        show();
        if (changed) announce('計算が完了しました。結果を更新しました。');
        return;
      case 'failed': {
        resultRegion.setAttribute('aria-busy', 'false');
        const { failure } = status;
        let spoken: string;
        if (failure.kind === 'exception') {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = RETRY_LABEL;
          button.addEventListener('click', () => onRetry());
          show(paragraph(`計算に失敗しました。${failure.message}`, 'status-failed'), button);
          spoken = `計算に失敗しました。${failure.message}`;
        } else if (failure.kind === 'invalid-condition') {
          const reasons = failure.issues.map((i) => i.reason);
          show(paragraph('条件に誤りがあるため計算しませんでした。', 'status-failed'), list(reasons));
          spoken = `条件に誤りがあるため計算しませんでした。${reasons.join(' ')}`;
        } else {
          const { estimate } = failure;
          const head = `計算量の上限(${formatInt(WORK_LIMIT)})を超えるため、計算を始めませんでした。見積もりは ${formatInt(estimate.units)} です。`;
          show(
            paragraph(head, 'status-failed'),
            paragraph('条件を次のように減らしてください。'),
            list(estimate.suggestions),
          );
          spoken = `${head}${estimate.suggestions.join(' ')}`;
        }
        if (changed) announce(spoken);
        return;
      }
    }
  }

  return { element, update };
}
