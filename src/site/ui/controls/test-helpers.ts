// テスト専用: 操作部品のテスト用の小さな補助(DOM 環境のテストだけが使い、本番のコードは import しない)。

/** 入力欄に値を入れて input イベントを発火する(矢印キーやタイプ入力の結果と同じ) */
export function typeInto(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 項目のそばの理由の文字列。aria-describedby が指す要素の文字、なければ null */
export function reasonOf(input: HTMLElement): string | null {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const el = input.ownerDocument.getElementById(id);
    if (el !== null && !el.hidden && (el.textContent ?? '') !== '') return el.textContent;
  }
  return null;
}

/** テスト用に body へ取り付ける(getElementById を効かせるため) */
export function mount(el: HTMLElement): void {
  document.body.append(el);
}
