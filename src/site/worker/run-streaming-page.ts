// ストリーミング分位点のページのジョブ(5.1、5.3、5.5〜5.8)。上流の実験関数を 3 回呼び、結果をそのまま返す。
// 内部状態は、同じデータで対象の手法を作成して投入し、inspect() の結果を返す。
import { err, generate, ok, type PercentileSketch, type Result } from '../../core';
import {
  createGk,
  createKll,
  createTDigest,
  runStreamingExperiment,
  type ConfigError,
  type StreamingExperimentResult,
  type StreamingExperimentSpec,
  type StreamingSketchConfig,
} from '../../streaming';
import type { StreamingPageCondition } from '../shared/conditions';
import { compressionGrid, countGrid, DETAIL_QUANTILES, epsilonGrid, kGrid, REFERENCE_DEFINITION, SUMMARY_QUANTILES } from '../shared/grids';
import type { StreamingInspection, StreamingPageResult } from '../shared/protocol';
import type { FieldIssue } from '../shared/validate';
import { fromConfigError, fromExperimentError, fromGenerateError, GENERAL_FIELD, streamingFieldMap } from './error-map';

const SEED_LIMIT = 2 ** 32;

/** 手法ごとの指定。格子は各パラメータの格子、現在の値は条件のまま */
function sketchConfigs(c: StreamingPageCondition, grid: boolean): StreamingSketchConfig[] {
  const out: StreamingSketchConfig[] = [];
  for (const m of c.methods) {
    if (m === 'gk') {
      for (const epsilon of grid ? epsilonGrid(c.epsilon) : [c.epsilon]) out.push({ kind: 'gk', epsilon });
    } else if (m === 'kll') {
      for (const k of grid ? kGrid(c.k) : [c.k]) out.push({ kind: 'kll', k });
    } else {
      for (const scale of c.scales) {
        for (const compression of grid ? compressionGrid(c.compression) : [c.compression]) {
          out.push({ kind: 'tdigest', compression, scale });
        }
      }
    }
  }
  return out;
}

/** 試行のシード: seed, seed + 1, …(2^32 を超える分は先頭へ折り返す) */
function trialSeeds(seed: number, trials: number): number[] {
  return Array.from({ length: trials }, (_, i) => (seed + i) % SEED_LIMIT);
}

function configIssue(e: ConfigError): FieldIssue {
  return fromConfigError(e, streamingFieldMap);
}

function inspect(c: StreamingPageCondition, firstTrialSeed: number): Result<StreamingInspection, FieldIssue> {
  const data = generate({ ...c.data });
  if (!data.ok) return err(fromGenerateError(data.error, 'data.distribution'));
  const feed = (sketch: PercentileSketch): FieldIssue | undefined => {
    for (const v of data.value) {
      const r = sketch.insert(v);
      if (!r.ok) return { field: GENERAL_FIELD, reason: '内部状態を観察するための値の投入に失敗しました。' };
    }
    return undefined;
  };
  switch (c.inspectTarget) {
    case 'gk': {
      const s = createGk({ epsilon: c.epsilon });
      if (!s.ok) return err(configIssue(s.error));
      const bad = feed(s.value);
      return bad ? err(bad) : ok({ algorithm: 'gk', state: s.value.inspect() });
    }
    case 'kll': {
      const s = createKll({ k: c.k, seed: firstTrialSeed });
      if (!s.ok) return err(configIssue(s.error));
      const bad = feed(s.value);
      return bad ? err(bad) : ok({ algorithm: 'kll', state: s.value.inspect() });
    }
    case 'tdigest': {
      const s = createTDigest({ compression: c.compression, scale: c.scales[0] ?? 'k1' });
      if (!s.ok) return err(configIssue(s.error));
      const bad = feed(s.value);
      return bad ? err(bad) : ok({ algorithm: 'tdigest', state: s.value.inspect() });
    }
  }
}

export function runStreamingPage(c: StreamingPageCondition): Result<StreamingPageResult, readonly FieldIssue[]> {
  const n = c.data.count;
  const seeds = trialSeeds(c.data.seed, c.trials);
  const common = {
    cases: [{ label: 'site', distribution: c.data.distribution }],
    seed: c.data.seed,
    referenceDefinition: REFERENCE_DEFINITION,
  } satisfies Partial<StreamingExperimentSpec>;

  const specs: readonly StreamingExperimentSpec[] = [
    { ...common, orders: [c.data.order], counts: [n], quantiles: SUMMARY_QUANTILES, sketches: sketchConfigs(c, true) },
    { ...common, orders: [c.data.order], counts: countGrid(n), quantiles: SUMMARY_QUANTILES, sketches: sketchConfigs(c, false) },
    {
      ...common,
      orders: ['random', 'ascending', 'descending'],
      trialSeeds: seeds,
      counts: [n],
      quantiles: DETAIL_QUANTILES,
      sketches: sketchConfigs(c, false),
    },
  ];

  const results: StreamingExperimentResult[] = [];
  for (const spec of specs) {
    const r = runStreamingExperiment(spec);
    if (!r.ok) return err([fromExperimentError(r.error, streamingFieldMap)]);
    results.push(r.value);
  }
  const [paramSweep, countSweep, detail] = results as [StreamingExperimentResult, StreamingExperimentResult, StreamingExperimentResult];

  const inspection = inspect(c, seeds[0] ?? c.data.seed);
  if (!inspection.ok) return err([inspection.error]);
  return ok({ kind: 'streaming', paramSweep, countSweep, detail, inspection: inspection.value });
}
