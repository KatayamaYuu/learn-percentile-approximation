// 相対誤差型のページの表示(6.3〜6.8)。RelativePageResult → ChartSpec[] と縮約・バケットの表示モデルの純粋な変換。
// 上流の結果の値をそのまま読み、指標を計算し直さない(7.7)。
import type { AlgorithmResult, BenchmarkResult, SweepResult } from '../../../core';
import { defaultScale, OPERATIONS_TOTAL_BREAKDOWN, type ChartSpec, type ReferenceLine, type SeriesSpec } from '../chart-spec';
import type { RelativePageCondition } from '../conditions';
import { formatInt, formatSig3 } from '../format';
import { MAX_HDR_BUCKETS } from '../limits';
import { metricLabel, pickError, type ErrorSelection } from '../metric';
import type { HdrDigitsInfo, RelativePageResult } from '../protocol';
import {
  allOperations,
  countAxisSeries,
  familyOf,
  memoryBytes,
  paramAxisSeries,
  quantileAxisSeries,
  unavailableNotes,
  unavailableText,
} from '../series';
import type { ViewOptions } from './histogram-view';
import { limitTableRows, type InspectionView } from './streaming-view';

export interface CollapseNotice {
  readonly collapsed: boolean;
  /** 縮約の影響の上限(DDSketchSnapshot.collapsedUpperBound)。縮約なしは null */
  readonly upperBound: number | null;
  readonly collapseCount: number;
  /** 利用者に見せる通知の文 */
  readonly message: string;
}

export interface RelativeCharts {
  readonly charts: readonly ChartSpec[];
  readonly inspection: InspectionView | { readonly rejected: string };
  /** DDSketch を観察しているときだけ。HDR の観察では null */
  readonly collapse: CollapseNotice | null;
  /** HDR の範囲と有効桁数の通知。HDR を選んでいないときは空(6.4) */
  readonly hdrNotices: readonly string[];
}

type Method = RelativePageCondition['methods'][number];

const DD_LABEL = 'DDSketch';
const HDR_LABEL = 'HDR Histogram';

function isSelected(id: string, methods: readonly Method[]): boolean {
  const f = familyOf(id);
  return (f === 'ddsketch' || f === 'hdr') && methods.includes(f);
}

function selectionText(selection: ErrorSelection): string {
  const q = selection.pick.kind === 'max' ? '全分位点の最大' : `分位点 ${selection.pick.quantile}`;
  return `${metricLabel(selection.metric)}(${q})`;
}

const firstRun = (r: { readonly cases: readonly { readonly sweep: SweepResult }[] }): BenchmarkResult | null =>
  r.cases[0]?.sweep.runs[0] ?? null;

function selectedNotes(source: SweepResult | BenchmarkResult | null, methods: readonly Method[], only?: Method): readonly string[] {
  if (source === null) return [];
  return unavailableNotes(source)
    .filter((u) => isSelected(u.id, methods) && (only === undefined || familyOf(u.id) === only))
    .map(unavailableText);
}

// --- HDR の通知 ---

function hdrNoticesOf(result: RelativePageResult): readonly string[] {
  const plan = result.hdrPlan;
  const notices: string[] = plan.excluded.map(
    (e) =>
      `有効桁数 ${e.significantDigits}: バケットの総数が上限(${formatInt(MAX_HDR_BUCKETS)})を超えるため除きました(${e.reason})`,
  );
  // 基準の有効桁数は、現在の有効桁数を含む「実行した有効桁数の最大値」と比べる(格子の最大値とは比べない)
  const ran = plan.included.map((i) => i.significantDigits);
  if (plan.mode === 'auto' && plan.referenceDigits !== null && ran.length > 0 && plan.referenceDigits < Math.max(...ran)) {
    notices.push(
      `バケットの総数の上限のため、範囲の下限 L は有効桁数 ${plan.referenceDigits} を基準に決めました。それより大きい有効桁数では、最小値付近の値が保証の対象外になりえます`,
    );
  }
  if (plan.lowestClamped) {
    notices.push(
      `データの値の幅が広すぎるため、範囲の下限 L を ${formatSig3(plan.range.lowest)} に切り詰めました。L より小さい値は HDR の範囲外です`,
    );
  }
  return notices;
}

