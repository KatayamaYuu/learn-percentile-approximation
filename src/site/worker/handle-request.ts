// 要求の受け付けと振り分け(3.6)。Worker の API を触らない純粋な関数。
// サイトの検証 → 計算量の再確認 → ジョブの実行の順に処理し、失敗はすべて要求の番号つきの応答にする。
import type { Result } from '../../core';
import type { CompareCondition, HistogramPageCondition, RelativePageCondition, StreamingPageCondition } from '../shared/conditions';
import type {
  CompareResult,
  HistogramPageResult,
  JobFailure,
  JobRequest,
  JobResult,
  RelativePageResult,
  StreamingPageResult,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from '../shared/protocol';
import {
  validateCompare,
  validateHistogramPage,
  validateRelativePage,
  validateStreamingPage,
  type FieldIssue,
} from '../shared/validate';
import { estimateWork } from '../shared/workload';
import { runCompare } from './run-compare';
import { runHistogramPage } from './run-histogram-page';
import { runRelativePage } from './run-relative-page';
import { runStreamingPage } from './run-streaming-page';

/** ジョブの実行関数の集まり。テストで差し替えられるようにする */
export interface JobRunners {
  readonly histogram: (c: HistogramPageCondition) => Result<HistogramPageResult, readonly FieldIssue[]>;
  readonly streaming: (c: StreamingPageCondition) => Result<StreamingPageResult, readonly FieldIssue[]>;
  readonly relative: (c: RelativePageCondition) => Result<RelativePageResult, JobFailure>;
  readonly compare: (c: CompareCondition) => Result<CompareResult, JobFailure>;
}

export const DEFAULT_RUNNERS: JobRunners = {
  histogram: runHistogramPage,
  streaming: runStreamingPage,
  relative: runRelativePage,
  compare: runCompare,
};

function validate(job: JobRequest): readonly FieldIssue[] {
  switch (job.kind) {
    case 'histogram':
      return validateHistogramPage(job.condition);
    case 'streaming':
      return validateStreamingPage(job.condition);
    case 'relative':
      return validateRelativePage(job.condition);
    case 'compare':
      return validateCompare(job.condition);
  }
}

function run(job: JobRequest, runners: JobRunners): Result<JobResult, JobFailure> {
  const invalid = (issues: readonly FieldIssue[]): JobFailure => ({ kind: 'invalid-condition', issues });
  switch (job.kind) {
    case 'histogram': {
      const r = runners.histogram(job.condition);
      return r.ok ? r : { ok: false, error: invalid(r.error) };
    }
    case 'streaming': {
      const r = runners.streaming(job.condition);
      return r.ok ? r : { ok: false, error: invalid(r.error) };
    }
    case 'relative':
      return runners.relative(job.condition);
    case 'compare':
      return runners.compare(job.condition);
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function handleRequest(message: WorkerRequestMessage, runners: JobRunners = DEFAULT_RUNNERS): WorkerResponseMessage {
  const { requestId, job } = message;
  const failed = (failure: JobFailure): WorkerResponseMessage => ({ requestId, status: 'failed', failure });
  try {
    const issues = validate(job);
    if (issues.length > 0) return failed({ kind: 'invalid-condition', issues });

    // 投入の項だけの再確認。relative と compare は HDR の項を含めた再判定をジョブの中で行う
    const estimate = estimateWork(job);
    if (!estimate.withinLimit) return failed({ kind: 'over-limit', estimate });

    const r = run(job, runners);
    return r.ok ? { requestId, status: 'ok', result: r.value } : failed(r.error);
  } catch (e) {
    return failed({ kind: 'exception', message: describeError(e) });
  }
}
