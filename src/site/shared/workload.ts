// 計算量の見積もりと上限の判定。投入の項(件数 × その件数で動く sketch の数)と、
// HDR のバケットの総数の項(hdr を渡したときだけ)を足す。
import {
  DETAIL_QUANTILES,
  SUMMARY_QUANTILES,
  alphaGrid,
  bucketsGrid,
  compressionGrid,
  countGrid,
  digitsGrid,
  epsilonGrid,
  kGrid,
} from './grids';
import { WORK_LIMIT } from './limits';
import type { JobRequest } from './protocol';
import type {
  CompareCondition,
  RelativePageCondition,
  StreamingPageCondition,
  HistogramPageCondition,
} from './conditions';

export interface HdrWorkInput {
  /** 実行する有効桁数 → その範囲での HdrLayout.totalBuckets(除いた有効桁数は含めない) */
  readonly totalBuckets: ReadonlyMap<number, number>;
}

export interface WorkEstimate {
  /** 投入の項 Σ(データ件数 × その件数で動く sketch の数。厳密解を含む)+ HDR の項 */
  readonly units: number;
  /** HDR のバケットの総数の項を含めたか(hdr を渡したときだけ true) */
  readonly includesHdrTerm: boolean;
  readonly withinLimit: boolean;
  /** 上限を超えたときの減らし方の案内(日本語) */
  readonly suggestions: readonly string[];
}

/** 厳密解(整列と選択)の 2 方式 */
const EXACT_SOLVERS = 2;
const SUMMARY_COUNT = SUMMARY_QUANTILES.length;
const DETAIL_COUNT = DETAIL_QUANTILES.length;

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** 3 回の実験(パラメータの掃引、件数の掃引、詳細)の投入の項 */
function threeExperiments(n: number, paramSketches: number, currentSketches: number, detailFactor: number): number {
  const counts = countGrid(n);
  return (
    n * (EXACT_SOLVERS + paramSketches) +
    sum(counts) * (EXACT_SOLVERS + currentSketches) +
    n * (EXACT_SOLVERS + currentSketches) * detailFactor
  );
}

function histogramInjection(c: HistogramPageCondition): number {
  const schemes = c.schemes.length;
  return threeExperiments(c.data.count, schemes * bucketsGrid(c.buckets).length, schemes, 1);
}

function streamingInjection(c: StreamingPageCondition): number {
  const n = c.data.count;
  const scales = c.scales.length;
  let grid = 0;
  let current = 0;
  if (c.methods.includes('gk')) {
    grid += epsilonGrid(c.epsilon).length;
    current += 1;
  }
  if (c.methods.includes('kll')) {
    grid += kGrid(c.k).length;
    current += 1;
  }
  if (c.methods.includes('tdigest')) {
    grid += scales * compressionGrid(c.compression).length;
    current += scales;
  }
  const orders = 3;
  return threeExperiments(n, grid, current, orders * c.trials) + n;
}

/** 相対誤差型は観察のための再投入があるので、DDSketch と HDR を 2 倍に数える */
function relativeInjection(c: RelativePageCondition): number {
  const grid = 2 * (alphaGrid(c.alpha).length + digitsGrid(c.significantDigits).length);
  const current = 2 * 2;
  return threeExperiments(c.data.count, grid, current, 1) + c.data.count;
}

function compareInjection(c: CompareCondition): number {
  const n = c.data.count;
  const algorithms = c.algorithms.length;
  return (sum(countGrid(n)) + n) * algorithms;
}

function injectionTerm(job: JobRequest): number {
  switch (job.kind) {
    case 'histogram':
      return histogramInjection(job.condition);
    case 'streaming':
      return streamingInjection(job.condition);
    case 'relative':
      return relativeInjection(job.condition);
    case 'compare':
      return compareInjection(job.condition);
  }
}

/** HDR のインスタンス 1 つの費用: 確保 1 回 + 走査の回数。総数が 0 以下や未知なら 0 */
function hdrInstance(total: number, scans: number): number {
  return total * (1 + scans);
}

function hdrTerm(job: JobRequest, hdr: HdrWorkInput): number {
  const buckets = hdr.totalBuckets;
  if (job.kind === 'relative') {
    const c = job.condition;
    const counts = countGrid(c.data.count);
    // ハーネスのインスタンス(1 + 分位点)と観察のための再投入のインスタンス(確保 1 + inspect の走査 1)
    const per = (total: number, quantiles: number): number => hdrInstance(total, quantiles) + hdrInstance(total, 1);
    const current = buckets.get(c.significantDigits) ?? 0;
    let total = 0;
    for (const t of buckets.values()) total += per(t, SUMMARY_COUNT);
    total += counts.length * per(current, SUMMARY_COUNT);
    total += per(current, DETAIL_COUNT);
    if (c.inspectTarget === 'hdr') total += hdrInstance(current, 1);
    return total;
  }
  if (job.kind === 'compare') {
    const c = job.condition;
    const counts = countGrid(c.data.count);
    let total = 0;
    for (const a of c.algorithms) {
      if (a.kind !== 'hdr') continue;
      const t = buckets.get(a.significantDigits) ?? 0;
      total += counts.length * hdrInstance(t, SUMMARY_COUNT) + hdrInstance(t, DETAIL_COUNT);
    }
    return total;
  }
  return 0;
}

function suggest(job: JobRequest, excess: number, hdrPart: number, hasHdr: boolean): string[] {
  const out: string[] = [];
  out.push('データ件数を減らしてください。');
  if (job.kind === 'streaming' && job.condition.trials > 1) {
    out.push('試行の回数を減らしてください。');
  }
  if (job.kind === 'compare' && job.condition.algorithms.length > 1) {
    out.push('比較の対象を減らしてください。');
  }
  if (job.kind === 'streaming' && job.condition.methods.length > 1) {
    out.push('選ぶ手法を減らしてください。');
  }
  // HDR の項を除けば収まる(HDR の項が超過に効いている)ときだけ
  if (hasHdr && hdrPart > 0 && hdrPart >= excess) {
    out.push('HDR の有効桁数を下げるか、追跡する範囲を狭める。');
  }
  return out;
}

export function estimateWork(job: JobRequest, hdr?: HdrWorkInput): WorkEstimate {
  const injection = injectionTerm(job);
  const hdrPart = hdr === undefined ? 0 : hdrTerm(job, hdr);
  const units = injection + hdrPart;
  const withinLimit = units <= WORK_LIMIT;
  return {
    units,
    includesHdrTerm: hdr !== undefined,
    withinLimit,
    suggestions: withinLimit ? [] : suggest(job, units - WORK_LIMIT, hdrPart, hdr !== undefined),
  };
}
