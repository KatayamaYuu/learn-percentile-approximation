// @vitest-environment happy-dom
// 横断比較のページのテスト(8.1〜8.8、9.2)。偽の計算の窓口と、実際のジョブ(runCompare)で作った結果を使う。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartSpec } from '../../shared/chart-spec';
import { DEFAULT_COMPARE, PAGE_DEFAULTS, type CompareAlgorithm, type CompareCondition } from '../../shared/conditions';
import { formatInt, formatSig3 } from '../../shared/format';
import { DEFAULT_ERROR_SELECTION } from '../../shared/metric';
import type { CompareResult, JobRequest } from '../../shared/protocol';
import { buildCompareCharts, ELAPSED_REFERENCE_NOTE } from '../../shared/views/compare-view';
import { runCompare } from '../../worker/run-compare';
import { PAGE_GUIDES } from '../../content/guides';
import type { ChartPanel } from '../components/chart-panel';
import type { ComputeClient, ComputeStatus } from '../compute/compute-client';
import { createConditionStore } from '../condition-store';
import { reasonOf, typeInto } from '../controls/test-helpers';
import type { PageContext } from '../page-registry';
import { comparePage, mountComparePage } from './compare-page';

afterEach(() => {
  document.body.innerHTML = '';
});

const SMALL: CompareCondition = { ...DEFAULT_COMPARE, data: { ...DEFAULT_COMPARE.data, count: 1000 } };

