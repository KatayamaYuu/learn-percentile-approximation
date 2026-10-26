import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPARE, DEFAULT_HISTOGRAM, DEFAULT_RELATIVE, DEFAULT_STREAMING } from './conditions';
import type {
  HdrPlanSummary,
  JobFailure,
  JobRequest,
  JobResult,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from './protocol';

describe('Worker との通信の型(3.3、3.6)', () => {
  it('要求は 4 種のページの条件を kind で区別し、JSON を往復しても等しい', () => {
    const jobs: JobRequest[] = [
      { kind: 'histogram', condition: DEFAULT_HISTOGRAM },
      { kind: 'streaming', condition: DEFAULT_STREAMING },
      { kind: 'relative', condition: DEFAULT_RELATIVE },
      { kind: 'compare', condition: DEFAULT_COMPARE },
    ];
    for (const job of jobs) {
      const msg: WorkerRequestMessage = { requestId: 7, job };
      expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it('失敗は 3 種(条件の不備、上限超過、例外)で、応答は requestId を持つ', () => {
    const failures: JobFailure[] = [
      { kind: 'invalid-condition', issues: [{ field: 'data.count', reason: '範囲外です' }] },
      {
        kind: 'over-limit',
        estimate: { units: 5e7, includesHdrTerm: false, withinLimit: false, suggestions: ['件数を減らしてください'] },
      },
      { kind: 'exception', message: 'x' },
    ];
    for (const failure of failures) {
      const res: WorkerResponseMessage = { requestId: 3, status: 'failed', failure };
      expect(JSON.parse(JSON.stringify(res))).toEqual(res);
    }
  });

  it('HDR の要点(範囲の決め方、実行した・除いた有効桁数)を結果に入れられる', () => {
    const plan: HdrPlanSummary = {
      range: { lowest: 2, highest: 1000 },
      mode: 'auto',
      referenceDigits: 2,
      lowestClamped: false,
      included: [{ significantDigits: 2, subBucketCount: 256, totalBuckets: 1000, guaranteeFrom: 256 }],
      excluded: [{ significantDigits: 5, reason: '上限を超えます' }],
    };
    const result: Pick<Extract<JobResult, { kind: 'compare' }>, 'hdrPlan' | 'hdrRange'> = {
      hdrPlan: plan,
      hdrRange: plan.range,
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
