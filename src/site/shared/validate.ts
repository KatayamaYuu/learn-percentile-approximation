// サイトとしての条件の検証。サイトが定める条件(範囲・整数・選択・範囲の大小・重複)だけを検査する。
// 分布のパラメータとアルゴリズムの設定は検証し直さず、Worker の中で上流が返すエラーを項目に対応づける(2.5)。
import type {
  CompareAlgorithm,
  CompareCondition,
  DataCondition,
  HdrRangeMode,
  HistogramPageCondition,
  RelativePageCondition,
  StreamingPageCondition,
} from './conditions';
import { COUNT_RANGE, SEED_RANGE, TRIALS_RANGE } from './limits';
import type { IntRange } from './limits';

export interface FieldIssue {
  /** UI の項目の識別。例: 'data.count'、'data.distribution.sigma'、'epsilon'、'algorithms' */
  readonly field: string;
  readonly reason: string;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 整数で、範囲内であること。問題があれば理由を返す */
function intRangeReason(label: string, value: number, range: IntRange): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return `${label}は整数で指定してください。`;
  }
  if (value < range.min || value > range.max) {
    return `${label}は ${fmt(range.min)} 以上 ${fmt(range.max)} 以下で指定してください。`;
  }
  return null;
}

function isFinitePositive(x: number): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** 下限・上限が有限の正の数で、下限 < 上限であること */
function rangeIssues(
  lowerField: string,
  upperField: string,
  lowerLabel: string,
  upperLabel: string,
  lower: number,
  upper: number,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const lowerOk = isFinitePositive(lower);
  const upperOk = isFinitePositive(upper);
  if (!lowerOk)
    issues.push({
      field: lowerField,
      reason: `${lowerLabel}は有限の正の数で指定してください。`,
    });
  if (!upperOk)
    issues.push({
      field: upperField,
      reason: `${upperLabel}は有限の正の数で指定してください。`,
    });
  if (lowerOk && upperOk && lower >= upper) {
    issues.push({
      field: lowerField,
      reason: `${lowerLabel}は${upperLabel}より小さい値にしてください。`,
    });
  }
  return issues;
}

function hdrRangeIssues(range: HdrRangeMode): FieldIssue[] {
  if (range.kind !== 'manual') return [];
  return rangeIssues(
    'hdrRange.lowest',
    'hdrRange.highest',
    'HDR の範囲の下限',
    'HDR の範囲の上限',
    range.lowest,
    range.highest,
  );
}

export function validateData(data: DataCondition): readonly FieldIssue[] {
  const issues: FieldIssue[] = [];
  const count = intRangeReason('データ件数', data.count, COUNT_RANGE);
  if (count !== null) issues.push({ field: 'data.count', reason: count });
  const seed = intRangeReason('シード', data.seed, SEED_RANGE);
  if (seed !== null) issues.push({ field: 'data.seed', reason: seed });
  return issues;
}

export function validateHistogramPage(c: HistogramPageCondition): readonly FieldIssue[] {
  const issues: FieldIssue[] = [...validateData(c.data)];
  if (c.schemes.length === 0) {
    issues.push({
      field: 'schemes',
      reason: 'バケットの幅の方式を 1 つ以上選んでください。',
    });
  }
  if (c.range.kind === 'fixed') {
    issues.push(
      ...rangeIssues(
        'range.lower',
        'range.upper',
        '固定の範囲の下限',
        '固定の範囲の上限',
        c.range.lower,
        c.range.upper,
      ),
    );
  }
  return issues;
}

export function validateStreamingPage(c: StreamingPageCondition): readonly FieldIssue[] {
  const issues: FieldIssue[] = [...validateData(c.data)];
  const trials = intRangeReason('試行の回数', c.trials, TRIALS_RANGE);
  if (trials !== null) issues.push({ field: 'trials', reason: trials });
  if (c.methods.length === 0) {
    issues.push({
      field: 'methods',
      reason: '手法を 1 つ以上選んでください。',
    });
  } else {
    if (!c.methods.includes(c.inspectTarget)) {
      issues.push({
        field: 'inspectTarget',
        reason: '内部状態を表示する手法は、選んだ手法の中から選んでください。',
      });
    }
    if (c.methods.includes('tdigest') && c.scales.length === 0) {
      issues.push({
        field: 'scales',
        reason: 't-digest のスケール関数を 1 つ以上選んでください。',
      });
    }
  }
  return issues;
}

export function validateRelativePage(c: RelativePageCondition): readonly FieldIssue[] {
  const issues: FieldIssue[] = [...validateData(c.data)];
  if (c.methods.length === 0) {
    issues.push({
      field: 'methods',
      reason: '手法を 1 つ以上選んでください。',
    });
  } else {
    if (!c.methods.includes(c.inspectTarget)) {
      issues.push({
        field: 'inspectTarget',
        reason: '内部状態を表示する手法は、選んだ手法の中から選んでください。',
      });
    }
    if (c.methods.includes('hdr')) issues.push(...hdrRangeIssues(c.hdrRange));
  }
  return issues;
}

/** 同じ種類・同じパラメータなら同じキー(キーの順序によらない) */
function algorithmKey(a: CompareAlgorithm): string {
  const entries = Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify(entries);
}

export function validateCompare(c: CompareCondition): readonly FieldIssue[] {
  const issues: FieldIssue[] = [...validateData(c.data)];
  if (c.algorithms.length === 0) {
    issues.push({
      field: 'algorithms',
      reason: '比較する手法を 1 つ以上選んでください。',
    });
    return issues;
  }
  const seen = new Set<string>();
  let duplicated = false;
  for (const a of c.algorithms) {
    const key = algorithmKey(a);
    if (seen.has(key)) duplicated = true;
    seen.add(key);
  }
  if (duplicated) {
    issues.push({
      field: 'algorithms',
      reason: '同じ手法を同じパラメータで重ねて選ぶことはできません。パラメータを変えるか、重複を外してください。',
    });
  }
  if (c.algorithms.some((a) => a.kind === 'hdr')) issues.push(...hdrRangeIssues(c.hdrRange));
  return issues;
}