function realResult(condition: CompareCondition): CompareResult {
  const r = runCompare(condition);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

interface FakeClient extends ComputeClient {
  readonly requests: JobRequest[];
  readonly emit: (s: ComputeStatus) => void;
}

function fakeClient(): FakeClient {
  const listeners = new Set<(s: ComputeStatus) => void>();
  const requests: JobRequest[] = [];
  return {
    requests,
    request: (job) => void requests.push(job),
    retry: () => {},
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    dispose: () => {},
    emit: (s) => {
      for (const l of [...listeners]) l(s);
    },
  };
}

function setup(initial?: CompareCondition) {
  const client = fakeClient();
  const store = createConditionStore();
  if (initial !== undefined) store.set('compare', initial);
  const context: PageContext = { store, announce: vi.fn(), createCompute: () => client };
  const container = document.createElement('div');
  document.body.append(container);
  const instance = mountComparePage(container, context, {
    createPanel: (s) => {
      const element = document.createElement('section');
      element.className = 'chart-panel';
      const render = (c: ChartSpec) => {
        element.textContent = [c.title, ...c.notes, ...c.referenceLines.map((r) => r.label)].join('\n');
        element.dataset.chart = c.id;
      };
      render(s);
      return { element, update: render, destroy: () => element.remove() } as unknown as ChartPanel;
    },
  });
  const last = (): CompareCondition => {
    const j = client.requests.at(-1);
    if (j === undefined || j.kind !== 'compare') throw new Error('no compare request');
    return j.condition;
  };
  const $ = <T extends HTMLElement>(id: string): T => container.querySelector<T>(`#${id}`)!;
  const select = (id: string, value: string) => {
    const sel = $<HTMLSelectElement>(id);
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const click = (el: Element) => el.dispatchEvent(new Event('click', { bubbles: true }));
  const items = () => [...container.querySelectorAll<HTMLElement>('.compare-algorithm-list > li')];
  const removeButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.compare-algorithm-list button')];
  const chartIds = () => [...container.querySelectorAll<HTMLElement>('.chart-panel')].map((p) => p.dataset.chart);
  return { client, store, container, instance, last, $, select, click, items, removeButtons, chartIds };
}

describe('comparePage', () => {
  it('ページの登録の形(題名・パス)を持つ', () => {
    expect(comparePage.id).toBe('compare');
    expect(comparePage.path).toBe('/compare');
    expect(comparePage.title).toBe(comparePage.navLabel);
    expect(comparePage.title.length).toBeGreaterThan(0);
  });

  it('共通の条件と、手法の一覧・追加の部品・共通の HDR の範囲を置き、既定の条件で依頼する(8.1)', () => {
    const t = setup();
    for (const id of [
      'distribution-kind', 'cmp-count', 'cmp-seed', 'cmp-order',
      'cmp-add-kind', 'cmp-add', 'cmp-hdr-range-kind', 'cmp-hdr-lowest', 'cmp-hdr-highest',
    ]) {
      expect(t.$(id), id).not.toBeNull();
    }
    expect(t.client.requests).toHaveLength(1);
    expect(t.last()).toEqual(PAGE_DEFAULTS.compare);
    expect(t.items()).toHaveLength(DEFAULT_COMPARE.algorithms.length);
    // 一覧の各項目に外すボタンがある
    expect(t.removeButtons()).toHaveLength(DEFAULT_COMPARE.algorithms.length);
    expect(t.items()[0]!.textContent).toContain('厳密解');
    expect(t.$('cmp-hdr-range-manual').hidden).toBe(true);
  });

  it('記録した結果で、比較表・グラフ・処理時間の注記・各ページへの案内・解説が出て、表の値は結果と一致する(8.3、8.4、8.5、8.6、9.2)', () => {
    const t = setup(SMALL);
    const result = realResult(SMALL);
    t.client.emit({ state: 'done', result });
    const ids = t.chartIds();
    for (const id of [
      'compare-method-error', 'compare-method-memory', 'compare-method-operations', 'compare-method-elapsed',
      'compare-quantile-error', 'compare-count-memory', 'compare-count-elapsed',
    ]) {
      expect(ids, id).toContain(id);
    }
    // 比較表: 本物の table、caption、列と行の見出し
    const table = t.container.querySelector('table.compare-table')!;
    expect(table).not.toBeNull();
    expect(table.querySelector('caption')?.textContent).toContain('比較表');
    const heads = [...table.querySelectorAll('thead th')];
    expect(heads.length).toBeGreaterThanOrEqual(6);
    expect(heads.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
    const bodyRows = [...table.querySelectorAll('tbody tr')];
    const { rows } = buildCompareCharts(result, SMALL, { selection: DEFAULT_ERROR_SELECTION });
    expect(bodyRows).toHaveLength(rows.length);
    rows.forEach((row, i) => {
      const tr = bodyRows[i]!;
      const th = tr.querySelector('th')!;
      expect(th.getAttribute('scope')).toBe('row');
      expect(th.textContent).toBe(row.label);
      expect(row.status).toBe('ok');
      const cells = [...tr.querySelectorAll('td')].map((c) => c.textContent);
      expect(cells).toEqual([
        formatSig3(row.error!),
        formatInt(row.memoryBytes!),
        formatInt(row.insertOperations!),
        formatInt(row.queryOperations!),
        formatSig3(row.elapsedMs!),
      ]);
    });
    // 厳密解の誤差は 0 のまま
    expect(bodyRows[0]!.querySelectorAll('td')[0]!.textContent).toBe(formatSig3(0));
    // 処理時間の注記
    expect(t.container.querySelector('.compare-note')?.textContent).toContain(ELAPSED_REFERENCE_NOTE);
    // 条件の表示、解説の手引き
    expect(t.container.querySelector('.condition-summary')?.textContent).toContain('1,000');
    const guide = PAGE_GUIDES.find((g) => g.page === 'compare')!;
    expect(t.container.querySelector('.explainer-guide')?.textContent).toContain(guide.tryThis[0]);
    // 各ページの解説への案内(ナビゲーションと同じハッシュのリンク)
    const hrefs = [...t.container.querySelectorAll<HTMLAnchorElement>('.explainer-links a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#/histogram', '#/streaming', '#/relative-error']);
  });

  it('誤差の選択を変えると、表の誤差の列と見出しが選択に合わせて作り直される(8.3)', () => {
    const t = setup(SMALL);
    const result = realResult(SMALL);
    t.client.emit({ state: 'done', result });
    const before = t.container.querySelector('.compare-table caption')?.textContent;
    const sel = t.container.querySelector<HTMLSelectElement>('.control-error-selector select')!;
    sel.value = 'relative';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const after = t.container.querySelector('.compare-table caption')?.textContent;
    expect(after).not.toBe(before);
    const { rows } = buildCompareCharts(result, SMALL, { selection: { metric: 'relative', pick: { kind: 'max' } } });
    const firstTd = t.container.querySelector('.compare-table tbody tr:nth-child(2) td')!.textContent;
    expect(firstTd).toBe(formatSig3(rows[1]!.error!));
  });

  it('HDR だけが範囲外で失敗したとき、表にその手法の理由が出て、残りの手法の値は表に残る(8.8)', () => {
    const cond: CompareCondition = { ...SMALL, hdrRange: { kind: 'manual', lowest: 1000, highest: 2000 } };
    const result = realResult(cond);
    const t = setup(cond);
    t.client.emit({ state: 'done', result });
    const { rows } = buildCompareCharts(result, cond, { selection: DEFAULT_ERROR_SELECTION });
    const failed = rows.filter((r) => r.status === 'error');
    expect(failed.map((r) => r.id)).toEqual(['hdr-d2']);
    const trs = [...t.container.querySelectorAll('.compare-table tbody tr')];
    const failedTr = trs.find((tr) => tr.querySelector('th')?.textContent === failed[0]!.label)!;
    expect(failedTr.textContent).toContain('計算できませんでした');
    expect(failedTr.textContent).toContain(failed[0]!.reason!);
    expect(failed[0]!.reason!.length).toBeGreaterThan(0);
    expect(failedTr.querySelectorAll('td')).toHaveLength(1); // 値の列は理由 1 つにまとめる
    expect(trs.filter((tr) => tr !== failedTr).every((tr) => tr.querySelectorAll('td').length === 5)).toBe(true);
    expect(t.chartIds()).toContain('compare-method-error');
  });

  it('バケットの総数の上限で除いた HDR の有効桁数が、理由つきの行で表に出る(8.8)', () => {
    const algorithms: CompareAlgorithm[] = [
      { kind: 'exact-sort' },
      ...[2, 5].map((d): CompareAlgorithm => ({ kind: 'hdr', significantDigits: d })),
    ];
    const cond: CompareCondition = { ...SMALL, algorithms, hdrRange: { kind: 'manual', lowest: 1e-60, highest: 1e60 } };
    const result = realResult(cond);
    expect(result.hdrPlan.excluded.map((e) => e.significantDigits)).toEqual([5]);
    const t = setup(cond);
    t.client.emit({ state: 'done', result });
    const excludedDigits = result.hdrPlan.excluded.map((e) => e.significantDigits);
    const trs = [...t.container.querySelectorAll('.compare-table tbody tr')];
    for (const d of excludedDigits) {
      const tr = trs.find((r) => r.querySelector('th')?.textContent === `HDR Histogram(有効桁数=${d})`);
      expect(tr, `d=${d}`).toBeDefined();
      expect(tr!.textContent).toContain('除きました');
    }
    expect(t.container.querySelector('.compare-table')?.textContent).toContain('計算できませんでした');
  });

  it('手法を 0 件にすると、選択を促す理由が出て依頼しない。追加すると依頼を再開する(8.7)', () => {
    const t = setup({ ...SMALL, algorithms: [{ kind: 'exact-sort' }] });
    const before = t.client.requests.length;
    click0(t);
    expect(t.items()).toHaveLength(0);
    expect(t.client.requests).toHaveLength(before);
    expect(t.container.querySelector('.compare-algorithms-reason')?.textContent).toContain('1 つ以上選んでください');
    expect(t.container.querySelector('.status-failed')).not.toBeNull();
    // 追加で解消する
    t.select('cmp-add-kind', 'exact-quickselect');
    t.click(t.$('cmp-add'));
    expect(t.items()).toHaveLength(1);
    expect(t.last().algorithms).toEqual([{ kind: 'exact-quickselect' }]);
    expect(t.container.querySelector('.compare-algorithms-reason')?.textContent ?? '').toBe('');
  });

  it('同じ種類・同じパラメータの手法は追加できず理由が出る。パラメータを変えれば追加できる(8.1)', () => {
    const t = setup();
    const count = t.items().length;
    const requests = t.client.requests.length;
    t.select('cmp-add-kind', 'gk');
    t.click(t.$('cmp-add')); // 既定の ε=0.01 は既に選ばれている
    expect(t.items()).toHaveLength(count);
    expect(t.client.requests).toHaveLength(requests);
    expect(t.$('cmp-add-reason').textContent).toContain('既に');
    expect(t.last().algorithms).toHaveLength(count);

    typeInto(t.$('cmp-add-epsilon-number'), '0.05');
    t.click(t.$('cmp-add'));
    expect(t.items()).toHaveLength(count + 1);
    expect(t.last().algorithms.at(-1)).toEqual({ kind: 'gk', epsilon: 0.05 });
    expect(t.$('cmp-add-reason').textContent).toBe('');
    // 厳密解のようにパラメータのない手法も重複できない
    t.select('cmp-add-kind', 'exact-sort');
    t.click(t.$('cmp-add'));
    expect(t.items()).toHaveLength(count + 1);
    expect(t.$('cmp-add-reason').textContent).toContain('既に');
  });

  it('種類ごとのパラメータの入力が出て、追加した手法に写る(8.1)', () => {
    const t = setup({ ...SMALL, algorithms: [{ kind: 'exact-sort' }] });
    const add = (kind: string) => {
      t.select('cmp-add-kind', kind);
      t.click(t.$('cmp-add'));
      return t.last().algorithms.at(-1);
    };
    expect(t.$('cmp-add-params-histogram').hidden).toBe(true);
    t.select('cmp-add-kind', 'histogram');
    expect(t.$('cmp-add-params-histogram').hidden).toBe(false);
    expect(t.$('cmp-add-params-gk').hidden).toBe(true);
    select2(t, 'cmp-add-scheme', 'equal');
    typeInto(t.$('cmp-add-buckets-number'), '16');
    expect(add('histogram')).toEqual({ kind: 'histogram', scheme: 'equal', buckets: 16 });
    typeInto(t.$('cmp-add-k-number'), '300');
    expect(add('kll')).toEqual({ kind: 'kll', k: 300 });
    typeInto(t.$('cmp-add-compression-number'), '50');
    select2(t, 'cmp-add-scale', 'k2');
    expect(add('tdigest')).toEqual({ kind: 'tdigest', compression: 50, scale: 'k2' });
    typeInto(t.$('cmp-add-alpha-number'), '0.05');
    typeInto(t.$('cmp-add-max-buckets-number'), '64');
    expect(add('ddsketch')).toEqual({ kind: 'ddsketch', alpha: 0.05, maxBuckets: 64 });
    typeInto(t.$('cmp-add-digits-number'), '3');
    expect(add('hdr')).toEqual({ kind: 'hdr', significantDigits: 3 });
    expect(t.items()).toHaveLength(6);
  });

  it('手法を外すと依頼に写り、外した手法の分だけ一覧が減る(8.1)', () => {
    const t = setup();
    const n = DEFAULT_COMPARE.algorithms.length;
    t.click(t.removeButtons()[1]!); // ヒストグラム
    expect(t.items()).toHaveLength(n - 1);
    expect(t.last().algorithms.map((a) => a.kind)).not.toContain('histogram');
    expect(t.removeButtons()[0]!.getAttribute('aria-label')).toContain('を外す');
  });

  it('共通の HDR の範囲を手動にすると下限・上限の入力が出て、依頼に写る。下限 ≥ 上限は理由が出て依頼しない(8.1)', () => {
    const t = setup(SMALL);
    t.select('cmp-hdr-range-kind', 'manual');
    expect(t.$('cmp-hdr-range-manual').hidden).toBe(false);
    expect(t.last().hdrRange.kind).toBe('manual');
    typeInto(t.$('cmp-hdr-lowest'), '0.5');
    typeInto(t.$('cmp-hdr-highest'), '5000');
    expect(t.last().hdrRange).toEqual({ kind: 'manual', lowest: 0.5, highest: 5000 });
    const before = t.client.requests.length;
    typeInto(t.$('cmp-hdr-lowest'), '99999999');
    expect(t.client.requests).toHaveLength(before);
    expect(reasonOf(t.$('cmp-hdr-lowest')) ?? reasonOf(t.$('cmp-hdr-highest'))).not.toBeNull();
    t.select('cmp-hdr-range-kind', 'auto');
    expect(t.last().hdrRange).toEqual({ kind: 'auto' });
  });

  it('既定に戻すと一覧と条件が既定に戻る', () => {
    const t = setup({ ...SMALL, algorithms: [{ kind: 'exact-sort' }] });
    expect(t.items()).toHaveLength(1);
    const reset = [...t.container.querySelectorAll('button')].find((b) => b.textContent === '既定に戻す')!;
    t.click(reset);
    expect(t.items()).toHaveLength(DEFAULT_COMPARE.algorithms.length);
    expect(t.last()).toEqual(PAGE_DEFAULTS.compare);
  });

  it('Worker が返した手法ごとの設定の誤りが、その手法の項目のそばに出る(8.8)', () => {
    const t = setup({ ...SMALL, algorithms: [{ kind: 'exact-sort' }, { kind: 'gk', epsilon: 0.01 }] });
    t.client.emit({
      state: 'failed',
      failure: { kind: 'invalid-condition', issues: [{ field: 'algorithms[1].epsilon', reason: 'ε が不正です。' }] },
    });
    expect(t.items()[1]!.textContent).toContain('ε が不正です。');
    expect(t.items()[0]!.textContent).not.toContain('ε が不正です。');
  });
});

function click0(t: ReturnType<typeof setup>): void {
  for (const b of t.removeButtons()) t.click(b);
}

function select2(t: ReturnType<typeof setup>, id: string, value: string): void {
  t.select(id, value);
}
