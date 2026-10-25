// @vitest-environment happy-dom
// 偽の Worker と偽のタイマーで、待ち合わせ・番号付け・打ち切り・配送を確かめる(3.1〜3.4、3.6、3.7)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRequest, JobResult, WorkerRequestMessage, WorkerResponseMessage } from '../../shared/protocol';
import { createComputeClient, DEBOUNCE_MS, type ComputeStatus, type WorkerLike } from './compute-client';

class FakeWorker implements WorkerLike {
  readonly posted: WorkerRequestMessage[] = [];
  terminated = false;
  onmessage: ((ev: { readonly data: WorkerResponseMessage }) => void) | null = null;
  onerror: ((ev: { readonly message: string }) => void) | null = null;
  onmessageerror: ((ev: unknown) => void) | null = null;
  postMessage(message: WorkerRequestMessage): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: WorkerResponseMessage): void {
    this.onmessage?.({ data: message });
  }
}

function job(seed: number): JobRequest {
  return { kind: 'histogram', condition: { seed } } as unknown as JobRequest;
}
const RESULT = { kind: 'histogram' } as unknown as JobResult;

function setup() {
  const workers: FakeWorker[] = [];
  const client = createComputeClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  const statuses: ComputeStatus[] = [];
  client.subscribe((s) => statuses.push(s));
  return { client, workers, statuses };
}