function currentDigitsInfo(result: RelativePageResult, condition: RelativePageCondition): HdrDigitsInfo | undefined {
  return result.hdrPlan.included.find((i) => i.significantDigits === condition.significantDigits);
}

// --- 分位点 × 相対誤差 ---

function guaranteeNote(detail: BenchmarkResult | null, info: HdrDigitsInfo | undefined): readonly string[] {
  if (detail === null || info === undefined) return [];
  const exact = detail.algorithms.find((a) => a.status === 'ok' && familyOf(a.id) === 'exact');
  if (exact === undefined || exact.status !== 'ok') return [];
  const below = exact.queries.filter((q) => q.exact < info.guaranteeFrom).map((q) => q.quantile);
  if (below.length === 0) return [];
  return [
    `分位点 ${Math.min(...below)}〜${Math.max(...below)} の値は half × L = ${formatSig3(info.guaranteeFrom)} 未満で、HDR の 1/S の保証の対象外(絶対誤差 L/2 以下)`,
  ];
}

function quantileChart(
  result: RelativePageResult,
  condition: RelativePageCondition,
  selection: ErrorSelection,
): ChartSpec {
  const run = firstRun(result.detail);
  const relative = selection.metric === 'relative';
  const info = currentDigitsInfo(result, condition);
  const lines: ReferenceLine[] = [];
  if (relative && condition.methods.includes('ddsketch')) {
    lines.push({ axis: 'y', value: condition.alpha, label: `DDSketch の保証の上限 α = ${condition.alpha}` });
  }
  if (relative && condition.methods.includes('hdr') && info !== undefined) {
    lines.push({
      axis: 'y',
      value: 1 / info.subBucketCount,
      label: `HDR の保証の上限 1/S(d = ${info.significantDigits})= ${formatSig3(1 / info.subBucketCount)}`,
    });
  }
  const hdrNote = relative && condition.methods.includes('hdr') ? guaranteeNote(run, info) : [];
  return {
    id: 'relative-quantile-error',
    title: `分位点ごとの${metricLabel(selection.metric)}`,
    x: { label: '分位点', unit: '', scale: defaultScale('quantile'), toggleable: true },
    y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
    series: run === null ? [] : quantileAxisSeries(run, selection.metric, (id) => isSelected(id, condition.methods)),
    referenceLines: lines,
    notes: [...hdrNote, ...selectedNotes(run, condition.methods)],
    summary: `分位点ごとの${metricLabel(selection.metric)}を、DDSketch と HDR Histogram で示します。破線の基準線は、DDSketch の保証の上限 α と、HDR の保証の上限 1/S(S は副バケット数)です。HDR の保証は、値が half × L 以上のときに成り立ちます。`,
  };
}

// --- α ごと・有効桁数ごと ---

type ParamKind = 'ddsketch' | 'hdr';

const PARAM: Readonly<Record<ParamKind, { key: string; label: string; summary: string; name: string; scale: 'error' | 'count' }>> = {
  ddsketch: { key: 'alpha', label: 'α(相対誤差の許容値)', summary: 'α', name: DD_LABEL, scale: 'error' },
  hdr: { key: 'significantDigits', label: '有効桁数', summary: '有効桁数', name: HDR_LABEL, scale: 'count' },
};

function paramSeries(
  run: BenchmarkResult | null,
  kind: ParamKind,
  value: (r: Extract<AlgorithmResult, { status: 'ok' }>) => number | null,
): SeriesSpec[] {
  if (run === null) return [];
  return paramAxisSeries(run, (r) => (familyOf(r.id) === kind ? kind : null), PARAM[kind].key, value).map((s) => ({
    ...s,
    label: PARAM[kind].name,
  }));
}

