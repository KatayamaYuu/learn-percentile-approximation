// ハッシュ → ページ。直接開く・再読み込み・サブパス配置でも同じページを表示する(1.4、1.5、1.6)。
import { renderLayout } from './layout';
import { PAGES, type PageContext, type PageInstance, type PageModule } from './page-registry';

/** '#/streaming' → streaming のページ。'' と '#' と '#/' はトップ。それ以外の未知のパスは not-found */
export function resolveRoute(hash: string, pages: readonly PageModule[] = PAGES): PageModule {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path === '') path = '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const found = pages.find((p) => p.path === path);
  if (found !== undefined) return found;
  const notFound = pages.find((p) => p.id === 'not-found');
  if (notFound === undefined) throw new Error('見つからないページが登録されていません');
  return notFound;
}

/**
 * レイアウトを描き、ハッシュに応じたページを表示する。ハッシュが変わると前のページの unmount を呼んで入れ替える。
 * ページに渡す announce はレイアウトのライブリージョンに書き、context の announce にも渡す。戻り値は停止の関数。
 */
export function startRouter(root: HTMLElement, context: PageContext, pages: readonly PageModule[] = PAGES): () => void {
  const layout = renderLayout(root, pages);
  const pageContext: PageContext = {
    ...context,
    announce: (message) => {
      layout.announce(message);
      context.announce(message);
    },
  };
  let current: PageInstance | null = null;
  let shownHash: string | null = null;

  const show = (initial: boolean): void => {
    const hash = window.location.hash;
    if (hash === shownHash) return;
    shownHash = hash;
    current?.unmount();
    current = null;
    layout.content.textContent = '';
    const page = resolveRoute(hash, pages);
    layout.setCurrent(page);
    current = page.mount(layout.content, pageContext);
    if (!initial) layout.heading.focus();
  };

  const onHashChange = (): void => show(false);
  window.addEventListener('hashchange', onHashChange);
  show(true);

  return () => {
    window.removeEventListener('hashchange', onHashChange);
    current?.unmount();
    current = null;
  };
}
