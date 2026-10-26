// 横断比較の表示(8.3〜8.5、8.8)。CompareResult → ChartSpec[] と比較表の行の純粋な変換。
// 上流の結果の値をそのまま読み、指標を計算し直さない(7.7)。処理時間は参考値、操作数は環境によらない費用の目安。
import type { AlgorithmResult, BenchmarkResult, SweepResult } from '../../../core';
import {
  defaultScale,
  ELAPSED_BREAKDOWN,
  OPERATIONS_INSERT_BREAKDOWN,
  type ChartSpec,
  type ReferenceLine,
  type SeriesSpec,
} from '../chart-spec';
import type { CompareCondition } from '../conditions';
import { formatInt, formatSig3 } from '../format';
import { MAX_HDR_BUCKETS } from '../limits';
import { metricLabel, pickError, type ErrorSelection } from '../metric';
import type { CompareResult, HdrDigitsInfo } from '../protocol';
import {
  allOperations,
  countAxisSeries,
  elapsedMs,
  familyOf,
  insertOperations,
  memoryBytes,
  quantileAxisSeries,
  unavailableNotes,
  unavailableText,
} from '../series';
import type { ViewOptions } from './histogram-view';

type OkResult = Extract<AlgorithmResult, { status: 'ok' }>;

/** 比較表の 1 行。値は結果の値そのまま(失敗した手法・除いた HDR は status 'error' で値が null、reason に理由) */
export interface ComparisonRow {
  readonly id: string;
  readonly label: string;
  readonly status: 'ok' | 'error';
  readonly error: number | null;
  readonly memoryBytes: number | null;
  readonly insertOperations: number | null;
  readonly queryOperations: number | null;
  readonly elapsedMs: number | null;
  readonly reason: string | null;
}

export interface CompareCharts {
  readonly charts: readonly ChartSpec[];
  readonly rows: readonly ComparisonRow[];
}

/** 処理時間の注記(8.3 の参考値の表示) */
export const ELAPSED_REFERENCE_NOTE =
  '処理時間は実行環境や実行のたびに変わる参考値です。環境によらない費用の目安は操作数です。';

const OPERATIONS_ENVIRONMENT_NOTE = '操作数は実行環境によらない費用の目安です。';

const num = (v: number): string => (Number.isInteger(v) ? formatInt(v) : formatSig3(v));

function selectionText(selection: ErrorSelection): string {
  const q = selection.pick.kind === 'max' ? '全分位点の最大' : `分位点 ${selection.pick.quantile}`;
  return `${metricLabel(selection.metric)}(${q})`;
}

// --- バケットの総数の上限で除いた HDR(8.8) ---

