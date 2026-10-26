// 項目のそばの理由表示。入力部品の aria-invalid と aria-describedby を結び、支援技術にも理由を伝える(2.5、10.2)。

export interface FieldReason {
  /** 理由を表示する要素。入力部品の近くに置く */
  readonly element: HTMLElement;
  /** 理由を出す(null で消す)。targets の aria-invalid と aria-describedby を更新する */
  show(reason: string | null): void;
}

/**
 * 理由の表示要素を作る。targets は理由を結びつける入力部品(複数可)。
 * 理由がないときは要素を隠し、aria-invalid と aria-describedby を外す。
 */
export function createFieldReason(id: string, targets: readonly HTMLElement[]): FieldReason {
  const element = document.createElement('p');
  element.id = `${id}-reason`;
  element.className = 'field-reason';
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;

  const show = (reason: string | null): void => {
    const has = reason !== null && reason !== '';
    element.textContent = has ? reason : '';
    element.hidden = !has;
    for (const t of targets) {
      if (has) {
        t.setAttribute('aria-invalid', 'true');
        t.setAttribute('aria-describedby', element.id);
      } else {
        t.removeAttribute('aria-invalid');
        t.removeAttribute('aria-describedby');
      }
    }
  };
  return { element, show };
}
