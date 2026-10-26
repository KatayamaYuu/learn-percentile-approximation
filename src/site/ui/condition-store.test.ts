// @vitest-environment happy-dom
// ConditionStore のテスト: ページごとの最後の条件をメモリに保持する(2.9)。
import { describe, expect, it } from 'vitest';
import { PAGE_DEFAULTS } from '../shared/conditions';
import { createConditionStore } from './condition-store';

describe('ConditionStore', () => {
  it('未設定のページは undefined を返す', () => {
    const store = createConditionStore();
    expect(store.get('histogram')).toBeUndefined();
    expect(store.get('compare')).toBeUndefined();
  });

  it('設定した条件をページごとに独立して返す', () => {
    const store = createConditionStore();
    const h = { ...PAGE_DEFAULTS.histogram, buckets: 64 };
    const s = { ...PAGE_DEFAULTS.streaming, epsilon: 0.05 };
    store.set('histogram', h);
    store.set('streaming', s);
    expect(store.get('histogram')).toBe(h);
    expect(store.get('streaming')).toBe(s);
    expect(store.get('relative')).toBeUndefined();
  });

  it('上書きでき、別のストアには共有されない(再読み込みで既定に戻る)', () => {
    const a = createConditionStore();
    const b = createConditionStore();
    a.set('relative', PAGE_DEFAULTS.relative);
    const next = { ...PAGE_DEFAULTS.relative, alpha: 0.02 };
    a.set('relative', next);
    expect(a.get('relative')).toBe(next);
    expect(b.get('relative')).toBeUndefined();
  });
});
