// 数値の書式(7.8)。小数は有効数字 3 桁、件数・操作数・バイト数は桁区切りの整数。

/** 有効数字 3 桁。0 は '0'。絶対値が 1e-4 未満または 1e6 以上は指数表記(例: '1.23e-5') */
export function formatSig3(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const rounded = Number(value.toPrecision(3));
  const abs = Math.abs(rounded);
  if (abs < 1e-4 || abs >= 1e6) {
    return value.toExponential(2).replace('e+', 'e');
  }
  return String(rounded);
}

/** 桁区切りの整数(例: '1,000,000') */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const n = Math.round(value);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${digits}` : digits;
}

/** バイトの表示。整数の桁区切り + 'バイト'。グラフの目盛りは formatSig3 */
export function formatBytes(value: number): string {
  return `${formatInt(value)} バイト`;
}
