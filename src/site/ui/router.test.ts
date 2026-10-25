// @vitest-environment happy-dom
// Router・Layout・PageRegistry のテスト(1.2、1.3、1.4、1.6、1.7、10.6)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_CONTENT } from '../content/guides';
import { createConditionStore } from './condition-store';
import { PAGES, type PageContext, type PageModule } from './page-registry';
import { resolveRoute, startRouter } from './router';

function makeContext(announce: (m: string) => void = () => {}): PageContext {
  return {
    store: createConditionStore(),
    announce,
    createCompute: () => {
      throw new Error('このテストでは計算しない');
    },
  };
}

let root: HTMLElement;
let stop: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  window.location.hash = '';
});

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
});

async function go(hash: string): Promise<void> {
  window.location.hash = hash;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await Promise.resolve();
}

describe('PAGES(1.2)', () => {
  it('5 ページ + 見つからないページを持ち、4 つの学習ページは識別・パス・題名が決まっている', () => {
    expect(PAGES.map((p) => p.id)).toEqual(['home', 'histogram', 'streaming', 'relative', 'compare', 'not-found']);
    expect(PAGES.map((p) => p.path)).toEqual(['/', '/histogram', '/streaming', '/relative-error', '/compare', null]);
    for (const p of PAGES) expect(p.title.length).toBeGreaterThan(0);
    const titles = HOME_CONTENT.families.map((f) => f.title);
    expect(PAGES.filter((p) => p.id !== 'home' && p.id !== 'not-found').map((p) => p.navLabel)).toEqual(titles);
    expect(PAGES.find((p) => p.id === 'not-found')?.navLabel).toBeNull();
  });
});

describe('resolveRoute(1.4、1.6)', () => {
  it('空・# ・#/ はトップ', () => {
    for (const h of ['', '#', '#/']) expect(resolveRoute(h).id).toBe('home');
  });
  it('4 つのパスが対応するページになる', () => {
    expect(resolveRoute('#/histogram').id).toBe('histogram');
    expect(resolveRoute('#/streaming').id).toBe('streaming');
    expect(resolveRoute('#/relative-error').id).toBe('relative');
    expect(resolveRoute('#/compare').id).toBe('compare');
  });
  it('末尾のスラッシュは許し、未知のパスは not-found', () => {
    expect(resolveRoute('#/compare/').id).toBe('compare');
    expect(resolveRoute('#/nothing').id).toBe('not-found');
    expect(resolveRoute('#/relative').id).toBe('not-found');
    expect(resolveRoute('#histogram').id).toBe('not-found');
  });
});

