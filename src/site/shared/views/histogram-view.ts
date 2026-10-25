// 厳密解とヒストグラムのページの表示(4.3〜4.6)。HistogramPageResult → ChartSpec[] の純粋な変換。
// 上流の結果の値をそのまま読み、指標を計算し直さない(7.7)。厳密解は誤差 0 なので誤差のグラフに入れない。
import type { BenchmarkResult, SweepResult } from '../../../core';
import type { BucketExperimentResult } from '../../../histogram';
import { defaultScale, OPERATIONS_TOTAL_BREAKDOWN, type ChartSpec, type SeriesSpec } from '../chart-spec';
import type { HistogramPageCondition } from '../conditions';
import { formatInt } from '../format';
import { metricLabel, pickError, type ErrorSelection } from '../metric';
import type { HistogramPageResult } from '../protocol';
import {
  allOperations,
  countAxisSeries,
  familyOf,
  memoryBytes,
  paramAxisSeries,
  quantileAxisSeries,
  unavailableNotes,
  unavailableText,
  variantOf,
} from '../series';

export interface ViewOptions {
  readonly selection: ErrorSelection;
}

const SCHEME_LABEL: Readonly<Record<string, string>> = {
  'histogram-equal': '等幅',
  'histogram-exponential': '指数幅',
};

function firstSweep(r: BucketExperimentResult): SweepResult | null {
  return r.cases[0]?.sweep ?? null;
}

function firstRun(r: BucketExperimentResult): BenchmarkResult | null {
  return firstSweep(r)?.runs[0] ?? null;
}

function notesOf(source: SweepResult | BenchmarkResult | null): readonly string[] {
  return source === null ? [] : unavailableNotes(source).map(unavailableText);
}

const isHistogram = (id: string): boolean => familyOf(id) === 'histogram';

function selectionText(selection: ErrorSelection): string {
  const q = selection.pick.kind === 'max' ? '全分位点の最大' : `分位点 ${selection.pick.quantile}`;
  return `${metricLabel(selection.metric)}(${q})`;
}

/** バケット数 × 誤差。系列は境界の決め方ごと。厳密解は入れない(4.3) */
function bucketsErrorChart(result: HistogramPageResult, selection: ErrorSelection): ChartSpec {
  const run = firstRun(result.paramSweep);
  const series: readonly SeriesSpec[] =
    run === null
      ? []
      : paramAxisSeries(
          run,
          (r) => {
            const v = variantOf(r.id);
            return v !== null && isHistogram(r.id) ? v : null;
          },
          'buckets',
          (r) => pickError(r.queries, selection),
        ).map((s) => ({ ...s, label: SCHEME_LABEL[s.id] ?? s.label }));
  return {
    id: 'histogram-buckets-error',
    title: 'バケット数ごとの誤差',
    x: { label: 'バケット数', unit: '個', scale: defaultScale('count'), toggleable: true },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series,
    referenceLines: [],
    notes: notesOf(run),
    summary: `バケット数を変えたときの${selectionText(selection)}を、境界の決め方(等幅・指数幅)ごとに示します。厳密解は誤差が 0 なので含めません。`,
  };
}

function countChart(
  result: HistogramPageResult,
  condition: HistogramPageCondition,
  spec: { id: string; title: string; yLabel: string; yUnit: string; quantity: 'operations' | 'memory'; breakdown: string },
  value: Parameters<typeof countAxisSeries>[1],
): ChartSpec {
  const sweep = firstSweep(result.countSweep);
  return {
    id: spec.id,
    title: spec.title,
    x: { label: 'データ件数', unit: '件', scale: defaultScale('count'), toggleable: true },
    y: { label: spec.yLabel, unit: spec.yUnit, scale: defaultScale(spec.quantity), toggleable: true },
    series: sweep === null ? [] : countAxisSeries(sweep, value),
    referenceLines: [],
    notes: notesOf(sweep),
    summary: `データ件数を変えたときの${spec.yLabel}を、厳密解 2 方式と現在のバケット数(${formatInt(condition.buckets)})のヒストグラムで比べます。${spec.breakdown}`,
  };
}

/** 累積分布: 厳密値(整列方式)の折れ線と、ヒストグラムの推定値の点(4.5)。詳細の結果から作る */
export function cdfChart(detail: BucketExperimentResult): ChartSpec {
  const run = firstRun(detail);
  const series: SeriesSpec[] = [];
  if (run !== null) {
    const exact = run.algorithms.find((a) => a.status === 'ok' && familyOf(a.id) === 'exact');
    if (exact !== undefined && exact.status === 'ok') {
      series.push({
        id: exact.id,
        label: `${exact.label}の厳密値`,
        kind: 'line',
        points: exact.queries.map((q) => ({ x: q.exact, y: q.quantile })),
      });
    }
    for (const a of run.algorithms) {
      if (a.status !== 'ok' || !isHistogram(a.id)) continue;
      series.push({
        id: a.id,
        label: `${a.label}の推定値`,
        kind: 'scatter',
        points: a.queries.map((q) => ({ x: q.estimate, y: q.quantile })),
      });
    }
  }
  return {
    id: 'histogram-cdf',
    title: '累積分布とヒストグラムの推定値',
    x: { label: '値', unit: '', scale: 'log', toggleable: true },
    y: { label: '分位点', unit: '', scale: defaultScale('quantile'), toggleable: true },
    series,
    referenceLines: [],
    notes: notesOf(run),
    summary:
      '厳密な値を結んだ線(累積分布)に、各ヒストグラムの推定値を点で重ねます。点が線に近いほど推定が正確です。計算できなかったヒストグラムは点を描かず、注記に示します。',
  };
}

/** 分位点 × 誤差(ヒストグラムのみ) */
function quantileErrorChart(result: HistogramPageResult, selection: ErrorSelection): ChartSpec {
  const run = firstRun(result.detail);
  return {
    id: 'histogram-quantile-error',
    title: '分位点ごとの誤差',
    x: { label: '分位点', unit: '', scale: defaultScale('quantile'), toggleable: true },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series: run === null ? [] : quantileAxisSeries(run, selection.metric, isHistogram),
    referenceLines: [],
    notes: notesOf(run),
    summary: `分位点ごとの${metricLabel(selection.metric)}を、ヒストグラムごとに示します。厳密解は誤差が 0 なので含めません。`,
  };
}

/** ヒストグラムのページのグラフ 5 枚: バケット数×誤差、件数×操作数、件数×メモリ、累積分布、分位点×誤差 */
export function buildHistogramCharts(
  result: HistogramPageResult,
  condition: HistogramPageCondition,
  options: ViewOptions,
): readonly ChartSpec[] {
  return [
    bucketsErrorChart(result, options.selection),
    countChart(
      result,
      condition,
      {
        id: 'histogram-count-operations',
        title: 'データ件数ごとの操作数',
        yLabel: '操作数',
        yUnit: '回',
        quantity: 'operations',
        breakdown: `操作数は ${OPERATIONS_TOTAL_BREAKDOWN} の合計です。`,
      },
      allOperations,
    ),
    countChart(
      result,
      condition,
      {
        id: 'histogram-count-memory',
        title: 'データ件数ごとのメモリ見積もり',
        yLabel: 'メモリ見積もり',
        yUnit: 'バイト',
        quantity: 'memory',
        breakdown: 'メモリは値の投入後の見積もりです。',
      },
      memoryBytes,
    ),
    cdfChart(result.detail),
    quantileErrorChart(result, options.selection),
  ];
}
