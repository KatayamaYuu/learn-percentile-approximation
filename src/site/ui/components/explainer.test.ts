// @vitest-environment happy-dom
// Explainer のテスト: 4 項目の見出し・注意・文書名と、ページの手引き(9.1、9.2、9.4、9.5、9.6)。
import { describe, expect, it } from 'vitest';
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { PAGE_GUIDES } from '../../content/guides';
import { createExplainer } from './explainer';

const headings = (el: HTMLElement, tag: string): string[] => [...el.querySelectorAll(tag)].map((h) => h.textContent ?? '');

describe('createExplainer', () => {
  it('ページの手法ごとに、定義・保証・計算量・向き不向きの見出しを出す', () => {
    const el = createExplainer({ page: 'streaming' });
    const streaming = ALGORITHM_EXPLAINERS.filter((e) => e.page === 'streaming');
    expect(streaming.length).toBeGreaterThan(0);
    const articles = el.querySelectorAll('article');
    expect(articles).toHaveLength(streaming.length);
    for (const [i, e] of streaming.entries()) {
      const a = articles[i] as HTMLElement;
      expect(a.querySelector('h3')?.textContent).toBe(e.name);
      expect(headings(a, 'h4').slice(0, 4)).toEqual(['定義', '保証', '計算量', '向き不向き']);
      expect(a.textContent).toContain(e.definition);
      expect(a.textContent).toContain(e.guarantee);
      expect(a.textContent).toContain(e.complexity);
      expect(a.textContent).toContain(e.suitability);
    }
  });

  it('注意(簡略化した点・保証が成り立たない条件)と詳しい文書名を出す', () => {
    const el = createExplainer({ page: 'relative' });
    const first = ALGORITHM_EXPLAINERS.find((e) => e.page === 'relative')!;
    const a = el.querySelector('article')!;
    expect(headings(a, 'h4')).toContain('注意');
    expect(headings(a, 'h4')).toContain('詳しい文書');
    for (const c of first.caveats) expect(a.textContent).toContain(c);
    for (const d of first.docRefs) expect(a.textContent).toContain(d);
    const lists = a.querySelectorAll('ul');
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it('ページの手引きを「試してみること」として出す', () => {
    const el = createExplainer({ page: 'histogram' });
    const guide = PAGE_GUIDES.find((g) => g.page === 'histogram')!;
    const section = el.querySelector('.explainer-guide')!;
    expect(section.querySelector('h2')?.textContent).toBe('試してみること');
    expect(section.textContent).toContain(guide.intro);
    expect(section.querySelectorAll('li')).toHaveLength(guide.tryThis.length);
  });

  it('手法の解説がないページ(横断比較)でも手引きだけを出す', () => {
    const el = createExplainer({ page: 'compare' });
    expect(el.querySelectorAll('article')).toHaveLength(0);
    expect(el.querySelector('.explainer-guide')).not.toBeNull();
    expect(el.textContent).not.toContain('アルゴリズムの解説');
  });

  it('explainers を渡すと、その一覧だけを出す', () => {
    const only = ALGORITHM_EXPLAINERS.filter((e) => e.id === 'kll');
    const el = createExplainer({ page: 'streaming', explainers: only });
    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.querySelector('h3')?.textContent).toBe(only[0]!.name);
  });
});
