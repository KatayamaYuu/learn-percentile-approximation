// @vitest-environment happy-dom
// ConditionSummary のテスト: 結果を作った条件を、結果の受け取り時に記録して表示する(2.8)。
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPARE,
  DEFAULT_HISTOGRAM,
  DEFAULT_RELATIVE,
  DEFAULT_STREAMING,
  type RelativePageCondition,
} from '../../shared/conditions';
import type { JobRequest, JobResult } from '../../shared/protocol';
import { createConditionSummary, describeCondition } from './condition-summary';

afterEach(() => {
  document.body.innerHTML = '';
});

const asRows = (rows: readonly { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.label, r.value]));

const relativeResult = (lowest: number, highest: number): JobResult =>
  ({ kind: 'relative', hdrRange: { lowest, highest } }) as unknown as JobResult;

describe('describeCondition', () => {
  it('共通: 分布とパラメータ、件数、シード、順序、基準の定義', () => {
    const rows = asRows(describeCondition({ kind: 'histogram', condition: DEFAULT_HISTOGRAM }));
    expect(rows['分布']).toBe('対数正規(μ = 0、σ = 1)');
    expect(rows['件数']).toBe('10,000');
    expect(rows['シード']).toBe('1');
    expect(rows['挿入順序']).toBe('ランダム');
    expect(rows['基準の定義']).toContain('最近順位法');
  });

  it('ヒストグラム: バケット数、境界の決め方、範囲', () => {
    const rows = asRows(describeCondition({ kind: 'histogram', condition: DEFAULT_HISTOGRAM }));
    expect(rows['バケット数']).toBe('32');
    expect(rows['境界の決め方']).toBe('等幅、指数幅');
    expect(rows['範囲']).toBe('データの最小値から最大値');
    const fixed = asRows(
      describeCondition({
        kind: 'histogram',
        condition: { ...DEFAULT_HISTOGRAM, range: { kind: 'fixed', lower: 1, upper: 500 } },
      }),
    );
    expect(fixed['範囲']).toBe('固定(1 から 500)');
  });

  it('分布ごとのパラメータ、順序の表示名', () => {
    const data = (distribution: RelativePageCondition['data']['distribution'], order: 'ascending' | 'descending') => ({
      kind: 'relative' as const,
      condition: { ...DEFAULT_RELATIVE, data: { ...DEFAULT_RELATIVE.data, distribution, order } },
    });
    expect(asRows(describeCondition(data({ kind: 'uniform', min: 1, max: 1000 }, 'ascending')))['分布']).toBe('一様(最小 1、最大 1000)');
    expect(asRows(describeCondition(data({ kind: 'normal', mean: 100, stdDev: 15 }, 'descending')))['挿入順序']).toBe('降順');
    expect(asRows(describeCondition(data({ kind: 'heavy-tail', scale: 1, shape: 1.5 }, 'ascending')))['分布']).toBe('重い裾(尺度 1、形状 1.5)');
    const multi = asRows(
      describeCondition(
        data({ kind: 'multimodal', modes: [{ weight: 1, mean: 50, stdDev: 5 }, { weight: 2, mean: 200, stdDev: 20 }] }, 'ascending'),
      ),
    )['分布'];
    expect(multi).toContain('多峰');
    expect(multi).toContain('重み 2、平均 200、標準偏差 20');
  });

  it('ストリーミング: 手法ごとのパラメータ、試行回数、内部状態の対象', () => {
    const rows = asRows(describeCondition({ kind: 'streaming', condition: DEFAULT_STREAMING }));
    expect(rows['手法']).toBe('GK、KLL、t-digest');
    expect(rows['GK の ε']).toBe('0.01');
    expect(rows['KLL の k']).toBe('200');
    expect(rows['t-digest の圧縮度 δ']).toBe('100');
    expect(rows['t-digest のスケール関数']).toBe('k1');
    expect(rows['試行回数']).toBe('1');
    expect(rows['内部状態の対象']).toBe('GK');
    const only = asRows(describeCondition({ kind: 'streaming', condition: { ...DEFAULT_STREAMING, methods: ['kll'] } }));
    expect(only['GK の ε']).toBeUndefined();
    expect(only['KLL の k']).toBe('200');
  });

  it('相対誤差型: α・上限・有効桁数と、HDR の範囲は結果の範囲を優先する', () => {
    const job: JobRequest = { kind: 'relative', condition: DEFAULT_RELATIVE };
    const rows = asRows(describeCondition(job, relativeResult(0.001, 5000)));
    expect(rows['DDSketch の α']).toBe('0.01');
    expect(rows['DDSketch のバケット数の上限']).toBe('2,048');
    expect(rows['HDR の有効桁数']).toBe('2');
    expect(rows['HDR の範囲']).toBe('自動(0.001 から 5000)');
    expect(rows['内部状態の対象']).toBe('DDSketch');
    // 結果がまだないときは決め方だけ
    expect(asRows(describeCondition(job))['HDR の範囲']).toBe('自動');
    const manual = asRows(
      describeCondition({
        kind: 'relative',
        condition: { ...DEFAULT_RELATIVE, hdrRange: { kind: 'manual', lowest: 0.5, highest: 100 } },
      }),
    );
    expect(manual['HDR の範囲']).toBe('手動(0.5 から 100)');
  });

  it('HDR を使わない相対誤差型では HDR の項目を出さない', () => {
    const rows = asRows(describeCondition({ kind: 'relative', condition: { ...DEFAULT_RELATIVE, methods: ['ddsketch'] } }));
    expect(rows['HDR の範囲']).toBeUndefined();
    expect(rows['HDR の有効桁数']).toBeUndefined();
  });

  it('横断比較: 手法の一覧と HDR の範囲', () => {
    const rows = asRows(describeCondition({ kind: 'compare', condition: DEFAULT_COMPARE }));
    expect(rows['比較する手法']).toContain('厳密解(整列)');
    expect(rows['比較する手法']).toContain('ヒストグラム(指数幅、64 バケット)');
    expect(rows['比較する手法']).toContain('GK(ε = 0.01)');
    expect(rows['比較する手法']).toContain('t-digest(δ = 100、k1)');
    expect(rows['比較する手法']).toContain('DDSketch(α = 0.01、上限 2,048)');
    expect(rows['比較する手法']).toContain('HDR(有効桁数 2)');
    expect(rows['HDR の範囲']).toBe('自動');
  });
});

