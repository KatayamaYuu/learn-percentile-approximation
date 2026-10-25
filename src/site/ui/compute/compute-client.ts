// 計算の依頼の窓口。待ち合わせ(3.4)、単調増加の番号(3.3)、実行中の打ち切り、最新の応答だけの配送、
// Worker の異常の失敗としての配送(3.6)、再実行、破棄(3.7)を受け持つ。
import type {
  JobFailure,
  JobRequest,
  JobResult,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from '../../shared/protocol';

export interface WorkerLike {
  postMessage(message: WorkerRequestMessage): void;
  terminate(): void;
  onmessage: ((ev: { readonly data: WorkerResponseMessage }) => void) | null;
  onerror: ((ev: { readonly message: string }) => void) | null;
  /** 応答を復元できなかったとき */
  onmessageerror?: ((ev: unknown) => void) | null;
}

export type ComputeStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' } // 待ち合わせ中または計算中(表示は直前の結果)
  | { readonly state: 'done'; readonly result: JobResult }
  | { readonly state: 'failed'; readonly failure: JobFailure };

export interface ComputeClient {
  /** 待ち合わせのあとで送る。既定 250ms。immediate は初回表示と再実行に使う */
  request(job: JobRequest, options?: { readonly immediate?: boolean }): void;
  /** 最後に送った条件で計算し直す */
  retry(): void;
  /** 状態が変わるたびに呼ばれる。最新の requestId の結果だけを配送する */
  subscribe(listener: (status: ComputeStatus) => void): () => void;
  /** 待ち合わせの取り消しと Worker の終了 */
  dispose(): void;
}

export const DEBOUNCE_MS = 250;

export interface Timers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

// 既定は呼び出し時にグローバルを引く(テストの偽のタイマーに追従する)
const defaultTimers: Timers = {
  setTimeout: ((...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args)) as typeof setTimeout,
  clearTimeout: ((...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args)) as typeof clearTimeout,
};

export function createComputeClient(factory: () => WorkerLike, timers: Timers = defaultTimers): ComputeClient {
  const listeners = new Set<(status: ComputeStatus) => void>();
  let latestId = 0;
  let runningId: number | null = null; // Worker が計算中の番号
  let acceptedId: number | null = null; // 応答を配送してよい番号(新しい依頼が来た時点で無効にする)
  let worker: WorkerLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastJob: JobRequest | null = null;
  let pendingStatus = false;
  let disposed = false;

  function emit(status: ComputeStatus): void {
    pendingStatus = status.state === 'pending';
    for (const l of [...listeners]) l(status);
  }

  function discardWorker(): void {
    if (worker === null) return;
    const w = worker;
    worker = null;
    w.onmessage = null;
    w.onerror = null;
    if (w.onmessageerror !== undefined) w.onmessageerror = null;
    w.terminate();
  }

  function clearTimer(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function fail(w: WorkerLike, message: string): void {
    if (disposed || w !== worker) return;
    const wasAccepted = runningId !== null && runningId === acceptedId;
    runningId = null;
    acceptedId = null;
    discardWorker();
    if (wasAccepted) emit({ state: 'failed', failure: { kind: 'exception', message } });
  }

  function createAndWire(): WorkerLike {
    const w = factory();
    w.onmessage = (ev) => {
      if (disposed || w !== worker) return;
      const msg = ev.data;
      if (msg.requestId !== acceptedId || runningId !== msg.requestId) return;
      runningId = null;
      acceptedId = null;
      emit(
        msg.status === 'ok'
          ? { state: 'done', result: msg.result }
          : { state: 'failed', failure: msg.failure },
      );
    };
    w.onerror = (ev) => fail(w, ev.message);
    w.onmessageerror = () => fail(w, 'Worker の応答を読み取れませんでした。');
    return w;
  }

  function send(job: JobRequest): void {
    timer = null;
    if (disposed) return;
    latestId += 1;
    if (runningId !== null) discardWorker();
    worker ??= createAndWire();
    runningId = latestId;
    acceptedId = latestId;
    if (!pendingStatus) emit({ state: 'pending' });
    worker.postMessage({ requestId: latestId, job });
  }

  function request(job: JobRequest, options?: { readonly immediate?: boolean }): void {
    if (disposed) return;
    lastJob = job;
    clearTimer();
    acceptedId = null; // 計算中の古い応答は、待ち合わせの間も配送しない(3.3)
    if (!pendingStatus) emit({ state: 'pending' });
    if (options?.immediate === true) send(job);
    else timer = timers.setTimeout(() => send(job), DEBOUNCE_MS);
  }

  function retry(): void {
    if (disposed || lastJob === null) return;
    request(lastJob, { immediate: true });
  }

  return {
    request,
    retry,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      runningId = null;
      discardWorker();
      listeners.clear();
    },
  };
}
