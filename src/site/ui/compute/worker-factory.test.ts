// @vitest-environment happy-dom
// Worker の生成は WorkerFactory の 1 か所に閉じ込める。生成の引数(モジュール形式、entry の場所)を確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorker } from './worker-factory';

describe('createWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('worker/entry.ts を module 形式の Worker として生成する', () => {
    const calls: { url: URL; options: WorkerOptions | undefined }[] = [];
    class StubWorker {
      constructor(url: URL, options?: WorkerOptions) {
        calls.push({ url, options });
      }
    }
    vi.stubGlobal('Worker', StubWorker);
    const w = createWorker();
    expect(w).toBeInstanceOf(StubWorker);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname.endsWith('/src/site/worker/entry.ts')).toBe(true);
    expect(calls[0]!.options).toEqual({ type: 'module' });
  });
});
