import { describe, expect, it } from 'vitest';
import { BYTES_PER_NUMBER, estimateBytes } from './memory-model';

describe('estimateBytes', () => {
  it('1 個あたり 8 バイト', () => {
    expect(BYTES_PER_NUMBER).toBe(8);
  });

  it('(数値の個数 + カウンタの個数) × 8 バイト', () => {
    expect(estimateBytes({ numbers: 0, counters: 0 })).toBe(0);
    expect(estimateBytes({ numbers: 10, counters: 0 })).toBe(80);
    expect(estimateBytes({ numbers: 0, counters: 3 })).toBe(24);
    expect(estimateBytes({ numbers: 10, counters: 3 })).toBe(104);
  });
});
