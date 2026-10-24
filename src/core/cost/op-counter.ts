export interface OperationCounts {
  readonly comparisons: number;
  readonly moves: number;
}

/**
 * 操作数の計数器。比較は値と値(区切り値を含む)の大小比較 1 回ごとに 1、
 * 移動は数値またはカウンタを記憶領域の 1 要素へ書き込むごとに 1(交換は 2)。
 * 四則演算、添字計算、ループ制御は数えない。
 */
export class OperationCounter {
  #comparisons = 0;
  #moves = 0;

  /** times は 0 以上の整数 */
  compare(times = 1): void {
    this.#comparisons += times;
  }

  /** times は 0 以上の整数 */
  move(times = 1): void {
    this.#moves += times;
  }

  /** 呼び出し時点の累計を、独立したオブジェクトで返す */
  snapshot(): OperationCounts {
    return { comparisons: this.#comparisons, moves: this.#moves };
  }

  reset(): void {
    this.#comparisons = 0;
    this.#moves = 0;
  }
}
