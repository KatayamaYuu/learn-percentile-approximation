export const BYTES_PER_NUMBER = 8;

/**
 * メモリ見積もり = (保持する数値の個数 + 保持するカウンタの個数) × 8 バイト。
 * 配列の余白、オブジェクトの管理領域、一時的な作業領域は含まない。
 */
export function estimateBytes(parts: {
  readonly numbers: number;
  readonly counters: number;
}): number {
  return (parts.numbers + parts.counters) * BYTES_PER_NUMBER;
}
