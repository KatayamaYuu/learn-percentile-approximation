// 内部状態・バケットの表(5.8、6.6)。行数の上限を超えた表は、先頭と末尾だけを出して省略を明示する。
// 観察が拒否されたときは表の代わりに理由を出す。
import type { InspectionView } from '../../shared/views/streaming-view';
import { formatInt } from '../../shared/format';

export type StateTableInput = InspectionView | { readonly rejected: string };

export interface StateTable {
  readonly element: HTMLElement;
  show(view: StateTableInput): void;
  clear(): void;
}

function renderTable(view: InspectionView): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'state-table-scroll';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'region');
  frame.setAttribute('aria-label', view.table.caption);

  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.textContent = view.table.caption;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const c of view.table.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = c;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  const cut = view.truncation;
  for (const [i, row] of view.table.rows.entries()) {
    if (cut !== null && i === cut.head) {
      const gap = document.createElement('tr');
      gap.className = 'state-table-gap';
      const td = document.createElement('td');
      td.colSpan = view.table.columns.length;
      td.textContent = `…(中略: ${formatInt(cut.total - cut.head - cut.tail)} 行を省略)…`;
      gap.append(td);
      tbody.append(gap);
    }
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(caption, thead, tbody);
  frame.append(table);
  return frame;
}

export function createStateTable(): StateTable {
  const element = document.createElement('div');
  element.className = 'state-table';
  element.hidden = true;

  function clear(): void {
    element.replaceChildren();
    element.hidden = true;
  }

  function show(view: StateTableInput): void {
    if ('rejected' in view) {
      const p = document.createElement('p');
      p.className = 'state-table-rejected';
      p.textContent = view.rejected;
      element.replaceChildren(p);
      element.hidden = false;
      return;
    }
    const nodes: Node[] = [];
    if (view.facts.length > 0) {
      const dl = document.createElement('dl');
      dl.className = 'state-table-facts';
      for (const f of view.facts) {
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        dd.textContent = f.value;
        dl.append(dt, dd);
      }
      nodes.push(dl);
    }
    if (view.truncation !== null) {
      const notice = document.createElement('p');
      notice.className = 'state-table-notice';
      notice.textContent = view.truncation.notice;
      nodes.push(notice);
    }
    nodes.push(renderTable(view));
    element.replaceChildren(...nodes);
    element.hidden = false;
  }

  return { element, show, clear };
}
