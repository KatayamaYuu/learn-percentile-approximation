import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPARE, DEFAULT_DATA, DEFAULT_HISTOGRAM, DEFAULT_RELATIVE, DEFAULT_STREAMING } from './conditions';
import type { CompareCondition, DataCondition } from './conditions';
import {
  validateCompare,
  validateData,
  validateHistogramPage,
  validateRelativePage,
  validateStreamingPage,
} from './validate';

const fields = (xs: readonly { field: string }[]): string[] => xs.map((x) => x.field);
const data = (patch: Partial<DataCondition>): DataCondition => ({
  ...DEFAULT_DATA,
  ...patch,
});

describe('データ条件の検証(2.5)', () => {
  it('既定は問題なし', () => {
    expect(validateData(DEFAULT_DATA)).toEqual([]);
  });
  it('件数: 99 と 1,000,001 は範囲外、100 と 1,000,000 は受け付ける', () => {
    expect(fields(validateData(data({ count: 99 })))).toEqual(['data.count']);
    expect(fields(validateData(data({ count: 1_000_001 })))).toEqual(['data.count']);
    expect(validateData(data({ count: 100 }))).toEqual([]);
    expect(validateData(data({ count: 1_000_000 }))).toEqual([]);
  });
  it('件数: 小数と数値でない値は整数でないとして拒む', () => {
    for (const count of [1000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const issues = validateData(data({ count }));
      expect(fields(issues)).toEqual(['data.count']);
      expect(issues[0]?.reason.length).toBeGreaterThan(0);
    }
  });
  it('シード: 0 と 2^32-1 は受け付け、-1・2^32・小数は拒む', () => {
    expect(validateData(data({ seed: 0 }))).toEqual([]);
    expect(validateData(data({ seed: 2 ** 32 - 1 }))).toEqual([]);
    for (const seed of [-1, 2 ** 32, 1.5, Number.NaN]) {
      expect(fields(validateData(data({ seed })))).toEqual(['data.seed']);
    }
  });
  it('件数とシードが両方誤りなら両方の項目を返す', () => {
    expect(fields(validateData(data({ count: 5, seed: -3 })))).toEqual(['data.count', 'data.seed']);
  });
  it('分布のパラメータは検証し直さない(上流が返す)', () => {
    const bad = data({ distribution: { kind: 'lognormal', mu: 0, sigma: -5 } });
    expect(validateData(bad)).toEqual([]);
  });
});

describe('ヒストグラムのページの検証', () => {
  it('既定は問題なし。バケット数は検証しない', () => {
    expect(validateHistogramPage(DEFAULT_HISTOGRAM)).toEqual([]);
    expect(validateHistogramPage({ ...DEFAULT_HISTOGRAM, buckets: 0 })).toEqual([]);
  });
  it('データ条件の誤りを含める', () => {
    expect(
      fields(
        validateHistogramPage({
          ...DEFAULT_HISTOGRAM,
          data: data({ count: 99 }),
        }),
      ),
    ).toEqual(['data.count']);
  });
  it('方式の選択が 0 件', () => {
    expect(fields(validateHistogramPage({ ...DEFAULT_HISTOGRAM, schemes: [] }))).toEqual(['schemes']);
  });
  it('固定の範囲: 下限 < 上限なら可、逆転・同値は拒む', () => {
    const fixed = (lower: number, upper: number) => ({
      ...DEFAULT_HISTOGRAM,
      range: { kind: 'fixed' as const, lower, upper },
    });
    expect(validateHistogramPage(fixed(1, 10))).toEqual([]);
    expect(fields(validateHistogramPage(fixed(10, 1)))).toEqual(['range.lower']);
    expect(fields(validateHistogramPage(fixed(5, 5)))).toEqual(['range.lower']);
  });
  it('固定の範囲: 有限の正の数でない値は項目ごとに拒む', () => {
    const fixed = (lower: number, upper: number) => ({
      ...DEFAULT_HISTOGRAM,
      range: { kind: 'fixed' as const, lower, upper },
    });
    expect(fields(validateHistogramPage(fixed(0, 10)))).toEqual(['range.lower']);
    expect(fields(validateHistogramPage(fixed(-1, 10)))).toEqual(['range.lower']);
    expect(fields(validateHistogramPage(fixed(1, Number.POSITIVE_INFINITY)))).toEqual(['range.upper']);
    expect(fields(validateHistogramPage(fixed(Number.NaN, 10)))).toEqual(['range.lower']);
  });
});

describe('ストリーミングのページの検証', () => {
  it('既定は問題なし。ε・k・δ は検証しない', () => {
    expect(validateStreamingPage(DEFAULT_STREAMING)).toEqual([]);
    expect(validateStreamingPage({ ...DEFAULT_STREAMING, epsilon: -1 })).toEqual([]);
  });
  it('試行: 1 と 10 は可、0・11・小数は拒む', () => {
    expect(validateStreamingPage({ ...DEFAULT_STREAMING, trials: 10 })).toEqual([]);
    for (const trials of [0, 11, 2.5]) {
      expect(fields(validateStreamingPage({ ...DEFAULT_STREAMING, trials }))).toEqual(['trials']);
    }
  });
  it('手法の選択 0 件', () => {
    const issues = validateStreamingPage({
      ...DEFAULT_STREAMING,
      methods: [],
      inspectTarget: 'gk',
    });
    expect(fields(issues)).toContain('methods');
  });
  it('内部状態の対象が選択に含まれない', () => {
    const issues = validateStreamingPage({
      ...DEFAULT_STREAMING,
      methods: ['kll'],
      inspectTarget: 'gk',
    });
    expect(fields(issues)).toEqual(['inspectTarget']);
    expect(
      validateStreamingPage({
        ...DEFAULT_STREAMING,
        methods: ['kll'],
        inspectTarget: 'kll',
      }),
    ).toEqual([]);
  });
  it('t-digest を選んだのにスケール関数が 0 件なら拒む。選んでいなければ問わない', () => {
    expect(fields(validateStreamingPage({ ...DEFAULT_STREAMING, scales: [] }))).toEqual(['scales']);
    expect(
      validateStreamingPage({
        ...DEFAULT_STREAMING,
        methods: ['gk'],
        scales: [],
      }),
    ).toEqual([]);
  });
});

describe('相対誤差型のページの検証', () => {
  it('既定は問題なし。α・有効桁数は検証しない', () => {
    expect(validateRelativePage(DEFAULT_RELATIVE)).toEqual([]);
    expect(validateRelativePage({ ...DEFAULT_RELATIVE, alpha: 5 })).toEqual([]);
  });
  it('手法の選択 0 件と、内部状態の対象が選択に含まれない場合', () => {
    expect(fields(validateRelativePage({ ...DEFAULT_RELATIVE, methods: [] }))).toContain('methods');
    expect(
      fields(
        validateRelativePage({
          ...DEFAULT_RELATIVE,
          methods: ['ddsketch'],
          inspectTarget: 'hdr',
        }),
      ),
    ).toEqual(['inspectTarget']);
  });
  it('手動の範囲: 逆転は下限の項目、正でない値は該当の項目を拒む', () => {
    const manual = (lowest: number, highest: number) => ({
      ...DEFAULT_RELATIVE,
      hdrRange: { kind: 'manual' as const, lowest, highest },
    });
    expect(validateRelativePage(manual(1, 1e6))).toEqual([]);
    expect(fields(validateRelativePage(manual(100, 10)))).toEqual(['hdrRange.lowest']);
    expect(fields(validateRelativePage(manual(1, 0)))).toEqual(['hdrRange.highest']);
    expect(fields(validateRelativePage(manual(Number.NaN, 5)))).toEqual(['hdrRange.lowest']);
  });
  it('HDR を選んでいなければ手動の範囲を検査しない', () => {
    const c = {
      ...DEFAULT_RELATIVE,
      methods: ['ddsketch' as const],
      hdrRange: { kind: 'manual' as const, lowest: 100, highest: 10 },
    };
    expect(validateRelativePage(c)).toEqual([]);
  });
});

describe('横断比較の検証(8.7、2.5)', () => {
  it('既定は問題なし', () => {
    expect(validateCompare(DEFAULT_COMPARE)).toEqual([]);
  });
  it('比較の対象が 0 件なら algorithms を返す', () => {
    const issues = validateCompare({ ...DEFAULT_COMPARE, algorithms: [] });
    expect(fields(issues)).toEqual(['algorithms']);
    expect(issues[0]?.reason).toMatch(/選/);
  });
  it('同じ種類・同じパラメータの重複を拒む。パラメータが違えば可', () => {
    const dup: CompareCondition = {
      ...DEFAULT_COMPARE,
      algorithms: [
        { kind: 'gk', epsilon: 0.01 },
        { kind: 'kll', k: 200 },
        { kind: 'gk', epsilon: 0.01 },
      ],
    };
    expect(fields(validateCompare(dup))).toEqual(['algorithms']);
    const ok: CompareCondition = {
      ...DEFAULT_COMPARE,
      algorithms: [
        { kind: 'gk', epsilon: 0.01 },
        { kind: 'gk', epsilon: 0.02 },
        { kind: 'exact-sort' },
        { kind: 'exact-quickselect' },
      ],
    };
    expect(validateCompare(ok)).toEqual([]);
    const dupExact: CompareCondition = {
      ...DEFAULT_COMPARE,
      algorithms: [{ kind: 'exact-sort' }, { kind: 'exact-sort' }],
    };
    expect(fields(validateCompare(dupExact))).toEqual(['algorithms']);
  });
  it('HDR の手動の範囲の逆転は、HDR を選んでいるときだけ拒む', () => {
    const range = { kind: 'manual' as const, lowest: 50, highest: 5 };
    expect(fields(validateCompare({ ...DEFAULT_COMPARE, hdrRange: range }))).toEqual(['hdrRange.lowest']);
    expect(
      validateCompare({
        ...DEFAULT_COMPARE,
        algorithms: [{ kind: 'exact-sort' }],
        hdrRange: range,
      }),
    ).toEqual([]);
  });
  it('データ条件の誤りを含める', () => {
    expect(fields(validateCompare({ ...DEFAULT_COMPARE, data: data({ seed: -1 }) }))).toEqual(['data.seed']);
  });
});
