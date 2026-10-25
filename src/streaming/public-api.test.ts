import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, runBenchmark, runConformance } from '../core';
import * as streaming from './index';
import {
  COMPRESSION_RANGE,
  EPSILON_RANGE,
  K_RANGE,
  KLL_SHRINK,
  SCALE_FUNCTIONS,
  createGk,
  createKll,
  createTDigest,
  gkSpec,
  kllSpec,
  runStreamingExperiment,
  streamingSketchSpec,
  tdigestSpec,
  type Centroid,
  type ConfigError,
  type GkOptions,
  type GkSketch,
  type GkState,
  type GkTuple,
  type KllLevel,
  type KllOptions,
  type KllSketch,
  type KllState,
  type ScaleFunctionKind,
  type StreamingExperimentCase,
  type StreamingExperimentError,
  type StreamingExperimentResult,
  type StreamingExperimentSpec,
  type StreamingSketchConfig,
  type TDigestOptions,
  type TDigestSketch,
  type TDigestState,
} from './index';

describe('公開入口の export 一覧', () => {
  it('実行時の export は設計で挙げた名前だけ(過不足があれば失敗する)', () => {
    expect(Object.keys(streaming).sort()).toEqual(
      [
        'COMPRESSION_RANGE',
        'EPSILON_RANGE',
        'KLL_SHRINK',
        'K_RANGE',
        'SCALE_FUNCTIONS',
        'createGk',
        'createKll',
        'createTDigest',
        'gkSpec',
        'kllSpec',
        'runStreamingExperiment',
        'streamingSketchSpec',
        'tdigestSpec',
      ].sort(),
    );
  });

  it('整列とスケール関数の上限計算などの内部の補助関数は公開しない', () => {
    const exported = streaming as Record<string, unknown>;
    for (const name of ['sortValues', 'sortWeighted', 'scaleLimit']) {
      expect(exported[name]).toBeUndefined();
      expect(name in streaming).toBe(false);
    }
  });

  it('許容範囲・縮小率・スケール関数の一覧が公開されている', () => {
    expect(EPSILON_RANGE).toEqual({ min: 0.0001, max: 0.5 });
    expect(K_RANGE).toEqual({ min: 8, max: 65536 });
    expect(COMPRESSION_RANGE).toEqual({ min: 10, max: 10000 });
    expect(KLL_SHRINK).toBeCloseTo(2 / 3, 12);
    expect(SCALE_FUNCTIONS).toEqual(['k0', 'k1', 'k2']);
  });
});

describe('公開入口だけから使える', () => {
  it('3 手法の作成と内部状態の観察', () => {
    const gkOptions: GkOptions = { epsilon: 0.05 };
    const kllOptions: KllOptions = { k: 8 };
    const tdOptions: TDigestOptions = { compression: 10, scale: 'k1' };
    const gk = createGk(gkOptions);
    const kll = createKll({ ...kllOptions, seed: 3 });
    const td = createTDigest(tdOptions);
    if (!gk.ok || !kll.ok || !td.ok) throw new Error('create');
    const sketches = [gk.value, kll.value, td.value];
    for (let i = 1; i <= 100; i++) for (const s of sketches) expect(s.insert(i).ok).toBe(true);

    const gkSketch: GkSketch = gk.value;
    const kllSketch: KllSketch = kll.value;
    const tdSketch: TDigestSketch = td.value;
    const gkState: GkState = gkSketch.inspect();
    const tuple: GkTuple | undefined = gkState.tuples[0];
    const kllState: KllState = kllSketch.inspect();
    const level: KllLevel | undefined = kllState.levels[0];
    const tdState: TDigestState = tdSketch.inspect();
    const centroid: Centroid | undefined = tdState.centroids[0];

    expect(gkState.algorithm).toBe('gk');
    expect(gkState.count).toBe(100);
    expect(tuple).toBeDefined();
    expect(kllState.algorithm).toBe('kll');
    expect(kllState.count).toBe(100);
    expect(level).toBeDefined();
    expect(tdState.algorithm).toBe('tdigest');
    expect(tdState.count).toBe(100);
    expect(centroid).toBeDefined();
    for (const s of sketches) {
      const r = s.query(0.5);
      expect(r.ok).toBe(true);
    }
  });

  it('不正な指定は ConfigError として返る', () => {
    const e = createGk({ epsilon: 0 });
    if (e.ok) throw new Error('expected error');
    const config: ConfigError = e.error;
    expect(config.kind).toBe('invalid-config');
    expect(config.field).toBe('epsilon');
  });

  it('手法の指定を生成仕様に変換し、core のハーネスに渡して計測できる', () => {
    const configs: StreamingSketchConfig[] = [
      { kind: 'gk', epsilon: 0.05 },
      { kind: 'kll', k: 64 },
      { kind: 'tdigest', compression: 50, scale: 'k2' },
    ];
    const specs = configs.map((c) => streamingSketchSpec(c));
    const viaFactories = [gkSpec({ epsilon: 0.05 }), kllSpec({ k: 64 }), tdigestSpec({ compression: 50, scale: 'k2' })];
    const data = generate({ distribution: { kind: 'uniform', min: 2, max: 900 }, count: 500, seed: 1 });
    if (!data.ok) throw new Error('data');
    const values = specs.map((s, i) => {
      const direct = viaFactories[i]!;
      if (!s.ok || !direct.ok) throw new Error('spec');
      expect(s.value.id).toBe(direct.value.id);
      expect(runConformance(s.value).failures).toEqual([]);
      return s.value;
    });
    const r = runBenchmark({ data: data.value, quantiles: [0.5, 0.99], sketches: values, seed: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.algorithms.length).toBeGreaterThanOrEqual(3);
    expect(r.value.algorithms.filter((a) => a.status === 'ok').length).toBe(r.value.algorithms.length);
  });

  it('実験を実行できる', () => {
    const c: StreamingExperimentCase = { label: 'u', distribution: { kind: 'uniform', min: 2, max: 900 } };
    const spec: StreamingExperimentSpec = {
      cases: [c],
      counts: [100, 200],
      seed: 1,
      orders: ['ascending', 'random'],
      quantiles: [0.5, 0.99],
      sketches: [
        { kind: 'gk', epsilon: 0.05 },
        { kind: 'kll', k: 16 },
        { kind: 'tdigest', compression: 20, scale: 'k0' },
      ],
    };
    const r = runStreamingExperiment(spec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result: StreamingExperimentResult = r.value;
    expect(result.schemaVersion).toBe(1);
    expect(result.cases.map((x) => x.order)).toEqual(['ascending', 'random']);
  });

  it('実験のエラーの型を判別できる', () => {
    const r = runStreamingExperiment({ cases: [], counts: [100], seed: 1, quantiles: [0.5], sketches: [] });
    if (r.ok) throw new Error('expected error');
    const e: StreamingExperimentError = r.error;
    expect(e.kind).toBe('invalid-experiment');
    const scale: ScaleFunctionKind = 'k1';
    expect(SCALE_FUNCTIONS).toContain(scale);
  });
});

// ---- 取り込み関係(依存方向)のテスト ----

/** コメントを除いた上で、静的・動的・再エクスポートの取り込み指定子を集める */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const p of patterns) for (const m of code.matchAll(p)) found.push(m[1]!);
  return found;
}

