// ページの登録。5 ページ + 見つからないページ。4 つの学習ページは、7.1 で実際のページに差し替えるまでの仮のページ(準備中)。
import { HOME_CONTENT } from '../content/guides';
import type { PageId } from '../shared/conditions';
import type { ComputeClient } from './compute/compute-client';
import type { ConditionStore } from './condition-store';
import { homePage } from './pages/home-page';
import { notFoundPage } from './pages/not-found-page';

export interface PageContext {
  readonly store: ConditionStore;
  /** ライブリージョンへの通知(10.6) */
  readonly announce: (message: string) => void;
  readonly createCompute: () => ComputeClient;
}

export interface PageInstance {
  /** ページを離れるときに呼ぶ。計算の打ち切り、グラフの破棄 */
  unmount(): void;
}

export interface PageModule {
  readonly id: PageId | 'not-found';
  /** ハッシュのパス。例: '/'、'/histogram'、'/streaming'、'/relative-error'、'/compare' */
  readonly path: string | null;
  /** ページの見出し(h1)とタブの題名 */
  readonly title: string;
  readonly navLabel: string | null;
  mount(container: HTMLElement, context: PageContext): PageInstance;
}

function familyTitle(page: PageId): string {
  const family = HOME_CONTENT.families.find((f) => f.page === page);
  if (family === undefined) throw new Error(`系統の題名が見つかりません: ${page}`);
  return family.title;
}

function placeholderPage(id: Exclude<PageId, 'home'>, path: string): PageModule {
  const title = familyTitle(id);
  return {
    id,
    path,
    title,
    navLabel: title,
    mount(container) {
      const p = document.createElement('p');
      p.textContent = 'このページは準備中です。';
      container.append(p);
      return { unmount() {} };
    },
  };
}

export const PAGES: readonly PageModule[] = [
  homePage,
  placeholderPage('histogram', '/histogram'),
  placeholderPage('streaming', '/streaming'),
  placeholderPage('relative', '/relative-error'),
  placeholderPage('compare', '/compare'),
  notFoundPage,
];
