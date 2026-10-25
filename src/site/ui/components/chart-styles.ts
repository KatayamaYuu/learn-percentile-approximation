// 系列の見た目: 色・破線・点の形の組を系列ごとに変え、色だけに頼らない(10.4)。
// 色は白い背景に対して図形のコントラスト 3:1 以上のものを選ぶ。

export type PointStyleName = 'circle' | 'rect' | 'triangle' | 'rectRot' | 'cross' | 'star' | 'crossRot';

export interface SeriesStyle {
  readonly color: string;
  readonly dash: readonly number[];
  readonly pointStyle: PointStyleName;
}

// 組は 7 通り。8 本目以降は組が一巡して繰り返すため、chart-renderer.ts が一巡ごとに
// pointRadius と borderWidth を 1 ずつ大きくして見分けを補う(8 本以上の系列は想定外の上限)。
export const SERIES_STYLES: readonly SeriesStyle[] = [
  { color: '#0072b2', dash: [], pointStyle: 'circle' },
  { color: '#c24e00', dash: [8, 4], pointStyle: 'rect' },
  { color: '#007a5a', dash: [2, 3], pointStyle: 'triangle' },
  { color: '#a83c7a', dash: [10, 3, 2, 3], pointStyle: 'rectRot' },
  { color: '#6b4fbb', dash: [14, 4], pointStyle: 'cross' },
  { color: '#7a6a00', dash: [4, 2, 1, 2], pointStyle: 'star' },
  { color: '#404040', dash: [1, 4], pointStyle: 'crossRot' },
];

/** 基準線(α・ε・1/S など)の見た目。系列とは別の灰色の破線で、点は描かない */
export const REFERENCE_STYLE = { color: '#595959', dash: [5, 5] as readonly number[] } as const;

/** dashed の系列で、割り当てられた破線が実線のときに使う破線 */
export const DASHED_FALLBACK: readonly number[] = [6, 4];

export function styleFor(index: number): SeriesStyle {
  return SERIES_STYLES[index % SERIES_STYLES.length] as SeriesStyle;
}