describe('startRouter', () => {
  it.each([
    ['', 'home'],
    ['#/', 'home'],
    ['#/histogram', 'histogram'],
    ['#/streaming', 'streaming'],
    ['#/relative-error', 'relative'],
    ['#/compare', 'compare'],
    ['#/unknown', 'not-found'],
  ] as const)('ハッシュ %s で %s のページが出る(題名が h1 とタブ題名に反映される)', (hash, id) => {
    window.location.hash = hash;
    stop = startRouter(root, makeContext());
    const page = PAGES.find((p) => p.id === id)!;
    const h1s = root.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(page.title);
    expect(document.title).toContain(page.title);
    expect(root.querySelector('main')).not.toBeNull();
  });

  it('4 つの学習ページの仮のページは「準備中」と表示する', () => {
    window.location.hash = '#/streaming';
    stop = startRouter(root, makeContext());
    expect(root.querySelector('main')!.textContent).toContain('準備中');
  });

  it('共通のナビゲーションが 5 ページへのリンクを持ち、現在のページに aria-current="page" を付ける(1.3)', async () => {
    window.location.hash = '#/histogram';
    stop = startRouter(root, makeContext());
    const nav = root.querySelector('nav')!;
    const links = [...nav.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/', '#/histogram', '#/streaming', '#/relative-error', '#/compare']);
    const current = () => links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href'));
    expect(current()).toEqual(['#/histogram']);
    await go('#/compare');
    expect(current()).toEqual(['#/compare']);
    await go('#/missing');
    expect(current()).toEqual([]);
    await go('');
    expect(current()).toEqual(['#/']);
  });

  it('ハッシュの変化でページが入れ替わり、移動後は見出しにフォーカスが移る', async () => {
    window.location.hash = '#/';
    stop = startRouter(root, makeContext());
    await go('#/compare');
    const h1 = root.querySelector('h1')!;
    expect(h1.textContent).toBe(resolveRoute('#/compare').title);
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute('tabindex')).toBe('-1');
  });

  it('ページの入れ替えで前のページの unmount が呼ばれる(停止でも呼ばれる)', async () => {
    const unmountA = vi.fn();
    const unmountB = vi.fn();
    const make = (id: 'home' | 'histogram', path: string, unmount: () => void): PageModule => ({
      id,
      path,
      title: `題名${id}`,
      navLabel: id,
      mount: (container) => {
        container.textContent = `中身${id}`;
        return { unmount };
      },
    });
    const notFound: PageModule = { id: 'not-found', path: null, title: 'なし', navLabel: null, mount: () => ({ unmount() {} }) };
    const pages = [make('home', '/', unmountA), make('histogram', '/histogram', unmountB), notFound];
    window.location.hash = '#/';
    stop = startRouter(root, makeContext(), pages);
    expect(root.querySelector('main')!.textContent).toContain('中身home');
    await go('#/histogram');
    expect(unmountA).toHaveBeenCalledTimes(1);
    expect(unmountB).not.toHaveBeenCalled();
    expect(root.querySelector('main')!.textContent).toContain('中身histogram');
    expect(root.querySelector('main')!.textContent).not.toContain('中身home');
    stop();
    stop = null;
    expect(unmountB).toHaveBeenCalledTimes(1);
    await go('#/');
    expect(root.querySelector('main')!.textContent).toContain('中身histogram');
  });

  it('ページに渡す announce がライブリージョンに書き、context の announce にも渡る(10.6)', () => {
    const outer = vi.fn();
    let received: PageContext | null = null;
    const page: PageModule = {
      id: 'home',
      path: '/',
      title: 'ホーム',
      navLabel: 'ホーム',
      mount: (_c, ctx) => {
        received = ctx;
        return { unmount() {} };
      },
    };
    const notFound: PageModule = { id: 'not-found', path: null, title: 'なし', navLabel: null, mount: () => ({ unmount() {} }) };
    stop = startRouter(root, makeContext(outer), [page, notFound]);
    const live = root.querySelector('[aria-live]')!;
    expect(live.getAttribute('role')).toBe('status');
    received!.announce('計算が完了しました');
    expect(live.textContent).toBe('計算が完了しました');
    expect(outer).toHaveBeenCalledWith('計算が完了しました');
    received!.announce('計算が完了しました');
    expect(live.textContent).toBe('計算が完了しました');
  });
});

describe('トップページ(1.7)', () => {
  it('4 系統の概要と各ページへのリンク、グラフの読み方が出る', () => {
    window.location.hash = '#/';
    stop = startRouter(root, makeContext());
    const main = root.querySelector('main')!;
    for (const f of HOME_CONTENT.families) {
      expect(main.textContent).toContain(f.title);
      expect(main.textContent).toContain(f.summary);
    }
    const hrefs = [...main.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#/histogram', '#/streaming', '#/relative-error', '#/compare']);
    const headings = [...main.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toContain('グラフの読み方');
    for (const t of HOME_CONTENT.howToRead) expect(main.textContent).toContain(t);
  });
});

describe('見つからないページ(1.6)', () => {
  it('見つからないことを伝え、トップページへの案内を出す', () => {
    window.location.hash = '#/nope';
    stop = startRouter(root, makeContext());
    const main = root.querySelector('main')!;
    expect(main.textContent).toContain('見つかりません');
    const link = main.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('#/');
    expect(link.textContent).toContain('トップページ');
  });
});