/** バケット数: 実験のバケットの統計(bucketCount)をそのまま読む。拒否された設定は点にしない */
function bucketCountSeries(result: RelativePageResult, run: BenchmarkResult | null, kind: ParamKind): SeriesSpec[] {
  const stats = result.paramSweep.cases[0]?.bucketStats ?? [];
  if (run === null) return [];
  const points: { x: number; y: number; detail: string }[] = [];
  for (const s of stats) {
    if (s.status !== 'ok' || familyOf(s.sketchId) !== kind) continue;
    const a = run.algorithms.find((x) => x.id === s.sketchId);
    const x = a?.params[PARAM[kind].key];
    if (a === undefined || typeof x !== 'number') continue;
    points.push({ x, y: s.bucketCount, detail: a.label });
  }
  points.sort((a, b) => a.x - b.x);
  return points.length === 0 ? [] : [{ id: kind, label: PARAM[kind].name, kind: 'line', points }];
}

function paramCharts(
  result: RelativePageResult,
  condition: RelativePageCondition,
  selection: ErrorSelection,
  kind: ParamKind,
  hdrNotices: readonly string[],
): readonly ChartSpec[] {
  const run = firstRun(result.paramSweep);
  const p = PARAM[kind];
  const prefix = kind === 'ddsketch' ? 'relative-alpha' : 'relative-digits';
  const xAxis = { label: p.label, unit: '', scale: kind === 'ddsketch' ? defaultScale('error') : 'linear', toggleable: true } as const;
  const notes = [...(kind === 'hdr' ? hdrNotices : []), ...selectedNotes(run, condition.methods, kind)];
  const errorSeries: SeriesSpec[] = paramSeries(run, kind, (r) => pickError(r.queries, selection));
  if (kind === 'hdr' && selection.metric === 'relative') {
    // 有効桁数ごとに保証の上限 1/S が変わるので、基準線ではなく破線の系列で重ねる
    errorSeries.push({
      id: 'hdr-guarantee-bound',
      label: 'HDR の保証の上限 1/S',
      kind: 'line',
      dashed: true,
      points: result.hdrPlan.included.map((i) => ({ x: i.significantDigits, y: 1 / i.subBucketCount, detail: `S = ${formatInt(i.subBucketCount)}` })),
    });
  }
  return [
    {
      id: `${prefix}-error`,
      title: `${p.summary}ごとの${metricLabel(selection.metric)}`,
      x: xAxis,
      y: { label: metricLabel(selection.metric), unit: '', scale: defaultScale('error'), toggleable: true },
      series: errorSeries,
      referenceLines: [],
      notes,
      summary: `${p.name}の ${p.summary} を変えたときの${selectionText(selection)}を示します。${
        kind === 'hdr' ? '破線は、有効桁数ごとの保証の上限 1/S です。' : ''
      }`,
    },
    {
      id: `${prefix}-buckets`,
      title: `${p.summary}ごとのバケット数`,
      x: xAxis,
      y: { label: 'バケット数', unit: '個', scale: defaultScale('count'), toggleable: true },
      series: bucketCountSeries(result, run, kind),
      referenceLines: [],
      notes,
      summary: `${p.name}の ${p.summary} を変えたときのバケット数を示します。${
        kind === 'ddsketch' ? 'DDSketch は保持範囲の長さです。' : 'HDR はバケットの総数です。'
      }`,
    },
    {
      id: `${prefix}-memory`,
      title: `${p.summary}ごとのメモリ見積もり`,
      x: xAxis,
      y: { label: 'メモリ見積もり', unit: 'バイト', scale: defaultScale('memory'), toggleable: true },
      series: paramSeries(run, kind, (r) => memoryBytes(r)),
      referenceLines: [],
      notes,
      summary: `${p.name}の ${p.summary} を変えたときの、値の投入後のメモリ見積もりを示します。`,
    },
  ];
}

// --- 件数ごと ---

