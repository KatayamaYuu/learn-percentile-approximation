// ストリーミング分位点のページの表示(5.3〜5.9)。StreamingPageResult → ChartSpec[] と内部状態の表示モデルの純粋な変換。
// 上流の結果の値をそのまま読み、指標を計算し直さない(7.7)。
import type { AlgorithmResult, BenchmarkResult } from '../../../core';
import type { GkState, KllState, TDigestState } from '../../../streaming';
import { defaultScale, type ChartSpec, type ReferenceLine, type SeriesSpec, type TableModel } from '../chart-spec';
import type { StreamingMethod, StreamingPageCondition } from '../conditions';
import { formatInt, formatSig3 } from '../format';
import { metricLabel, pickError, type ErrorSelection } from '../metric';
import type { StreamingInspection, StreamingPageResult } from '../protocol';
import {
  familyOf,
  memoryBytes,
  paramAxisSeries,
  quantileAxisSeries,
  tradeoffSeries,
  unavailableNotes,
  unavailableText,
  variantOf,
} from '../series';
import type { ViewOptions } from './histogram-view';

/** 内部状態の表に載せる行数の上限。これを超えたら先頭と末尾だけにする */
export const STATE_TABLE_LIMIT = 200;
const EDGE_ROWS = STATE_TABLE_LIMIT / 2;

export interface TableTruncation {
  readonly total: number;
  readonly head: number;
  readonly tail: number;
  readonly notice: string;
}

export interface LimitedRows {
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
  readonly truncation: TableTruncation | null;
}

/** 行数が上限(200)を超えたら先頭 100 行と末尾 100 行だけにし、省略の情報を返す。入力は変更しない */
export function limitTableRows(rows: readonly (readonly string[])[]): LimitedRows {
  if (rows.length <= STATE_TABLE_LIMIT) return { rows, truncated: false, truncation: null };
  return {
    rows: [...rows.slice(0, EDGE_ROWS), ...rows.slice(rows.length - EDGE_ROWS)],
    truncated: true,
    truncation: {
      total: rows.length,
      head: EDGE_ROWS,
      tail: EDGE_ROWS,
      notice: `先頭 ${formatInt(EDGE_ROWS)} 行と末尾 ${formatInt(EDGE_ROWS)} 行を表示(全 ${formatInt(rows.length)} 行)`,
    },
  };
}

