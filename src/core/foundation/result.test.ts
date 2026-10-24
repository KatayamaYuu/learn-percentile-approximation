import { describe, expect, it } from 'vitest';
import { err, ok } from './result';

describe('Result', () => {
  it('ok は成功値を包む', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
  });
  it('err は失敗を値として包み、例外を投げない', () => {
    expect(err({ kind: 'empty' as const })).toEqual({ ok: false, error: { kind: 'empty' } });
  });
});
