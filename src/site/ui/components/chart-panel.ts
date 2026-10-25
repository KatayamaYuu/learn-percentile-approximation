// グラフのパネル: 見出し、代替テキスト付きの描画領域、軸ごとの線形/対数の切り替え、注記、数値の表(7.1、7.3、7.4、10.3、10.4、10.7、10.8)。
import type { AxisScale, ChartSpec } from '../../shared/chart-spec';
import { altText, prepareForScale, toTable } from '../../shared/chart-spec';
import { createChartJsRenderer } from './chart-renderer';
import type { ChartRenderer } from './chart-renderer';

export type { ChartRenderer } from './chart-renderer';
export { SERIES_STYLES } from './chart-styles';

export interface ChartPanel {
  readonly element: HTMLElement;
  update(spec: ChartSpec): void;
  destroy(): void;
}

const SCALE_LABELS: readonly { readonly scale: AxisScale; readonly label: string }[] = [
  { scale: 'linear', label: '線形' },
  { scale: 'log', label: '対数' },
];

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createChartPanel(spec: ChartSpec, renderer: ChartRenderer = createChartJsRenderer()): ChartPanel {
  let current = spec;
  let destroyed = false;
  /** 利用者が切り替えた尺度。切り替えられない軸には持たない */
  const chosen: { x: AxisScale | null; y: AxisScale | null } = { x: null, y: null };

  const root = document.createElement('section');
  root.className = 'chart-panel';
  const heading = document.createElement('h3');
  heading.className = 'chart-title';

  const controls = document.createElement('div');
  controls.className = 'chart-controls';

  const frame = document.createElement('div');
  frame.className = 'chart-canvas-frame';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  frame.append(canvas);

  const notes = document.createElement('ul');
  notes.className = 'chart-notes';

  const details = document.createElement('details');
  details.className = 'chart-table';
  const summary = document.createElement('summary');
  summary.textContent = '数値の表';
  const tableWrap = document.createElement('div');
  tableWrap.className = 'chart-table-scroll';
  details.append(summary, tableWrap);

  root.append(heading, controls, frame, notes, details);

  function scales(): { x: AxisScale; y: AxisScale } {
    return {
      x: current.x.toggleable ? (chosen.x ?? current.x.scale) : current.x.scale,
      y: current.y.toggleable ? (chosen.y ?? current.y.scale) : current.y.scale,
    };
  }

  function prepared(): ChartSpec {
    return prepareForScale(current, scales());
  }

  let controlsKey = '';

  function renderControls(): void {
    const now = scales();
    const key = JSON.stringify(
      (['x', 'y'] as const).map((axis) => (current[axis].toggleable ? current[axis].label : null)),
    );
    if (key !== controlsKey) {
      // 軸の構成が変わったときだけ作り直す(押した後もフォーカスを保つため)
      controlsKey = key;
      controls.replaceChildren();
      for (const axis of ['x', 'y'] as const) {
        const axisSpec = current[axis];
        if (!axisSpec.toggleable) continue;
        const group = document.createElement('div');
        group.className = 'chart-axis-toggle';
        group.setAttribute('role', 'group');
        group.setAttribute('data-axis', axis);
        group.setAttribute('aria-label', `${axis === 'x' ? '横軸' : '縦軸'}(${axisSpec.label})の尺度`);
        const caption = document.createElement('span');
        caption.className = 'chart-axis-caption';
        caption.textContent = `${axis === 'x' ? '横軸' : '縦軸'}:`;
        group.append(caption);
        for (const { scale, label } of SCALE_LABELS) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.dataset['scale'] = scale;
          button.addEventListener('click', () => {
            if (destroyed || scales()[axis] === scale) return;
            chosen[axis] = scale;
            refresh(true);
          });
          group.append(button);
        }
        controls.append(group);
      }
      controls.hidden = controls.childElementCount === 0;
    }
    for (const group of controls.querySelectorAll<HTMLElement>('[data-axis]')) {
      const axis = group.dataset['axis'] === 'x' ? 'x' : 'y';
      for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
        button.setAttribute('aria-pressed', String(button.dataset['scale'] === now[axis]));
      }
    }
  }

  function renderTexts(p: ChartSpec): void {
    heading.textContent = p.title;
    canvas.setAttribute('aria-label', altText(p));
    notes.replaceChildren(
      ...p.notes.map((n) => {
        const li = document.createElement('li');
        li.textContent = n;
        return li;
      }),
    );
    notes.hidden = p.notes.length === 0;

    const model = toTable(p);
    const table = document.createElement('table');
    const caption = document.createElement('caption');
    caption.textContent = model.caption;
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of model.columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const row of model.rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(caption, thead, tbody);
    tableWrap.replaceChildren(table);
  }

  /** 画面の部分を作り直し、描画層には変換済みの仕様を渡す */
  function refresh(rerender: boolean): ChartSpec {
    const p = prepared();
    renderControls();
    renderTexts(p);
    if (rerender) renderer.update(p);
    return p;
  }

  const first = refresh(false);
  renderer.render(canvas, first, { animate: !prefersReducedMotion() });

  // 動きを減らす設定が途中で変わったら描き直す(10.7)
  let motionQuery: MediaQueryList | null = null;
  const onMotionChange = (): void => {
    if (!destroyed) renderer.update(prepared(), { animate: !prefersReducedMotion() });
  };
  try {
    motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    motionQuery?.addEventListener('change', onMotionChange);
  } catch {
    motionQuery = null;
  }

  return {
    element: root,
    update(next) {
      if (destroyed) return;
      current = next;
      refresh(true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      motionQuery?.removeEventListener('change', onMotionChange);
      renderer.destroy();
    },
  };
}
