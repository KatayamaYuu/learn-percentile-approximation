// グラフの表示の仕様と、対数軸の扱い、表・代替テキストへの変換。
// 上流の型には依存せず、ページごとの view builder が上流の結果から ChartSpec を作る。
import { formatInt, formatSig3 } from './format';

export type AxisScale = 'linear' | 'log';

export interface AxisSpec {
  /** 量の名前。例: 'バケット数'、'順位誤差' */
  readonly label: string;
  /** 例: '件'、'回'、'バイト'、'ミリ秒'、''(無次元) */
  readonly unit: string;
  readonly scale: AxisScale;
  /** 利用者が切り替えられるか(7.1) */
  readonly toggleable: boolean;
}

export interface ChartPoint {
  readonly x: number | string;
  readonly y: number;
  /** ツールチップと表に出す追加情報(条件など) */
  readonly detail?: string;
}

export interface SeriesSpec {
  readonly id: string;
  readonly label: string;
  readonly points: readonly ChartPoint[];
  /** 表示の形 */
  readonly kind: 'line' | 'scatter' | 'bar';
}

export interface ReferenceLine {
  readonly axis: 'y' | 'x';
  readonly value: number;
  readonly label: string;
}

export interface ChartSpec {
  readonly id: string;
  readonly title: string;
  readonly x: AxisSpec;
  readonly y: AxisSpec;
  readonly series: readonly SeriesSpec[];
  readonly referenceLines: readonly ReferenceLine[];
  /** 計算できなかった手法、除外した点などの注記 */
  readonly notes: readonly string[];
  /** 内容の要約(代替テキスト) */
  readonly summary: string;
}

/** 軸が表す量。既定の尺度の決定に使う */
export type AxisQuantity = 'count' | 'error' | 'operations' | 'memory' | 'quantile' | 'time';

/** 既定の尺度: 件数・誤差・操作数・メモリは対数、分位点・処理時間は線形(7.1) */
export function defaultScale(quantity: AxisQuantity): AxisScale {
  switch (quantity) {
    case 'count':
    case 'error':
    case 'operations':
    case 'memory':
      return 'log';
    case 'quantile':
    case 'time':
      return 'linear';
  }
}

/** 足し算は表示のための集計であり、指標の再定義ではない。凡例と表に内訳を書くための文言 */
export const OPERATIONS_INSERT_BREAKDOWN = '比較 + 移動';
export const OPERATIONS_TOTAL_BREAKDOWN = '投入(比較 + 移動) + 問い合わせ(比較 + 移動)';
export const ELAPSED_BREAKDOWN = '投入 + 問い合わせ';

/** 対数軸に載せられる値か。正の有限の数だけが載る */
function plottableOnLog(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 対数軸で 0 以下(と有限でない値)の点を除き、除いた点を系列ごとに notes に足した新しい ChartSpec を返す(7.6)。
 * 線形軸では何も除かない。文字列の x(項目名)は x 軸の判定の対象にしない。元の仕様は変えない。
 */
export function prepareForScale(spec: ChartSpec, scales: { readonly x: AxisScale; readonly y: AxisScale }): ChartSpec {
  const added: string[] = [];
  const series = spec.series.map((s) => {
    const kept = s.points.filter((p) => {
      if (scales.x === 'log' && typeof p.x === 'number' && !plottableOnLog(p.x)) return false;
      if (scales.y === 'log' && !plottableOnLog(p.y)) return false;
      return true;
    });
    const removed = s.points.length - kept.length;
    if (removed > 0) {
      added.push(`${s.label}: 対数軸には 0 以下の値を描けないため、${formatInt(removed)} 個の点を除きました。`);
    }
    return removed > 0 ? { ...s, points: kept } : s;
  });
  return {
    ...spec,
    x: { ...spec.x, scale: scales.x },
    y: { ...spec.y, scale: scales.y },
    series,
    notes: [...spec.notes, ...added],
  };
}

export interface TableModel {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function axisHeading(axis: AxisSpec): string {
  return axis.unit === '' ? axis.label : `${axis.label}(${axis.unit})`;
}

function formatCell(value: number | string): string {
  if (typeof value === 'string') return value;
  return Number.isInteger(value) && Math.abs(value) < 1e15 ? formatInt(value) : formatSig3(value);
}

/** 系列 × 点を表にする。行数は点の数に等しい。数値は Format で整形する(10.3) */
export function toTable(spec: ChartSpec): TableModel {
  const rows: string[][] = [];
  for (const s of spec.series) {
    for (const p of s.points) {
      rows.push([s.label, formatCell(p.x), formatCell(p.y), p.detail ?? '']);
    }
  }
  return {
    caption: spec.title,
    columns: ['系列', axisHeading(spec.x), axisHeading(spec.y), '備考'],
    rows,
  };
}

/** 題名・軸・系列名・要約を 1 つの文章にする(10.3) */
export function altText(spec: ChartSpec): string {
  const points = spec.series.reduce((n, s) => n + s.points.length, 0);
  const seriesPart =
    spec.series.length === 0
      ? '描ける系列はありません。'
      : `系列は ${spec.series.map((s) => s.label).join('、')} の ${formatInt(spec.series.length)} 本、点は合計 ${formatInt(points)} 個です。`;
  const parts = [`${spec.title}。`, `横軸は${axisHeading(spec.x)}、縦軸は${axisHeading(spec.y)}です。`, seriesPart];
  if (spec.summary !== '') parts.push(spec.summary);
  return parts.join('');
}
