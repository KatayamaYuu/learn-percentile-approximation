import type { OperationCounter } from '../core';

export interface StoreView {
  readonly minIndex: number | null;
  readonly span: number;
  readonly total: number;
  /** 件数配列の読み取り専用の参照。長さは span。保持しない(呼び出し側は複製してから外に出す) */
  readonly counts: ArrayLike<number>;
  readonly collapseCount: number;
  /** 縮約の合算先の番号の最大値。縮約がなければ null */
  readonly collapsedUpToIndex: number | null;
}

/**
 * 番号ごとの件数を、最小番号から最大番号までの連続した範囲ちょうどの長さで保持する。
 * 範囲の長さは上限 m 以下。小さい番号の側だけを縮約し、最大番号のバケットは常に本来の値だけを数える。
 * 番号の値としての意味(境界)は扱わない。
 */
export class CollapsingStore {
  readonly #maxBuckets: number;
  #counts: number[] = [];
  #minIndex: number | null = null;
  #total = 0;
  #collapseCount = 0;
  #collapsedUpTo: number | null = null;

  /** maxBuckets は検証済みの 1 以上の整数 */
  constructor(maxBuckets: number) {
    this.#maxBuckets = maxBuckets;
  }

  /**
   * 比較は「index < 最小番号」「index > 最大番号」を順に実行した分だけ数える(最大 2 回)。
   * 移動は件数配列・総件数への書き込みごとに 1。範囲を作り直すときはコピーした件数 1 個ごとに 1。
   * 配列の 0 での初期化、最小番号と縮約の記録の更新は数えない。
   */
  add(index: number, counter: OperationCounter): void {
    const min = this.#minIndex;
    if (min === null) {
      this.#counts = [1];
      this.#minIndex = index;
      this.#total = 1;
      counter.move(2);
      return;
    }
    const max = min + this.#counts.length - 1;
    counter.compare();
    if (index < min) {
      counter.move(this.#addBelow(index, min, max));
    } else {
      counter.compare();
      if (index > max) counter.move(this.#addAbove(index, min));
      else {
        this.#counts[index - min]! += 1;
        counter.move(1);
      }
    }
    this.#total += 1;
    counter.move(1);
  }

  /** 範囲より上の番号。件数配列への書き込み(コピーを含む)の回数を返す */
  #addAbove(index: number, min: number): number {
    const old = this.#counts;
    const m = this.#maxBuckets;
    if (index - min + 1 <= m) {
      const next = new Array<number>(index - min + 1).fill(0);
      for (let p = 0; p < old.length; p++) next[p] = old[p]!;
      next[index - min] = 1;
      this.#counts = next;
      return old.length + 1;
    }
    // 新しい最小番号 t より小さい番号の件数を t のバケットへ合算する
    const t = index - m + 1;
    const next = new Array<number>(m).fill(0);
    let writes = 0;
    let merged = 0;
    for (let p = 0; p < old.length; p++) {
      const j = min + p;
      if (j <= t) merged += old[p]!;
      else {
        next[j - t] = old[p]!;
        writes++;
      }
    }
    next[0] = merged;
    writes++;
    // m = 1 では合算先と新しい値のバケットが同じ(書き込みは 1 回)
    if (index !== t) writes++;
    next[index - t]! += 1;
    this.#counts = next;
    this.#minIndex = t;
    this.#recordCollapse(t);
    return writes;
  }

  /** 範囲より下の番号。件数配列への書き込みの回数を返す */
  #addBelow(index: number, min: number, max: number): number {
    const old = this.#counts;
    const m = this.#maxBuckets;
    if (max - index + 1 <= m) {
      const next = new Array<number>(max - index + 1).fill(0);
      for (let p = 0; p < old.length; p++) next[min - index + p] = old[p]!;
      next[0] = 1;
      this.#counts = next;
      this.#minIndex = index;
      return old.length + 1;
    }
    // 範囲の長さが m を超えない最小番号 t のバケットに数える
    const t = max - m + 1;
    this.#recordCollapse(t);
    if (t >= min) {
      this.#counts[t - min]! += 1;
      return 1;
    }
    const next = new Array<number>(m).fill(0);
    for (let p = 0; p < old.length; p++) next[min - t + p] = old[p]!;
    next[0] = 1;
    this.#counts = next;
    this.#minIndex = t;
    return old.length + 1;
  }

  #recordCollapse(target: number): void {
    this.#collapseCount += 1;
    this.#collapsedUpTo = this.#collapsedUpTo === null ? target : Math.max(this.#collapsedUpTo, target);
  }

  view(): StoreView {
    return {
      minIndex: this.#minIndex,
      span: this.#counts.length,
      total: this.#total,
      counts: this.#counts,
      collapseCount: this.#collapseCount,
      collapsedUpToIndex: this.#collapsedUpTo,
    };
  }

  /** 範囲・総件数・縮約の記録を戻す。上限 m は保つ */
  reset(): void {
    this.#counts = [];
    this.#minIndex = null;
    this.#total = 0;
    this.#collapseCount = 0;
    this.#collapsedUpTo = null;
  }
}