function countChart(
  result: RelativePageResult,
  condition: RelativePageCondition,
  spec: { id: string; title: string; yLabel: string; yUnit: string; quantity: 'operations' | 'memory'; breakdown: string },
  value: Parameters<typeof countAxisSeries>[1],
): ChartSpec {
  const sweep = result.countSweep.cases[0]?.sweep ?? null;
  return {
    id: spec.id,
    title: spec.title,
    x: { label: 'データ件数', unit: '件', scale: defaultScale('count'), toggleable: true },
    y: { label: spec.yLabel, unit: spec.yUnit, scale: defaultScale(spec.quantity), toggleable: true },
    series:
      sweep === null
        ? []
        : countAxisSeries(sweep, value, (id) => familyOf(id) === 'exact' || isSelected(id, condition.methods)),
    referenceLines: [],
    notes: selectedNotes(sweep, condition.methods),
    summary: `データ件数を変えたときの${spec.yLabel}を、厳密解 2 方式と選んだ手法で比べます。${spec.breakdown}`,
  };
}

// --- バケットの状態 ---

const num = (v: number): string => (Number.isInteger(v) ? formatInt(v) : formatSig3(v));

interface BucketRows {
  readonly index: number;
  readonly lower: number;
  readonly upper: number;
  readonly representative: number;
  readonly count: number;
}

function bucketView(
  id: string,
  title: string,
  buckets: readonly BucketRows[],
  lines: readonly ReferenceLine[],
  notes: readonly string[],
  facts: InspectionView['facts'],
  summary: string,
): InspectionView {
  const chart: ChartSpec = {
    id,
    title,
    x: { label: '代表値', unit: '', scale: 'log', toggleable: true },
    y: { label: '件数', unit: '件', scale: 'linear', toggleable: true },
    series: [
      {
        id: `${id}-buckets`,
        label: 'バケットの件数',
        kind: 'scatter',
        points: buckets.map((b) => ({
          x: b.representative,
          y: b.count,
          detail: `番号 ${b.index}、${num(b.lower)} 〜 ${num(b.upper)}`,
        })),
      },
    ],
    referenceLines: lines,
    notes,
    summary,
  };
  const limited = limitTableRows(
    buckets.map((b) => [String(b.index), num(b.lower), num(b.upper), num(b.representative), formatInt(b.count)]),
  );
  return {
    chart,
    table: { caption: title, columns: ['番号', '下側の境界', '上側の境界', '代表値', '件数'], rows: limited.rows },
    truncated: limited.truncated,
    truncation: limited.truncation,
    facts,
  };
}

function collapseNoticeOf(upperBound: number | null, collapsed: boolean, count: number): CollapseNotice {
  return {
    collapsed,
    upperBound,
    collapseCount: count,
    message:
      collapsed && upperBound !== null
        ? `縮約が起きました(${formatInt(count)} 回)。${formatSig3(upperBound)} 以下の値の推定は、相対誤差の保証が成り立ちません。`
        : '縮約は起きていません。保持している範囲のすべてで相対誤差の保証が成り立ちます。',
  };
}