describe('ComputeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('待ち合わせの既定は 250ms である', () => {
    expect(DEBOUNCE_MS).toBe(250);
  });

  it('連続した依頼は待ち合わせて、最後の 1 回だけを送る(3.4)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1));
    vi.advanceTimersByTime(100);
    client.request(job(2));
    vi.advanceTimersByTime(100);
    client.request(job(3));
    expect(workers).toHaveLength(0);
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(workers).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([{ requestId: 1, job: job(3) }]);
    expect(statuses[0]).toEqual({ state: 'pending' });
  });

  it('依頼のあいだ、操作を止めずに pending を通知する(3.1、3.2)', () => {
    const { client, statuses } = setup();
    client.request(job(1));
    expect(statuses).toEqual([{ state: 'pending' }]);
  });

  it('immediate は待ち合わせずに送る', () => {
    const { client, workers } = setup();
    client.request(job(1), { immediate: true });
    expect(workers[0]!.posted).toHaveLength(1);
  });

  it('immediate は待ち合わせ中の依頼を置き換える', () => {
    const { client, workers } = setup();
    client.request(job(1));
    client.request(job(2), { immediate: true });
    vi.advanceTimersByTime(1000);
    expect(workers[0]!.posted).toEqual([{ requestId: 1, job: job(2) }]);
  });

  it('応答を done として配送する', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    expect(statuses.at(-1)).toEqual({ state: 'done', result: RESULT });
  });

  it('失敗の応答を failed として配送する(3.6)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    const failure = { kind: 'exception', message: 'x' } as const;
    workers[0]!.reply({ requestId: 1, status: 'failed', failure });
    expect(statuses.at(-1)).toEqual({ state: 'failed', failure });
  });

  it('実行中に新しい依頼が来ると Worker を終了して作り直し、古い応答は配送しない(3.3)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([{ requestId: 2, job: job(2) }]);
    const before = statuses.length;
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    expect(statuses).toHaveLength(before);
    workers[1]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    expect(statuses).toHaveLength(before);
    workers[1]!.reply({ requestId: 2, status: 'ok', result: RESULT });
    expect(statuses.at(-1)).toEqual({ state: 'done', result: RESULT });
  });

  it('待ち合わせの間は実行中の Worker を終了しない(送る時点で終了する)', () => {
    const { client, workers } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2));
    expect(workers[0]!.terminated).toBe(false);
  });

  it('完了後の依頼は同じ Worker を使い、終了しない', () => {
    const { client, workers } = setup();
    client.request(job(1), { immediate: true });
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    client.request(job(2), { immediate: true });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    expect(workers[0]!.posted.map((m) => m.requestId)).toEqual([1, 2]);
  });

  it('番号は単調に増える', () => {
    const { client, workers } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2), { immediate: true });
    client.request(job(3), { immediate: true });
    const ids = workers.flatMap((w) => w.posted.map((m) => m.requestId));
    expect(ids).toEqual([1, 2, 3]);
  });

  it('Worker の onerror を failed(exception)として配送し、Worker を捨てる(3.6)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    workers[0]!.onerror?.({ message: 'boom' });
    expect(statuses.at(-1)).toEqual({ state: 'failed', failure: { kind: 'exception', message: 'boom' } });
    expect(workers[0]!.terminated).toBe(true);
    client.request(job(2), { immediate: true });
    expect(workers).toHaveLength(2);
  });

  it('onmessageerror も failed として配送する(3.6)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    workers[0]!.onmessageerror?.({});
    expect(statuses.at(-1)?.state).toBe('failed');
  });

  it('終了済みの Worker の異常は配送しない', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2), { immediate: true });
    const before = statuses.length;
    workers[0]!.onerror?.({ message: 'late' });
    expect(statuses).toHaveLength(before);
  });

  it('retry は最後の条件を待ち合わせずに新しい番号で送り直す', () => {
    const { client, workers, statuses } = setup();
    client.request(job(7), { immediate: true });
    workers[0]!.onerror?.({ message: 'boom' });
    client.retry();
    expect(workers[1]!.posted).toEqual([{ requestId: 2, job: job(7) }]);
    expect(statuses.at(-1)).toEqual({ state: 'pending' });
  });

  it('依頼がないときの retry は何もしない', () => {
    const { client, workers, statuses } = setup();
    client.retry();
    expect(workers).toHaveLength(0);
    expect(statuses).toEqual([]);
  });

  it('subscribe の戻り値で購読を解除できる', () => {
    const { client } = setup();
    const listener = vi.fn();
    const off = client.subscribe(listener);
    off();
    client.request(job(1), { immediate: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispose は待ち合わせを取り消し、Worker を終了し、以後配送しない(3.7)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2));
    client.dispose();
    expect(workers[0]!.terminated).toBe(true);
    const before = statuses.length;
    vi.advanceTimersByTime(1000);
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    workers[0]!.onerror?.({ message: 'x' });
    client.request(job(3), { immediate: true });
    client.retry();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(1);
    expect(statuses).toHaveLength(before);
  });

  it('Worker は最初の送信まで作らない(遅延して作る)', () => {
    const { client, workers } = setup();
    client.request(job(1));
    expect(workers).toHaveLength(0);
    client.dispose();
    expect(workers).toHaveLength(0);
  });

  it('実行中に新しい依頼が来たら、待ち合わせの間に来た古い応答は配送しない。送信時も pending である(3.2、3.3)', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2));
    vi.advanceTimersByTime(100);
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    expect(statuses.map((s) => s.state)).toEqual(['pending']);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(statuses.map((s) => s.state)).toEqual(['pending']);
    expect(workers[1]!.posted).toEqual([{ requestId: 2, job: job(2) }]);
    workers[1]!.reply({ requestId: 2, status: 'ok', result: RESULT });
    expect(statuses.map((s) => s.state)).toEqual(['pending', 'done']);
  });

  it('待ち合わせ中に古い Worker が異常を起こしても failed を配送しない', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    client.request(job(2));
    workers[0]!.onerror?.({ message: 'old' });
    expect(statuses.map((s) => s.state)).toEqual(['pending']);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toHaveLength(1);
  });

  it('retry は this に依存しない(分離して呼べる)', () => {
    const { client, workers } = setup();
    const { retry } = client;
    client.request(job(5), { immediate: true });
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    retry();
    expect(workers[0]!.posted.map((m) => m.requestId)).toEqual([1, 2]);
  });

  it('実行中でないときの onerror / onmessageerror は黙って Worker を捨て、次の依頼で作り直す', () => {
    const { client, workers, statuses } = setup();
    client.request(job(1), { immediate: true });
    workers[0]!.reply({ requestId: 1, status: 'ok', result: RESULT });
    const before = statuses.length;
    workers[0]!.onerror?.({ message: 'idle' });
    expect(statuses).toHaveLength(before);
    expect(workers[0]!.terminated).toBe(true);
    client.request(job(2), { immediate: true });
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ requestId: 2, status: 'ok', result: RESULT });
    const before2 = statuses.length;
    workers[1]!.onmessageerror?.({});
    expect(statuses).toHaveLength(before2);
    expect(workers[1]!.terminated).toBe(true);
    client.request(job(3), { immediate: true });
    expect(workers).toHaveLength(3);
  });

  it('retry: 計算中は古い Worker を終了して送り直し、完了後は新しい番号で再計算する', () => {
    const { client, workers, statuses } = setup();
    client.request(job(9), { immediate: true });
    client.retry();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.posted).toEqual([{ requestId: 2, job: job(9) }]);
    workers[1]!.reply({ requestId: 2, status: 'ok', result: RESULT });
    expect(statuses.at(-1)?.state).toBe('done');
    client.retry();
    expect(statuses.at(-1)).toEqual({ state: 'pending' });
    expect(workers[1]!.posted.map((m) => m.requestId)).toEqual([2, 3]);
  });
});
