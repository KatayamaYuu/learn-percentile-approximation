// 共通のレイアウト: サイト名、ナビゲーション(現在のページを aria-current)、本文の枠(h1 とページの領域)、ライブリージョン(1.3、10.6)。
import type { PageModule } from './page-registry';

export const SITE_NAME = 'パーセンタイル近似を学ぶ実験サイト';

export interface Layout {
  /** ページを載せる領域(h1 の下) */
  readonly content: HTMLElement;
  readonly heading: HTMLHeadingElement;
  /** ライブリージョンに通知する(同じ文でも読み上げ直されるよう、いったん空にする) */
  announce(message: string): void;
  /** ナビゲーションの現在のページ、見出し、ページ題名を更新する */
  setCurrent(page: PageModule): void;
}

function navHref(page: PageModule): string {
  return `#${page.path ?? '/'}`;
}

export function renderLayout(root: HTMLElement, pages: readonly PageModule[]): Layout {
  root.textContent = '';

  const header = document.createElement('header');
  header.className = 'site-header';
  const name = document.createElement('p');
  name.className = 'site-name';
  name.textContent = SITE_NAME;
  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'ページ移動');
  const list = document.createElement('ul');
  const links = new Map<PageModule, HTMLAnchorElement>();
  for (const page of pages) {
    if (page.navLabel === null || page.path === null) continue;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = navHref(page);
    a.textContent = page.navLabel;
    li.append(a);
    list.append(li);
    links.set(page, a);
  }
  nav.append(list);
  header.append(name, nav);

  const main = document.createElement('main');
  main.className = 'site-main';
  const heading = document.createElement('h1');
  heading.tabIndex = -1;
  const content = document.createElement('div');
  content.className = 'page-content';
  main.append(heading, content);

  const live = document.createElement('div');
  live.className = 'visually-hidden';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  root.append(header, main, live);

  return {
    content,
    heading,
    announce(message) {
      live.textContent = '';
      live.textContent = message;
    },
    setCurrent(page) {
      for (const [p, a] of links) {
        if (p === page) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      heading.textContent = page.title;
      document.title = `${page.title} - ${SITE_NAME}`;
    },
  };
}