describe('createConditionSummary', () => {
  it('結果を受け取った時点の条件を表示し、以後の条件の変更には追随しない(2.8)', () => {
    const summary = createConditionSummary();
    document.body.append(summary.element);
    const condition = { ...DEFAULT_HISTOGRAM, data: { ...DEFAULT_HISTOGRAM.data } };
    summary.show({ kind: 'histogram', condition });
    expect(summary.element.textContent).toContain('10,000');
    // 操作部品側で条件の写しが書き換わっても、表示は受け取り時のまま
    (condition.data as { count: number }).count = 500;
    expect(summary.element.textContent).toContain('10,000');
    expect(summary.element.textContent).not.toContain('500');
  });

  it('見出しと説明リスト(dt/dd)で出し、clear で空にする', () => {
    const summary = createConditionSummary();
    expect(summary.element.querySelector('h3')?.textContent).toBe('この結果の条件');
    summary.show({ kind: 'streaming', condition: DEFAULT_STREAMING });
    const terms = [...summary.element.querySelectorAll('dt')].map((e) => e.textContent);
    expect(terms).toContain('分布');
    expect(terms).toContain('シード');
    expect(summary.element.querySelectorAll('dd').length).toBe(terms.length);
    summary.clear();
    expect(summary.element.querySelector('dl')).toBeNull();
    expect(summary.element.hidden).toBe(true);
  });

  it('show のたびに表示を入れ替える', () => {
    const summary = createConditionSummary();
    summary.show({ kind: 'histogram', condition: DEFAULT_HISTOGRAM });
    summary.show({ kind: 'streaming', condition: DEFAULT_STREAMING });
    expect(summary.element.querySelectorAll('dl')).toHaveLength(1);
    expect(summary.element.textContent).toContain('GK の ε');
    expect(summary.element.textContent).not.toContain('バケット数');
  });
});
