// 表示中の結果を作った条件の表示(2.8)。結果を受け取った時点で文字列に起こして保持するため、
// そのあと操作部品の値が変わっても(まだ新しい結果が届いていない間も)表示は結果の条件のままになる。
import type { Distribution } from '../../../core';
import type { CompareAlgorithm, DataCondition, HdrRangeMode } from '../../shared/conditions';
import { formatInt, formatSig3 } from '../../shared/format';
import { REFERENCE_DEFINITION } from '../../shared/grids';
import type { JobRequest, JobResult } from '../../shared/protocol';

export interface ConditionRow {
  readonly label: string;
  readonly value: string;
}

const ORDER_LABEL: Readonly<Record<DataCondition['order'], string>> = {
  random: 'ランダム',
  ascending: '昇順',
  descending: '降順',
};

const STREAMING_LABEL = { gk: 'GK', kll: 'KLL', tdigest: 't-digest' } as const;
const RELATIVE_LABEL = { ddsketch: 'DDSketch', hdr: 'HDR' } as const;
const SCHEME_LABEL = { equal: '等幅', exponential: '指数幅' } as const;
const REFERENCE_LABEL: Readonly<Record<string, string>> = { 'nearest-rank': '最近順位法(nearest-rank)' };

function describeDistribution(d: Distribution): string {
  switch (d.kind) {
    case 'uniform':
      return `一様(最小 ${d.min}、最大 ${d.max})`;
    case 'normal':
      return `正規(平均 ${d.mean}、標準偏差 ${d.stdDev})`;
    case 'lognormal':
      return `対数正規(μ = ${d.mu}、σ = ${d.sigma})`;
    case 'heavy-tail':
      return `重い裾(尺度 ${d.scale}、形状 ${d.shape})`;
    case 'multimodal':
      return `多峰(${d.modes.map((m) => `重み ${m.weight}、平均 ${m.mean}、標準偏差 ${m.stdDev}`).map((s, i) => `山 ${i + 1}: ${s}`).join(' / ')})`;
  }
}

function describeAlgorithm(a: CompareAlgorithm): string {
  switch (a.kind) {
    case 'exact-sort':
      return '厳密解(整列)';
    case 'exact-quickselect':
      return '厳密解(quickselect)';
    case 'histogram':
      return `ヒストグラム(${SCHEME_LABEL[a.scheme]}、${formatInt(a.buckets)} バケット)`;
    case 'gk':
      return `GK(ε = ${a.epsilon})`;
    case 'kll':
      return `KLL(k = ${a.k})`;
    case 'tdigest':
      return `t-digest(δ = ${a.compression}、${a.scale})`;
    case 'ddsketch':
      return `DDSketch(α = ${a.alpha}、上限 ${formatInt(a.maxBuckets)})`;
    case 'hdr':
      return `HDR(有効桁数 ${a.significantDigits})`;
  }
}

function describeHdrRange(mode: HdrRangeMode, result: JobResult | undefined): string {
  const used = result !== undefined && (result.kind === 'relative' || result.kind === 'compare') ? result.hdrRange : null;
  const label = mode.kind === 'auto' ? '自動' : '手動';
  if (used !== null) return `${label}(${formatSig3(used.lowest)} から ${formatSig3(used.highest)})`;
  if (mode.kind === 'manual') return `${label}(${mode.lowest} から ${mode.highest})`;
  return label;
}

function dataRows(data: DataCondition): ConditionRow[] {
  return [
    { label: '分布', value: describeDistribution(data.distribution) },
    { label: '件数', value: formatInt(data.count) },
    { label: 'シード', value: String(data.seed) },
    { label: '挿入順序', value: ORDER_LABEL[data.order] },
  ];
}

/** 結果を作った条件を、項目名と値の並びにする。result があれば HDR の範囲は実際に使った範囲を出す */
export function describeCondition(job: JobRequest, result?: JobResult): readonly ConditionRow[] {
  const rows: ConditionRow[] = [];
  const push = (label: string, value: string): void => void rows.push({ label, value });
  switch (job.kind) {
    case 'histogram': {
      const c = job.condition;
      rows.push(...dataRows(c.data));
      push('バケット数', formatInt(c.buckets));
      push('境界の決め方', c.schemes.map((s) => SCHEME_LABEL[s]).join('、'));
      push('範囲', c.range.kind === 'data-extent' ? 'データの最小値から最大値' : `固定(${c.range.lower} から ${c.range.upper})`);
      break;
    }
    case 'streaming': {
      const c = job.condition;
      rows.push(...dataRows(c.data));
      push('手法', c.methods.map((m) => STREAMING_LABEL[m]).join('、'));
      if (c.methods.includes('gk')) push('GK の ε', String(c.epsilon));
      if (c.methods.includes('kll')) push('KLL の k', String(c.k));
      if (c.methods.includes('tdigest')) {
        push('t-digest の圧縮度 δ', String(c.compression));
        push('t-digest のスケール関数', c.scales.join('、'));
      }
      push('試行回数', String(c.trials));
      push('内部状態の対象', STREAMING_LABEL[c.inspectTarget]);
      break;
    }
    case 'relative': {
      const c = job.condition;
      rows.push(...dataRows(c.data));
      push('手法', c.methods.map((m) => RELATIVE_LABEL[m]).join('、'));
      if (c.methods.includes('ddsketch')) {
        push('DDSketch の α', String(c.alpha));
        push('DDSketch のバケット数の上限', formatInt(c.maxBuckets));
      }
      if (c.methods.includes('hdr')) {
        push('HDR の有効桁数', String(c.significantDigits));
        push('HDR の範囲', describeHdrRange(c.hdrRange, result));
      }
      push('内部状態の対象', RELATIVE_LABEL[c.inspectTarget]);
      break;
    }
    case 'compare': {
      const c = job.condition;
      rows.push(...dataRows(c.data));
      push('比較する手法', c.algorithms.map(describeAlgorithm).join('、'));
      if (c.algorithms.some((a) => a.kind === 'hdr')) push('HDR の範囲', describeHdrRange(c.hdrRange, result));
      break;
    }
  }
  push('基準の定義', REFERENCE_LABEL[REFERENCE_DEFINITION] ?? REFERENCE_DEFINITION);
  return rows;
}

export interface ConditionSummary {
  readonly element: HTMLElement;
  /** 結果を受け取ったときに呼ぶ。その時点の条件を表示に写す */
  show(job: JobRequest, result?: JobResult): void;
  clear(): void;
}

export function createConditionSummary(): ConditionSummary {
  const element = document.createElement('section');
  element.className = 'condition-summary';
  const heading = document.createElement('h3');
  heading.textContent = 'この結果の条件';
  element.hidden = true;
  element.append(heading);

  return {
    element,
    show(job, result) {
      const dl = document.createElement('dl');
      for (const row of describeCondition(job, result)) {
        const dt = document.createElement('dt');
        dt.textContent = row.label;
        const dd = document.createElement('dd');
        dd.textContent = row.value;
        dl.append(dt, dd);
      }
      element.replaceChildren(heading, dl);
      element.hidden = false;
    },
    clear() {
      element.replaceChildren(heading);
      element.hidden = true;
    },
  };
}
