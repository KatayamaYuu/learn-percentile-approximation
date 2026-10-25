// Worker の生成を 1 か所に閉じ込める。テストは ComputeClient に偽の WorkerLike を返すファクトリを渡す。
import type { WorkerLike } from './compute-client';

export function createWorker(): WorkerLike {
  return new Worker(new URL('../../worker/entry.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