function inspectionOf(
  result: RelativePageResult,
  condition: RelativePageCondition,
): { inspection: RelativeCharts['inspection']; collapse: CollapseNotice | null } {
  const insp = result.inspection;
  if ('rejected' in insp) return { inspection: { rejected: insp.reason }, collapse: null };
  if (insp.algorithm === 'ddsketch') {
    const s = insp.snapshot;
    const collapse = collapseNoticeOf(s.collapsedUpperBound, s.collapsed, s.collapseCount);
    const lines: ReferenceLine[] =
      s.collapsed && s.collapsedUpperBound !== null
        ? [
            {
              axis: 'x',
              value: s.collapsedUpperBound,
              label: `縮約の影響の上限 ${formatSig3(s.collapsedUpperBound)}(これ以下は保証なし)`,
            },
          ]
        : [];
    const view = bucketView(
      'relative-inspect-ddsketch',
      'DDSketch のバケットの状態',
      s.buckets,
      lines,
      [collapse.message],
      [
        { label: '件数', value: formatInt(s.totalCount) },
        { label: 'α', value: String(s.alpha) },
        { label: 'γ', value: formatSig3(s.gamma) },
        { label: 'バケット数の上限', value: formatInt(s.maxBuckets) },
        { label: '保持範囲の長さ', value: formatInt(s.span) },
        { label: '件数が 1 以上のバケット', value: formatInt(s.nonEmptyBuckets) },
        { label: '縮約', value: s.collapsed ? 'あり' : 'なし' },
        { label: '縮約の回数', value: formatInt(s.collapseCount) },
        { label: '縮約の影響の上限', value: s.collapsedUpperBound === null ? '—' : num(s.collapsedUpperBound) },
      ],
      `DDSketch のバケットを、代表値(横軸、対数)と件数(縦軸)で示します。値が大きくなるほどバケットの幅が比例して広がります。${
        s.collapsed ? '縦の破線より左は、縮約の影響で相対誤差の保証が成り立ちません。' : ''
      }`,
    );
    return { inspection: view, collapse };
  }
  const s = insp.snapshot;
  const info = result.hdrPlan.included.find((i) => i.significantDigits === s.significantDigits);
  const guaranteeFrom = info?.guaranteeFrom ?? (s.subBucketCount / 2) * s.lowest;
  const view = bucketView(
    'relative-inspect-hdr',
    'HDR Histogram のバケットの状態',
    s.buckets,
    [
      { axis: 'x', value: guaranteeFrom, label: `HDR の保証の始まり half × L = ${formatSig3(guaranteeFrom)}` },
      { axis: 'x', value: s.lowest, label: `最小の識別単位 L = ${formatSig3(s.lowest)}` },
    ],
    [],
    [
      { label: '件数', value: formatInt(s.totalCount) },
      { label: '有効桁数', value: String(s.significantDigits) },
      { label: '副バケット数 S', value: formatInt(s.subBucketCount) },
      { label: 'バケットの総数', value: formatInt(s.totalBuckets) },
      { label: '件数が 1 以上のバケット', value: formatInt(s.nonEmptyBuckets) },
      { label: '最小の識別単位 L', value: num(s.lowest) },
      { label: '最大値 H', value: num(s.highest) },
      { label: '保証が始まる値 half × L', value: num(guaranteeFrom) },
    ],
    'HDR Histogram のバケットを、代表値(横軸、対数)と件数(縦軸)で示します。half × L より小さい値は、相対誤差の保証の対象外です。',
  );
  return { inspection: view, collapse: null };
}

/**
 * 相対誤差型のページのグラフと内部状態。分位点 × 相対誤差、(DDSketch を選んだとき)α ごとの 3 枚、
 * (HDR を選んだとき)有効桁数ごとの 3 枚、件数ごとのメモリと操作数
 */
export function buildRelativeCharts(
  result: RelativePageResult,
  condition: RelativePageCondition,
  options: ViewOptions,
): RelativeCharts {
  const { selection } = options;
  const hdrSelected = condition.methods.includes('hdr');
  const hdrNotices = hdrSelected ? hdrNoticesOf(result) : [];
  const charts: ChartSpec[] = [
    quantileChart(result, condition, selection),
    ...(condition.methods.includes('ddsketch') ? paramCharts(result, condition, selection, 'ddsketch', []) : []),
    ...(hdrSelected ? paramCharts(result, condition, selection, 'hdr', hdrNotices) : []),
    countChart(
      result,
      condition,
      {
        id: 'relative-count-operations',
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
        id: 'relative-count-memory',
        title: 'データ件数ごとのメモリ見積もり',
        yLabel: 'メモリ見積もり',
        yUnit: 'バイト',
        quantity: 'memory',
        breakdown: 'メモリは値の投入後の見積もりです。',
      },
      memoryBytes,
    ),
  ];
  const { inspection, collapse } = inspectionOf(result, condition);
  return { charts, inspection, collapse, hdrNotices };
}
