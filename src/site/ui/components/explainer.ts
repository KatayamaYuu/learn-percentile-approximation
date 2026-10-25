// アルゴリズムの解説(定義・保証・計算量・向き不向きの 4 項目 + 注意 + 文書名)とページの手引きの表示(9.1、9.2、9.4、9.5、9.6)。
import { ALGORITHM_EXPLAINERS, type AlgorithmExplainer } from '../../content/algorithms';
import { PAGE_GUIDES } from '../../content/guides';
import type { PageId } from '../../shared/conditions';

export interface ExplainerOptions {
  readonly page: PageId;
  /** 表示する解説。省略するとそのページの全手法 */
  readonly explainers?: readonly AlgorithmExplainer[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className !== undefined) e.className = className;
  return e;
}

function bullets(items: readonly string[]): HTMLUListElement {
  const ul = el('ul');
  for (const item of items) ul.append(el('li', item));
  return ul;
}

function renderAlgorithm(e: AlgorithmExplainer): HTMLElement {
  const article = el('article', undefined, 'explainer-item');
  article.id = `explainer-${e.id}`;
  article.append(el('h3', e.name));
  const items: readonly (readonly [string, string])[] = [
    ['定義', e.definition],
    ['保証', e.guarantee],
    ['計算量', e.complexity],
    ['向き不向き', e.suitability],
  ];
  for (const [title, body] of items) article.append(el('h4', title), el('p', body));
  article.append(el('h4', '注意'), bullets(e.caveats));
  article.append(el('h4', '詳しい文書'), bullets(e.docRefs));
  return article;
}

export function createExplainer(options: ExplainerOptions): HTMLElement {
  const root = el('section', undefined, 'explainer');
  const explainers = options.explainers ?? ALGORITHM_EXPLAINERS.filter((e) => e.page === options.page);
  if (explainers.length > 0) {
    const section = el('div', undefined, 'explainer-algorithms');
    section.append(el('h2', 'アルゴリズムの解説'));
    for (const e of explainers) section.append(renderAlgorithm(e));
    root.append(section);
  }
  const guide = PAGE_GUIDES.find((g) => g.page === options.page);
  if (guide !== undefined) {
    const section = el('div', undefined, 'explainer-guide');
    section.append(el('h2', '試してみること'), el('p', guide.intro), bullets(guide.tryThis));
    root.append(section);
  }
  return root;
}
