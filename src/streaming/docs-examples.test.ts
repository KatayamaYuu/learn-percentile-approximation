import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRng,
  exactQuantileSorted,
  nearestRank,
  rankError,
  type AlgorithmResult,
  type DataOrder,
  type Distribution,
  type SweepResult,
} from '../core';
import * as api from './index';
import {
  createGk,
  createKll,
  createTDigest,
  type GkSketch,
  type KllSketch,
  type KllState,
  type ScaleFunctionKind,
  type StreamingSketchConfig,
  type TDigestSketch,
} from './index';
import { runStreamingExperiment } from './index';
import { scaleLimit } from './scale';

const docsDir = join(__dirname, '..', '..', 'docs', 'streaming');
const readDoc = (name: string): string => readFileSync(join(docsDir, name), 'utf8');

/** 文書の表から、指定した先頭セルを持つ行のセルを取り出す */
function rowOf(doc: string, firstCell: string): string[] {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${firstCell} |`));
  if (line === undefined) throw new Error(`row not found: ${firstCell}`);
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** 見出しから次の同じ階層以上の見出しの手前までを取り出す(表の先頭セルが重なるのを避ける) */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const rest = doc.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next < 0 ? rest : rest.slice(0, next);
}

function gkOf(epsilon: number): GkSketch {
  const r = createGk({ epsilon });
  if (!r.ok) throw new Error('gk');
  return r.value;
}

const tuplesText = (g: GkSketch): string =>
  g
    .inspect()
    .tuples.map((t) => `(${t.value},${t.g},${t.delta})`)
    .join(' ');

function estimate(g: GkSketch, q: number): number {
  const r = g.query(q);
  if (!r.ok) throw new Error('query');
  return r.value;
}

describe('gk.md の例 ε = 0.2、値 5、3、8、1、9、2、7、4、10、6', () => {
  const doc = readDoc('gk.md');
  const trace = section(doc, '## 例 ε = 0.2、値 5、3、8、1、9、2、7、4、10、6');
  const values = [5, 3, 8, 1, 9, 2, 7, 4, 10, 6];
  const thresholds: Record<number, number> = { 2: 0, 4: 1, 6: 2, 8: 3, 10: 4 };

  it('1件ずつ投入した inspect() の結果が、文書の表の各行と一致する', () => {
    const g = gkOf(0.2);
    values.forEach((v, i) => {
      const n = i + 1;
      g.insert(v);
      expect(g.inspect().count).toBe(n);
      const t = thresholds[n];
      expect(rowOf(trace, String(n))).toEqual([String(n), String(v), t === undefined ? '—' : String(t), tuplesText(g)]);
    });
  });

  it('圧縮の周期は2件ごと、閾値は ⌊2εn⌋ で 0、1、2、3、4 になる', () => {
    expect(Math.max(1, Math.floor(1 / (2 * 0.2)))).toBe(2);
    expect([2, 4, 6, 8, 10].map((n) => Math.floor(2 * 0.2 * n))).toEqual([0, 1, 2, 3, 4]);
    expect(doc).toContain('max(1, ⌊1/0.4⌋) = 2');
    expect(doc).toContain('n = 2、4、6、8、10 のとき、それぞれ 0、1、2、3、4 になる');
  });

  it('不変条件: Σ g = n、g + Δ ≤ max(1, ⌊2εn⌋)、先頭と末尾は Δ = 0(各投入の後)', () => {
    const g = gkOf(0.2);
    values.forEach((v, i) => {
      g.insert(v);
      const s = g.inspect();
      const n = i + 1;
      expect(s.tuples.reduce((a, t) => a + t.g, 0)).toBe(n);
      for (const t of s.tuples) expect(t.g + t.delta).toBeLessThanOrEqual(Math.max(1, Math.floor(2 * 0.2 * n)));
      expect(s.tuples[0]!.delta).toBe(0);
      expect(s.tuples[s.tuples.length - 1]!.delta).toBe(0);
    });
  });

  it('n = 7 の挿入: 後続 (9,2,0) から Δ = 2 + 0 − 1 = 1 の (7,1,1) が入り、順位の範囲は [5, 6]', () => {
    const g = gkOf(0.2);
    for (const v of values.slice(0, 6)) g.insert(v);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (5,2,0) (9,2,0)');
    g.insert(7);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (5,2,0) (7,1,1) (9,2,0)');
    const tuples = g.inspect().tuples;
    const rminPrev = tuples[0]!.g + tuples[1]!.g + tuples[2]!.g;
    expect(rminPrev).toBe(4);
    expect([rminPrev + 1, rminPrev + 1 + tuples[3]!.delta]).toEqual([5, 6]);
    expect(doc).toContain('Δ = 2 + 0 − 1 = 1');
    expect(doc).toContain('直前のタプル(5,2,0)の最小順位は 1 + 1 + 2 = 4');
    expect(doc).toContain('最小順位は 4 + 1 = 5、最大順位は 5 + 1 = 6');
    expect(doc).toContain('範囲[5, 6]');
  });

  it('n = 6 の圧縮の手計算が表の結果と整合する(判定の式の数値)', () => {
    // 圧縮前は 1、2、3、5、8、9 がすべて (g, Δ) = (1, 0)。閾値 T = 2
    const T = Math.floor(2 * 0.2 * 6);
    expect(T).toBe(2);
    expect(1 + 1 + 0).toBeLessThanOrEqual(T); // 8 を 9 に併合 → (9,2,0)
    expect(1 + 2 + 0).toBeGreaterThan(T); // 5 は併合しない
    expect(1 + 1 + 0).toBeLessThanOrEqual(T); // 3 を 5 に併合 → (5,2,0)
    expect(1 + 2 + 0).toBeGreaterThan(T); // 2 は併合しない
    for (const s of [
      'g(8) + g(9) + Δ(9) = 1 + 1 + 0 = 2 ≤ 2',
      'g(5) + g(9) + Δ(9) = 1 + 2 + 0 = 3 > 2',
      'g(3) + g(5) + Δ(5) = 1 + 1 + 0 = 2 ≤ 2',
      'g(2) + g(5) + Δ(5) = 1 + 2 + 0 = 3 > 2',
      '(1,1,0) (2,1,0) (5,2,0) (9,2,0)',
    ]) {
      expect(doc).toContain(s);
    }
    const g = gkOf(0.2);
    for (const v of values.slice(0, 6)) g.insert(v);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (5,2,0) (9,2,0)');
  });

  it('最終状態 (1,1,0) (5,4,0) (6,1,2) (10,4,0): (6,1,2) の順位の範囲は [6, 8]、最大順位は 1、5、8、10', () => {
    const g = gkOf(0.2);
    for (const v of values) g.insert(v);
    const tuples = g.inspect().tuples;
    expect(tuplesText(g)).toBe('(1,1,0) (5,4,0) (6,1,2) (10,4,0)');
    let rmin = 0;
    const ranges = tuples.map((t) => {
      rmin += t.g;
      return [rmin, rmin + t.delta];
    });
    expect(ranges).toEqual([
      [1, 1],
      [5, 5],
      [6, 8],
      [10, 10],
    ]);
    expect(doc).toContain('最小順位は 1 + 4 + 1 = 6、最大順位は 6 + 2 = 8');
    expect(doc).toContain('最大順位は、先頭から 1、5、8、10 である');
    expect(doc).toContain('g + Δ = 3 ≤ ⌊2 × 0.2 × 10⌋ = 4');
    expect(tuples.length).toBe(4);
    expect(doc).toContain('10件が4個のタプルに縮む');
  });

  it('問い合わせの表: 目標順位、r + e、返される値、順位誤差が実装の出力と一致する', () => {
    const g = gkOf(0.2);
    for (const v of values) g.insert(v);
    const sorted = Float64Array.from(values).sort();
    const queryTable = section(doc, '### 問い合わせの結果');
    let worst = 0;
    for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const r = nearestRank(10, q);
      const e = 0.2 * 10;
      const est = estimate(g, q);
      const re = rankError(sorted, est, q);
      if (!re.ok) throw new Error('rankError');
      worst = Math.max(worst, re.value);
      expect(rowOf(queryTable, String(q))).toEqual([
        String(q),
        String(r),
        String(r + e),
        String(est),
        String(re.value),
      ]);
      expect(re.value).toBeLessThanOrEqual(0.2);
      // 値は 1..10 の異なる整数なので、値がそのまま真の順位
      expect(Math.abs(est - r) / 10).toBe(re.value);
    }
    expect(worst).toBe(0.2);
    expect(doc).toContain('q = 0.25 と q = 0.75 では、ちょうどεに達している');
    expect(estimate(g, 0.25)).toBe(5);
    expect(estimate(g, 0.75)).toBe(10);
    expect(doc).toContain('1つ前の(5,4,0)の値5を返す');
    expect(doc).toContain('(10 − 8) ÷ 10 = 0.2');
  });

  it('整列した値 1〜10 の最近順位法の厳密値と、返される値の関係(q = 0.5 は厳密値と一致)', () => {
    const g = gkOf(0.2);
    for (const v of values) g.insert(v);
    const sorted = Float64Array.from(values).sort();
    expect(estimate(g, 0.5)).toBe(exactQuantileSorted(sorted, 0.5, 'nearest-rank'));
    expect(estimate(g, 0.25)).not.toBe(exactQuantileSorted(sorted, 0.25, 'nearest-rank'));
  });
});

describe('gk.md の例 ε = 0.05、値 3、1、2(圧縮が働かない)', () => {
  const doc = readDoc('gk.md');

  it('周期 10、閾値 0 で、(1,1,0) (2,1,0) (3,1,0) のまま厳密値を返す', () => {
    const g = gkOf(0.05);
    for (const v of [3, 1, 2]) g.insert(v);
    expect(tuplesText(g)).toBe('(1,1,0) (2,1,0) (3,1,0)');
    expect(Math.max(1, Math.floor(1 / (2 * 0.05)))).toBe(10);
    expect(Math.floor(2 * 0.05 * 3)).toBe(0);
    expect(doc).toContain('max(1, ⌊1/0.1⌋) = 10 件');
    expect(doc).toContain('⌊2 × 0.05 × 3⌋ = 0');
    expect(doc).toContain('(1,1,0) (2,1,0) (3,1,0)になる');
    const sorted = Float64Array.from([1, 2, 3]);
    for (const q of [0, 0.2, 0.34, 0.5, 0.67, 1]) {
      expect(estimate(g, q)).toBe(exactQuantileSorted(sorted, q, 'nearest-rank'));
    }
  });
});

function kllOf(k: number, seed: number): KllSketch {
  const r = createKll({ k, seed });
  if (!r.ok) throw new Error('kll');
  return r.value;
}

const levelsText = (s: KllState): string =>
  s.levels.map((l) => `段${l.level}(容量${l.capacity}): [${l.values.join(',')}]`).join(' / ');

/** 値 x 以下の要素の重みの合計(順位の推定) */
const estimatedRank = (s: KllState, x: number): number =>
  s.levels.reduce((a, l) => a + l.weight * l.values.filter((v) => v <= x).length, 0);

const signed = (e: number): string => (e > 0 ? `+${e}` : String(e));

function rngBits(seed: number, count: number): number[] {
  const r = createRng(seed);
  if (!r.ok) throw new Error('rng');
  return Array.from({ length: count }, () => r.value.nextIntBelow(2));
}

function queryOf(s: { query(q: number): { ok: boolean; value?: number } }, q: number): number {
  const r = s.query(q);
  if (!r.ok || r.value === undefined) throw new Error('query');
  return r.value;
}

describe('kll.md の容量の表と浮動小数の注意', () => {
  const doc = readDoc('kll.md');
  const capacityTable = section(doc, '## 段の容量');

  it('k = 8: 段数 H ごとの容量、容量の合計、3k + 2H、初めてその段数になる件数が表と一致する', () => {
    const sketch = kllOf(8, 1);
    const firstSeen = new Map<number, KllState>();
    for (let n = 1; n <= 259; n++) {
      sketch.insert(n);
      const state = sketch.inspect();
      if (!firstSeen.has(state.levels.length)) firstSeen.set(state.levels.length, state);
    }
    expect([...firstSeen.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [h, state] of firstSeen) {
      const capacities = state.levels.map((l) => l.capacity);
      // 容量の式: 最上段が k で、1 段下がるごとに 2/3 倍して切り捨て、下限 2
      expect(capacities).toEqual(state.levels.map((_, i) => Math.max(2, Math.floor(8 * (2 / 3) ** (h - 1 - i)))));
      const total = capacities.reduce((a, c) => a + c, 0);
      expect(total).toBeLessThanOrEqual(3 * 8 + 2 * h);
      expect(rowOf(capacityTable, String(h))).toEqual([
        String(h),
        capacities.join('、'),
        String(total),
        String(3 * 8 + 2 * h),
        String(state.count),
      ]);
    }
    expect(Math.floor(8 * (2 / 3) ** 4)).toBe(1);
    expect(doc).toContain('8 × (2/3)^4 ≈ 1.58 を切り捨てると1になるが、下限により2になる');
  });

  it('k = 81 の浮動小数の落とし穴: 段数4の段0の容量は 81 × (2/3)^3 = 24 ではなく 23(563件で初めて段数4)', () => {
    expect(81 * (2 / 3) ** 3).toBe(23.999999999999993);
    expect(Math.floor(81 * (2 / 3) ** 3)).toBe(23);
    const sketch = kllOf(81, 1);
    for (let n = 1; n <= 562; n++) sketch.insert(n);
    expect(sketch.inspect().levels.length).toBe(3);
    sketch.insert(563);
    const state = sketch.inspect();
    expect(state.levels.length).toBe(4);
    expect(state.levels.map((l) => l.capacity)).toEqual([23, 36, 54, 81]);
    for (const s of [
      '81 × (2/3)^3 = 24 のはずだが',
      '23.999999999999993',
      '切り捨てて23になる',
      '実装が返す容量は23である',
      '1から昇順に563件を投入する(シードは1)と段数が初めて4になり、容量は段0から 23、36、54、81 になる',
    ]) {
      expect(doc).toContain(s);
    }
  });
});

describe('kll.md の例 k = 8、シード1、値 1〜25 を昇順に投入', () => {
  const doc = readDoc('kll.md');
  const trace = section(doc, '## 例 k = 8、シード1、値 1〜25 を昇順に投入');
  const shown = [8, 9, 17, 18, 22, 23, 25];

  it('主な行の compaction の回数と段ごとの状態が、inspect() の出力と一致する', () => {
    const sketch = kllOf(8, 1);
    const seen: number[] = [];
    for (let n = 1; n <= 25; n++) {
      sketch.insert(n);
      if (!shown.includes(n)) continue;
      seen.push(n);
      const state = sketch.inspect();
      expect(state.count).toBe(n);
      expect(rowOf(trace, String(n))).toEqual([String(n), String(n), String(state.compactions), levelsText(state)]);
    }
    expect(seen).toEqual(shown);
  });

  it('乱数: シード1は 1、0、1、0、…、シード5は 0、1、0、1、…。使うのは compaction のときだけ(n = 9、18、23、25 で 1、0、1、0)', () => {
    expect(rngBits(1, 6)).toEqual([1, 0, 1, 0, 0, 0]);
    expect(rngBits(5, 6)).toEqual([0, 1, 0, 1, 1, 1]);
    expect(doc).toContain('シード1だと 1、0、1、0、0、0、… の順に、シード5だと 0、1、0、1、1、1、… の順に出す');
    // compaction のたびに列を先頭から 1 つずつ使う。間の投入で引いていれば、n = 9 の最初の選択がずれる
    const sketch = kllOf(8, 1);
    const compactionsAt: number[] = [];
    let previous = 0;
    for (let n = 1; n <= 25; n++) {
      sketch.insert(n);
      const c = sketch.inspect().compactions;
      if (c > previous) compactionsAt.push(n);
      previous = c;
      // 圧縮が起きない投入(n = 1〜8、10〜17、19〜22、24)では回数が変わらない
    }
    expect(compactionsAt).toEqual([9, 18, 23, 25]);
    expect(doc).toContain(
      '乱数は n = 9、18、23、25 の4回のcompactionで、1、0、1、0 の順に使われた。その間の投入では引いていない。',
    );
    // 乱数が compaction ごとに 1 つ進むことは、選ばれた側(大きい方=1、小さい方=0)で確かめる
    const at = (n: number): KllState => {
      const s = kllOf(8, 1);
      for (let i = 1; i <= n; i++) s.insert(i);
      return s.inspect();
    };
    expect(at(9).levels[1]!.values).toEqual([3, 5, 7, 9]); // 1: 大きい方
    expect(at(18).levels[1]!.values.slice(4)).toEqual([1, 11, 13, 15, 17]); // 0: 小さい方
    expect(at(23).levels[1]!.values.slice(9)).toEqual([21, 23]); // 1: 大きい方
    expect(at(25).levels[2]!.values).toEqual([3, 7, 11, 15, 21]); // 0: 小さい方
  });

  it('手計算の数値: 容量の合計との比較、compaction の対象の段、奇数個の最小の保持、段の追加', () => {
    const at = (n: number): KllState => {
      const s = kllOf(8, 1);
      for (let i = 1; i <= n; i++) s.insert(i);
      return s.inspect();
    };
    const retained = (s: KllState): number => s.levels.reduce((a, l) => a + l.values.length, 0);
    const capacity = (s: KllState): number => s.levels.reduce((a, l) => a + l.capacity, 0);
    // n = 8: 容量の合計 8 に届き、超えない。n = 9: 段を足して H = 2、段 0 には最小の 1 が残る
    expect(retained(at(8))).toBe(8);
    expect(capacity(at(8))).toBe(8);
    expect(at(9).levels.map((l) => l.values.length)).toEqual([1, 4]);
    expect(at(9).levels[0]!.values).toEqual([1]);
    // n = 17: 9 + 4 = 13 = 5 + 8。超えないので compaction しない
    expect(retained(at(17))).toBe(13);
    expect(capacity(at(17))).toBe(13);
    expect(at(17).compactions).toBe(1);
    // n = 18: 10 + 4 = 14 > 13。段 0(10 個、偶数)の全部が対象で段 0 は空になる
    expect(at(18).levels[0]!.values).toEqual([]);
    expect(at(18).levels[1]!.values.length).toBe(9);
    // n = 22: 4 + 9 = 13 で超えない(compaction しない)
    expect(retained(at(22))).toBe(13);
    expect(at(22).compactions).toBe(2);
    // n = 23: 段 0 は 5 個 = 容量 5、段 1 は 9 個 ≥ 8。下の段 0 が選ばれ、最小の 19 が残る
    expect(at(23).levels[0]!.values).toEqual([19]);
    expect(at(23).levels[1]!.values.length).toBe(11);
    // n = 24: 2 + 11 = 13 で超えない。n = 25: 3 + 11 = 14 > 13。段 0 は 3 < 5、段 1 は最上段で段が足される
    expect(retained(at(24))).toBe(13);
    expect(at(24).levels.length).toBe(2);
    expect(at(25).levels.length).toBe(3);
    expect(at(25).levels.map((l) => l.values.length)).toEqual([3, 1, 5]);
    for (const s of [
      '保持要素数9が容量の合計8を超える',
      '最小の1を段0に残す',
      '(2,3)(4,5)(6,7)(8,9)の4組',
      '9 + 4 = 13',
      '容量の合計も 5 + 8 = 13 なので、超えていない',
      '保持要素数 10 + 4 = 14 が容量の合計13を超える',
      '(1,10)(11,12)(13,14)(15,16)(17,18)の5組',
      '段0は4個、段1は9個で、保持要素数13は容量の合計13を超えない',
      '段0(5個 ≥ 容量5)が、段1(9個 ≥ 容量8)より下なので、段0を対象にする',
      '最小の19を残し、20〜23を(20,21)(22,23)に分ける',
      '段0は [19,24,25] の3個、段1は11個で、保持要素数14が容量の合計13を超える',
      '段0は3個で容量5に届かず、段1は11個で容量8以上である',
      '1、3、5、7、9、11、13、15、17、21、23の11個',
      '(3,5)(7,9)(11,13)(15,17)(21,23)に分ける',
      '3、7、11、15、21 を段2に送る',
    ]) {
      expect(doc).toContain(s);
    }
  });

  it('重みの保存と保持要素数: 表の行と一致し、投入のたびに Σ 重み × 要素数 = n、保持要素数 ≤ 容量の合計 ≤ 3k + 2H', () => {
    const table = section(trace, '### 重みの保存と保持要素数');
    const sketch = kllOf(8, 1);
    const weightText: Record<number, string> = {
      9: '1 × 1 + 2 × 4 = 9',
      18: '2 × 9 = 18',
      23: '1 × 1 + 2 × 11 = 23',
      25: '1 × 3 + 2 × 1 + 4 × 5 = 25',
    };
    let previous = { retained: 0, total: 8, compactions: 0 };
    for (let n = 1; n <= 259; n++) {
      sketch.insert(n);
      const state = sketch.inspect();
      expect(state.levels.reduce((a, l) => a + l.weight * l.values.length, 0)).toBe(n);
      const retained = state.levels.reduce((a, l) => a + l.values.length, 0);
      const total = state.levels.reduce((a, l) => a + l.capacity, 0);
      expect(retained).toBeLessThanOrEqual(total);
      // 1 回の投入で compaction は最大 1 回。compaction すると保持要素数は投入前以下になる(1 以上減る)
      expect(state.compactions - previous.compactions).toBeLessThanOrEqual(1);
      if (state.compactions > previous.compactions) expect(retained).toBeLessThanOrEqual(previous.retained);
      // 段を足すと容量の合計は増え、減らない
      expect(total).toBeGreaterThanOrEqual(previous.total);
      previous = { retained, total, compactions: state.compactions };
      expect(total).toBeLessThanOrEqual(3 * 8 + 2 * state.levels.length);
      const text = weightText[n];
      if (text !== undefined) {
        expect(rowOf(table, String(n))).toEqual([String(n), text, String(retained), String(total)]);
      }
    }
    expect(Object.keys(weightText).length).toBe(4);
    for (const s of [
      '投入のあとの保持要素数 ≤ 容量の合計 ≤ 3k + 2H である',
      '1回の投入で行うcompactionは、最大1回である',
      '1回のcompactionで、保持する要素数は1以上減る',
      '容量の合計は減らない',
    ]) {
      expect(doc).toContain(s);
    }
    expect(doc).toContain(
      'n = 25 の段2の5個は、重み4の要素なので、20件を代表している。25件が9個に縮み、保持要素数は容量の合計16以下である',
    );
  });

  it('1回の compaction が順位の推定を動かす量は、乱数 0 なら 0 か +2^h、乱数 1 なら 0 か −2^h(動く x がある)', () => {
    for (const seed of [1, 5, 7]) {
      const bits = rngBits(seed, 200);
      const sketch = kllOf(8, seed);
      let before = sketch.inspect();
      let used = 0;
      let moved = 0;
      for (let n = 1; n <= 300; n++) {
        sketch.insert(n);
        const after = sketch.inspect();
        if (after.compactions > before.compactions) {
          // 減った段が compaction の対象 h(重み w = 2^h)
          const size = (st: KllState, h: number): number => st.levels[h]?.values.length ?? 0;
          const source = after.levels.findIndex((_, h) => size(after, h) < size(before, h) + (h === 0 ? 1 : 0));
          const w = 2 ** source;
          let nonzero = 0;
          for (let x = 0; x <= n; x++) {
            const diff = estimatedRank(after, x) - (estimatedRank(before, x) + (n <= x ? 1 : 0));
            expect(bits[used] === 0 ? [0, w] : [0, -w]).toContain(diff);
            if (diff !== 0) nonzero++;
          }
          // x をまたぐ組は組ごとに 1 つで、乱数が選ぶ側が決まる。値が 1 個ずつの段なら動く x が必ずある
          if (nonzero > 0) moved++;
          used++;
        }
        before = after;
      }
      expect(used).toBeGreaterThan(20);
      expect(moved).toBeGreaterThan(0);
    }
    for (const s of [
      'a ≤ x < b なら、真の寄与は w だが、aを残すと 2w、bを残すと 0 になる。誤差は+wか−wで、乱数が0か1かで決まる。',
      '+2^h、−2^h、0のどれかで、乱数が一様なら期待値は0である',
      '0なら各組の小さい方、1なら大きい方である',
    ]) {
      expect(doc).toContain(s);
    }
  });

  it('問い合わせは状態を変えない', () => {
    const sketch = kllOf(8, 1);
    for (let n = 1; n <= 25; n++) sketch.insert(n);
    const before = sketch.inspect();
    for (const q of [0, 0.5, 1]) queryOf(sketch, q);
    expect(sketch.inspect()).toEqual(before);
    expect(doc).toContain('問い合わせは、要約の状態を変えない。');
  });

  it('シード5との比較: n = 9 と n = 25 の状態、x 以下の件数の推定の誤差が表と一致する', () => {
    const seed5 = kllOf(8, 5);
    const seed1 = kllOf(8, 1);
    for (let n = 1; n <= 9; n++) {
      seed1.insert(n);
      seed5.insert(n);
    }
    const a = seed1.inspect();
    const b = seed5.inspect();
    expect(a.levels[1]!.values).toEqual([3, 5, 7, 9]);
    expect(b.levels[1]!.values).toEqual([2, 4, 6, 8]);
    const table = section(trace, '### 乱数の役割: シード5との比較');
    for (const x of [2, 3, 4, 5]) {
      const ea = estimatedRank(a, x);
      const eb = estimatedRank(b, x);
      expect(rowOf(table, String(x))).toEqual([
        String(x),
        String(x),
        String(ea),
        signed(ea - x),
        String(eb),
        signed(eb - x),
      ]);
    }
    for (let n = 10; n <= 25; n++) {
      seed5.insert(n);
    }
    expect(levelsText(seed5.inspect())).toBe('段0(容量3): [19,24,25] / 段1(容量5): [2] / 段2(容量8): [6,10,14,18,22]');
    expect(doc).toContain('n = 9 の段1は [2,4,6,8] になる(シード1は [3,5,7,9])');
    expect(doc).toContain('段0が [19,24,25]、段1が [2]、段2が [6,10,14,18,22] である');
  });

  it('問い合わせの表: 目標順位、返される値、順位誤差がシード1とシード5の実装の出力と一致する', () => {
    const table = section(trace, '### 問い合わせの結果');
    const sorted = Float64Array.from({ length: 25 }, (_, i) => i + 1);
    const sketches = [kllOf(8, 1), kllOf(8, 5)];
    for (const s of sketches) for (let n = 1; n <= 25; n++) s.insert(n);
    const cumulative: number[] = [];
    let acc = 0;
    for (const l of [...sketches[0]!.inspect().levels]
      .flatMap((lv) => lv.values.map((v) => ({ v, w: lv.weight })))
      .sort((x, y) => x.v - y.v)) {
      acc += l.w;
      cumulative.push(acc);
    }
    expect(cumulative).toEqual([2, 6, 10, 14, 18, 19, 23, 24, 25]);
    for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const cells = [String(q), String(nearestRank(25, q))];
      for (const s of sketches) {
        const est = queryOf(s, q);
        const re = rankError(sorted, est, q);
        if (!re.ok) throw new Error('rankError');
        // 値は 1〜25 の異なる整数なので、値がそのまま真の順位
        expect(Math.abs(est - nearestRank(25, q)) / 25).toBe(re.value);
        cells.push(String(est), String(re.value));
      }
      expect(rowOf(table, String(q))).toEqual(cells);
    }
    expect(queryOf(sketches[0]!, 0.5)).toBe(11);
    expect(queryOf(sketches[1]!, 0)).toBe(2);
    for (const s of [
      '(1,重み2)(3,4)(7,4)(11,4)(15,4)(19,1)(21,4)(24,1)(25,1) で、重みの累計は 2、6、10、14、18、19、23、24、25 である',
      '順位は13と11の差の2、誤差は 2 ÷ 25 = 0.08 である',
      'シード5の q = 0 は、最小値1が段で捨てられたため、2を返す',
    ]) {
      expect(doc).toContain(s);
    }
  });

  it('保証は確率的: シードによって結果が違い、文書は定数を保証として扱わない', () => {
    expect(doc).toContain('KLLが約束するのは、順位誤差が「高い確率で小さい」ことである');
    expect(doc).toContain('論文の定数を保証としては扱わない');
    expect(doc).toContain('特定のシードで誤差が小さいことは約束せず');
    const outcomes = new Set<string>();
    for (const seed of [1, 5, 7]) {
      const s = kllOf(8, seed);
      for (let n = 1; n <= 25; n++) s.insert(n);
      outcomes.add(levelsText(s.inspect()));
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

function tdOf(compression: number, scale: ScaleFunctionKind): TDigestSketch {
  const r = createTDigest({ compression, scale });
  if (!r.ok) throw new Error('tdigest');
  return r.value;
}

/** 1〜49 を昇順に投入して問い合わせ(バッファをまとめる)た t-digest */
function td49(scale: ScaleFunctionKind): TDigestSketch {
  const t = tdOf(10, scale);
  for (let v = 1; v <= 49; v++) t.insert(v);
  queryOf(t, 0.5);
  return t;
}

const kinds: readonly ScaleFunctionKind[] = ['k0', 'k1', 'k2'];

describe('t-digest.md の例 δ = 10、値 1〜49', () => {
  const doc = readDoc('t-digest.md');

  it('バッファ容量は ⌈5δ⌉ = 50 で、49 件ではまとまらず、最初の問い合わせがまとめる', () => {
    const t = tdOf(10, 'k0');
    for (let v = 1; v <= 49; v++) t.insert(v);
    expect(t.inspect().buffered).toBe(49);
    expect(t.inspect().centroids).toEqual([]);
    expect(Math.ceil(5 * 10)).toBe(50);
    expect(t.inspect().min).toBe(1);
    expect(t.inspect().max).toBe(49);
    // 50 件目で容量に達して束ねる(問い合わせなしで centroid ができる)
    const full = tdOf(10, 'k0');
    for (let v = 1; v <= 50; v++) full.insert(v);
    expect(full.inspect().buffered).toBe(0);
    expect(full.inspect().centroids.length).toBeGreaterThan(0);
    queryOf(t, 0.5);
    expect(t.inspect().buffered).toBe(0);
    expect(t.inspect().centroids.length).toBeGreaterThan(0);
    for (const s of [
      'バッファの容量は ⌈5δ⌉ である。δ = 10 なら50になる。',
      'バッファは49件で容量50に届かないので、`inspect()`は`buffered`が49、centroidが空である。',
    ]) {
      expect(doc).toContain(s);
    }
  });

  for (const [kind, heading] of [
    ['k0', '### k0 の場合'],
    ['k1', '### k1 の場合'],
    ['k2', '### k2 の場合'],
  ] as const) {
    it(`${kind}: まとめの表の各行(確定済みの重み、q_left、上限、上限 × n、重み、平均値)が実装の出力と一致する`, () => {
      const table = section(doc, heading);
      const { centroids } = td49(kind).inspect();
      let settled = 0;
      for (const c of centroids) {
        const limit = scaleLimit(kind, settled / 49, 10, 49);
        expect(rowOf(table, String(settled))).toEqual([
          String(settled),
          (settled / 49).toFixed(4),
          limit.toFixed(4),
          (limit * 49).toFixed(3),
          String(c.weight),
          String(c.mean),
        ]);
        // 貪欲な規則: この重みで上限以内(1 件だけの centroid は上限を超えてもよい)、1 件多いと超える(最後を除く)
        if (c.weight > 1) expect((settled + c.weight) / 49).toBeLessThanOrEqual(limit);
        if (settled + c.weight < 49) expect((settled + c.weight + 1) / 49).toBeGreaterThan(limit);
        settled += c.weight;
      }
      expect(settled).toBe(49);
      // 表の行数と centroid の数が一致する(行の取りこぼしがない)
      expect(table.split('\n').filter((l) => /^\| \d/.test(l)).length).toBe(centroids.length);
    });
  }

  it('k0 の手計算: 9 件目で右端 9 ≤ 9.8、10 件目は 10 > 9.8、平均値 5、最後は残りの 4 件で平均 47.5', () => {
    const t = td49('k0');
    expect(0.2 * 49).toBeCloseTo(9.8, 12);
    expect(9 <= 9.8 && 10 > 9.8).toBe(true);
    expect((1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9) / 9).toBe(5);
    expect(t.inspect().centroids[0]).toEqual({ mean: 5, weight: 9 });
    expect(t.inspect().centroids[5]).toEqual({ mean: 47.5, weight: 4 });
    expect(scaleLimit('k0', 45 / 49, 10, 49)).toBe(1);
    for (const s of [
      '9件で右端が 9 ≤ 9.8 を満たし、10件目は 10 > 9.8 で加えられない',
      '平均値は (1 + 2 + … + 9) / 9 = 5 である',
      '残りの 46〜49 の4件が全部入り、平均値は 47.5 である',
    ]) {
      expect(doc).toContain(s);
    }
  });

  it('k2: 最初の上限は 0 で 1 だけの centroid、4 つ目は 49 を加えると 49 > 48.674 になる', () => {
    expect(scaleLimit('k2', 0, 10, 49)).toBe(0);
    const c = td49('k2').inspect().centroids;
    expect(c[0]).toEqual({ mean: 1, weight: 1 });
    expect(c[3]).toEqual({ mean: 46, weight: 5 });
    expect(c[4]).toEqual({ mean: 49, weight: 1 });
    expect(49 > scaleLimit('k2', 43 / 49, 10, 49) * 49).toBe(true);
    expect(doc).toContain('上限 × n が 48.674 で、6件目の49を加えると 49 > 48.674 になるので、5件(44〜48)で確定する');
    expect(doc).toContain('残った49は、最後のcentroidを1件だけで作る');
  });

  it('裾と中央の重みの違い: 先頭・最大・末尾の重みが表と一致し、k0 は一様、k1・k2 は裾が小さい', () => {
    const table = section(doc, '### 裾と中央の重みの違い');
    const first: Record<string, number> = {};
    const last: Record<string, number> = {};
    const max: Record<string, number> = {};
    for (const kind of kinds) {
      const weights = td49(kind)
        .inspect()
        .centroids.map((c) => c.weight);
      expect(weights.reduce((a, w) => a + w, 0)).toBe(49);
      first[kind] = weights[0]!;
      last[kind] = weights[weights.length - 1]!;
      max[kind] = Math.max(...weights);
      expect(rowOf(table, kind)).toEqual([
        kind,
        String(weights.length),
        weights.join('、'),
        String(first[kind]),
        String(max[kind]),
        String(last[kind]),
      ]);
    }
    expect(first).toEqual({ k0: 9, k1: 4, k2: 1 });
    expect(max).toEqual({ k0: 9, k1: 15, k2: 29 });
    expect(last).toEqual({ k0: 4, k1: 1, k2: 1 });
    // 裾(先頭・末尾)が中央の最大より小さい: k1、k2。k0 の先頭は最大と同じ
    expect(first.k1! < max.k1! && last.k1! < max.k1!).toBe(true);
    expect(first.k2! < max.k2! && last.k2! < max.k2!).toBe(true);
    expect(first.k0).toBe(max.k0);
  });

  it('折れ線の点: n = 49 の点と、補間の手計算(12.75、1.3675、k2 の q = 0.01 は 1、q = 1 は最大値)', () => {
    for (const kind of kinds) {
      const { centroids } = td49(kind).inspect();
      let settled = 0;
      const points = [[0, 1]];
      for (const c of centroids) {
        points.push([settled + c.weight / 2, c.mean]);
        settled += c.weight;
      }
      points.push([49, 49]);
      const text = points.map(([x, y]) => `(${x}, ${y})`).join('、');
      expect(doc).toContain(`- ${kind}: ${text}`);
    }
    expect(5 + (9 * (12.25 - 4.5)) / (13.5 - 4.5)).toBe(12.75);
    expect(queryOf(td49('k0'), 0.25)).toBe(12.75);
    expect(1 + (1.5 * 0.49) / 2).toBeCloseTo(1.3675, 12);
    expect(queryOf(td49('k1'), 0.01).toFixed(4)).toBe('1.3675');
    expect(queryOf(td49('k2'), 0.01)).toBe(1);
    expect(queryOf(td49('k0'), 1)).toBe(49);
    for (const s of [
      't = 0.25 × 49 = 12.25',
      '5 + (14 − 5) × (12.25 − 4.5) / (13.5 − 4.5) = 5 + 9 × 7.75 / 9 = 12.75',
      '1 + (2.5 − 1) × 0.49 / 2 = 1.3675',
      't = 49 が終点の位置と等しいので、最大値49を返す',
    ]) {
      expect(doc).toContain(s);
    }
  });

  it('推定値の表: 厳密な値(最近順位法)と、スケール関数ごとの推定値(小数第4位)が実装の出力と一致する', () => {
    const table = section(doc, '## 補間');
    const sorted = Float64Array.from({ length: 49 }, (_, i) => i + 1);
    const digests = kinds.map((k) => td49(k));
    for (const q of [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
      const exact = exactQuantileSorted(sorted, q, 'nearest-rank');
      expect(exact).toBe(nearestRank(49, q));
      expect(rowOf(table, String(q))).toEqual([
        String(q),
        String(exact),
        ...digests.map((d) => queryOf(d, q).toFixed(4)),
      ]);
    }
    // 裾: k0 は外れ、k1、k2 の順に厳密な値に近づく。中央は 3 つとも同じ
    const err = (d: TDigestSketch, q: number): number => Math.abs(queryOf(d, q) - nearestRank(49, q));
    expect(err(digests[0]!, 0.01)).toBeGreaterThan(err(digests[1]!, 0.01));
    expect(err(digests[1]!, 0.01)).toBeGreaterThan(err(digests[2]!, 0.01));
    expect(err(digests[2]!, 0.01)).toBe(0);
    expect(err(digests[0]!, 0.99)).toBeGreaterThan(err(digests[1]!, 0.99));
    for (const q of [0.1, 0.5, 0.9]) {
      expect(queryOf(digests[0]!, q)).toBe(queryOf(digests[1]!, q));
      expect(queryOf(digests[1]!, q)).toBe(queryOf(digests[2]!, q));
    }
  });
});

describe('t-digest.md のスケール関数の幅の表と、順位誤差の上限がないことの例', () => {
  const doc = readDoc('t-digest.md');

  it('文書の k(q) の式: 上限は k(q_right) − k(q_left) = 1 になる位置(頭打ちでない範囲)', () => {
    const delta = 100;
    const n = 10000;
    const z = 4 * Math.log(Math.max(n / delta, 1)) + 24;
    const k: Record<ScaleFunctionKind, (q: number) => number> = {
      k0: (q) => (delta * q) / 2,
      k1: (q) => (delta / (2 * Math.PI)) * Math.asin(2 * q - 1),
      k2: (q) => (delta / z) * Math.log(q / (1 - q)),
    };
    for (const kind of kinds) {
      for (const q of [0.01, 0.1, 0.3, 0.5]) {
        const limit = scaleLimit(kind, q, delta, n);
        expect(limit).toBeLessThan(1);
        expect(k[kind](limit) - k[kind](q)).toBeCloseTo(1, 9);
      }
    }
  });

  it('δ = 100、n = 10000 の幅(上限 − q_left、小数第4位)が表と一致し、k0 は一様、k1・k2 は裾で小さく中央で大きい', () => {
    const table = section(doc, '## スケール関数と centroid の大きさ');
    const width = (kind: ScaleFunctionKind, q: number): number => scaleLimit(kind, q, 100, 10000) - q;
    for (const q of [0, 0.01, 0.1, 0.5]) {
      expect(rowOf(table, String(q))).toEqual([String(q), ...kinds.map((k) => width(k, q).toFixed(4))]);
    }
    for (const q of [0, 0.01, 0.1, 0.5]) expect(width('k0', q)).toBeCloseTo(0.02, 12);
    for (const kind of ['k1', 'k2'] as const) {
      expect(width(kind, 0.01)).toBeLessThan(width('k0', 0.01));
      expect(width(kind, 0.5)).toBeGreaterThan(width('k0', 0.5));
    }
    expect(scaleLimit('k2', 0, 100, 10000)).toBe(0);
    expect(width('k1', 0) * 10000).toBeCloseTo(9.9, 1);
    expect(width('k1', 0.5)).toBeCloseTo(Math.PI / 100, 3);
    for (const s of [
      'k(q_right) − k(q_left) ≤ 1',
      'k0: k(q) = δq / 2',
      'k1: k(q) = δ / (2π) × asin(2q − 1)',
      'k2: k(q) = δ / Z × ln(q / (1−q))',
      'Z(n) = 4 ln(max(n/δ, 1)) + 24',
      'k0は、どこでも幅0.02で、10000件なら約200件まで入る',
      'q_left = 0 では、k1は約10件(0.001 × 10000)、k2は幅0なので1件だけである',
    ]) {
      expect(doc).toContain(s);
    }
  });

  it('順位誤差の上限がない例: 2つのデータの centroid 列が完全に同じで、推定値も同じ 5.4 だが、順位誤差は 0 と 0.0816', () => {
    const table = section(doc, '## 順位誤差の上限がない理由');
    const even = Array.from({ length: 49 }, (_, i) => i + 1);
    const dup = [...Array.from({ length: 9 }, () => 5), ...Array.from({ length: 40 }, (_, i) => 10 + i)];
    expect(even.length).toBe(49);
    expect(dup.length).toBe(49);
    const digests = [even, dup].map((data) => {
      const t = tdOf(10, 'k0');
      for (const v of data) t.insert(v);
      return t;
    });
    const estimates = digests.map((t) => queryOf(t, 0.1));
    // 要約は完全に同じ(centroid の列全体)
    const centroids = digests.map((t) => t.inspect().centroids);
    expect(centroids[1]).toEqual(centroids[0]);
    // 文書の centroid 列は実装の出力と一致し、文書から読み取る
    const listLine = table.split('\n').find((l) => l.startsWith('centroid(平均値, 重み)は、'));
    if (listLine === undefined) throw new Error('centroid list not found');
    const docCentroids = [...listLine.matchAll(/\(([\d.]+), (\d+)\)/g)].map((m) => ({
      mean: Number(m[1]),
      weight: Number(m[2]),
    }));
    expect(docCentroids).toEqual(centroids[0]);
    // 推定値は同じ 5.4
    expect(estimates).toEqual([5.4, 5.4]);
    // 文書の表(厳密な値・推定値・件数・順位誤差)が実装と core の rankError に一致する
    const labels = ['A: 1から49', 'B: 5が9個、10から49'];
    [even, dup].forEach((data, i) => {
      const sorted = Float64Array.from(data).sort();
      const re = rankError(sorted, estimates[i]!, 0.1);
      if (!re.ok) throw new Error('rankError');
      const exact = exactQuantileSorted(sorted, 0.1, 'nearest-rank');
      expect(exact).toBe(5);
      expect(nearestRank(49, 0.1)).toBe(5);
      const below = data.filter((v) => v <= estimates[i]!).length;
      expect(rowOf(table, labels[i]!)).toEqual([
        labels[i],
        String(exact),
        estimates[i]!.toFixed(4),
        String(below),
        re.value.toFixed(4),
      ]);
      expect(re.value).toBe(Math.abs(below - 5) / 49);
    });
    expect(rowOf(table, labels[0]!)[3]).toBe('5');
    expect(rowOf(table, labels[1]!)[3]).toBe('9');
    expect(rowOf(table, labels[0]!)[4]).toBe('0.0000');
    expect(rowOf(table, labels[1]!)[4]).toBe('0.0816');
    expect(table).toContain('ceil(49 × 0.1) = 5 の値5');
    expect(table).toContain('4 / 49 = 0.0816');
    expect(table).toContain('典型的な誤差の大きさを表すものではない');
  });

  it('保証の文言: 順位誤差の上限を保証しない(保証する記述がない)', () => {
    expect(doc).toContain('t-digestは、順位誤差の上限を保証しない。この実装も、上限を導出していない。');
    expect(doc).toContain('これは条件つきの観察であり、約束ではない。');
    expect(doc).not.toMatch(/順位誤差は.*以下になる/);
  });

  it('乱数は使わない: 同じ入力から同じ inspect() になる', () => {
    for (const kind of kinds) {
      expect(td49(kind).inspect()).toEqual(td49(kind).inspect());
    }
    expect(doc).toContain('乱数は使わず、同じ入力からは必ず同じ結果になる');
  });
});

describe('overview.md の記述', () => {
  const doc = readDoc('overview.md');

  it('マージの機能は提供しない: 公開 API にもスケッチにもマージがない', () => {
    expect(Object.keys(api).filter((k) => /merge/i.test(k))).toEqual([]);
    const kll = createKll({ k: 8 });
    const td = createTDigest({ compression: 20, scale: 'k1' });
    if (!kll.ok || !td.ok) throw new Error('create');
    for (const sk of [gkOf(0.1), kll.value, td.value]) {
      expect(Object.keys(sk).filter((k) => /merge/i.test(k))).toEqual([]);
      expect('merge' in sk).toBe(false);
    }
    expect(doc).toContain('このリポジトリの実装は、マージの機能を提供しない。');
  });

  it('KLL の下限容量 2 と、容量の合計 ≤ 3k + 2 × 段数、投入ごとの compaction は最大1回', () => {
    const r = createKll({ k: 8 });
    if (!r.ok) throw new Error('kll');
    let previous = 0;
    for (let i = 1; i <= 2000; i++) {
      r.value.insert(i);
      const s = r.value.inspect();
      expect(s.compactions - previous).toBeLessThanOrEqual(1);
      previous = s.compactions;
      const retained = s.levels.reduce((a, l) => a + l.values.length, 0);
      const capacity = s.levels.reduce((a, l) => a + l.capacity, 0);
      expect(retained).toBeLessThanOrEqual(capacity);
      expect(capacity).toBeLessThanOrEqual(3 * 8 + 2 * s.levels.length);
    }
    const levels = r.value.inspect().levels;
    expect(Math.min(...levels.map((l) => l.capacity))).toBe(2);
    expect(doc).toContain('下限を2にしている');
    expect(doc).toContain('3k + 2 × 段数 以下');
  });

  it('t-digest の k2 の正規化 Z(n) は n < δ では n = δ と同じ(下限は max(n/δ, 1))', () => {
    for (const q of [0.01, 0.3, 0.5, 0.9]) {
      expect(scaleLimit('k2', q, 100, 10)).toBe(scaleLimit('k2', q, 100, 1));
      expect(scaleLimit('k2', q, 100, 10)).toBe(scaleLimit('k2', q, 100, 100));
    }
    // n > δ では Z(n) が大きくなり、上限が変わる
    expect(scaleLimit('k2', 0.3, 100, 100000)).not.toBe(scaleLimit('k2', 0.3, 100, 100));
    expect(doc).toContain('Z(n) = 4 ln(max(n/δ, 1)) + 24');
  });

  it('保証の種類の比較表が3手法の行を持つ', () => {
    expect(rowOf(doc, 'GK')[2]).toBe('決定的(いつでも成り立つ)');
    expect(rowOf(doc, 'KLL')[2]).toBe('確率的(乱数のシードによって誤差が変わる)');
    expect(rowOf(doc, 't-digest')[2]).toBe('保証なし(傾向だけ)');
  });
});

// ---------------------------------------------------------------------------------------------
// experiments.md: 文書の表が基準。文書と同じ条件(基準の定義は最近順位法、データのシード1、
// 主な表の挿入順序はランダム)で実験を再実行し、表の各行と、文書が述べる性質を確かめる
// ---------------------------------------------------------------------------------------------

const LOGNORMAL: Distribution = { kind: 'lognormal', mu: 0, sigma: 1 };
/** 有効数字3桁。文書の表と同じ書き方にする */
const fmt = (x: number): string => String(Number(x.toPrecision(3)));
const QS = [0, 0.5, 0.9, 0.99, 0.999, 1] as const;
const QUANTILES_MAIN = [0, 0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999, 1] as const;
const QUANTILES_DETAIL = [0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999] as const;
const GK_EPSILONS = [0.1, 0.05, 0.01, 0.005] as const;
const KLL_KS = [16, 32, 64, 128, 256] as const;
const TDIGEST_COMPRESSIONS = [20, 50, 100, 200] as const;
const MAIN_COUNTS = [1000, 10000, 100000] as const;
const TRIAL_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const DATA_SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const ORDERS: readonly DataOrder[] = ['ascending', 'descending', 'random'];
const SCALES: readonly ScaleFunctionKind[] = ['k0', 'k1', 'k2'];

const gkIds = GK_EPSILONS.map((e) => `gk-eps-${e}`);
const kllIds = KLL_KS.map((k) => `kll-k-${k}`);
const tdigestK1Ids = TDIGEST_COMPRESSIONS.map((c) => `tdigest-k1-c${c}`);
const EXACT_ID = 'exact-sort-nearest-rank';

function runExperiment(spec: {
  counts: number[];
  seed?: number;
  orders?: DataOrder[];
  trialSeeds?: number[];
  quantiles: readonly number[];
  sketches: StreamingSketchConfig[];
}) {
  const r = runStreamingExperiment({
    cases: [{ label: 'lognormal', distribution: LOGNORMAL }],
    seed: 1,
    referenceDefinition: 'nearest-rank',
    ...spec,
  });
  if (!r.ok) throw new Error(`experiment failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function okAlgorithm(
  sweep: SweepResult,
  count: number,
  id: string,
  trial = 0,
): Extract<AlgorithmResult, { status: 'ok' }> {
  const run = sweep.runs.filter((r) => r.count === count)[trial];
  const a = run?.algorithms.find((x) => x.id === id);
  if (a === undefined || a.status !== 'ok') throw new Error(`missing ${count} ${id} ${trial}`);
  return a;
}

const rankErrorAt = (a: Extract<AlgorithmResult, { status: 'ok' }>, q: number): number => {
  const r = a.queries.find((x) => x.quantile === q);
  if (r === undefined) throw new Error(`missing q=${q}`);
  return r.rankError;
};
const maxRankError = (a: Extract<AlgorithmResult, { status: 'ok' }>): number =>
  Math.max(...a.queries.map((x) => x.rankError));
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const rms = (xs: readonly number[]): number => Math.sqrt(mean(xs.map((x) => x * x)));

interface ExpectedTable {
  readonly heading: string;
  readonly header: string[];
  readonly rows: string[][];
}

let experimentCache: ReturnType<typeof computeExperiments> | undefined;
const experiments = (): ReturnType<typeof computeExperiments> => (experimentCache ??= computeExperiments());

function computeExperiments() {
  const gk = GK_EPSILONS.map((epsilon) => ({ kind: 'gk' as const, epsilon }));
  const kll = KLL_KS.map((k) => ({ kind: 'kll' as const, k }));
  const tdigestK1 = TDIGEST_COMPRESSIONS.map((compression) => ({
    kind: 'tdigest' as const,
    compression,
    scale: 'k1' as const,
  }));
  // 主な表: 件数を変える。挿入順序はランダム
  const main = runExperiment({
    counts: [...MAIN_COUNTS],
    quantiles: QUANTILES_MAIN,
    sketches: [...gk, ...kll, ...tdigestK1],
  });
  // 挿入順序の比較と t-digest のスケール関数の比較: 件数10,000
  const tdigestScales = SCALES.flatMap((scale) =>
    [50, 100].map((compression) => ({ kind: 'tdigest' as const, compression, scale })),
  );
  const order = runExperiment({
    counts: [10000],
    orders: [...ORDERS],
    quantiles: QUANTILES_DETAIL,
    sketches: [{ kind: 'gk', epsilon: 0.05 }, { kind: 'gk', epsilon: 0.01 }, { kind: 'kll', k: 64 }, ...tdigestScales],
  });
  // KLL の試行間のばらつき: 試行のシード 1〜20、挿入順序ごと
  const trials = runExperiment({
    counts: [10000],
    orders: [...ORDERS],
    trialSeeds: TRIAL_SEEDS,
    quantiles: QUANTILES_DETAIL,
    sketches: kll,
  });
  // t-digest の裾と中央: データのシード 1〜10(δ = 100 の表と、δ = 50 の平均の文に使う)
  const dataSeeds = DATA_SEEDS.map((seed) =>
    runExperiment({
      counts: [10000],
      seed,
      quantiles: QUANTILES_DETAIL,
      sketches: SCALES.flatMap((scale) =>
        [50, 100].map((compression) => ({ kind: 'tdigest' as const, compression, scale })),
      ),
    }),
  );
  return { main, order, trials, dataSeeds };
}

/** データのシード1〜10の、件数10,000の1つの分位点の値(10個) */
const seedValues = (id: string, q: number, pick: 'rankError' | 'relativeError'): number[] =>
  experiments().dataSeeds.map(
    (r) => okAlgorithm(r.cases[0]!.sweep, 10000, id).queries.find((x) => x.quantile === q)![pick],
  );

/** 裾(q = 0.001、q = 0.999、その両方)が中央(q = 0.5)に対して cmp を満たしたデータのシードの数 */
const tailCounts = (
  id: string,
  pick: 'rankError' | 'relativeError',
  cmp: (tail: number, middle: number) => boolean,
): [number, number, number] => {
  const middle = seedValues(id, 0.5, pick);
  const low = seedValues(id, 0.001, pick).map((v, i) => cmp(v, middle[i]!));
  const high = seedValues(id, 0.999, pick).map((v, i) => cmp(v, middle[i]!));
  const count = (xs: boolean[]): number => xs.filter(Boolean).length;
  return [count(low), count(high), count(low.map((b, i) => b && high[i]!))];
};

function buildTables(): Record<string, ExpectedTable> {
  const { main, order, trials, dataSeeds } = experiments();
  const mainSweep = main.cases[0]!.sweep;
  const orderSweep = (o: DataOrder): SweepResult => order.cases.find((c) => c.order === o)!.sweep;
  const trialSweep = (o: DataOrder): SweepResult => trials.cases.find((c) => c.order === o)!.sweep;
  const tables: Record<string, ExpectedTable> = {};
  const qHeader = (qs: readonly number[]): string[] => qs.map((q) => `q=${q}`);

  // 1. パラメータとメモリ・誤差(件数10,000)
  tables.parameters = {
    heading: '### 件数10,000での順位誤差(シード1)',
    header: ['手法', 'メモリ(バイト)', ...qHeader(QS), '最大'],
    rows: [...gkIds, ...kllIds, ...tdigestK1Ids].map((id) => {
      const a = okAlgorithm(mainSweep, 10000, id);
      return [id, String(a.afterInsertion.memoryBytes), ...QS.map((q) => fmt(rankErrorAt(a, q))), fmt(maxRankError(a))];
    }),
  };

  // 2. 件数とメモリ
  tables.memory = {
    heading: '### 件数ごとのメモリ(シード1)',
    header: ['手法', '件数1,000', '件数10,000', '件数100,000', '100,000 ÷ 1,000'],
    rows: [EXACT_ID, ...gkIds, ...kllIds, ...tdigestK1Ids].map((id) => {
      const m = MAIN_COUNTS.map((n) => okAlgorithm(mainSweep, n, id).afterInsertion.memoryBytes);
      return [id, ...m.map(String), fmt(m[2]! / m[0]!)];
    }),
  };

  // 3. GK
  tables.gkCounts = {
    heading: '### 件数ごとの最大順位誤差(シード1)',
    header: ['手法', 'ε', '件数1,000', '件数10,000', '件数100,000'],
    rows: gkIds.map((id, i) => [
      id,
      String(GK_EPSILONS[i]),
      ...MAIN_COUNTS.map((n) => fmt(maxRankError(okAlgorithm(mainSweep, n, id)))),
    ]),
  };
  tables.gkQuantiles = {
    heading: '### 分位点ごとの順位誤差(件数10,000、シード1)',
    header: ['手法', ...qHeader(QUANTILES_MAIN)],
    rows: gkIds.map((id) => [id, ...QUANTILES_MAIN.map((q) => fmt(rankErrorAt(okAlgorithm(mainSweep, 10000, id), q)))]),
  };

  // 4. KLL(ランダム、20試行)
  const kllErrors = (o: DataOrder, id: string): number[] =>
    trialSweep(o).runs.flatMap((r) => {
      const a = r.algorithms.find((x) => x.id === id);
      if (a === undefined || a.status !== 'ok') throw new Error('kll');
      return a.queries.map((x) => x.rankError);
    });
  const kllTrial = (o: DataOrder, id: string, q: number): number[] =>
    trialSweep(o).runs.map((r) => {
      const a = r.algorithms.find((x) => x.id === id);
      if (a === undefined || a.status !== 'ok') throw new Error('kll');
      return rankErrorAt(a, q);
    });
  tables.kll = {
    heading: '### 20試行の順位誤差(ランダム、件数10,000)',
    header: [
      '手法',
      'メモリ(バイト)',
      'q=0.5の最小',
      'q=0.5の最大',
      '全体の平均',
      '全体の二乗平均平方根',
      '全体の最大',
    ],
    rows: kllIds.map((id) => {
      const all = kllErrors('random', id);
      const q5 = kllTrial('random', id, 0.5);
      return [
        id,
        String(okAlgorithm(trialSweep('random'), 10000, id).afterInsertion.memoryBytes),
        fmt(Math.min(...q5)),
        fmt(Math.max(...q5)),
        fmt(mean(all)),
        fmt(rms(all)),
        fmt(Math.max(...all)),
      ];
    }),
  };

  // 5. t-digest
  const tdIds = SCALES.flatMap((s) => [50, 100].map((c) => `tdigest-${s}-c${c}`));
  tables.tdigestRank = {
    heading: '### 順位誤差(件数10,000、ランダム、シード1)',
    header: ['手法', 'メモリ(バイト)', ...qHeader(QUANTILES_DETAIL)],
    rows: tdIds.map((id) => {
      const a = okAlgorithm(orderSweep('random'), 10000, id);
      return [id, String(a.afterInsertion.memoryBytes), ...QUANTILES_DETAIL.map((q) => fmt(rankErrorAt(a, q)))];
    }),
  };
  tables.tdigestRelative = {
    heading: '### 相対誤差(件数10,000、ランダム、シード1)',
    header: ['手法', ...qHeader(QUANTILES_DETAIL)],
    rows: tdIds.map((id) => {
      const a = okAlgorithm(orderSweep('random'), 10000, id);
      return [id, ...QUANTILES_DETAIL.map((q) => fmt(a.queries.find((x) => x.quantile === q)!.relativeError))];
    }),
  };
  const dataSeedMean = (id: string, pick: 'rankError' | 'relativeError'): number[] =>
    QUANTILES_DETAIL.map((q) =>
      mean(
        dataSeeds.map((e) => {
          const a = okAlgorithm(e.cases[0]!.sweep, 10000, id);
          return a.queries.find((x) => x.quantile === q)![pick];
        }),
      ),
    );
  const sc100 = SCALES.map((s) => `tdigest-${s}-c100`);
  tables.tdigestSeedsRank = {
    heading: '### データのシード1〜10の平均(順位誤差、δ = 100)',
    header: ['手法', ...qHeader(QUANTILES_DETAIL)],
    rows: sc100.map((id) => [id, ...dataSeedMean(id, 'rankError').map(fmt)]),
  };
  tables.tdigestSeedsRelative = {
    heading: '### データのシード1〜10の平均(相対誤差、δ = 100)',
    header: ['手法', ...qHeader(QUANTILES_DETAIL)],
    rows: sc100.map((id) => [id, ...dataSeedMean(id, 'relativeError').map(fmt)]),
  };

  const countRow = (
    id: string,
    pick: 'rankError' | 'relativeError',
    cmp: (a: number, b: number) => boolean,
  ): string[] => [id, ...tailCounts(id, pick, cmp).map(String)];
  tables.seedCountsRank = {
    heading: '### 裾が中央より小さかったシード数(δ = 100、10回中)',
    header: ['手法', 'q=0.001', 'q=0.999', '両方'],
    rows: sc100.map((id) => countRow(id, 'rankError', (a, b) => a < b)),
  };
  tables.seedCountsRelative = {
    heading: '### 相対誤差の裾が中央より大きかったシード数(δ = 100、10回中)',
    header: ['手法', 'q=0.001', 'q=0.999', '両方'],
    rows: sc100.map((id) => countRow(id, 'relativeError', (a, b) => a > b)),
  };

  // 6. 挿入順序
  const orderHeader = ['手法', '昇順', '降順', 'ランダム'];
  const orderIds = ['gk-eps-0.05', 'gk-eps-0.01', 'kll-k-64', ...tdIds];
  tables.orderMemory = {
    heading: '### メモリ(バイト、シード1)',
    header: orderHeader,
    rows: orderIds.map((id) => [
      id,
      ...ORDERS.map((o) => String(okAlgorithm(orderSweep(o), 10000, id).afterInsertion.memoryBytes)),
    ]),
  };
  tables.orderError = {
    heading: '### 最大順位誤差(7分位点、シード1)',
    header: orderHeader,
    rows: orderIds.map((id) => [id, ...ORDERS.map((o) => fmt(maxRankError(okAlgorithm(orderSweep(o), 10000, id))))]),
  };
  tables.orderKll = {
    heading: '### KLL の20試行の平均誤差',
    header: orderHeader,
    rows: kllIds.map((id) => [id, ...ORDERS.map((o) => fmt(mean(kllErrors(o, id))))]),
  };
  return tables;
}

type ClaimScope = 'seed1' | 'mean10' | 'trials20';

/** 主張の文頭に書く測定の範囲(experiments.md の「実験の条件」と同じ) */
const SCOPE_LEADS: Record<ClaimScope, readonly string[]> = {
  seed1: ['シード1の表では、'],
  mean10: ['10回の平均(δ = 100)では、', '10回の個々のシード(δ = 100)では、'],
  trials20: ['20試行では、'],
};
/** 「実験の条件」に書く、測定の範囲の名前 */
const SCOPE_TAGS: Record<ClaimScope, string> = {
  seed1: '【シード1】',
  mean10: '【10シード平均・δ=100】',
  trials20: '【20試行】',
};
/** 文頭に範囲を書くことを求める節(experiments.md) */
const LEAD_SECTIONS = ['## KLLの試行間のばらつき', '## t-digestの裾と中央', '## 挿入順序の影響'];

/** 比較・全称・増減・倍率・順序などを表しうる語。「実験の条件」の節と、他の文書の案内文には置かない */
const DIRECTION_RE =
  /すべて|どの|常に|必ず|より|最も|最大|最小|以上|以下|倍|順に|とは限らない|増|減|変わ|同じ|一致|傾向|大き|小さ|高|低|上回|下回|超え|逆|比例|ほぼ|わずか|少し|だけ/;
/** 程度をぼかす語。仮説と方法の説明を除く文には置かない */
const VAGUE_RE = /ほぼ|わずか|少し|かなり|やや|大幅|一貫して|顕著/;
/** 倍率・回数・大小の比較を述べる語。方法・定義・案内の文には置かない */
const COUNT_RE = /\d+(\.\d+)?倍|\d+回中|より(大|小)|上回|下回|超え/;
/** 他の文書で、experiments.md の測定を指しうる語 */
const POINTER_TRIGGER_RE = /experiments\.md|10回|20試行|20通り|データのシード|シード1の表/;

const increasing = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
const decreasing = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || x < xs[i - 1]!);
const nonIncreasing = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || x <= xs[i - 1]!);
// ---- 文の組み立て(条件が成り立たないときは throw し、向きの語は実測から選ぶ) ----
const num = (n: number): string => n.toLocaleString('en-US');
const list = (xs: readonly number[]): string => xs.map(fmt).join('、');
const must = (cond: boolean, why: string): void => {
  if (!cond) throw new Error(`実測で成り立たない: ${why}`);
};
/** 厳密に単調な並びの向きを語にする。単調でなければ throw */
const mono = (xs: readonly number[], up: string, down: string): string => {
  if (increasing(xs)) return up;
  if (decreasing(xs)) return down;
  throw new Error(`厳密に単調ではない: ${xs.join(',')}`);
};
/** a が b より小さければ「小さ」、大きければ「大き」。等しければ throw */
const adj = (a: number, b: number): string => {
  must(a !== b, `${a} と ${b} が異なる`);
  return a < b ? '小さ' : '大き';
};
/** 2つの裾の値 a、b がどちらも中央 m に対して同じ向きにあるときの語幹 */
const adjBoth = (a: number, b: number, m: number): string => {
  const x = adj(a, m);
  must(x === adj(b, m), `${a} と ${b} が ${m} に対して同じ向き`);
  return x;
};
/** 前の値から後の値への変化を語にする(「小さくなった」または「大きくなった」) */
const becomes = (from: number, to: number): string => `${adj(to, from)}くなった`;
const floor1 = (x: number): number => Math.floor(x * 10) / 10;

