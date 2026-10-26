// @vitest-environment happy-dom
// StateTable のテスト: 内部状態・バケットの表と、省略の表示・観察の拒否の理由(5.8、6.6)。
import { afterEach, describe, expect, it } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import { limitTableRows, type InspectionView } from '../../shared/views/streaming-view';
import { createStateTable } from './state-table';

afterEach(() => {
  document.body.innerHTML = '';
});

const chart: ChartSpec = {
  id: 'c',
  title: '図',
  x: { label: 'x', unit: '', scale: 'linear', toggleable: false },
  y: { label: 'y', unit: '', scale: 'linear', toggleable: false },
  series: [],
  referenceLines: [],
  notes: [],
  summary: '',
};

function view(rowCount: number): InspectionView {
  const all = Array.from({ length: rowCount }, (_, i) => [String(i + 1), `v${i + 1}`]);
  const limited = limitTableRows(all);
  return {
    chart,
    table: { caption: 'GK のタプル', columns: ['番号', '値'], rows: limited.rows },
    truncated: limited.truncated,
    truncation: limited.truncation,
    facts: [{ label: 'タプル数', value: String(rowCount) }],
  };
}

describe('createStateTable', () => {
  it('キャプション・列見出し(scope=col)・行を表にする', () => {
    const t = createStateTable();
    document.body.append(t.element);
    t.show(view(3));
    const table = t.element.querySelector('table')!;
    expect(table.querySelector('caption')?.textContent).toBe('GK のタプル');
    const heads = [...table.querySelectorAll('thead th')];
    expect(heads.map((h) => h.textContent)).toEqual(['番号', '値']);
    expect(heads.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(t.element.querySelector('.state-table-notice')).toBeNull();
  });

  it('事実(facts)を説明リストで出す', () => {
    const t = createStateTable();
    t.show(view(3));
    expect(t.element.querySelector('dt')?.textContent).toBe('タプル数');
    expect(t.element.querySelector('dd')?.textContent).toBe('3');
  });

  it('上限を超える表は省略の通知を出し、先頭と末尾の間に省略の行を挟む', () => {
    const t = createStateTable();
    t.show(view(450));
    const notice = t.element.querySelector('.state-table-notice')!;
    expect(notice.textContent).toBe('先頭 100 行と末尾 100 行を表示(全 450 行)');
    const rows = t.element.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(201);
    const gap = rows[100]!;
    expect(gap.textContent).toContain('250 行を省略');
    expect(gap.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(rows[99]!.textContent).toContain('v100');
    expect(rows[101]!.textContent).toContain('v351');
  });

  it('観察が拒否されたときは表を出さず理由を出す', () => {
    const t = createStateTable();
    t.show(view(3));
    t.show({ rejected: 'HDR の範囲がデータを覆わないため観察できません。' });
    expect(t.element.querySelector('table')).toBeNull();
    expect(t.element.textContent).toContain('HDR の範囲がデータを覆わないため観察できません。');
  });

  it('clear で空にして隠す。show で再表示する', () => {
    const t = createStateTable();
    t.show(view(3));
    t.clear();
    expect(t.element.hidden).toBe(true);
    expect(t.element.querySelector('table')).toBeNull();
    t.show(view(2));
    expect(t.element.hidden).toBe(false);
    expect(t.element.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('表のスクロール枠はキーボードで操作でき、名前が付く', () => {
    const t = createStateTable();
    t.show(view(2));
    const wrap = t.element.querySelector('.state-table-scroll')!;
    expect(wrap.getAttribute('tabindex')).toBe('0');
    expect(wrap.getAttribute('role')).toBe('region');
    expect(wrap.getAttribute('aria-label')).toBe('GK のタプル');
  });
});
