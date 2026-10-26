// 描画層: ChartRenderer は差し替え可能な境界で、既定は Chart.js。設定の組み立ては純粋関数にして canvas なしでも確かめられる。
import { Chart } from 'chart.js';
import type { ChartConfiguration, ChartDataset } from 'chart.js';
import type { AxisSpec, ChartSpec, SeriesSpec } from '../../shared/chart-spec';
import { formatInt, formatSig3 } from '../../shared/format';
import { setupChart } from './chart-setup';
import { DASHED_FALLBACK, REFERENCE_STYLE, SERIES_STYLES, styleFor } from './chart-styles';

export interface ChartRenderer {
  render(canvas: HTMLCanvasElement, spec: ChartSpec, options: { readonly animate: boolean }): void;
  /** options.animate を渡すと、以後の描画のアニメーションの有無を切り替える(動きを減らす設定の変更に追従) */
  update(spec: ChartSpec, options?: { readonly animate: boolean }): void;
  destroy(): void;
}

function axisTitle(axis: AxisSpec): string {
  return axis.unit === '' ? axis.label : `${axis.label}(${axis.unit})`;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) && Math.abs(v) < 1e15 ? formatInt(v) : formatSig3(v);
}

function isCategorical(spec: ChartSpec): boolean {
  return spec.series.some((s) => s.points.some((p) => typeof p.x === 'string'));
}

/** category 軸の項目名。全系列の x を最初に現れた順に重複なく並べる(系列ごとに 1 点でも全項目が軸に出る) */
function categoryLabels(spec: ChartSpec): string[] {
  return [...new Set(spec.series.flatMap((s) => s.points.map((p) => String(p.x))))];
}

function seriesDataset(s: SeriesSpec, index: number): ChartDataset {
  const style = styleFor(index);
  const lap = Math.floor(index / SERIES_STYLES.length);
  const dash = s.dashed === true && style.dash.length === 0 ? DASHED_FALLBACK : style.dash;
  const data = s.points.map((p) => ({ x: p.x, y: p.y, detail: p.detail }));
  const base = {
    label: s.label,
    data,
    borderColor: style.color,
    backgroundColor: style.color,
    pointStyle: style.pointStyle,
    pointRadius: 4 + lap,
    pointHoverRadius: 6 + lap,
    borderDash: [...dash],
  };
  if (s.kind === 'bar') return { ...base, type: 'bar', borderWidth: 1 + lap } as unknown as ChartDataset;
  if (s.kind === 'scatter') return { ...base, type: 'scatter', showLine: false } as unknown as ChartDataset;
  return { ...base, type: 'line', borderWidth: 2 + lap, showLine: true } as unknown as ChartDataset;
}

function referenceDatasets(spec: ChartSpec): ChartDataset[] {
  const xs: (number | string)[] = [];
  const ys: number[] = [];
  for (const s of spec.series) {
    for (const p of s.points) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  const numericXs = xs.filter((x): x is number => typeof x === 'number');
  const out: ChartDataset[] = [];
  for (const ref of spec.referenceLines) {
    let data: { x: number | string; y: number }[] | null = null;
    if (ref.axis === 'y') {
      if (spec.y.scale === 'log' && !(ref.value > 0)) continue;
      if (numericXs.length > 0) {
        data = [
          { x: Math.min(...numericXs), y: ref.value },
          { x: Math.max(...numericXs), y: ref.value },
        ];
      } else if (xs.length > 0) {
        data = [
          { x: xs[0] as string, y: ref.value },
          { x: xs[xs.length - 1] as string, y: ref.value },
        ];
      }
    } else {
      if (spec.x.scale === 'log' && !(ref.value > 0)) continue;
      if (ys.length > 0 && !isCategorical(spec)) {
        data = [
          { x: ref.value, y: Math.min(...ys) },
          { x: ref.value, y: Math.max(...ys) },
        ];
      }
    }
    if (data === null) continue;
    out.push({
      type: 'line',
      label: ref.label,
      data,
      borderColor: REFERENCE_STYLE.color,
      backgroundColor: REFERENCE_STYLE.color,
      borderDash: [...REFERENCE_STYLE.dash],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 0,
      showLine: true,
    } as unknown as ChartDataset);
  }
  return out;
}

/**
 * 棒の系列が同じ項目に 2 本以上重ならないか。重ならなければ棒を項目の枠の中央に太く描ける
 * (系列ごとに別の dataset なので、既定の grouped では各項目の枠の中で左に寄って細く描かれる)。
 */
function barsAreDisjoint(spec: ChartSpec): boolean {
  const seen = new Set<string>();
  for (const s of spec.series) {
    if (s.kind !== 'bar') continue;
    for (const p of s.points) {
      const key = String(p.x);
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

/** ChartSpec(prepareForScale 済み)から Chart.js の設定を作る */
export function buildChartConfig(spec: ChartSpec, animate: boolean): ChartConfiguration {
  const categorical = isCategorical(spec);
  const datasets = [...spec.series.map((s, i) => seriesDataset(s, i)), ...referenceDatasets(spec)];
  return {
    type: 'line',
    data: categorical ? { labels: categoryLabels(spec), datasets } : { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: animate ? { duration: 300 } : false,
      parsing: false,
      ...(categorical && barsAreDisjoint(spec) ? { datasets: { bar: { grouped: false, barPercentage: 0.6, categoryPercentage: 1 } } } : {}),
      interaction: { mode: 'nearest', intersect: true },
      scales: {
        x: {
          type: categorical ? 'category' : spec.x.scale === 'log' ? 'logarithmic' : 'linear',
          title: { display: true, text: axisTitle(spec.x) },
        },
        y: {
          type: spec.y.scale === 'log' ? 'logarithmic' : 'linear',
          title: { display: true, text: axisTitle(spec.y) },
        },
      },
      plugins: {
        // 凡例は小さめにして、狭い画面(320px)でもプロットの領域を残す(10.8)
        legend: { display: true, labels: { boxWidth: 24, boxHeight: 10, padding: 8, font: { size: 11 } } },
        title: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const raw = ctx.raw as { x?: unknown; y?: unknown; detail?: string } | undefined;
              const x = raw?.x ?? ctx.parsed.x;
              const y = raw?.y ?? ctx.parsed.y;
              const lines = [`${ctx.dataset.label ?? ''}`, `${spec.x.label}: ${formatValue(x)}`, `${spec.y.label}: ${formatValue(y)}`];
              if (raw?.detail !== undefined && raw.detail !== '') lines.push(raw.detail);
              return lines;
            },
          },
        },
      },
    },
  } as ChartConfiguration;
}

/** Chart.js による既定の描画層 */
export function createChartJsRenderer(): ChartRenderer {
  let chart: Chart | null = null;
  let animate = true;
  return {
    render(canvas, spec, options) {
      setupChart();
      animate = options.animate;
      chart?.destroy();
      chart = new Chart(canvas, buildChartConfig(spec, animate));
    },
    update(spec, options) {
      if (chart === null) return;
      if (options !== undefined) animate = options.animate;
      const next = buildChartConfig(spec, animate);
      chart.data = next.data;
      chart.options = next.options ?? {};
      chart.update();
    },
    destroy() {
      chart?.destroy();
      chart = null;
    },
  };
}
