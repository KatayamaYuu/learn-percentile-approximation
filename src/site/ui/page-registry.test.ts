// @vitest-environment happy-dom
// PageRegistry の登録内容(1.1、1.2): 4 つの学習ページは仮のページではなく実際のページのモジュール。
import { describe, expect, it } from 'vitest';
import { PAGES } from './page-registry';
import { comparePage } from './pages/compare-page';
import { histogramPage } from './pages/histogram-page';
import { homePage } from './pages/home-page';
import { notFoundPage } from './pages/not-found-page';
import { relativePage } from './pages/relative-page';
import { streamingPage } from './pages/streaming-page';

describe('PAGES は実際のページのモジュールを登録している(1.1、1.2)', () => {
  it('順序と実体が一致する', () => {
    expect(PAGES).toHaveLength(6);
    expect(PAGES[0]).toBe(homePage);
    expect(PAGES[1]).toBe(histogramPage);
    expect(PAGES[2]).toBe(streamingPage);
    expect(PAGES[3]).toBe(relativePage);
    expect(PAGES[4]).toBe(comparePage);
    expect(PAGES[5]).toBe(notFoundPage);
  });

  it('識別・パス・題名が決まっている', () => {
    expect(PAGES.map((p) => [p.id, p.path])).toEqual([
      ['home', '/'],
      ['histogram', '/histogram'],
      ['streaming', '/streaming'],
      ['relative', '/relative-error'],
      ['compare', '/compare'],
      ['not-found', null],
    ]);
    for (const p of PAGES) expect(p.title.length).toBeGreaterThan(0);
  });
});
