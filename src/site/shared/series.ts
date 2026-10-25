// 結果を手法・条件の軸で系列にする共通の処理。
// 上流の core は型だけを import する(実行時に import しない)。groupByAlgorithm は core の seriesByAlgorithm と同じ規則の書き写し。
import type { AlgorithmResult, BenchmarkResult, SweepResult } from '../../core';
import type { SeriesSpec } from './chart-spec';
import { pickError, type ErrorMetric, type ErrorSelection } from './metric';

type OkResult = Extract<AlgorithmResult, { status: 'ok' }>;

export interface GroupedPoint {
  readonly count: number;
  readonly result: AlgorithmResult;
}

/**
 * core の seriesByAlgorithm と同じ規則: runs を件数の昇順(同じ件数は入力の並び)に並べ、
 * AlgorithmResult.id ごとに初出順で集める。入力は変更しない。
 */
export function groupByAlgorithm(sweep: SweepResult): Readonly<Record<string, readonly GroupedPoint[]>> {
  const groups = new Map<string, GroupedPoint[]>();
  const sortedRuns = [...sweep.runs].sort((a, b) => a.count - b.count);
  for (const run of sortedRuns) {
    for (const result of run.algorithms) {
      let points = groups.get(result.id);
      if (points === undefined) {
        points = [];
        groups.set(result.id, points);
      }
      points.push({ count: run.count, result });
    }
  }
  return Object.fromEntries(groups);
}

export type AlgorithmFamily = 'exact' | 'histogram' | 'gk' | 'kll' | 'tdigest' | 'ddsketch' | 'hdr';

const FAMILIES: readonly AlgorithmFamily[] = ['exact', 'histogram', 'gk', 'kll', 'tdigest', 'ddsketch', 'hdr'];

/** id の最初の '-' より前の部分が AlgorithmFamily のいずれかと完全一致ならそれを返し、それ以外は null */
export function familyOf(id: string): AlgorithmFamily | null {
  const cut = id.indexOf('-');
  if (cut < 0) return null;
  const prefix = id.slice(0, cut);
  return FAMILIES.find((f) => f === prefix) ?? null;
}

/**
 * 系統の中の系列の識別。exact(方式)・histogram(境界の決め方)・tdigest(スケール関数)は id の先頭 2 区切り、
 * 他は familyOf と同じ。該当なし(2 区切り目がない場合を含む)は null
 */
export function variantOf(id: string): string | null {
  const family = familyOf(id);
  if (family === null) return null;
  if (family !== 'exact' && family !== 'histogram' && family !== 'tdigest') return family;
  const second = id.split('-')[1];
  return second === undefined || second === '' ? null : `${family}-${second}`;
}

// --- 値の取り出し(表示のための和だけ。指標の再定義ではない) ---

/** 投入の操作数: 比較 + 移動 */
export function insertOperations(r: OkResult): number {
  return r.afterInsertion.operations.comparisons + r.afterInsertion.operations.moves;
}

/** 投入と問い合わせの操作数の合計(それぞれ比較 + 移動) */
export function allOperations(r: OkResult): number {
  let total = insertOperations(r);
  for (const q of r.queries) total += q.operations.comparisons + q.operations.moves;
  return total;
}

/** 投入後のメモリの見積もり(バイト) */
export function memoryBytes(r: OkResult): number {
  return r.afterInsertion.memoryBytes;
}

/** 処理時間: 投入 + 問い合わせの合計(ミリ秒) */
export function elapsedMs(r: OkResult): number {
  let total = r.afterInsertion.elapsedMs;
  for (const q of r.queries) total += q.elapsedMs;
  return total;
}

// --- 計算できなかった手法 ---