/** 文を、。で終わる文に分ける。残りが。で終わらなければ、それも1文とする */
function splitSentences(line: string): string[] {
  return line
    .split(/(?<=。)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
const stripBullet = (l: string): string => l.replace(/^\s*(- |\d+\. )/, '');

/** 「実験の条件」の節を除く */
function withoutConditions(text: string): string {
  const i = text.indexOf('\n## 実験の条件\n');
  if (i < 0) return text;
  const j = text.indexOf('\n## ', i + 5);
  return text.slice(0, i) + text.slice(j);
}

/** experiments.md の本文の文: 表の行、見出し、「実験の条件」の節を除き、箇条書きの印を外して、。の後で分ける */
function proseSentences(text: string): string[] {
  return withoutConditions(text)
    .split('\n')
    .filter((l) => !l.startsWith('|') && !l.startsWith('#'))
    .flatMap((l) => splitSentences(stripBullet(l)));
}

/** 他の文書の全文: 表の行は、セルごとに分ける */
function allSentences(text: string): string[] {
  return text.split('\n').flatMap((l) =>
    l.startsWith('|')
      ? l
          .split('|')
          .slice(1, -1)
          .flatMap((c) => splitSentences(c.trim()))
      : splitSentences(stripBullet(l)),
  );
}

type NaCategory = 'method' | 'definition' | 'mechanism' | 'hypothesis' | 'pointer';

/**
 * 主張でない文(測定の主張ではないもの)。種類ごとに制約がある:
 * 仮説は「と考えられる」と、原因を切り分けていないことを書く。案内は`.md`を含む。
 * 方法・定義・案内は、倍率・回数・大小の比較の語を含まない。
 */
const NOT_A_CLAIM: readonly (readonly [NaCategory, string])[] = [
  [
    'method',
    'GK、KLL、t-digestのパラメータ、件数、挿入順序を変えたときの、メモリと誤差の違いを、`runStreamingExperiment`の実験で測った結果をまとめる。',
  ],
  ['method', '表の数値は、`src/streaming/docs-examples.test.ts`が、条件を合わせて実験を再実行して確かめている。'],
  ['method', '条件・定義・仮説・参照の案内を除くすべての文は、実測から組み立てた文として、同じテストが照らしている。'],
  ['pointer', '各手法の仕組みは`gk.md`、`kll.md`、`t-digest.md`、保証の種類の比較は`overview.md`にある。'],
  [
    'method',
    '実験の結果を見てから主張を書いており、測ったのは次の条件だけで、別の分布、別のデータのシード、別のパラメータでは、結果が異なることがある。',
  ],
  ['method', '範囲は「実験の条件」の3つの名前で表し、各文の文頭に書く。'],
  [
    'definition',
    '件数10,000で各手法のパラメータを変えたときのメモリと順位誤差を並べ、「最大」は、q = 0、0.001、0.01、0.1、0.5、0.9、0.99、0.999、1の9つの分位点のうち最大の順位誤差とする(表には6つの分位点だけ載せた)。',
  ],
  [
    'mechanism',
    'overviewが書くとおり、この実装は要約の大きさの上限を証明しないので、この関係は観察であって保証ではない。',
  ],
  [
    'method',
    'シード1の表の1行から「kを大きくすると必ず小さくなる」とは言えないので、次の節以降で複数のシードを使って確かめる。',
  ],
  ['mechanism', '最小値と最大値を保持しているためである。'],
  ['mechanism', 'KLLは最小値と最大値を保持しないので、q = 0やq = 1に最小値や最大値が返るとは限らない。'],
  [
    'method',
    '件数を1,000、10,000、100,000と変えたときのメモリを、厳密解(整列方式の`exact-sort-nearest-rank`)と比べ、次の表と箇条書きはシード1の結果である。',
  ],
  ['method', '要約の大きさの上限は証明されていないので、測っていない件数での増減は言えない。'],
  ['mechanism', '保持要素数の上限は 3k + 2 × 段数 で、段数は件数とともに増えうる(`kll.md`)。'],
  ['mechanism', 'GKは、どの分位点でも順位誤差がε以下になることを保証する(導出は`gk.md`)。'],
  ['method', 'この保証を、4つのεと3つの件数で確かめるために、次の表は9つの分位点の最大を示す。'],
  [
    'mechanism',
    '問い合わせは、目標順位に許容幅ε × nを足した値を超える最大順位のタプルを探し、見つからなければ最大値を返す(`gk.md`)。',
  ],
  [
    'mechanism',
    '保証されるのは順位誤差だけで、値の誤差は保証されず、値が疎な裾では、順位が近くても値が大きく離れることがある(`gk.md`)。',
  ],
  [
    'method',
    'KLLの保証は確率的で乱数のシードに左右されるので、件数10,000のランダムな入力で、試行のシードを1から20まで変え、7つの分位点(0.001、0.01、0.1、0.5、0.9、0.99、0.999)の順位誤差を集めた(「全体」は、20試行 × 7分位点 = 140個の順位誤差である)。',
  ],
  ['definition', '保証が確率的であるとは、このような外れが起こりうるという意味である。'],
  [
    'method',
    '分位点ごとの値は試行の偶然に左右されるので、ばらつきの比較は、分位点をまとめた全体の統計と、q = 0.5の幅で行った。',
  ],
  ['mechanism', 't-digestは、順位誤差の上限を保証しない(`t-digest.md`)。'],
  ['pointer', 'ここでは、裾と中央の誤差、スケール関数による違いを測る(上限がないことの実演は`t-digest.md`にある)。'],
  [
    'method',
    '件数10,000、データのシード1の表だけでは、1つのデータの偶然が混ざるので、データのシードを1から10まで変えた10回の平均も測った(δ = 100)。',
  ],
  [
    'method',
    '平均だけでは、個々のデータのシードの向きが分からないので、10回のそれぞれで、裾(q = 0.001とq = 0.999)の誤差を中央(q = 0.5)の誤差と比べた。',
  ],
  [
    'definition',
    '表の数は、q = 0.001、q = 0.999、その両方で、順位誤差がq = 0.5の順位誤差に対して厳密な不等号で小さかったデータのシードの数である。',
  ],
  [
    'definition',
    '表の数は、q = 0.001、q = 0.999、その両方で、相対誤差がq = 0.5の相対誤差に対して厳密な不等号で大きかったデータのシードの数である。',
  ],
  ['method', '測れた範囲で言えることは、次のとおりである(以下、裾はq = 0.001とq = 0.999、中央はq = 0.5を指す)。'],
  [
    'hypothesis',
    'k0の裾が中央より小さくならなかったのは、k0がどこでも同じ大きさのcentroidを許し、裾を細かくしないためと考えられる(この原因は、実験では切り分けていない)。',
  ],
  [
    'hypothesis',
    '対数正規分布の裾では、順位が少しずれるだけで値が大きく動くためと考えられる(この原因は、実験では切り分けていない)。',
  ],
  [
    'hypothesis',
    '裾を細かくする分、中央のcentroidが大きくなるためと考えられる(`t-digest.md`のスケール関数の幅の表が根拠で、この原因は実験では切り分けていない)。',
  ],
  ['method', 'これは観察であり、上限の保証ではなく、誤差が小さかったのは対数正規分布のこれらの入力での結果である。'],
  [
    'method',
    '件数10,000で、1つの値の集まりを、昇順(整列済み)、降順(その反対向きの並び)、ランダムのそれぞれで投入し、7つの分位点(0.001、0.01、0.1、0.5、0.9、0.99、0.999)を測る(KLLの試行のシードは1である)。',
  ],
  ['mechanism', 'メモリは件数とkだけで決まるためである。'],
  ['definition', '表は、20試行 × 7分位点の順位誤差の平均である。'],
  ['method', '理由までは調べておらず、1つの分布、1つのデータのシードの観察である。'],
  ['method', '測れたことの入口を次の表に節ごとに示し、数値と向きは各節の文にある。'],
  [
    'pointer',
    'これらは1つの分布での観察であり、手法の優劣を決めるものではない(保証の種類の違いは、`overview.md`の比較表にある)。',
  ],
];

/** 他の文書で、experiments.md を指す(または測定を述べうる)文。主張は持たず、案内だけを書く */
const POINTERS: readonly (readonly [string, string])[] = [
  ['overview.md', '各手法の仕組みは`gk.md`、`kll.md`、`t-digest.md`、実験の数値は`experiments.md`にある。'],
  ['overview.md', '裾と中央の誤差の測定は`experiments.md`にある'],
  ['overview.md', 'ただし、実際に誤差がどう現れたかは、`experiments.md`の測定を見る。'],
  ['overview.md', '件数とεを変えて測ったメモリは、`experiments.md` に載せる。'],
  ['kll.md', '複数のシードで測った誤差の分布は`experiments.md`で見る。'],
  ['t-digest.md', '対数正規分布での、スケール関数ごとの裾と中央の誤差と、挿入順序の影響は、`experiments.md`で測る。'],
  ['t-digest.md', 'ただし、これは仕組みの説明であり、測定の結果は`experiments.md`にある。'],
  ['t-digest.md', 'また、これは順位のずれの話であり、値の相対誤差は別である(`experiments.md`に相対誤差の測定もある)。'],
  ['t-digest.md', '対数正規分布で昇順・降順・ランダムに投入したときの順位誤差は、`experiments.md`で測る。'],
  ['t-digest.md', '`experiments.md`に、対数正規分布での測定を載せた。'],
];

describe('experiments.md の実験結果', () => {
  const doc = readDoc('experiments.md');

  const ctx = () => {
    const e = experiments();
    const main = e.main.cases[0]!.sweep;
    const orderOf = (o: DataOrder): SweepResult => e.order.cases.find((c) => c.order === o)!.sweep;
    const trialsOf = (o: DataOrder): SweepResult => e.trials.cases.find((c) => c.order === o)!.sweep;
    return { main, orderOf, trialsOf, dataSeeds: e.dataSeeds.map((r) => r.cases[0]!.sweep) };
  };
  const mem = (sweep: SweepResult, count: number, id: string): number =>
    okAlgorithm(sweep, count, id).afterInsertion.memoryBytes;
  const at = (sweep: SweepResult, count: number, id: string, q: number): number =>
    rankErrorAt(okAlgorithm(sweep, count, id), q);
  /** 20試行 × 7分位点の順位誤差 */
  const trialErrors = (o: DataOrder, id: string): number[] =>
    ctx()
      .trialsOf(o)
      .runs.flatMap((r) => {
        const a = r.algorithms.find((x) => x.id === id);
        if (a === undefined || a.status !== 'ok') throw new Error('kll');
        return a.queries.map((x) => x.rankError);
      });
  const trialAt = (o: DataOrder, id: string, q: number): number[] =>
    ctx()
      .trialsOf(o)
      .runs.map((r) => {
        const a = r.algorithms.find((x) => x.id === id);
        if (a === undefined || a.status !== 'ok') throw new Error('kll');
        return rankErrorAt(a, q);
      });

  // ---- 範囲ごとのデータの取り出し ----
  const td = (s: string, c = 100): string => `tdigest-${s}-c${c}`;
  const tdIds = SCALES.flatMap((s) => [50, 100].map((c) => td(s, c)));
  /** 【シード1】 件数10,000、主な表(挿入順序はランダム) */
  const A = (id: string, q: number): number => at(ctx().main, 10000, id, q);
  /** 【シード1】 挿入順序の表(t-digest の表はランダム) */
  const S1 = (id: string, q: number, o: DataOrder = 'random'): number => at(ctx().orderOf(o), 10000, id, q);
  const orderMem = (o: DataOrder, id: string): number => mem(ctx().orderOf(o), 10000, id);
  const orderErr = (o: DataOrder, id: string): number => maxRankError(okAlgorithm(ctx().orderOf(o), 10000, id));
  /** 【10シード平均・δ=100】 */
  const rk = (s: string, q: number, c = 100): number => mean(seedValues(td(s, c), q, 'rankError'));
  const rl = (s: string, q: number, c = 100): number => mean(seedValues(td(s, c), q, 'relativeError'));
  const perSeed = (s: string, q: number, pick: 'rankError' | 'relativeError'): number[] => seedValues(td(s), q, pick);
  const seedsWhere = (f: (i: number) => boolean): number => DATA_SEEDS.filter((_, i) => f(i)).length;
  const mems = (ids: readonly string[]): number[] => ids.map((id) => mem(ctx().main, 10000, id));
  const maxima = (ids: readonly string[]): number[] =>
    ids.map((id) => maxRankError(okAlgorithm(ctx().main, 10000, id)));
  const gkMem = (id: string): number[] => MAIN_COUNTS.map((n) => mem(ctx().main, n, id));
  const gkMaxSeries = (id: string): number[] => MAIN_COUNTS.map((n) => maxRankError(okAlgorithm(ctx().main, n, id)));
  const memRatio = (id: string): number => mem(ctx().main, 100000, id) / mem(ctx().main, 1000, id);
  const sketchIds = [...gkIds, ...kllIds, ...tdigestK1Ids];
  const kllWidths = (): number[] =>
    kllIds.map((id) => {
      const q5 = trialAt('random', id, 0.5);
      return Math.max(...q5) - Math.min(...q5);
    });
  const kllAvg = (o: DataOrder, id: string): number => mean(trialErrors(o, id));
  const sd = (xs: number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
  const bothWorse = (id: string): boolean =>
    orderErr('ascending', id) > orderErr('random', id) && orderErr('descending', id) > orderErr('random', id);
  const worstTd = (): number => Math.max(...ORDERS.flatMap((o) => tdIds.map((id) => orderErr(o, id))));
  const N = DATA_SEEDS.length;
  const pairMax = (id: string) => ORDERS.map((o) => orderErr(o, id));

  // ---- 主張の登録簿: 各主張は、実測から組み立てた文を返す。文は、条件が成り立たなければ throw し、 ----
  // ---- 向き(大小・増減)の語、数、回数は実測から選ぶので、文書の語を逆にすると文が一致しない ----
  interface Claim {
    readonly id: string;
    readonly scope: ClaimScope;
    readonly render: () => string;
    /** 同じ行の前の文に続く文(文頭の範囲を省く) */
    readonly continuation: boolean;
  }
  const CLAIMS: Claim[] = [];
  const claim = (id: string, scope: ClaimScope, render: () => string, continuation = false): void => {
    CLAIMS.push({ id, scope, render, continuation });
  };

  // ---- パラメータとメモリ・誤差 ----
  // 条件: 表の上から下へ ε が小さくなる / メモリの並びが厳密に単調 → 向きの語「増える」(減るなら「減る」になる)
  claim('gk-mem-grows', 'seed1', () => {
    must(decreasing(GK_EPSILONS), 'εは表の上から下へ小さくなる');
    return `GKは、εを小さくするほどメモリが${mono(mems(gkIds), '増える', '減る')}。`;
  });
  // 数: メモリ × ε の4つの値と、その最小・最大(整数に丸めた範囲)
  claim('gk-mem-products', 'seed1', () => {
    const p = GK_EPSILONS.map((e, i) => mem(ctx().main, 10000, gkIds[i]!) * e);
    const text = GK_EPSILONS.map((e, i) => `${e}で${String(Number(p[i]!.toFixed(2)))}`).join('、');
    return `メモリ × ε は、${text}になり、およそ ${Math.round(Math.min(...p))}〜${Math.round(Math.max(...p))} / ε バイトに見える。`;
  });
  claim('kll-mem-grows', 'seed1', () => {
    must(increasing(KLL_KS), 'kは表の上から下へ大きくなる');
    return `KLLは、kを大きくするほどメモリが${mono(mems(kllIds), '増える', '減る')}。`;
  });
  // 条件: kは隣の行で2倍 / 数: 隣の行とのメモリ比の最小と最大
  claim('kll-mem-doubling', 'seed1', () => {
    must(
      KLL_KS.slice(1).every((k, i) => k === 2 * KLL_KS[i]!),
      'kは2倍ずつ',
    );
    const m = mems(kllIds);
    const r = m.slice(1).map((x, i) => x / m[i]!);
    return `kを2倍にするとメモリは${fmt(Math.min(...r))}〜${fmt(Math.max(...r))}倍になる。`;
  });
  claim('td-mem-grows', 'seed1', () => {
    must(increasing(TDIGEST_COMPRESSIONS), 'δは表の上から下へ大きくなる');
    return `t-digest(k1)は、δを大きくするほどメモリが${mono(mems(tdigestK1Ids), '増える', '減る')}。`;
  });
  // 数: δ = 50、100、200 のδ 1あたりのメモリの最小と最大
  claim('td-mem-per-delta', 'seed1', () => {
    const m = mems(tdigestK1Ids);
    const per = [1, 2, 3].map((i) => m[i]! / TDIGEST_COMPRESSIONS[i]!);
    return `δ = ${TDIGEST_COMPRESSIONS[1]}〜${TDIGEST_COMPRESSIONS[3]}では、δ 1あたり${fmt(Math.min(...per))}〜${fmt(Math.max(...per))}バイトである。`;
  });
  // 量化: 3つの手法のすべての隣り合う行で、次の行の最大誤差は同じかそれ以下
  claim('max-error-adjacent', 'seed1', () => {
    for (const ids of [gkIds, kllIds, tdigestK1Ids])
      must(nonIncreasing(maxima(ids)), `${ids[0]} の最大誤差は下の行で同じかそれ以下`);
    return 'シード1の表では、GK、KLL、t-digest(k1)のどの隣り合う行でも、最大の順位誤差は、下の行で上の行と同じかそれ以下だった。';
  });
  // 向き: GKとKLLの最大誤差は、どちらも厳密に単調で同じ向き / 数: 最大誤差の並び
  claim('max-error-values', 'seed1', () => {
    const g = maxima(gkIds);
    const k = maxima(kllIds);
    const dir = mono(g, '大きくなる', '小さくなる');
    must(mono(k, '大きくなる', '小さくなる') === dir, 'GKとKLLは同じ向き');
    return `最大の順位誤差は、GKでは${list(g)}、KLLでは${list(k)}と、表の上から下へ${dir}。`;
  });
  // 数: k1の最大誤差の並び / 条件: δ = 100 と δ = 200 の最大誤差が等しい
  claim('td-k1-plateau', 'seed1', () => {
    const t = maxima(tdigestK1Ids);
    must(TDIGEST_COMPRESSIONS[2] === 100 && TDIGEST_COMPRESSIONS[3] === 200, 'δ = 100 と δ = 200');
    must(t[3] === t[2], 'δ = 100 と δ = 200 の最大誤差が等しい');
    return `t-digest(k1)の最大の順位誤差は${list(t)}で、δ = 100とδ = 200は同じ${fmt(t[2]!)}だった。`;
  });
  // 数: δ = 100 → 200 のメモリ比 / 条件: 最大誤差が変わらない
  claim('td-doubling-no-gain', 'seed1', () => {
    const t = maxima(tdigestK1Ids);
    must(t[3] === t[2], 'δ = 100 と δ = 200 の最大誤差が等しい');
    const ratio = mem(ctx().main, 10000, 'tdigest-k1-c200') / mem(ctx().main, 10000, 'tdigest-k1-c100');
    return `δ = 100からδ = 200へメモリが${fmt(ratio)}倍になっても、この条件では最大の順位誤差は変わらなかった。`;
  });
  // 向き: k = 16 と k = 32 の q = 0.99 の大小 / 数: 2つの値
  claim('kll-k16-k32-q99', 'seed1', () => {
    const a = A('kll-k-16', 0.99);
    const b = A('kll-k-32', 0.99);
    return `シード1の表のKLLでは、k = 16のq = 0.99(${fmt(a)})はk = 32のq = 0.99(${fmt(b)})より${adj(a, b)}い。`;
  });
  // 量化: GKとt-digest(k1)のすべての行で q = 0 と q = 1 の誤差が0
  claim('q0-q1-zero', 'seed1', () => {
    must(
      [...gkIds, ...tdigestK1Ids].every((id) => A(id, 0) === 0 && A(id, 1) === 0),
      'GKとt-digest(k1)のすべての行でq = 0とq = 1の誤差が0',
    );
    return 'シード1の「件数10,000での順位誤差」の表では、GKとt-digest(k1)は、q = 0とq = 1の順位誤差がすべての行で0だった。';
  });
  // 量化: KLLの5つのkのすべてで q = 0 と q = 1 の誤差が0ではない / 数: それぞれの最小と最大
  claim('kll-q0-q1-nonzero', 'seed1', () => {
    const q0 = kllIds.map((id) => A(id, 0));
    const q1 = kllIds.map((id) => A(id, 1));
    must(q0.every((x) => x > 0) && q1.every((x) => x > 0), 'KLLのすべての行でq = 0とq = 1の誤差が0ではない');
    return `同じ表のKLLは、${kllIds.length}つのkのすべてで、q = 0とq = 1の順位誤差が0ではなかった(q = 0は${fmt(Math.min(...q0))}〜${fmt(Math.max(...q0))}、q = 1は${fmt(Math.min(...q1))}〜${fmt(Math.max(...q1))})。`;
  });

  // ---- 件数とメモリの増え方 ----
  // 条件: 厳密解のメモリが件数 × 8バイト(比例) / 数: 件数の倍率とメモリの倍率
  claim('exact-memory-100x', 'seed1', () => {
    const m = MAIN_COUNTS.map((n) => mem(ctx().main, n, EXACT_ID));
    must(
      MAIN_COUNTS.every((n, i) => m[i] === 8 * n),
      '厳密解のメモリは件数 × 8バイト',
    );
    return `厳密解のメモリは件数に比例し、件数が${MAIN_COUNTS[2]! / MAIN_COUNTS[0]!}倍になるとメモリも${m[2]! / m[0]!}倍になる。`;
  });
  // 数: 3つの手法の件数100,000 ÷ 1,000 の最小と最大 / 条件: 最大が件数の倍率より小さい(とどまる)
  claim('sketch-memory-ratio', 'seed1', () => {
    const r = sketchIds.map(memRatio);
    must(Math.max(...r) < MAIN_COUNTS[2]! / MAIN_COUNTS[0]!, '倍率が件数の倍率より小さい');
    return `3つの手法は、件数が${MAIN_COUNTS[2]! / MAIN_COUNTS[0]!}倍になっても、メモリは${fmt(Math.min(...r))}〜${fmt(Math.max(...r))}倍にとどまる。`;
  });
  // 条件: 件数100,000でメモリが最も大きいのはKLLのk = 256 / 数: 厳密解との倍率の切り捨て
  claim('exact-vs-largest', 'seed1', () => {
    const m = sketchIds.map((id) => mem(ctx().main, 100000, id));
    const largest = Math.max(...m);
    must(
      sketchIds[m.indexOf(largest)] === 'kll-k-256' && m.filter((x) => x === largest).length === 1,
      '最も大きいのはk = 256',
    );
    const exact = mem(ctx().main, 100000, EXACT_ID);
    return `件数100,000で見ると、厳密解の${num(exact)}バイトは、最も大きいKLLのk = 256(${num(largest)}バイト)の${Math.floor(exact / largest)}倍以上である。`;
  });
  // 量化: 4つのεのすべてで、件数100,000のメモリは件数1,000以下
  claim('gk-mem-not-grown', 'seed1', () => {
    must(
      gkIds.every((id) => mem(ctx().main, 100000, id) <= mem(ctx().main, 1000, id)),
      'GKの件数100,000のメモリは件数1,000以下',
    );
    return `GKは、件数1,000から100,000では、メモリが増えなかった(${gkIds.length}つのεのすべてで、件数100,000のメモリは件数1,000以下である)。`;
  });
  // 数: ε = 0.05 の3つのメモリ / 排他: 件数1,000より大きいのは件数10,000だけ(集合の一致) / 数: その差の割合
  claim('gk-eps005-memory', 'seed1', () => {
    const g = gkMem('gk-eps-0.05');
    const bigger = MAIN_COUNTS.filter((_, i) => g[i]! > g[0]!);
    must(JSON.stringify(bigger) === JSON.stringify([10000]), '件数1,000より大きいのは件数10,000だけ');
    return `ε = 0.05のメモリは${g.join('、')}で、件数1,000より大きいのは件数${num(bigger[0]!)}だけで、その差は${fmt((g[1]! / g[0]! - 1) * 100)}%である。`;
  });
  // 量化: KLLの5つのkのすべてで、件数100,000のメモリは件数1,000より大きい / 数: 倍率の最小と最大
  claim('kll-mem-vs-n', 'seed1', () => {
    must(
      kllIds.every((id) => mem(ctx().main, 100000, id) > mem(ctx().main, 1000, id)),
      'KLLの件数100,000のメモリは件数1,000より大きい',
    );
    const r = kllIds.map(memRatio);
    return `KLLは、${kllIds.length}つのkのすべてで、件数100,000のメモリは件数1,000より大きく、倍率は${fmt(Math.min(...r))}〜${fmt(Math.max(...r))}倍である。`;
  });
  // 数: k = 256 の3つのメモリと、2つの区間の変化量 / 向き: 各区間の増減
  claim('kll-k256-steps', 'seed1', () => {
    const m = MAIN_COUNTS.map((n) => mem(ctx().main, n, 'kll-k-256'));
    const verb = (a: number, b: number, past: boolean): string =>
      b > a ? (past ? '増えた' : '増え') : past ? '減った' : '減り';
    return `k = 256のメモリは、件数${num(MAIN_COUNTS[0]!)}から${num(MAIN_COUNTS[1]!)}で${num(m[0]!)}から${num(m[1]!)}へ${num(Math.abs(m[1]! - m[0]!))}${verb(m[0]!, m[1]!, false)}、件数${num(MAIN_COUNTS[1]!)}から${num(MAIN_COUNTS[2]!)}では${num(m[1]!)}から${num(m[2]!)}へ${num(Math.abs(m[2]! - m[1]!))}${verb(m[1]!, m[2]!, true)}。`;
  });
  // 数: k1の4つのδの 件数100,000 ÷ 1,000 の最小と最大
  claim('td-mem-vs-n', 'seed1', () => {
    const r = tdigestK1Ids.map(memRatio);
    return `t-digest(k1)は、${tdigestK1Ids.length}つのδで、件数100,000のメモリは件数1,000の${fmt(Math.min(...r))}〜${fmt(Math.max(...r))}倍である。`;
  });

  // ---- GKの順位誤差はε以下 ----
  // 量化: 4つのε × 3つの件数 = 12個の最大誤差のすべてがε以下
  claim('gk-bound-12', 'seed1', () => {
    must(
      gkIds.every((id, i) => MAIN_COUNTS.every((n) => maxRankError(okAlgorithm(ctx().main, n, id)) <= GK_EPSILONS[i]!)),
      '12個の最大誤差がすべてε以下',
    );
    return `シード1の表では、${gkIds.length * MAIN_COUNTS.length}個の最大の順位誤差は、すべてε以下だった。`;
  });
  // 条件: ε = 0.1 と ε = 0.01 の最大誤差が、3つの件数のすべてでεに等しい
  claim('gk-exact-match', 'seed1', () => {
    must(
      MAIN_COUNTS.every(
        (n) =>
          maxRankError(okAlgorithm(ctx().main, n, 'gk-eps-0.1')) === 0.1 &&
          maxRankError(okAlgorithm(ctx().main, n, 'gk-eps-0.01')) === 0.01,
      ),
      'ε = 0.1とε = 0.01の最大誤差がεに等しい',
    );
    return 'シード1の表では、ε = 0.1とε = 0.01は、3つの件数のすべてでεにちょうど一致した。';
  });
  // 条件: ε = 0.1 の q = 0.9 と ε = 0.01 の q = 0.99 がεに等しい / 向き: ε = 0.05 の q = 0.9 と ε = 0.005 の q = 0.99 はεとの大小
  claim('gk-match-quantiles', 'seed1', () => {
    must(A('gk-eps-0.1', 0.9) === 0.1 && A('gk-eps-0.01', 0.99) === 0.01, 'q = 0.9 と q = 0.99 の誤差がεに等しい');
    const a = A('gk-eps-0.05', 0.9);
    const b = A('gk-eps-0.005', 0.99);
    const dir = adj(a, 0.05);
    must(adj(b, 0.005) === dir, 'どちらもεとの大小が同じ向き');
    return `シード1の表では、ε = 0.1ではq = 0.9、ε = 0.01ではq = 0.99の順位誤差がεに一致し、ε = 0.05の${fmt(a)}(q = 0.9)とε = 0.005の${fmt(b)}(q = 0.99)は、εより${dir}い。`;
  });
  // 条件: 2つの推定値が最大値(q = 1)の推定値と等しい
  claim('gk-match-is-max', 'seed1', () => {
    for (const [id, q] of [
      ['gk-eps-0.1', 0.9],
      ['gk-eps-0.01', 0.99],
    ] as const) {
      const a = okAlgorithm(ctx().main, 10000, id);
      must(
        a.queries.find((x) => x.quantile === q)!.estimate === a.queries.find((x) => x.quantile === 1)!.estimate,
        `${id} の q = ${q} の推定値が最大値`,
      );
    }
    return 'シード1の表では、εに一致した2つは、GKの推定値が最大値(q = 1の推定値)と同じだった。';
  });
  // 算術: 目標順位 + ε × n = 件数(9,000 + 1,000、9,900 + 100)
  claim('gk-target-plus-eps-n', 'seed1', () => {
    const n = 10000;
    const parts = (q: number, e: number): [number, number] => [nearestRank(n, q), e * n];
    const [r1, w1] = parts(0.9, 0.1);
    const [r2, w2] = parts(0.99, 0.01);
    must(r1 + w1 === n && r2 + w2 === n, '目標順位 + ε × n = 件数');
    return `この2つは、目標順位 + ε × n が件数${num(n)}に等しい(${num(r1)} + ${num(w1)}、${num(r2)} + ${num(w2)})ので、探索で止まるタプルがなく、最大値が返った。`;
  });
  // 算術: 誤差 = 1 − q かつ = ε
  claim('gk-error-one-minus-q', 'seed1', () => {
    must(
      Math.abs(A('gk-eps-0.1', 0.9) - (1 - 0.9)) < 1e-12 && Math.abs(A('gk-eps-0.01', 0.99) - (1 - 0.99)) < 1e-12,
      '誤差 = 1 − q',
    );
    return 'このとき誤差は 1 − q になり、これがεに一致した。';
  });
  // 量化: 4つのεのすべてで、9つの分位点のうちε/2以下の数の最小 / 数: その最小
  claim('gk-six-small', 'seed1', () => {
    const counts = gkIds.map((id, i) => QUANTILES_MAIN.filter((q) => A(id, q) <= GK_EPSILONS[i]! / 2).length);
    return `シード1の表では、${gkIds.length}つのεのすべてで、${QUANTILES_MAIN.length}つの分位点のうち${Math.min(...counts)}つ以上が、ε/2以下だった。`;
  });
  claim(
    'gk-eps001-small',
    'seed1',
    () => `ε = 0.01のq = 0.5は${fmt(A('gk-eps-0.01', 0.5))}、q = 0.9は${fmt(A('gk-eps-0.01', 0.9))}である。`,
  );
  // 量化: 4つのε × 3つの件数のすべてで、最大誤差がε以下
  claim('gk-never-exceeds', 'seed1', () => {
    must(
      gkIds.every((id, i) => gkMaxSeries(id).every((x) => x <= GK_EPSILONS[i]!)),
      '最大誤差がεを超えない',
    );
    return `${gkIds.length}つのεで件数を${num(MAIN_COUNTS[0]!)}〜${num(MAIN_COUNTS[2]!)}に増やしても、シード1の表では誤差はεを超えなかった。`;
  });
  // 向き: ε = 0.05 と ε = 0.005 の件数ごとの最大誤差の増減 / 数: 3つの値
  claim('gk-max-series', 'seed1', () => {
    const a = gkMaxSeries('gk-eps-0.05');
    const b = gkMaxSeries('gk-eps-0.005');
    return `ε = 0.05の最大は${list(a)}と${mono(a, '増え', '減り')}、ε = 0.005の最大は${list(b)}と${mono(b, '増えた', '減った')}。`;
  });

  // ---- KLLの試行間のばらつき ----
  // 量化: 5つのkのすべてで、q = 0.5 の誤差も全体の誤差も、試行のシードで値が変わる
  claim('trials-vary', 'trials20', () => {
    must(
      kllIds.every((id) => {
        const q5 = trialAt('random', id, 0.5);
        return Math.max(...q5) > Math.min(...q5) && new Set(trialErrors('random', id)).size > 1;
      }),
      '5つのkのすべてで誤差が試行のシードで変わる',
    );
    return `20試行では、${kllIds.length}つのkのすべてで、試行のシードによって誤差が変わった。`;
  });
  // 数: k = 16 の q = 0.5 の最小と最大 / 条件: 最大が最小の100倍以上
  claim('kll-k16-q5-spread', 'trials20', () => {
    const q5 = trialAt('random', 'kll-k-16', 0.5);
    must(Math.max(...q5) >= 100 * Math.min(...q5), '最大が最小の100倍以上');
    return `20試行では、k = 16のq = 0.5の順位誤差は、最小${fmt(Math.min(...q5))}から最大${fmt(Math.max(...q5))}までばらつき、最大が最小の100倍以上だった。`;
  });
  // 数: q = 0.5 の幅の並び / 向き: 幅の並びの向き(kが大きいほど狭い)
  claim('kll-widths', 'trials20', () => {
    const w = kllWidths();
    return `20試行では、q = 0.5の最大から最小を引いた幅は、k = ${KLL_KS[0]}から${KLL_KS[4]}の順に${list(w)}と、kが大きいほど${mono(w, '広かった', '狭かった')}。`;
  });
  // 向き: 全体の平均、二乗平均平方根、最大のそれぞれが厳密に単調で、同じ向き
  claim('kll-overall', 'trials20', () => {
    const stats = [
      kllIds.map((id) => kllAvg('random', id)),
      kllIds.map((id) => rms(trialErrors('random', id))),
      kllIds.map((id) => Math.max(...trialErrors('random', id))),
    ];
    const dirs = stats.map((s) => mono(s, '大きかった', '小さかった'));
    must(new Set(dirs).size === 1, '3つの統計は同じ向き');
    return `20試行では、全体の平均、二乗平均平方根、最大も、${kllIds.length}つのkのすべてでkが大きいほど${dirs[0]}。`;
  });
  // 数: k の倍率、全体の平均の2つの値、その比
  claim('kll-16x', 'trials20', () => {
    const a = kllAvg('random', 'kll-k-16');
    const b = kllAvg('random', 'kll-k-256');
    return `20試行では、kを${KLL_KS[4]! / KLL_KS[0]!}倍にした(${KLL_KS[0]}から${KLL_KS[4]})とき、全体の平均は ${fmt(a)} から ${fmt(b)} に${a > b ? '小さく' : '大きく'}なり、その比は${fmt(a > b ? a / b : b / a)}倍である。`;
  });
  // 量化: 5つのkのすべて × 20のシード × 3つの挿入順序で、メモリが同じ(値の集合の大きさが1)
  claim('kll-memory-constant', 'trials20', () => {
    must(
      kllIds.every((id) => {
        const ms = ORDERS.flatMap((o) =>
          ctx()
            .trialsOf(o)
            .runs.map((r) => okAlgorithm({ schemaVersion: 1, runs: [r] }, 10000, id).afterInsertion.memoryBytes),
        );
        return ms.length === ORDERS.length * TRIAL_SEEDS.length && new Set(ms).size === 1;
      }),
      'メモリはシードと挿入順序によらず同じ',
    );
    return `20試行では、${kllIds.length}つのkのすべてで、メモリは、${TRIAL_SEEDS.length}の試行のシードと${ORDERS.length}つの挿入順序のすべてで同じだった。`;
  });
  // 数: k = 16 の全体の最大 / 条件: 0.1以上(10%以上)
  claim('kll-k16-max', 'trials20', () => {
    const m = Math.max(...trialErrors('random', 'kll-k-16'));
    must(m >= 0.1, '全体の最大が10%以上');
    return `20試行では、k = 16の全体の最大は${fmt(m)}で、順位が10%以上ずれた試行があった。`;
  });
  // 存在: 隣り合うkで q = 0.99 の標準偏差が小さくならない組がある
  claim('kll-q99-not-monotone', 'trials20', () => {
    const s = kllIds.map((id) => sd(trialAt('random', id, 0.99)));
    must(
      s.some((x, i) => i > 0 && x >= s[i - 1]!),
      'q = 0.99 の標準偏差が、kを大きくしても小さくならない組がある',
    );
    return '20試行では、分位点を1つに絞ると、kが大きくても誤差の標準偏差が小さくならないことがある。';
  });
  // 向き: k = 16 と k = 32 の q = 0.99 の標準偏差の大小 / 数: 2つの値
  claim('kll-q99-sd', 'trials20', () => {
    const a = sd(trialAt('random', 'kll-k-16', 0.99));
    const b = sd(trialAt('random', 'kll-k-32', 0.99));
    return `20試行では、q = 0.99の順位誤差の標準偏差(母標準偏差)は、k = 16が${fmt(a)}、k = 32が${fmt(b)}で、kが大きい方が${adj(a, b) === '小さ' ? '大き' : '小さ'}い。`;
  });

  // ---- t-digestの裾と中央 ----
  // 排他: 裾(q = 0.001 と q = 0.999 の両方)が中央より小さいスケール関数の集合と、大きい集合を列挙する
  claim('rank-scale-sets', 'mean10', () => {
    const smaller = SCALES.filter((s) => rk(s, 0.001) < rk(s, 0.5) && rk(s, 0.999) < rk(s, 0.5));
    const larger = SCALES.filter((s) => rk(s, 0.001) > rk(s, 0.5) && rk(s, 0.999) > rk(s, 0.5));
    must(smaller.length + larger.length === SCALES.length, '3つのスケール関数がどちらかに分かれる');
    return `10回の平均(δ = 100)では、順位誤差の裾が中央より小さいのは${smaller.join('と')}で、${larger.join('、')}は裾の方が大きい。`;
  });
  // 向き: k2の2つの裾の平均と中央の大小(両方同じ向き) / 数: 3つの値
  claim('rank-k2-mean', 'mean10', () => {
    const [a, b, m] = [rk('k2', 0.001), rk('k2', 0.999), rk('k2', 0.5)] as const;
    return `10回の平均(δ = 100)では、k2は、q = 0.001とq = 0.999の平均が${fmt(a)}と${fmt(b)}で、中央のq = 0.5の${fmt(m)}より${adjBoth(a, b, m)}い。`;
  });
  claim('rank-k1-mean', 'mean10', () => {
    const [a, b, m] = [rk('k1', 0.001), rk('k1', 0.999), rk('k1', 0.5)] as const;
    return `10回の平均(δ = 100)では、k1も、q = 0.001(${fmt(a)})とq = 0.999(${fmt(b)})が、q = 0.5(${fmt(m)})より${adjBoth(a, b, m)}い。`;
  });
  // 数: k1の裾が中央より小さかったシード数(q = 0.001、q = 0.999)
  claim('rank-k1-per-seed', 'mean10', () => {
    const c = tailCounts(td('k1'), 'rankError', (a, b) => a < b);
    return `10回の個々のシード(δ = 100)では、k1の裾が中央より小さかったのは、q = 0.001で${N}回中${c[0]}回、q = 0.999で${c[1]}回だった(「裾が中央より小さかったシード数」の表)。`;
  });
  // 量化: k2は3つの数のすべてが10 / k0は3つの数のすべてが0
  claim('rank-k2-k0-per-seed', 'mean10', () => {
    const k2 = tailCounts(td('k2'), 'rankError', (a, b) => a < b);
    const k0 = tailCounts(td('k0'), 'rankError', (a, b) => a < b);
    must(
      k2.every((x) => x === N),
      'k2の裾は10回すべてで中央より小さい',
    );
    must(
      k0.every((x) => x === 0),
      'k0の裾が中央より小さかったのは0回',
    );
    return `10回の個々のシード(δ = 100)では、k2の裾は${N}回すべてで中央より小さく、k0の裾が中央より小さかったのは${k0[2]}回だった。`;
  });
  // 向き: k0の2つの裾が中央より大きい / 数: 3つの値と、倍率の最小の切り捨て
  claim('rank-k0-mean', 'mean10', () => {
    const [a, b, m] = [rk('k0', 0.001), rk('k0', 0.999), rk('k0', 0.5)] as const;
    must(adjBoth(a, b, m) === '大き', 'k0の裾は中央より大きい');
    return `10回の平均(δ = 100)では、k0は、裾が中央より小さくならず、q = 0.001(${fmt(a)})とq = 0.999(${fmt(b)})が、q = 0.5(${fmt(m)})の${floor1(Math.min(a / m, b / m))}倍以上である。`;
  });
  // 条件: 7つの分位点のうち、q = 0.99 だけが最大 / 数: その値
  claim('rank-k0-q99-max', 'mean10', () => {
    const v = QUANTILES_DETAIL.map((q) => rk('k0', q));
    const top = Math.max(...v);
    must(v.filter((x) => x === top).length === 1 && rk('k0', 0.99) === top, 'q = 0.99 が7つの分位点で最大');
    return `10回の平均(δ = 100)では、k0はq = 0.99の${fmt(top)}が${QUANTILES_DETAIL.length}つの分位点で最大である。`;
  });
  claim('seed1-k0-c50', 'seed1', () => {
    const id = td('k0', 50);
    const [a, b, m] = [S1(id, 0.001), S1(id, 0.999), S1(id, 0.5)] as const;
    return `シード1の表では、\`tdigest-k0-c50\`の裾は、q = 0.001が${fmt(a)}、q = 0.999が${fmt(b)}で、中央のq = 0.5の${fmt(m)}より${adjBoth(a, b, m)}い。`;
  });
  // 量化: 3つのスケール関数のすべてで、2つの裾の相対誤差の平均が中央より大きい
  claim('rel-all-above', 'mean10', () => {
    must(
      SCALES.every((s) => rl(s, 0.001) > rl(s, 0.5) && rl(s, 0.999) > rl(s, 0.5)),
      '3つのスケール関数のすべてで相対誤差の裾が中央より大きい',
    );
    return '10回の平均(δ = 100)では、3つのスケール関数のすべてで、相対誤差の裾が中央より大きい。';
  });
  // 量化: k0とk1は3つの数のすべてが10 / 数: k2の2つの数
  claim('rel-per-seed', 'mean10', () => {
    const above = (s: string): [number, number, number] => tailCounts(td(s), 'relativeError', (a, b) => a > b);
    must(above('k0').every((x) => x === N) && above('k1').every((x) => x === N), 'k0とk1は10回すべて');
    const k2 = above('k2');
    return `10回の個々のシード(δ = 100)では、相対誤差の裾が中央より大きかったのは、k0とk1が${N}回すべて、k2がq = 0.001で${N}回中${k2[0]}回、q = 0.999で${k2[1]}回だった(「相対誤差の裾が中央より大きかったシード数」の表)。`;
  });
  // 数: k2の相対誤差の平均3つ / 条件: 裾が中央より大きい / 倍率の最小の切り捨て
  claim('rel-k2-mean', 'mean10', () => {
    const [a, b, m] = [rl('k2', 0.001), rl('k2', 0.999), rl('k2', 0.5)] as const;
    must(adjBoth(a, b, m) === '大き', 'k2の相対誤差の裾は中央より大きい');
    return `10回の平均(δ = 100)では、k2の相対誤差の平均は ${fmt(a)} と ${fmt(b)} で、中央の ${fmt(m)} の${floor1(Math.min(a / m, b / m))}倍以上である。`;
  });
  // 向き: k2の順位誤差の裾と中央の大小、相対誤差の裾と中央の大小(それぞれ両方同じ向き)
  claim('rank-small-rel-large', 'mean10', () => {
    const rank = adjBoth(rk('k2', 0.001), rk('k2', 0.999), rk('k2', 0.5));
    const rel = adjBoth(rl('k2', 0.001), rl('k2', 0.999), rl('k2', 0.5));
    return `10回の平均(δ = 100)では、k2の裾は順位誤差が中央より${rank}かったが、相対誤差は中央より${rel}かった。`;
  });
  // 向き: 裾の相対誤差の並び(k2、k1、k0の順)が、q = 0.001 と q = 0.999 の両方で厳密に単調で同じ向き
  claim('rel-order-mean', 'mean10', () => {
    const dir = (q: number): string =>
      mono(
        ['k2', 'k1', 'k0'].map((s) => rl(s, q)),
        '大きくなる',
        '小さくなる',
      );
    must(dir(0.001) === dir(0.999), 'q = 0.001 と q = 0.999 は同じ向き');
    return `10回の平均(δ = 100)では、裾の相対誤差は、k2、k1、k0の順に${dir(0.001)}。`;
  });
  // 数: 上の文の6つの値
  claim(
    'rel-order-values',
    'mean10',
    () =>
      `q = 0.001は${list(['k2', 'k1', 'k0'].map((s) => rl(s, 0.001)))}、q = 0.999は${list(['k2', 'k1', 'k0'].map((s) => rl(s, 0.999)))}である。`,
    true,
  );
  // 数: シードごとに k2 < k1 < k0 となった回数(q = 0.001、q = 0.999)
  claim('rel-order-per-seed', 'mean10', () => {
    const inOrder = (q: number): number => {
      const [a, b, c] = ['k2', 'k1', 'k0'].map((s) => perSeed(s, q, 'relativeError'));
      return seedsWhere((i) => a![i]! < b![i]! && b![i]! < c![i]!);
    };
    return `10回の個々のシード(δ = 100)では、裾の相対誤差がk2、k1、k0の順に大きくなったのは、q = 0.001で${N}回中${inOrder(0.001)}回、q = 0.999で${N}回中${inOrder(0.999)}回だった。`;
  });
  // 排他: 中央の順位誤差の平均が最も大きいスケール関数(1つに決まる)
  claim('median-largest-mean', 'mean10', () => {
    const v = SCALES.map((s) => rk(s, 0.5));
    const top = Math.max(...v);
    must(v.filter((x) => x === top).length === 1, '最も大きいスケール関数は1つ');
    return `10回の平均(δ = 100)では、中央(q = 0.5)の順位誤差が最も大きいのは${SCALES[v.indexOf(top)]}である。`;
  });
  // 数: q = 0.5 の平均3つ / 倍率: k2 ÷ k1 の切り捨て
  claim('median-values-5x', 'mean10', () => {
    const [v0, v1, v2] = [rk('k0', 0.5), rk('k1', 0.5), rk('k2', 0.5)] as const;
    return `10回の平均(δ = 100)では、q = 0.5の平均は、k0が${fmt(v0)}、k1が${fmt(v1)}、k2が${fmt(v2)}で、k2はk1の${Math.floor(v2 / v1)}倍以上である。`;
  });
  // 数: q = 0.5 の誤差がk2で最も大きかったシード数
  claim('median-largest-per-seed', 'mean10', () => {
    const [a, b, c] = ['k2', 'k1', 'k0'].map((s) => perSeed(s, 0.5, 'rankError'));
    return `10回の個々のシード(δ = 100)では、q = 0.5の順位誤差がk2で最も大きかったのは${N}回中${seedsWhere((i) => a![i]! > b![i]! && a![i]! > c![i]!)}回だった。`;
  });
  // 数: シードごとの k2 ÷ k1 が5以上だった回数
  claim('median-5x-per-seed', 'mean10', () => {
    const [a, b] = ['k2', 'k1'].map((s) => perSeed(s, 0.5, 'rankError'));
    return `10回の個々のシード(δ = 100)では、q = 0.5の順位誤差がk2でk1の5倍以上だったのは${N}回中${seedsWhere((i) => a![i]! / b![i]! >= 5)}回だった。`;
  });
  // 排他: 中央の順位誤差の平均が最も小さいスケール関数(1つに決まる)
  claim('median-smallest-mean', 'mean10', () => {
    const v = SCALES.map((s) => rk(s, 0.5));
    const low = Math.min(...v);
    must(v.filter((x) => x === low).length === 1, '最も小さいスケール関数は1つ');
    return `10回の平均(δ = 100)では、q = 0.5の順位誤差が最も小さいのは${SCALES[v.indexOf(low)]}である。`;
  });
  // 数: シードごとに k0 が k1、k2 の両方より小さかった回数
  claim('median-smallest-per-seed', 'mean10', () => {
    const [a, b, c] = ['k0', 'k1', 'k2'].map((s) => perSeed(s, 0.5, 'rankError'));
    return `10回の個々のシード(δ = 100)では、q = 0.5の順位誤差がk0で最も小さかったのは${N}回中${seedsWhere((i) => a![i]! < b![i]! && a![i]! < c![i]!)}回だった。`;
  });
  // 向き: k2(q = 0.5)とk0(q = 0.99)の δ = 50 → 100 の変化 / 数: 4つの値
  claim('delta-examples', 'seed1', () => {
    const [a, b] = [S1(td('k2', 50), 0.5), S1(td('k2', 100), 0.5)] as const;
    const [c, d] = [S1(td('k0', 50), 0.99), S1(td('k0', 100), 0.99)] as const;
    return `シード1の表では、k2のq = 0.5はδ = 50の${fmt(a)}からδ = 100の${fmt(b)}に${becomes(a, b)}が、k0のq = 0.99はδ = 50の${fmt(c)}からδ = 100の${fmt(d)}に${becomes(c, d)}。`;
  });
  // 排他: 全6構成の挿入順序別の最大誤差のうち、最大の値を取る構成は k2・δ = 50・降順の1つ
  claim('td-max-seed1', 'seed1', () => {
    const w = worstTd();
    const where = ORDERS.flatMap((o) => tdIds.filter((id) => orderErr(o, id) === w).map((id) => `${o} ${id}`));
    must(JSON.stringify(where) === JSON.stringify(['descending tdigest-k2-c50']), '最大はk2、δ = 50、降順の1つ');
    return `シード1の表では、t-digestの最大順位誤差は、最大でも${fmt(w)}(挿入順序の節、k2、δ = 50、降順)だった。`;
  });
  // 数: 10回 × 3つのスケール関数の最大順位誤差の最大
  claim('td-max-10-seeds', 'mean10', () => {
    const m = Math.max(
      ...ctx().dataSeeds.flatMap((sw) => SCALES.map((s) => maxRankError(okAlgorithm(sw, 10000, td(s))))),
    );
    return `10回の個々のシード(δ = 100)では、t-digestの最大順位誤差は、最大でも${fmt(m)}だった。`;
  });

  // ---- 挿入順序の影響 ----
  // 量化: 2つのεで、3つの順序のすべての最大誤差がε以下 / 数: ε = 0.05 の3つ、ε = 0.01 の3つ(等しい)
  claim('order-gk-bound', 'seed1', () => {
    for (const [id, e] of [
      ['gk-eps-0.05', 0.05],
      ['gk-eps-0.01', 0.01],
    ] as const) {
      must(
        ORDERS.every((o) => orderErr(o, id) <= e),
        `${id} は3つの順序のすべてでε以下`,
      );
    }
    const e01 = pairMax('gk-eps-0.01');
    must(new Set(e01).size === 1, 'ε = 0.01 は3つとも等しい');
    return `シード1の表では、GKの順位誤差は${ORDERS.length}つの順序のすべてでε以下だった(ε = 0.05は${list(pairMax('gk-eps-0.05'))}、ε = 0.01は${ORDERS.length}つとも${fmt(e01[0]!)})。`;
  });
  // 条件: 2つのεで 昇順 < 降順 < ランダム(昇順が最小、ランダムが最大) / 数: 6つの値
  claim('order-gk-memory', 'seed1', () => {
    const m = (id: string): number[] => ORDERS.map((o) => orderMem(o, id));
    for (const id of ['gk-eps-0.05', 'gk-eps-0.01'])
      must(
        increasing(m(id)) && ORDERS[0] === 'ascending' && ORDERS[2] === 'random',
        `${id} は昇順が最小、ランダムが最大`,
      );
    return `シード1の表では、GKのメモリは、昇順が最も小さく、ランダムが最も大きい(ε = 0.01は${m('gk-eps-0.01').map(num).join('、')}、ε = 0.05は${m('gk-eps-0.05').map(num).join('、')})。`;
  });
  // 向き: ε = 0.01 の昇順とランダムのメモリの大小 / 数: 2つの値と、ランダムを基準にした差の割合
  claim('order-gk-20pct', 'seed1', () => {
    const a = orderMem('ascending', 'gk-eps-0.01');
    const r = orderMem('random', 'gk-eps-0.01');
    return `シード1の表では、ε = 0.01の昇順のメモリ(${num(a)})は、ランダム(${num(r)})より${fmt((Math.abs(r - a) / r) * 100)}%${adj(a, r)}い(ランダムを基準にした割合)。`;
  });
  // 条件: k = 64 のメモリが3つの順序で等しい / 数: その値
  claim('order-kll-memory', 'seed1', () => {
    const m = ORDERS.map((o) => orderMem(o, 'kll-k-64'));
    must(new Set(m).size === 1, 'k = 64 のメモリは3つの順序で等しい');
    return `シード1の表では、KLLのメモリは、順序によらず同じだった(k = 64は${ORDERS.length}つとも${num(m[0]!)})。`;
  });
  // 数: k = 64 の q = 0.5 の最小と最大
  claim('order-kll-k64-spread', 'trials20', () => {
    const q5 = trialAt('random', 'kll-k-64', 0.5);
    return `20試行では、k = 64のq = 0.5の順位誤差は、${fmt(Math.min(...q5))}から${fmt(Math.max(...q5))}までばらつく(KLLの節の表)。`;
  });
  // 量化: 2つの表のランダム列が、5つのkのすべてで一致し、再計算した値とも一致する
  claim('order-kll-random-column', 'trials20', () => {
    const kllTable = section(doc, '### 20試行の順位誤差(ランダム、件数10,000)');
    const orderTable = section(doc, '### KLL の20試行の平均誤差');
    must(
      kllIds.every(
        (id) =>
          rowOf(kllTable, id)[4] === rowOf(orderTable, id)[3] && rowOf(orderTable, id)[3] === fmt(kllAvg('random', id)),
      ),
      'ランダムの列が「全体の平均」と一致',
    );
    return '20試行では、ランダムの列は、前の節の「全体の平均」と同じ値である。';
  });
  // 向き: 5つのkのすべてで、昇順・降順の平均とランダムの比が1より小さい(大きい) / 数: 比の最小と最大(小数第2位)
  claim('order-kll-asc-desc', 'trials20', () => {
    const asc = kllIds.map((id) => kllAvg('ascending', id) / kllAvg('random', id));
    const desc = kllIds.map((id) => kllAvg('descending', id) / kllAvg('random', id));
    const all = [...asc, ...desc];
    const word = all.every((x) => x < 1) ? '小さかった' : all.every((x) => x > 1) ? '大きかった' : '';
    must(word !== '', '昇順・降順の比がすべて1より小さい(または大きい)');
    const range = (xs: number[]): string => `${Math.min(...xs).toFixed(2)}〜${Math.max(...xs).toFixed(2)}`;
    return `20試行では、${kllIds.length}つのkのすべてで、昇順と降順の平均がランダムより${word}(ランダムに対する比は、昇順が${range(asc)}、降順が${range(desc)})。`;
  });
  // 条件: 3つのスケール関数のすべてで、ランダムのメモリが昇順・降順より小さい / 数: 3つの値
  claim('order-td-random-smallest', 'seed1', () => {
    must(
      SCALES.every(
        (s) =>
          orderMem('random', td(s)) < orderMem('ascending', td(s)) &&
          orderMem('random', td(s)) < orderMem('descending', td(s)),
      ),
      'ランダムのメモリが最も小さい',
    );
    return `シード1の表では、δ = 100の3つのスケール関数のメモリは、ランダムが最も小さい(${SCALES.map((s) => num(orderMem('random', td(s)))).join('、')})。`;
  });
  // 向き: 昇順・降順のメモリがランダムより大きい / 数: 割合(百分率)の最小と最大を整数に丸めた範囲
  claim('order-td-2-21pct', 'seed1', () => {
    const larger = SCALES.flatMap((s) => [
      orderMem('ascending', td(s)) / orderMem('random', td(s)) - 1,
      orderMem('descending', td(s)) / orderMem('random', td(s)) - 1,
    ]);
    must(
      larger.every((x) => x > 0),
      '昇順・降順のメモリがランダムより大きい',
    );
    return `シード1の表では、δ = 100の3つのスケール関数のメモリは、昇順と降順が、ランダムより${Math.round(Math.min(...larger) * 100)}〜${Math.round(Math.max(...larger) * 100)}%大きい。`;
  });
  // 向き: δ = 50 のk2の降順がランダムより小さい / 条件: 降順が3つの順序で最小(唯一) / 数: 2つの値
  claim('order-td-k2-c50-desc', 'seed1', () => {
    const m = ORDERS.map((o) => orderMem(o, td('k2', 50)));
    const d = orderMem('descending', td('k2', 50));
    const r = orderMem('random', td('k2', 50));
    must(d === Math.min(...m) && m.filter((x) => x === d).length === 1, '降順が3つの順序で唯一の最小');
    return `シード1の表では、δ = 50のk2は、降順(${num(d)})がランダム(${num(r)})より${adj(d, r)}く、${ORDERS.length}つの順序で最も小さい。`;
  });
  // 数: δ = 100 の3つのスケール関数 × 3つの順序の最大誤差 / 条件: 各スケール関数の最大と最小の比が1.5以下
  claim('order-td-c100-ratio', 'seed1', () => {
    for (const s of SCALES) {
      const xs = pairMax(td(s));
      must(Math.max(...xs) / Math.min(...xs) <= 1.5, `${s} の順序による最大と最小の比が1.5以下`);
    }
    return `シード1の表では、δ = 100の最大順位誤差は、k0が${list(pairMax(td('k0')))}、k1が${list(pairMax(td('k1')))}、k2が${list(pairMax(td('k2')))}で、順序による最大と最小の比は3つのスケール関数のすべてで1.5倍以下である。`;
  });
  // 数: δ = 50 のk2の降順とランダム / 条件: 降順が2倍を超える
  claim('order-td-k2-c50-2x', 'seed1', () => {
    const d = orderErr('descending', td('k2', 50));
    const r = orderErr('random', td('k2', 50));
    must(d > 2 * r, '降順がランダムの2倍を超える');
    return `シード1の表では、δ = 50のk2は、降順が${fmt(d)}で、ランダムの${fmt(r)}の2倍を超える。`;
  });
  // 排他: 6行のうち、昇順と降順のどちらもランダムより大きい行の集合を列挙する
  claim('order-td-both-worse', 'seed1', () => {
    const rows = tdIds.filter(bothWorse);
    const label = (id: string): string => {
      const m = id.match(/^tdigest-(k\d)-c(\d+)$/)!;
      return `${m[1]}のδ = ${m[2]}`;
    };
    return `シード1の表では、最大順位誤差が昇順と降順のどちらもランダムより大きかったのは、t-digestの${tdIds.length}行のうち、${rows.map(label).join('と')}の${rows.length}行である。`;
  });

  // ---- 登録簿の検査 ----
  it('主張の識別子は重複しない', () => {
    expect(new Set(CLAIMS.map((c) => c.id)).size).toBe(CLAIMS.length);
  });

  for (const c of CLAIMS) {
    it(`主張 ${c.id} [${c.scope}]: 実測から組み立てた文が、文書にちょうど1回あり、文頭に範囲を示す`, () => {
      const sentence = c.render();
      expect(doc.split(sentence).length - 1, '文が文書にちょうど1回ある').toBe(1);
      expect(proseSentences(doc), '文が1つの文として数えられる').toContain(sentence);
      const heading = doc
        .slice(0, doc.indexOf(sentence))
        .split('\n')
        .filter((l) => l.startsWith('## '))
        .pop();
      if (LEAD_SECTIONS.includes(heading ?? '')) {
        if (c.continuation) {
          const line = doc.split('\n').find((l) => l.includes(sentence))!;
          expect(
            splitSentences(stripBullet(line)).some((s) => SCOPE_LEADS[c.scope].some((lead) => s.startsWith(lead))),
            '同じ行に範囲つきの文がある',
          ).toBe(true);
        } else {
          expect(
            SCOPE_LEADS[c.scope].some((lead) => sentence.startsWith(lead)),
            `文頭に範囲(${SCOPE_LEADS[c.scope].join(' / ')})がある`,
          ).toBe(true);
        }
      }
    });
  }

  it('本文のすべての文は、主張か、種類つきの「主張でない文」の一覧のどちらか1つにだけ対応する(閉じた対応)', () => {
    const rendered = CLAIMS.map((c) => c.render());
    const notClaims = NOT_A_CLAIM.map(([, s]) => s);
    const registered = [...rendered, ...notClaims];
    const sentences = proseSentences(doc);
    expect(new Set(registered).size, '登録された文に重複がない').toBe(registered.length);
    expect(new Set(sentences).size, '本文の文に重複がない').toBe(sentences.length);
    const registeredSet = new Set(registered);
    const sentenceSet = new Set(sentences);
    expect(
      sentences.filter((s) => !registeredSet.has(s)),
      '主張にも一覧にもない文(未登録)',
    ).toEqual([]);
    expect(
      registered.filter((s) => !sentenceSet.has(s)),
      '本文にない登録',
    ).toEqual([]);
    // 算術: 主張の数 + 主張でない文の数 = 本文の文の数
    expect(rendered.length + notClaims.length).toBe(sentences.length);
  });

  it('「主張でない文」の一覧: 40件以下で、種類ごとの制約を満たす', () => {
    expect(NOT_A_CLAIM.length).toBeLessThanOrEqual(40);
    const rendered = new Set(CLAIMS.map((c) => c.render()));
    for (const [category, s] of NOT_A_CLAIM) {
      expect(rendered.has(s), `主張と重ならない: ${s}`).toBe(false);
      if (category === 'hypothesis') {
        expect(s, s).toContain('と考えられる');
        expect(/切り分けていない|調べていない/.test(s), s).toBe(true);
      }
      if (category === 'pointer') expect(s, s).toContain('.md');
      if (category === 'method' || category === 'definition' || category === 'pointer') {
        expect(COUNT_RE.test(s), `倍率・回数・大小の比較を含まない: ${s}`).toBe(false);
      }
    }
  });

  it('ぼかす語(ほぼ、わずか、少し、かなり、やや、大幅、一貫して、顕著)は、仮説と方法の説明にしか使わない', () => {
    const allowed = new Set(NOT_A_CLAIM.filter(([c]) => c === 'hypothesis' || c === 'method').map(([, s]) => s));
    const sentences = [...proseSentences(doc), ...splitConditionSentences(doc)];
    expect(sentences.filter((s) => VAGUE_RE.test(s) && !allowed.has(s))).toEqual([]);
  });

  /** 「実験の条件」の節の文 */
  function splitConditionSentences(text: string): string[] {
    return section(text, '## 実験の条件')
      .split('\n')
      .flatMap((l) => splitSentences(stripBullet(l)));
  }

  it('「実験の条件」の節は、条件だけを書き、比較・全称・増減・倍率の語を含まない', () => {
    const sentences = splitConditionSentences(doc);
    expect(sentences.length).toBeGreaterThan(10);
    expect(sentences.filter((s) => DIRECTION_RE.test(s))).toEqual([]);
  });

  it('他の文書(overview.md、kll.md、t-digest.md): experiments.md を指す文は、数字も比較の語もない案内として登録されている', () => {
    for (const name of ['overview.md', 'kll.md', 't-digest.md']) {
      const registered = POINTERS.filter(([d]) => d === name).map(([, s]) => s);
      const found = allSentences(readDoc(name)).filter((s) => POINTER_TRIGGER_RE.test(s));
      expect(found.sort(), name).toEqual([...registered].sort());
    }
    for (const [name, s] of POINTERS) {
      expect(/\d/.test(s), `数字を含まない: ${s}`).toBe(false);
      expect(DIRECTION_RE.test(s), `比較・全称・増減の語を含まない: ${s}`).toBe(false);
      expect(allSentences(readDoc(name)), s).toContain(s);
    }
  });

  it('まとめの表: 測れたことの入口だけで、数字も比較の語もなく、節の名前は本文の見出しと一致する', () => {
    const summary = section(doc, '## まとめ');
    const rows = summary.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 測れたこと'));
    expect(rows.length).toBe(6);
    const headings = doc
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.slice(3));
    for (const row of rows) {
      const [item, sec] = row
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      expect(/\d/.test(item!) || DIRECTION_RE.test(item!), item).toBe(false);
      expect(headings, sec).toContain(sec);
    }
    expect(new Set(rows.map((r) => r.split('|')[2]!.trim())).size).toBe(6);
  });

  it('冒頭に実験の条件(最近順位法、データのシード1、ランダム、メモリの数え方、測定の範囲の3つの名前)を書いている', () => {
    const conditions = section(doc, '## 実験の条件');
    for (const s of [
      '基準の厳密値は、最近順位法(nearest-rank)で求める。',
      '対数正規分布(`mu = 0`、`sigma = 1`)で、データのシードは1である。',
      '件数は1,000、10,000、100,000で',
      '挿入順序は、断りがなければランダムである。',
      '昇順(整列済み)、降順(その反対向きの並び)、ランダムを比べる。',
      '1から20までの20通り',
      '1つの数値または計数を8バイトとして数える',
      '厳密解の整列方式は、件数 × 8バイトである。',
      ...Object.values(SCOPE_TAGS),
      '文頭は「シード1の表では、」で始める。',
      '「10回の平均(δ = 100)では、」',
      '「10回の個々のシード(δ = 100)では、」',
      '文頭は「20試行では、」で始める。',
      'q = 0 は順位1、q = 1 は順位n(nは件数)を指す。',
    ]) {
      expect(conditions).toContain(s);
    }
    expect(nearestRank(10000, 0)).toBe(1);
    expect(nearestRank(10000, 1)).toBe(10000);
    // 文書の主な表と同じ条件で実験を実行している(このテストの実験条件の確認)
    const e = experiments();
    for (const r of [e.main, e.order, e.trials]) {
      for (const c of r.cases) {
        for (const run of c.sweep.runs) {
          expect(run.referenceDefinition).toBe('nearest-rank');
          expect(run.meta.dataSeed).toBe(1);
        }
      }
    }
    expect(e.main.cases.map((c) => c.order)).toEqual(['random']);
    expect(e.order.cases.map((c) => c.order)).toEqual(['ascending', 'descending', 'random']);
    expect(e.trials.cases.map((c) => c.order)).toEqual(['ascending', 'descending', 'random']);
    expect(e.main.cases[0]!.sweep.runs.every((r) => r.seed === 1)).toBe(true);
    expect(e.trials.cases[0]!.sweep.runs.map((r) => r.seed)).toEqual(TRIAL_SEEDS);
    expect(e.dataSeeds.map((r) => r.cases[0]!.sweep.runs[0]!.meta.dataSeed)).toEqual(DATA_SEEDS);
    for (const r of e.dataSeeds) {
      expect(r.cases[0]!.sweep.runs.every((run) => run.referenceDefinition === 'nearest-rank')).toBe(true);
    }
  });

  const tables = (): Record<string, ExpectedTable> => buildTables();
  for (const key of [
    'parameters',
    'memory',
    'gkCounts',
    'gkQuantiles',
    'kll',
    'tdigestRank',
    'tdigestRelative',
    'tdigestSeedsRank',
    'tdigestSeedsRelative',
    'seedCountsRank',
    'seedCountsRelative',
    'orderMemory',
    'orderError',
    'orderKll',
  ]) {
    it(`表「${key}」の見出し、列、各行の数値が、再実行した実験の出力と一致する`, () => {
      const t = tables()[key]!;
      const sec = section(doc, t.heading);
      const lines = sec.split('\n').filter((l) => l.startsWith('| '));
      expect(lines[0]).toBe(`| ${t.header.join(' | ')} |`);
      expect(lines.length).toBe(t.rows.length + 1);
      for (const row of t.rows) expect(rowOf(sec, row[0]!)).toEqual(row);
    });
  }

  it('見出しの範囲: シード1の表の見出しに範囲があり、10回の平均の表の見出しに δ = 100 がある', () => {
    const t = tables();
    for (const key of [
      'parameters',
      'memory',
      'gkCounts',
      'gkQuantiles',
      'tdigestRank',
      'tdigestRelative',
      'orderMemory',
      'orderError',
    ]) {
      expect(t[key]!.heading, key).toContain('シード1');
    }
    for (const key of ['tdigestSeedsRank', 'tdigestSeedsRelative', 'seedCountsRank', 'seedCountsRelative']) {
      expect(t[key]!.heading, key).toContain('δ = 100');
    }
    expect(t.seedCountsRank!.heading).toBe('### 裾が中央より小さかったシード数(δ = 100、10回中)');
    expect(t.kll!.heading).toContain('20試行');
    expect(t.orderKll!.heading).toContain('20試行');
  });

  it('t-digest.md と overview.md の仕組みの説明は、測定の結果と分けて書いてある', () => {
    const overview = readDoc('overview.md');
    const tdigest = readDoc('t-digest.md');
    expect(rowOf(overview, 't-digest')[1]).toContain('約束しない。');
    expect(tdigest).toContain(
      'k1・k2では、裾(0や1に近い分位点)で小さく、中央で大きくする(k0は位置によらず一様な大きさである)。',
    );
    expect(tdigest).toContain('k0は幅が一様で裾を細かくしないので、この仕組みは働かない。');
    // k0 に当てはまらない題名・見出し・文を、k1・k2 に限った形に固定する
    expect(tdigest.split('\n')[0]).toBe(
      '# t-digest: k1・k2では裾を細かく、中央を粗く束ねる要約(順位誤差の上限は保証しない)',
    );
    expect(tdigest).toContain('\n## k1・k2が裾の順位誤差を小さくしやすい理由\n');
    expect(tdigest).toContain('k1、k2は裾でcentroidを小さくするので、k0より裾の順位のずれを小さくしやすい。');
    expect(tdigest).not.toContain('裾の精度が高くなりやすい理由');
    expect(tdigest).not.toContain('k0より裾の精度を高くしやすい');
    // 仕組みの説明の直後に、測定の結果は experiments.md にあるという案内がある
    const mechanism = tdigest.indexOf('k1、k2は裾でcentroidを小さくするので、k0より裾の順位のずれを小さくしやすい。');
    const measured = tdigest.indexOf('ただし、これは仕組みの説明であり、測定の結果は`experiments.md`にある。');
    expect(mechanism).toBeGreaterThan(0);
    expect(measured).toBeGreaterThan(mechanism);
    // 「やすい」「傾向」だけで範囲を書かない言い方が残っていない
    expect(overview).not.toContain('小さくなりやすい');
    expect(tdigest).not.toContain('小さくなりやすいのは');
  });
});
