// ページの手引きとトップページの概要(1.7, 1.8, 8.6, 9.6)。
import { describe, expect, it } from 'vitest';
import type { PageId } from '../shared/conditions';
import { HOME_CONTENT, PAGE_GUIDES } from './guides';

const PAGES: readonly PageId[] = ['home', 'histogram', 'streaming', 'relative', 'compare'];

describe('ページの手引き(9.6)', () => {
  it('5 ページ分が 1 つずつある', () => {
    expect(PAGE_GUIDES.map((g) => g.page).sort()).toEqual([...PAGES].sort());
  });

  it.each(PAGES)('%s に導入と操作の手引きがある', (page) => {
    const g = PAGE_GUIDES.find((x) => x.page === page);
    expect(g).toBeDefined();
    expect(g!.intro.trim().length).toBeGreaterThan(10);
    expect(g!.tryThis.length).toBeGreaterThan(0);
    for (const t of g!.tryThis) {
      expect(t.trim().length).toBeGreaterThan(10);
      expect(/[ぁ-んァ-ヶ一-龠]/.test(t)).toBe(true);
    }
  });

  it('学習ページの手引きは「動かすと見える」の形で、見える現象を述べる', () => {
    for (const page of ['histogram', 'streaming', 'relative', 'compare'] as const) {
      const g = PAGE_GUIDES.find((x) => x.page === page)!;
      for (const t of g.tryThis) {
        expect(t).toMatch(/(動かす|変える|増やす|減らす|切り替える|選ぶ|狭くする|広げる|大きくする|小さくする|比べる|繰り返す)(と|ば).*(見える|わかる|分かる|現れる|表示される)/);
      }
    }
  });
});

describe('横断比較の注記(8.6)', () => {
  it('処理時間は参考値、操作数は環境によらない目安', () => {
    const g = PAGE_GUIDES.find((x) => x.page === 'compare')!;
    const text = [g.intro, ...g.tryThis].join('\n');
    expect(text).toContain('参考値');
    expect(text).toContain('環境によらない');
    expect(text).toContain('処理時間');
    expect(text).toContain('操作数');
  });
});

describe('トップページ(1.7, 1.8)', () => {
  it('系統の概要が 4 つの学習ページを指す', () => {
    expect(HOME_CONTENT.families.map((f) => f.page).sort()).toEqual(['compare', 'histogram', 'relative', 'streaming']);
    for (const f of HOME_CONTENT.families) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.summary.length).toBeGreaterThan(10);
    }
  });

  it('グラフの読み方に、軸の尺度と誤差・操作数・メモリの意味が入る', () => {
    expect(HOME_CONTENT.howToRead.length).toBeGreaterThanOrEqual(3);
    const text = HOME_CONTENT.howToRead.join('\n');
    for (const w of ['対数', '誤差', '操作数', 'メモリ']) expect(text).toContain(w);
  });
});
