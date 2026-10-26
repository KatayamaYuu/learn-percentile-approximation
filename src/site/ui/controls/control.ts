// 操作部品の共通の契約。DOM の要素と、値・理由・変更通知の入口を持つ。

export interface ControlBase<T> {
  readonly element: HTMLElement;
  value(): T;
  /** 表示を値に合わせる。onChange は呼ばない */
  setValue(value: T): void;
  /** 項目のそばの理由(aria-invalid、aria-describedby)。null で消す */
  setIssue(reason: string | null): void;
  onChange(listener: (value: T) => void): void;
}

/** 通知先の一覧。受け付けた値だけを emit する */
export function createEmitter<T>(): { on(l: (v: T) => void): void; emit(v: T): void } {
  const listeners: ((v: T) => void)[] = [];
  return {
    on: (l) => void listeners.push(l),
    emit: (v) => {
      for (const l of listeners) l(v);
    },
  };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 数値の入力文字列を検査する。受け付けるなら数値、受け付けないなら理由 */
export function parseNumberInput(
  text: string,
  label: string,
  rule: { readonly min?: number; readonly max?: number; readonly integer: boolean },
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string } {
  const trimmed = text.trim();
  const n = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, reason: `${label}は数値で入力してください。` };
  if (rule.integer && !Number.isInteger(n)) return { ok: false, reason: `${label}は整数で入力してください。` };
  const { min, max } = rule;
  if (min !== undefined && max !== undefined && (n < min || n > max)) {
    return { ok: false, reason: `${label}は ${fmt(min)} 以上 ${fmt(max)} 以下で入力してください。` };
  }
  if (min !== undefined && n < min) return { ok: false, reason: `${label}は ${fmt(min)} 以上で入力してください。` };
  if (max !== undefined && n > max) return { ok: false, reason: `${label}は ${fmt(max)} 以下で入力してください。` };
  return { ok: true, value: n };
}