/** 内部の依存方向。段の小さい順に、より小さい段の兄弟だけを取り込める(同じ段どうしも禁止) */
const LAYERS: Readonly<Record<string, number>> = {
  errors: 0,
  sort: 1,
  scale: 2,
  gk: 3,
  kll: 3,
  tdigest: 3,
  config: 4,
  experiment: 5,
  index: 6,
};
/** 段の規則に加えた個別の禁止(設計: gk は sort と scale を使わず、kll は scale を使わない) */
const FORBIDDEN: Readonly<Record<string, readonly string[]>> = {
  gk: ['sort', 'scale'],
  kll: ['scale'],
};

const dir = __dirname;
const sourceFiles = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort();
const imports = (name: string): string[] => importSpecifiers(readFileSync(join(dir, `${name}.ts`), 'utf8'));

describe('取り込み関係の検査器そのもの', () => {
  it('静的・複数行・型のみ・再エクスポート・動的・require の指定子を拾い、コメントは無視する', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from '../core/exact/x';",
      'import {',
      '  c,',
      "} from '../core';",
      "export * from './d';",
      "export { e } from './e';",
      "import './side';",
      "const f = await import('./f');",
      "const g = require('./g');",
      "// import { z } from './comment-line';",
      "/* import { y } from './comment-block'; */",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual(
      expect.arrayContaining(['./a', '../core/exact/x', '../core', './d', './e', './side', './f', './g']),
    );
    expect(importSpecifiers(src)).toHaveLength(8);
  });
});

describe('取り込み関係が設計の依存方向に従う', () => {
  it('検査の対象は設計どおりの 9 ファイル(ファイルの増減・改名を見逃さない)', () => {
    expect(sourceFiles).toEqual(
      Object.keys(LAYERS)
        .map((n) => `${n}.ts`)
        .sort(),
    );
  });

  for (const name of Object.keys(LAYERS)) {
    describe(`${name}.ts`, () => {
      const specs = imports(name);
      const siblings = specs.filter((s) => s.startsWith('./'));
      const outside = specs.filter((s) => !s.startsWith('./'));

      it('外部は core の入口 (../core) だけを取り込む(core の内部ファイル・他の系統・外部パッケージは取り込まない)', () => {
        expect(outside.filter((s) => s !== '../core')).toEqual([]);
      });

      it('より小さい段の兄弟だけを取り込む(逆方向・同じ段・index は禁止)', () => {
        for (const s of siblings) {
          const target = s.slice(2);
          expect(target in LAYERS, `${s} は検査対象のファイルではない`).toBe(true);
          expect(LAYERS[target]!, `${name} は ${s} を取り込めない`).toBeLessThan(LAYERS[name]!);
        }
      });

      it('個別の禁止(gk は sort・scale、kll は scale)を守る', () => {
        for (const banned of FORBIDDEN[name] ?? []) expect(siblings).not.toContain(`./${banned}`);
      });
    });
  }

  it('3 手法は互いを取り込まない', () => {
    for (const name of ['gk', 'kll', 'tdigest']) {
      for (const other of ['gk', 'kll', 'tdigest']) expect(imports(name)).not.toContain(`./${other}`);
    }
  });

  it('入口は何も定義せず、取り込み先は手法・指定・実験・エラー・スケール関数だけで、整列を直接取り込まない', () => {
    const siblings = imports('index').filter((s) => s.startsWith('./'));
    expect(siblings.sort()).toEqual(['./config', './errors', './experiment', './gk', './kll', './scale', './tdigest']);
  });
});
