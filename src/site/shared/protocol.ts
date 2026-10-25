// Worker との通信の型。結果は上流の結果の構造をそのまま入れ、サイトで指標を足したり変換したりしない(7.7)。
// すべて構造化複製と JSON に通る。上流は型だけを import する。
import type { SweepResult } from '../../core';
import type {
  CompareCondition,
  HistogramPageCondition,
  RelativePageCondition,
  StreamingPageCondition,
} from './conditions';
import type { FieldIssue } from './validate';
import type { WorkEstimate } from './workload';
import type { BucketExperimentResult } from '../../histogram';
import type { StreamingExperimentResult, GkState, KllState, TDigestState } from '../../streaming';
import type { RelativeErrorExperimentResult, DDSketchSnapshot, HdrSnapshot } from '../../relative-error';

export type JobRequest =
  | { readonly kind: 'histogram'; readonly condition: HistogramPageCondition }
  | { readonly kind: 'streaming'; readonly condition: StreamingPageCondition }
  | { readonly kind: 'relative'; readonly condition: RelativePageCondition }
  | { readonly kind: 'compare'; readonly condition: CompareCondition };

export interface HistogramPageResult {
  readonly kind: 'histogram';
  readonly paramSweep: BucketExperimentResult;
  readonly countSweep: BucketExperimentResult;
  readonly detail: BucketExperimentResult;
}

export type StreamingInspection =
  | { readonly algorithm: 'gk'; readonly state: GkState }
  | { readonly algorithm: 'kll'; readonly state: KllState }
  | { readonly algorithm: 'tdigest'; readonly state: TDigestState };

export interface StreamingPageResult {
  readonly kind: 'streaming';
  readonly paramSweep: StreamingExperimentResult;
  readonly countSweep: StreamingExperimentResult;
  /** orders は ['random', 'ascending', 'descending']、trialSeeds は [seed, seed + 1, …] */
  readonly detail: StreamingExperimentResult;
  readonly inspection: StreamingInspection;
}

export type RelativeInspection =
  | { readonly algorithm: 'ddsketch'; readonly snapshot: DDSketchSnapshot }
  | { readonly algorithm: 'hdr'; readonly snapshot: HdrSnapshot }
  /** HDR の範囲がデータを覆わず、観察できなかった */
  | { readonly algorithm: 'hdr'; readonly rejected: true; readonly reason: string };

/** 実行した有効桁数ごとの HDR の構造の要点(Worker が createHdrLayout から作る) */
export interface HdrDigitsInfo {
  readonly significantDigits: number;
  /** HdrLayout.subBucketCount(S)。相対誤差の保証の上限は 1 / S */
  readonly subBucketCount: number;
  readonly totalBuckets: number;
  /** 相対誤差の保証が始まる値 half × L(half = S / 2) */
  readonly guaranteeFrom: number;
}

/** 範囲の決め方と、実行した・除いた有効桁数(DataExtent の planHdr の結果) */
export interface HdrPlanSummary {
  readonly range: { readonly lowest: number; readonly highest: number };
  readonly mode: 'auto' | 'manual';
  /** auto のとき、L を決める基準にした有効桁数(この値以下の有効桁数では、データの最小値が half × L 以上)。manual は null */
  readonly referenceDigits: number | null;
  /** auto で、どの基準の有効桁数でも範囲が作れず、下限 L を切り詰めたとき true(L より小さいデータの値は HDR の範囲外)。manual は false */
  readonly lowestClamped: boolean;
  readonly included: readonly HdrDigitsInfo[];
  /** バケットの総数が MAX_HDR_BUCKETS を超えるため除いた有効桁数と、上流の reason */
  readonly excluded: readonly { readonly significantDigits: number; readonly reason: string }[];
}

export interface RelativePageResult {
  readonly kind: 'relative';
  readonly hdrRange: { readonly lowest: number; readonly highest: number };
  readonly hdrPlan: HdrPlanSummary;
  readonly paramSweep: RelativeErrorExperimentResult;
  readonly countSweep: RelativeErrorExperimentResult;
  readonly detail: RelativeErrorExperimentResult;
  readonly inspection: RelativeInspection;
}

export interface CompareResult {
  readonly kind: 'compare';
  readonly hdrRange: { readonly lowest: number; readonly highest: number };
  /** 除いた HDR の手法は excluded に入り、SketchSpec に並べない(表と注記で理由を示す。8.8) */
  readonly hdrPlan: HdrPlanSummary;
  readonly countSweep: SweepResult;
  readonly detail: SweepResult;
}

export type JobResult = HistogramPageResult | StreamingPageResult | RelativePageResult | CompareResult;

export type JobFailure =
  | { readonly kind: 'invalid-condition'; readonly issues: readonly FieldIssue[] }
  | { readonly kind: 'over-limit'; readonly estimate: WorkEstimate }
  | { readonly kind: 'exception'; readonly message: string };

export interface WorkerRequestMessage {
  readonly requestId: number;
  readonly job: JobRequest;
}

export type WorkerResponseMessage =
  | { readonly requestId: number; readonly status: 'ok'; readonly result: JobResult }
  | { readonly requestId: number; readonly status: 'failed'; readonly failure: JobFailure };