export interface UnavailableAlgorithm {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

const STAGE_JA = {
  create: '作成',
  insert: '値の投入',
  query: '問い合わせ',
} as const;

const KIND_JA: Readonly<Record<string, string>> = {
  'invalid-value': '値が不正',
  'quantile-out-of-range': '分位点が範囲外',
  empty: '値が 1 つも入っていない',
  'unsupported-value': '扱えない範囲の値',
  'invalid-estimate': '推定値が不正',
  exception: '想定外の例外',
};

function reasonOf(r: Extract<AlgorithmResult, { status: 'error' }>): string {
  const stage = STAGE_JA[r.stage] ?? r.stage;
  const kind = KIND_JA[r.errorKind] ?? r.errorKind;
  const head = `${stage}の段階で${kind}`;
  return r.message === '' ? head : `${head}: ${r.message}`;
}

/** 注記の 1 行: 「<label>: 計算できませんでした(<理由>)」 */
export function unavailableText(u: UnavailableAlgorithm): string {
  return `${u.label}: 計算できませんでした(${u.reason})`;
}

/** status: 'error' の結果を識別子ごとに 1 件、初出順で集める。掃引または 1 つの run を受け取る */
export function unavailableNotes(source: SweepResult | BenchmarkResult): readonly UnavailableAlgorithm[] {
  const runs: readonly BenchmarkResult[] = 'runs' in source ? [...source.runs].sort((a, b) => a.count - b.count) : [source];
  const seen = new Map<string, UnavailableAlgorithm>();
  for (const run of runs) {
    for (const r of run.algorithms) {
      if (r.status === 'error' && !seen.has(r.id)) seen.set(r.id, { id: r.id, label: r.label, reason: reasonOf(r) });
    }
  }
  return [...seen.values()];
}

// --- 系列 ---

/**
 * 件数軸: groupByAlgorithm を使い、x は件数、y は value で選んだ値。
 * 失敗した結果は点にしない(0 として描かない)。点が 1 つもない手法は系列を作らない
 */
export function countAxisSeries(
  sweep: SweepResult,
  value: (r: OkResult) => number,
  filter?: (id: string) => boolean,
): readonly SeriesSpec[] {
  const out: SeriesSpec[] = [];
  for (const [id, grouped] of Object.entries(groupByAlgorithm(sweep))) {
    if (filter !== undefined && !filter(id)) continue;
    const points = grouped.flatMap((g) => (g.result.status === 'ok' ? [{ x: g.count, y: value(g.result) }] : []));
    if (points.length === 0) continue;
    out.push({ id, label: grouped[0]!.result.label, points, kind: 'line' });
  }
  return out;
}

/**
 * パラメータ軸: 1 つの run の成功した結果を groupKey(系列名。null は対象外)ごとに集め、
 * x は params[paramKey](識別子からは読まない。数値でなければ対象外)、y は value(null は対象外)。x の昇順
 */
export function paramAxisSeries(
  run: BenchmarkResult,
  groupKey: (r: AlgorithmResult) => string | null,
  paramKey: string,
  value: (r: OkResult) => number | null,
): readonly SeriesSpec[] {
  const groups = new Map<string, { x: number; y: number; detail: string }[]>();
  for (const r of run.algorithms) {
    if (r.status !== 'ok') continue;
    const key = groupKey(r);
    if (key === null) continue;
    const x = r.params[paramKey];
    if (typeof x !== 'number') continue;
    const y = value(r);
    if (y === null) continue;
    let points = groups.get(key);
    if (points === undefined) {
      points = [];
      groups.set(key, points);
    }
    points.push({ x, y, detail: r.label });
  }
  return [...groups].map(([key, points]) => ({
    id: key,
    label: key,
    kind: 'line' as const,
    points: points.sort((a, b) => a.x - b.x),
  }));
}

/** 分位点軸: 成功した手法ごとに、x は分位点、y は選んだ指標の値(上流の値のまま) */
export function quantileAxisSeries(
  run: BenchmarkResult,
  metric: ErrorMetric,
  filter?: (id: string) => boolean,
): readonly SeriesSpec[] {
  const out: SeriesSpec[] = [];
  for (const r of run.algorithms) {
    if (r.status !== 'ok' || (filter !== undefined && !filter(r.id))) continue;
    const points = r.queries.flatMap((q) => {
      const y = pickError([q], { metric, pick: { kind: 'max' } });
      return y === null ? [] : [{ x: q.quantile, y }];
    });
    if (points.length === 0) continue;
    out.push({ id: r.id, label: r.label, points, kind: 'line' });
  }
  return out;
}

/** メモリと誤差: groupKey(null は対象外)ごとに (投入後のメモリ, 選んだ誤差) の点。メモリの昇順 */
export function tradeoffSeries(
  run: BenchmarkResult,
  selection: ErrorSelection,
  groupKey: (r: AlgorithmResult) => string | null,
): readonly SeriesSpec[] {
  const groups = new Map<string, { x: number; y: number; detail: string }[]>();
  for (const r of run.algorithms) {
    if (r.status !== 'ok') continue;
    const key = groupKey(r);
    if (key === null) continue;
    const y = pickError(r.queries, selection);
    if (y === null) continue;
    let points = groups.get(key);
    if (points === undefined) {
      points = [];
      groups.set(key, points);
    }
    points.push({ x: r.afterInsertion.memoryBytes, y, detail: r.label });
  }
  return [...groups].map(([key, points]) => ({
    id: key,
    label: key,
    kind: 'line' as const,
    points: points.sort((a, b) => a.x - b.x),
  }));
}