export interface InspectionView {
  readonly chart: ChartSpec;
  /** 行は上限(200)を超えたとき先頭と末尾だけ。図は全点を描く */
  readonly table: TableModel;
  readonly truncated: boolean;
  readonly truncation: TableTruncation | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

// --- 手法の選択と表示名 ---

const METHOD_LABEL: Readonly<Record<StreamingMethod, string>> = { gk: 'GK', kll: 'KLL', tdigest: 't-digest' };

/** 系列の識別('gk' / 'kll' / 't-digest のスケール関数ごと') → 表示名 */
function groupLabel(key: string): string {
  if (key === 'gk') return 'GK';
  if (key === 'kll') return 'KLL';
  return key.startsWith('tdigest-') ? `t-digest(${key.slice('tdigest-'.length)})` : key;
}

function isSelected(id: string, methods: readonly StreamingMethod[]): boolean {
  const f = familyOf(id);
  return (f === 'gk' || f === 'kll' || f === 'tdigest') && methods.includes(f);
}

/** 手法ごとの系列の識別。選んでいない手法と厳密解は null */
function groupKeyFor(methods: readonly StreamingMethod[], only?: StreamingMethod) {
  return (r: AlgorithmResult): string | null => {
    if (!isSelected(r.id, methods)) return null;
    const f = familyOf(r.id);
    if (only !== undefined && f !== only) return null;
    return f === 'tdigest' ? variantOf(r.id) : f;
  };
}

function relabel(series: readonly SeriesSpec[]): readonly SeriesSpec[] {
  return series.map((s) => ({ ...s, label: groupLabel(s.id) }));
}

function notesOf(source: BenchmarkResult | null, methods: readonly StreamingMethod[], only?: StreamingMethod): readonly string[] {
  if (source === null) return [];
  return unavailableNotes(source)
    .filter((u) => isSelected(u.id, methods) && (only === undefined || familyOf(u.id) === only))
    .map(unavailableText);
}

function selectionText(selection: ErrorSelection): string {
  const q = selection.pick.kind === 'max' ? '全分位点の最大' : `分位点 ${selection.pick.quantile}`;
  return `${metricLabel(selection.metric)}(${q})`;
}

/** GK を表示していて指標が順位誤差のときだけ、保証の上限 ε の基準線(5.9) */
function epsilonLines(
  condition: StreamingPageCondition,
  selection: ErrorSelection,
  gkShown: boolean,
): readonly ReferenceLine[] {
  if (!gkShown || selection.metric !== 'rank') return [];
  return [{ axis: 'y', value: condition.epsilon, label: `GK の保証の上限 ε = ${condition.epsilon}` }];
}

// --- 結果の取り出し ---

const firstRunOf = (cases: PageCases, order?: string): BenchmarkResult | null =>
  (order === undefined ? cases[0] : cases.find((c) => c.order === order))?.sweep.runs[0] ?? null;
type PageCases = StreamingPageResult['detail']['cases'];

// --- グラフ ---

const PARAM_AXIS: Readonly<Record<StreamingMethod, { key: string; label: string; unit: string; summary: string }>> = {
  gk: { key: 'epsilon', label: 'ε(許容する順位誤差)', unit: '', summary: 'ε' },
  kll: { key: 'k', label: 'k(容量の基準)', unit: '', summary: 'k' },
  tdigest: { key: 'compression', label: 'δ(圧縮度)', unit: '', summary: 'δ' },
};

function paramCharts(
  result: StreamingPageResult,
  condition: StreamingPageCondition,
  selection: ErrorSelection,
  method: StreamingMethod,
): readonly ChartSpec[] {
  const run = firstRunOf(result.paramSweep.cases);
  const axis = PARAM_AXIS[method];
  const name = METHOD_LABEL[method];
  const groupKey = groupKeyFor(condition.methods, method);
  const make = (value: Parameters<typeof paramAxisSeries>[3]): readonly SeriesSpec[] =>
    run === null ? [] : relabel(paramAxisSeries(run, groupKey, axis.key, value));
  const xAxis = { label: axis.label, unit: axis.unit, scale: defaultScale('count'), toggleable: true } as const;
  const notes = notesOf(run, condition.methods, method);
  return [
    {
      id: `streaming-${method}-param-error`,
      title: `${name}の${axis.summary}ごとの誤差`,
      x: xAxis,
      y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
      series: make((r) => pickError(r.queries, selection)),
      referenceLines: epsilonLines(condition, selection, method === 'gk'),
      notes,
      summary: `${name}の ${axis.summary} を変えたときの${selectionText(selection)}を示します。${axis.summary} の値ごとに 1 点です。`,
    },
    {
      id: `streaming-${method}-param-memory`,
      title: `${name}の${axis.summary}ごとのメモリ見積もり`,
      x: xAxis,
      y: { label: 'メモリ見積もり', unit: 'バイト', scale: defaultScale('memory'), toggleable: true },
      series: make(memoryBytes),
      referenceLines: [],
      notes,
      summary: `${name}の ${axis.summary} を変えたときの、値の投入後のメモリ見積もりを示します。`,
    },
  ];
}

/** メモリ × 誤差: 選んだ手法ごとの系列(5.4) */
function tradeoffChart(
  result: StreamingPageResult,
  condition: StreamingPageCondition,
  selection: ErrorSelection,
): ChartSpec {
  const run = firstRunOf(result.paramSweep.cases);
  return {
    id: 'streaming-tradeoff',
    title: 'メモリ見積もりと誤差の関係',
    x: { label: 'メモリ見積もり', unit: 'バイト', scale: defaultScale('memory'), toggleable: true },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series: run === null ? [] : relabel(tradeoffSeries(run, selection, groupKeyFor(condition.methods))),
    referenceLines: epsilonLines(condition, selection, condition.methods.includes('gk')),
    notes: notesOf(run, condition.methods),
    summary: `パラメータを変えたときの、メモリ見積もり(横軸)と${selectionText(selection)}(縦軸)の関係を手法ごとに示します。左下に寄るほど、少ないメモリで正確です。`,
  };
}

/** 分位点 × 誤差: 詳細の random・最初の試行(5.5) */
function quantileChart(
  result: StreamingPageResult,
  condition: StreamingPageCondition,
  selection: ErrorSelection,
): ChartSpec {
  const run = firstRunOf(result.detail.cases, 'random');
  return {
    id: 'streaming-quantile-error',
    title: '分位点ごとの誤差',
    x: { label: '分位点', unit: '', scale: defaultScale('quantile'), toggleable: true },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series: run === null ? [] : quantileAxisSeries(run, selection.metric, (id) => isSelected(id, condition.methods)),
    referenceLines: epsilonLines(condition, selection, condition.methods.includes('gk')),
    notes: notesOf(run, condition.methods),
    summary: `ランダムな順序で投入したときの${metricLabel(selection.metric)}を、分位点ごと・手法ごとに示します。裾の分位点(0.001、0.999 など)と中央の分位点を比べられます。`,
  };
}

const ORDER_LABEL: Readonly<Record<string, string>> = { random: 'ランダム', ascending: '昇順', descending: '降順' };

/** 挿入順序ごとの誤差の棒。同じ値の集まりを並べ替えた結果を並べる(5.6) */
function orderChart(
  result: StreamingPageResult,
  condition: StreamingPageCondition,
  selection: ErrorSelection,
): ChartSpec {
  const byId = new Map<string, { label: string; points: { x: string; y: number }[] }>();
  const noteSet = new Map<string, string>();
  for (const c of result.detail.cases) {
    const run = c.sweep.runs[0];
    if (run === undefined) continue;
    for (const a of run.algorithms) {
      if (!isSelected(a.id, condition.methods)) continue;
      if (a.status !== 'ok') continue;
      const y = pickError(a.queries, selection);
      if (y === null) continue;
      let entry = byId.get(a.id);
      if (entry === undefined) {
        entry = { label: a.label, points: [] };
        byId.set(a.id, entry);
      }
      entry.points.push({ x: ORDER_LABEL[c.order] ?? c.order, y });
    }
    for (const u of unavailableNotes(run)) {
      if (isSelected(u.id, condition.methods) && !noteSet.has(u.id)) noteSet.set(u.id, unavailableText(u));
    }
  }
  return {
    id: 'streaming-order-error',
    title: '挿入順序ごとの誤差',
    x: { label: '挿入順序', unit: '', scale: 'linear', toggleable: false },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series: [...byId].map(([id, e]) => ({ id, label: e.label, kind: 'bar' as const, points: e.points })),
    referenceLines: epsilonLines(condition, selection, condition.methods.includes('gk')),
    notes: [...noteSet.values()],
    summary: `同じ値の集まりを、ランダム・昇順・降順に並べ替えて投入したときの${selectionText(selection)}を手法ごとに並べます。`,
  };
}

/** KLL の試行ごとの誤差(試行が 2 回以上のとき。5.7)。試行の番号は 1 から、シードは備考に出す */
function trialChart(result: StreamingPageResult, condition: StreamingPageCondition, selection: ErrorSelection): ChartSpec {
  const runs = result.detail.cases.find((c) => c.order === 'random')?.sweep.runs ?? [];
  const byId = new Map<string, { label: string; points: { x: number; y: number; detail: string }[] }>();
  runs.forEach((run, i) => {
    for (const a of run.algorithms) {
      if (a.status !== 'ok' || familyOf(a.id) !== 'kll') continue;
      const y = pickError(a.queries, selection);
      if (y === null) continue;
      let entry = byId.get(a.id);
      if (entry === undefined) {
        entry = { label: a.label, points: [] };
        byId.set(a.id, entry);
      }
      entry.points.push({ x: i + 1, y, detail: `シード ${run.seed}` });
    }
  });
  return {
    id: 'streaming-kll-trials',
    title: 'KLL の試行ごとの誤差',
    x: { label: '試行', unit: '', scale: 'linear', toggleable: false },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series: [...byId].map(([id, e]) => ({ id, label: e.label, kind: 'scatter' as const, points: e.points })),
    referenceLines: [],
    notes: notesOf(runs[0] ?? null, condition.methods, 'kll'),
    summary: `KLL は乱数を使うため、試行(シード)ごとに誤差が変わります。${formatInt(condition.trials)} 回の試行の${selectionText(selection)}を並べ、ばらつきを示します。`,
  };
}

// --- 内部状態 ---

const num = (v: number): string => (Number.isInteger(v) ? formatInt(v) : formatSig3(v));
const orDash = (v: number | null): string => (v === null ? '—' : num(v));

function finish(
  chart: ChartSpec,
  caption: string,
  columns: readonly string[],
  allRows: readonly (readonly string[])[],
  facts: InspectionView['facts'],
): InspectionView {
  const limited = limitTableRows(allRows);
  return { chart, table: { caption, columns, rows: limited.rows }, truncated: limited.truncated, truncation: limited.truncation, facts };
}

function gkView(state: GkState): InspectionView {
  const chart: ChartSpec = {
    id: 'streaming-inspect-gk',
    title: 'GK のタプル(値と順位の幅)',
    x: { label: '値', unit: '', scale: 'log', toggleable: true },
    y: { label: 'g + 順位の幅 Δ', unit: '', scale: 'linear', toggleable: true },
    series: [
      {
        id: 'gk-tuples',
        label: 'タプル(g + Δ)',
        kind: 'scatter',
        points: state.tuples.map((t, i) => ({ x: t.value, y: t.g + t.delta, detail: `番号 ${i + 1}、g = ${t.g}、Δ = ${t.delta}` })),
      },
    ],
    referenceLines: [],
    notes: [],
    summary: `GK が保持している ${formatInt(state.tuples.length)} 個のタプルを、値(横軸)と g + 順位の幅 Δ(縦軸)で示します。g + Δ が大きい値の周りほど、順位の不確かさが大きくなります。`,
  };
  const rows = state.tuples.map((t, i) => [String(i + 1), num(t.value), num(t.g), num(t.delta), num(t.g + t.delta)]);
  return finish(chart, 'GK のタプル', ['番号', '値', 'g', '順位の幅 Δ', 'g + Δ'], rows, [
    { label: '件数', value: formatInt(state.count) },
    { label: 'タプル数', value: formatInt(state.tuples.length) },
    { label: 'ε', value: String(state.epsilon) },
  ]);
}

function kllView(state: KllState): InspectionView {
  const label = (l: { level: number }): string => `段 ${l.level}`;
  const chart: ChartSpec = {
    id: 'streaming-inspect-kll',
    title: 'KLL の段ごとの保持数と容量',
    x: { label: '段', unit: '', scale: 'linear', toggleable: false },
    y: { label: '要素数', unit: '個', scale: 'linear', toggleable: true },
    series: [
      {
        id: 'kll-retained',
        label: '保持数',
        kind: 'bar',
        points: state.levels.map((l) => ({ x: label(l), y: l.values.length, detail: `重み ${formatInt(l.weight)}` })),
      },
      {
        id: 'kll-capacity',
        label: '容量',
        kind: 'bar',
        points: state.levels.map((l) => ({ x: label(l), y: l.capacity, detail: `重み ${formatInt(l.weight)}` })),
      },
    ],
    referenceLines: [],
    notes: [],
    summary: `KLL の ${formatInt(state.levels.length)} 段それぞれが保持している要素の数と、その段の容量を示します。上の段の要素 1 個は、より多くの件数を代表します。`,
  };
  const rows = state.levels.map((l) => [String(l.level), formatInt(l.weight), formatInt(l.capacity), formatInt(l.values.length)]);
  const retained = state.levels.reduce((n, l) => n + l.values.length, 0);
  return finish(chart, 'KLL の段', ['段', '重み', '容量', '保持数'], rows, [
    { label: '件数', value: formatInt(state.count) },
    { label: 'k', value: formatInt(state.k) },
    { label: '段数', value: formatInt(state.levels.length) },
    { label: '保持数の合計', value: formatInt(retained) },
    { label: '圧縮の回数', value: formatInt(state.compactions) },
  ]);
}

function tdigestView(state: TDigestState): InspectionView {
  const chart: ChartSpec = {
    id: 'streaming-inspect-tdigest',
    title: 't-digest の centroid(平均値と重み)',
    x: { label: '平均値', unit: '', scale: 'log', toggleable: true },
    y: { label: '重み', unit: '件', scale: defaultScale('count'), toggleable: true },
    series: [
      {
        id: 'tdigest-centroids',
        label: 'centroid',
        kind: 'scatter',
        points: state.centroids.map((c, i) => ({ x: c.mean, y: c.weight, detail: `番号 ${i + 1}` })),
      },
    ],
    referenceLines: [],
    notes: [],
    summary: `t-digest の ${formatInt(state.centroids.length)} 個の centroid を、平均値(横軸)と重み(縦軸)で示します。裾の centroid ほど重みが小さく、細かく分かれています。`,
  };
  const rows = state.centroids.map((c, i) => [String(i + 1), num(c.mean), num(c.weight)]);
  return finish(chart, 't-digest の centroid', ['番号', '平均値', '重み'], rows, [
    { label: '件数', value: formatInt(state.count) },
    { label: 'δ', value: num(state.compression) },
    { label: 'スケール関数', value: state.scale },
    { label: 'centroid 数', value: formatInt(state.centroids.length) },
    { label: 'バッファ件数', value: formatInt(state.buffered) },
    { label: '最小値', value: orDash(state.min) },
    { label: '最大値', value: orDash(state.max) },
  ]);
}

function inspectionView(inspection: StreamingInspection): InspectionView {
  switch (inspection.algorithm) {
    case 'gk':
      return gkView(inspection.state);
    case 'kll':
      return kllView(inspection.state);
    case 'tdigest':
      return tdigestView(inspection.state);
  }
}

/** ストリーミングのページのグラフと内部状態。手法ごとのパラメータ × 誤差・メモリ、メモリ × 誤差、分位点 × 誤差、順序、(試行 ≥ 2 の)KLL の試行 */
export function buildStreamingCharts(
  result: StreamingPageResult,
  condition: StreamingPageCondition,
  options: ViewOptions,
): { readonly charts: readonly ChartSpec[]; readonly inspection: InspectionView } {
  const { selection } = options;
  const methods = (['gk', 'kll', 'tdigest'] as const).filter((m) => condition.methods.includes(m));
  const charts: ChartSpec[] = [
    ...methods.flatMap((m) => paramCharts(result, condition, selection, m)),
    tradeoffChart(result, condition, selection),
    quantileChart(result, condition, selection),
    orderChart(result, condition, selection),
  ];
  if (condition.trials >= 2 && condition.methods.includes('kll')) charts.push(trialChart(result, condition, selection));
  return { charts, inspection: inspectionView(result.inspection) };
}