interface ExcludedHdr {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

function excludedHdrOf(result: CompareResult): readonly ExcludedHdr[] {
  return result.hdrPlan.excluded.map((e) => ({
    id: `hdr-d${e.significantDigits}`,
    label: `HDR Histogram(有効桁数=${e.significantDigits})`,
    reason: `バケットの総数が上限(${formatInt(MAX_HDR_BUCKETS)})を超えるため除きました(${e.reason})`,
  }));
}

function notesFor(source: SweepResult | BenchmarkResult | null, excluded: readonly ExcludedHdr[]): readonly string[] {
  return [...(source === null ? [] : unavailableNotes(source).map(unavailableText)), ...excluded.map(unavailableText)];
}

// --- 手法ごとの棒 ---

function barSeries(run: BenchmarkResult | null, value: (r: OkResult) => number | null): SeriesSpec[] {
  if (run === null) return [];
  const out: SeriesSpec[] = [];
  for (const a of run.algorithms) {
    if (a.status !== 'ok') continue;
    const y = value(a);
    if (y === null) continue;
    out.push({ id: a.id, label: a.label, kind: 'bar', points: [{ x: a.label, y }] });
  }
  return out;
}

function operationSeries(run: BenchmarkResult | null): SeriesSpec[] {
  const oks = run === null ? [] : run.algorithms.filter((a): a is OkResult => a.status === 'ok');
  if (oks.length === 0) return [];
  return [
    { id: 'insert', label: '投入', kind: 'bar', points: oks.map((a) => ({ x: a.label, y: insertOperations(a) })) },
    { id: 'query', label: '問い合わせ', kind: 'bar', points: oks.map((a) => ({ x: a.label, y: allOperations(a) - insertOperations(a) })) },
  ];
}

const METHOD_AXIS = { label: '手法', unit: '', scale: 'linear', toggleable: false } as const;

// --- 基準線と注記(相対誤差のときだけ) ---

function referenceLines(run: BenchmarkResult | null, result: CompareResult): readonly ReferenceLine[] {
  if (run === null) return [];
  const lines: ReferenceLine[] = [];
  for (const a of run.algorithms) {
    if (a.status !== 'ok') continue;
    const family = familyOf(a.id);
    if (family === 'ddsketch') {
      const alpha = a.params['alpha'];
      if (typeof alpha === 'number') lines.push({ axis: 'y', value: alpha, label: `DDSketch の保証の上限 α = ${alpha}` });
    } else if (family === 'hdr') {
      const info = digitsInfoOf(result, a);
      if (info !== undefined) {
        lines.push({
          axis: 'y',
          value: 1 / info.subBucketCount,
          label: `HDR の保証の上限 1/S(d = ${info.significantDigits})= ${formatSig3(1 / info.subBucketCount)}`,
        });
      }
    }
  }
  return lines;
}

function digitsInfoOf(result: CompareResult, a: OkResult): HdrDigitsInfo | undefined {
  const d = a.params['significantDigits'];
  return result.hdrPlan.included.find((i) => i.significantDigits === d);
}

function guaranteeNotes(run: BenchmarkResult | null, result: CompareResult): readonly string[] {
  if (run === null) return [];
  const reference = run.algorithms.find((a): a is OkResult => a.status === 'ok');
  if (reference === undefined) return [];
  const notes: string[] = [];
  for (const a of run.algorithms) {
    if (a.status !== 'ok' || familyOf(a.id) !== 'hdr') continue;
    const info = digitsInfoOf(result, a);
    if (info === undefined) continue;
    const below = reference.queries.filter((q) => q.exact < info.guaranteeFrom).map((q) => q.quantile);
    if (below.length === 0) continue;
    notes.push(
      `分位点 ${Math.min(...below)}〜${Math.max(...below)} の値は half × L = ${num(info.guaranteeFrom)} 未満で、${a.label} の 1/S の保証の対象外(絶対誤差 L/2 以下)`,
    );
  }
  return notes;
}

// --- 比較表 ---

function rowsOf(run: BenchmarkResult | null, selection: ErrorSelection, excluded: readonly ExcludedHdr[]): readonly ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const reasons = new Map(run === null ? [] : unavailableNotes(run).map((u) => [u.id, u.reason] as const));
  for (const a of run === null ? [] : run.algorithms) {
    if (a.status === 'ok') {
      rows.push({
        id: a.id,
        label: a.label,
        status: 'ok',
        error: pickError(a.queries, selection),
        memoryBytes: memoryBytes(a),
        insertOperations: insertOperations(a),
        queryOperations: allOperations(a) - insertOperations(a),
        elapsedMs: elapsedMs(a),
        reason: null,
      });
    } else {
      rows.push({
        id: a.id,
        label: a.label,
        status: 'error',
        error: null,
        memoryBytes: null,
        insertOperations: null,
        queryOperations: null,
        elapsedMs: null,
        reason: reasons.get(a.id) ?? '',
      });
    }
  }
  for (const e of excluded) {
    rows.push({
      id: e.id,
      label: e.label,
      status: 'error',
      error: null,
      memoryBytes: null,
      insertOperations: null,
      queryOperations: null,
      elapsedMs: null,
      reason: e.reason,
    });
  }
  return rows;
}

/**
 * 横断比較のグラフと比較表。手法ごとの棒(誤差・メモリ・操作数・処理時間、現在の件数の詳細の run)、
 * 分位点ごとの誤差の重ね描き、件数ごとのメモリと処理時間の 7 枚
 */
