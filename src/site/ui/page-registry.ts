// ページの登録。5 ページ + 見つからないページ。
import type { PageId } from '../shared/conditions';
import type { ComputeClient } from './compute/compute-client';
import type { ConditionStore } from './condition-store';
import { comparePage } from './pages/compare-page';
import { histogramPage } from './pages/histogram-page';
import { homePage } from './pages/home-page';
import { notFoundPage } from './pages/not-found-page';
import { relativePage } from './pages/relative-page';
import { streamingPage } from './pages/streaming-page';

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

export const PAGES: readonly PageModule[] = [
  homePage,
  histogramPage,
  streamingPage,
  relativePage,
  comparePage,
  notFoundPage,
];
