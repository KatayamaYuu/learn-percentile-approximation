// トップページ: 系統の概要、各ページへの案内、グラフの読み方(1.7)。
import { HOME_CONTENT, PAGE_GUIDES } from '../../content/guides';
import type { PageId } from '../../shared/conditions';
import type { PageModule } from '../page-registry';

const PATHS: Readonly<Record<Exclude<PageId, 'home'>, string>> = {
  histogram: '#/histogram',
  streaming: '#/streaming',
  relative: '#/relative-error',
  compare: '#/compare',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className !== undefined) e.className = className;
  return e;
}

export const homePage: PageModule = {
  id: 'home',
  path: '/',
  title: 'パーセンタイル近似を学ぶ',
  navLabel: 'トップ',
  mount(container) {
    const guide = PAGE_GUIDES.find((g) => g.page === 'home');
    if (guide !== undefined) {
      container.append(el('p', guide.intro, 'home-intro'));
    }

    const overview = el('section', undefined, 'home-section');
    overview.append(el('h2', '4 つの系統'));
    const grid = el('div', undefined, 'home-families');
    for (const family of HOME_CONTENT.families) {
      const card = el('article', undefined, 'home-family');
      card.append(el('h3', family.title), el('p', family.summary));
      const link = el('a', `${family.title}のページを開く`, 'home-link');
      link.href = PATHS[family.page as Exclude<PageId, 'home'>];
      card.append(link);
      grid.append(card);
    }
    overview.append(grid);
    container.append(overview);

    if (guide !== undefined && guide.tryThis.length > 0) {
      const section = el('section', undefined, 'home-section');
      section.append(el('h2', '使い方のヒント'));
      const ul = el('ul');
      for (const t of guide.tryThis) ul.append(el('li', t));
      section.append(ul);
      container.append(section);
    }

    const howTo = el('section', undefined, 'home-section');
    howTo.append(el('h2', 'グラフの読み方'));
    const list = el('ul');
    for (const t of HOME_CONTENT.howToRead) list.append(el('li', t));
    howTo.append(list);
    container.append(howTo);

    return { unmount() {} };
  },
};
