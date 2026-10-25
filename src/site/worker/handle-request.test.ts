import { describe, expect, it } from 'vitest';
import { err } from '../../core';
import {
  DEFAULT_COMPARE,
  DEFAULT_HISTOGRAM,
  DEFAULT_RELATIVE,
  DEFAULT_STREAMING,
  type DataCondition,
} from '../shared/conditions';
import type { JobRequest, WorkerRequestMessage } from '../shared/protocol';
import { handleRequest, type JobRunners } from './handle-request';

const N = 1_000;
const data = (d: DataCondition): DataCondition => ({ ...d, count: N });

const histogram: JobRequest = { kind: 'histogram', condition: { ...DEFAULT_HISTOGRAM, data: data(DEFAULT_HISTOGRAM.data) } };
const streaming: JobRequest = { kind: 'streaming', condition: { ...DEFAULT_STREAMING, data: data(DEFAULT_STREAMING.data) } };
const relative: JobRequest = { kind: 'relative', condition: { ...DEFAULT_RELATIVE, data: data(DEFAULT_RELATIVE.data) } };
const compare: JobRequest = { kind: 'compare', condition: { ...DEFAULT_COMPARE, data: data(DEFAULT_COMPARE.data) } };

const send = (requestId: number, job: JobRequest): WorkerRequestMessage => ({ requestId, job });

describe('handleRequest', () => {
  it.each([histogram, streaming, relative, compare])('$kind の要求が成功し、応答の番号が要求の番号と等しい', (job) => {
    const res = handleRequest(send(42, job));
    expect(res.requestId).toBe(42);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.result.kind).toBe(job.kind);
  });

  it('分布のパラメータの誤りは分布の項目の invalid-condition になる', () => {
    const bad: JobRequest = {
      kind: 'histogram',
      condition: {
        ...histogram.condition,
        data: { ...data(DEFAULT_HISTOGRAM.data), distribution: { kind: 'lognormal', mu: 0, sigma: -5 } },
      },
    };
    const res = handleRequest(send(7, bad));
    expect(res.requestId).toBe(7);
    if (res.status !== 'failed' || res.failure.kind !== 'invalid-condition') throw new Error('expected invalid-condition');
    expect(res.failure.issues.some((i) => i.field === 'data.distribution.sigma')).toBe(true);
  });

  it('上限を超える要求は、ジョブを実行せずに over-limit になる', () => {
    const big: JobRequest = {
      kind: 'streaming',
      condition: { ...streaming.condition, data: { ...streaming.condition.data, count: 1_000_000 }, trials: 10 },
    } as JobRequest;
    let called = false;
    const mark = () => {
      called = true;
      throw new Error('should not run');
    };
    const runners: JobRunners = { histogram: mark, streaming: mark, relative: mark, compare: mark };
    const res = handleRequest(send(3, big), runners);
    expect(res.requestId).toBe(3);
    if (res.status !== 'failed' || res.failure.kind !== 'over-limit') throw new Error('expected over-limit');
    expect(res.failure.estimate.withinLimit).toBe(false);
    expect(called).toBe(false);
  });

  it('ジョブ内の例外は exception になる(番号つき)', () => {
    const runners = {
      histogram: () => {
        throw new Error('壊れた');
      },
    } as unknown as JobRunners;
    const res = handleRequest(send(9, histogram), { ...defaultLike(), ...runners });
    expect(res.requestId).toBe(9);
    if (res.status !== 'failed' || res.failure.kind !== 'exception') throw new Error('expected exception');
    expect(res.failure.message).toContain('壊れた');
  });

  it('Error でない例外値も exception の文にする', () => {
    const runners = {
      streaming: () => {
        throw 'plain';
      },
    } as unknown as JobRunners;
    const res = handleRequest(send(1, streaming), { ...defaultLike(), ...runners });
    if (res.status !== 'failed' || res.failure.kind !== 'exception') throw new Error('expected exception');
    expect(res.failure.message).toContain('plain');
  });

  it('streaming・histogram が FieldIssue を返したら invalid-condition に包む', () => {
    const issues = [{ field: 'epsilon', reason: 'だめ' }];
    const res = handleRequest(send(5, streaming), { ...defaultLike(), streaming: () => err(issues) });
    if (res.status !== 'failed' || res.failure.kind !== 'invalid-condition') throw new Error('expected invalid-condition');
    expect(res.failure.issues).toEqual(issues);
  });

  it('relative・compare が返す JobFailure はそのまま返す', () => {
    const failure = { kind: 'exception', message: 'x' } as const;
    const res = handleRequest(send(6, compare), { ...defaultLike(), compare: () => err(failure) });
    if (res.status !== 'failed') throw new Error('expected failed');
    expect(res.failure).toEqual(failure);
  });
});

function defaultLike(): JobRunners {
  return {
    histogram: () => err([]),
    streaming: () => err([]),
    relative: () => err({ kind: 'exception', message: '' }),
    compare: () => err({ kind: 'exception', message: '' }),
  };
}