export function buildCompareCharts(result: CompareResult, _condition: CompareCondition, options: ViewOptions): CompareCharts {
  const { selection } = options;
  const run = result.detail.runs[0] ?? null;
  const excluded = excludedHdrOf(result);
  const detailNotes = notesFor(run, excluded);
  const countNotes = notesFor(result.countSweep, excluded);
  const relative = selection.metric === 'relative';
  const countAxis = { label: 'データ件数', unit: '件', scale: defaultScale('count'), toggleable: true } as const;

  const charts: ChartSpec[] = [
    {
      id: 'compare-method-error',
      title: '手法ごとの誤差',
      x: METHOD_AXIS,
      y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
      series: barSeries(run, (r) => pickError(r.queries, selection)),
      referenceLines: [],
      notes: detailNotes,
      summary: `現在のデータ件数で、手法ごとの${selectionText(selection)}を棒で比べます。厳密解の誤差は 0 です。`,
    },
    {
      id: 'compare-method-memory',
      title: '手法ごとのメモリ見積もり',
      x: METHOD_AXIS,
      y: { label: 'メモリ見積もり', unit: 'バイト', scale: defaultScale('memory'), toggleable: true },
      series: barSeries(run, memoryBytes),
      referenceLines: [],
      notes: detailNotes,
      summary: '現在のデータ件数で、値の投入後のメモリ見積もりを手法ごとに棒で比べます。',
    },
    {
      id: 'compare-method-operations',
      title: '手法ごとの操作数',
      x: METHOD_AXIS,
      y: { label: '操作数', unit: '回', scale: defaultScale('operations'), toggleable: true },
      series: operationSeries(run),
      referenceLines: [],
      notes: detailNotes,
      summary: `現在のデータ件数で、投入と問い合わせの操作数(それぞれ ${OPERATIONS_INSERT_BREAKDOWN})を手法ごとに棒で比べます。${OPERATIONS_ENVIRONMENT_NOTE}`,
    },
    {
      id: 'compare-method-elapsed',
      title: '手法ごとの処理時間(参考値)',
      x: METHOD_AXIS,
      y: { label: '処理時間', unit: 'ミリ秒', scale: defaultScale('time'), toggleable: true },
      series: barSeries(run, elapsedMs),
      referenceLines: [],
      notes: [ELAPSED_REFERENCE_NOTE, ...detailNotes],
      summary: `現在のデータ件数で、処理時間(${ELAPSED_BREAKDOWN})を手法ごとに棒で比べます。処理時間は実行環境や実行のたびに変わる参考値です。`,
    },
    {
      id: 'compare-quantile-error',
      title: `分位点ごとの${metricLabel(selection.metric)}`,
      x: { label: '分位点', unit: '', scale: defaultScale('quantile'), toggleable: true },
      y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
      series: run === null ? [] : quantileAxisSeries(run, selection.metric),
      referenceLines: relative ? referenceLines(run, result) : [],
      notes: [...(relative ? guaranteeNotes(run, result) : []), ...detailNotes],
      summary: `分位点ごとの${metricLabel(selection.metric)}を、選んだ手法の系列として重ねて示します。${
        relative
          ? '破線の基準線は、DDSketch の保証の上限 α と、HDR の保証の上限 1/S(S は副バケット数)です。HDR の保証は、値が half × L 以上のときに成り立ちます。'
          : ''
      }`,
    },
    {
      id: 'compare-count-memory',
      title: 'データ件数ごとのメモリ見積もり',
      x: countAxis,
      y: { label: 'メモリ見積もり', unit: 'バイト', scale: defaultScale('memory'), toggleable: true },
      series: countAxisSeries(result.countSweep, memoryBytes),
      referenceLines: [],
      notes: countNotes,
      summary: 'データ件数を変えたときの、値の投入後のメモリ見積もりを手法ごとの系列で示します。',
    },
    {
      id: 'compare-count-elapsed',
      title: 'データ件数ごとの処理時間(参考値)',
      x: countAxis,
      y: { label: '処理時間', unit: 'ミリ秒', scale: defaultScale('time'), toggleable: true },
      series: countAxisSeries(result.countSweep, elapsedMs),
      referenceLines: [],
      notes: [ELAPSED_REFERENCE_NOTE, ...countNotes],
      summary: `データ件数を変えたときの処理時間(${ELAPSED_BREAKDOWN})を手法ごとの系列で示します。処理時間は実行環境や実行のたびに変わる参考値です。`,
    },
  ];
  return { charts, rows: rowsOf(run, selection, excluded) };
}
