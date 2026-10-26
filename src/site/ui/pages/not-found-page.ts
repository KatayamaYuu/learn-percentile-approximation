// 見つからないページ: ページが見つからないことと、トップページへの案内(1.6)。
import type { PageModule } from '../page-registry';

export const notFoundPage: PageModule = {
  id: 'not-found',
  path: null,
  title: 'ページが見つかりません',
  navLabel: null,
  mount(container) {
    const p = document.createElement('p');
    p.textContent = '指定されたアドレスのページは見つかりません。アドレスを確かめるか、トップページから目的のページを選んでください。';
    const link = document.createElement('a');
    link.href = '#/';
    link.textContent = 'トップページへ戻る';
    link.className = 'home-link';
    container.append(p, link);
    return { unmount() {} };
  },
};
