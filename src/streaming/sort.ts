import type { OperationCounter } from '../core';

/**
 * 計数付きのボトムアップ併合整列(安定)。core の厳密解(sort-exact)と同じ数え方で、
 * 値と値の比較 1 回ごとに比較 1、作業領域または書き戻しへの 1 要素の書き込みごとに移動 1 を数える。
 * 重みを伴う場合は値と重みの組の書き込みを移動 2 と数える(perElement = 2)。
 * 乱数は使わない。
 */
function mergeSortPairs(
  values: Float64Array,
  weights: Float64Array | undefined,
  length: number,
  counter: OperationCounter,
): void {
  if (length < 2) return;
  const perElement = weights === undefined ? 1 : 2;
  let srcV: Float64Array = values;
  let dstV: Float64Array = new Float64Array(length);
  let srcW: Float64Array | undefined = weights;
  let dstW: Float64Array | undefined = weights === undefined ? undefined : new Float64Array(length);

  for (let width = 1; width < length; width *= 2) {
    for (let start = 0; start < length; start += 2 * width) {
      const mid = Math.min(start + width, length);
      const end = Math.min(start + 2 * width, length);
      let i = start;
      let j = mid;
      let k = start;
      while (i < mid && j < end) {
        counter.compare();
        // 同値は左を先にして安定にする
        const from = srcV[j]! < srcV[i]! ? j++ : i++;
        dstV[k] = srcV[from]!;
        if (srcW !== undefined && dstW !== undefined) dstW[k] = srcW[from]!;
        k++;
        counter.move(perElement);
      }
      while (i < mid) {
        dstV[k] = srcV[i]!;
        if (srcW !== undefined && dstW !== undefined) dstW[k] = srcW[i]!;
        k++;
        i++;
        counter.move(perElement);
      }
      while (j < end) {
        dstV[k] = srcV[j]!;
        if (srcW !== undefined && dstW !== undefined) dstW[k] = srcW[j]!;
        k++;
        j++;
        counter.move(perElement);
      }
    }
    const tv = srcV;
    srcV = dstV;
    dstV = tv;
    const tw = srcW;
    srcW = dstW;
    dstW = tw;
  }

  // 結果が作業領域側にあるときだけ、入力の配列へ書き戻す(書き戻しの移動も数える)
  if (srcV !== values) {
    for (let i = 0; i < length; i++) {
      values[i] = srcV[i]!;
      if (weights !== undefined && srcW !== undefined) weights[i] = srcW[i]!;
    }
    counter.move(length * perElement);
  }
}

/** values[0..length) を昇順に並べ替える。length は 0 以上 values.length 以下。[length..) は変更しない */
export function sortValues(values: Float64Array, length: number, counter: OperationCounter): void {
  mergeSortPairs(values, undefined, length, counter);
}

/** values[0..length) を昇順に並べ、weights[0..length) を同じ並びに揃える。[length..) は変更しない */
export function sortWeighted(
  values: Float64Array,
  weights: Float64Array,
  length: number,
  counter: OperationCounter,
): void {
  mergeSortPairs(values, weights, length, counter);
}
