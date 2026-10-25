import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRng, exactQuantileSorted, nearestRank, rankError } from '../core';
import * as api from './index';
import {
  createGk,
  createKll,
  createTDigest,
  type GkSketch,
  type KllSketch,
  type KllState,
  type ScaleFunctionKind,
  type TDigestSketch,
} from './index';
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
    expect(doc).toContain('裾で誤差が小さくなりやすいのは傾向であり、約束ではない。');
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
