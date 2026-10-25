// 相対誤差型のページのジョブ(6.1、6.3〜6.8)。HDR の範囲と有効桁数を決め、HDR の項を含めて計算量を再判定し、
// 上流の実験関数を 3 回呼ぶ。内部状態は、同じデータで対象の手法を作成して投入し、inspect() の結果を返す。
import { err, generate, ok, type Result } from '../../core';
import {
  createDDSketch,
  createHdrHistogram,
  runRelativeErrorExperiment,
  type RelativeErrorExperimentResult,
  type RelativeErrorExperimentSpec,
} from '../../relative-error';
import { alphaGrid, countGrid, DETAIL_QUANTILES, digitsGrid, REFERENCE_DEFINITION, SUMMARY_QUANTILES } from '../shared/grids';
import type { RelativePageCondition } from '../shared/conditions';
import type { HdrPlanSummary, JobFailure, RelativeInspection, RelativePageResult } from '../shared/protocol';
import type { FieldIssue } from '../shared/validate';
import { estimateWork } from '../shared/workload';
import { dataExtent, planHdr } from './data-extent';
import { fromConfigError, fromExperimentError, fromGenerateError, GENERAL_FIELD, relativeFieldMap } from './error-map';

const invalid = (...issues: FieldIssue[]): JobFailure => ({ kind: 'invalid-condition', issues });

function inspect(
  c: RelativePageCondition,
  data: Float64Array,
  plan: HdrPlanSummary,
  digits: number,
): Result<RelativeInspection, FieldIssue> {
  if (c.inspectTarget === 'ddsketch') {
    const s = createDDSketch({ alpha: c.alpha, maxBuckets: c.maxBuckets });
    if (!s.ok) return err(fromConfigError(s.error, relativeFieldMap));
    for (const v of data) {
      if (!s.value.insert(v).ok) return err({ field: GENERAL_FIELD, reason: '内部状態を観察するための値の投入に失敗しました。' });
    }
    return ok({ algorithm: 'ddsketch', snapshot: s.value.inspect() });
  }
  const h = createHdrHistogram({ ...plan.range, significantDigits: digits });
  if (!h.ok) return err(fromConfigError(h.error, relativeFieldMap));
  for (const v of data) {
    const r = h.value.insert(v);
    if (!r.ok) {
      if (r.error.kind === 'unsupported-value') return ok({ algorithm: 'hdr', rejected: true, reason: r.error.detail });
      return err({ field: GENERAL_FIELD, reason: '内部状態を観察するための値の投入に失敗しました。' });
    }
  }
  return ok({ algorithm: 'hdr', snapshot: h.value.inspect() });
}

export function runRelativePage(c: RelativePageCondition): Result<RelativePageResult, JobFailure> {
  const n = c.data.count;
  const generated = generate({ ...c.data });
  if (!generated.ok) return err(invalid(fromGenerateError(generated.error, 'data.distribution')));
  const data = generated.value;

  // 範囲と有効桁数。HDR を選んでいないときは、手動の指定にかかわらず auto(HDR の範囲で失敗させない)
  const hdrSelected = c.methods.includes('hdr');
  const grid = digitsGrid(c.significantDigits);
  const planned = planHdr(hdrSelected ? c.hdrRange : { kind: 'auto' }, dataExtent(data), grid);
  if (!planned.ok) return err(invalid(planned.error));
  const hdrPlan = planned.value;

  // 現在の有効桁数が除かれたとき
  let currentDigits = c.significantDigits;
  const droppedCurrent = hdrPlan.excluded.find((e) => e.significantDigits === c.significantDigits);
  if (droppedCurrent) {
    if (hdrSelected) return err(invalid({ field: 'significantDigits', reason: droppedCurrent.reason }));
    const smallest = Math.min(...hdrPlan.included.map((i) => i.significantDigits));
    if (!Number.isFinite(smallest)) {
      return err(invalid({ field: 'significantDigits', reason: droppedCurrent.reason }));
    }
    currentDigits = smallest;
  }

  // HDR の項を含めた計算量の再判定
  const excludedDigits = new Set(hdrPlan.excluded.map((e) => e.significantDigits));
  const estimate = estimateWork(
    { kind: 'relative', condition: { ...c, significantDigits: currentDigits } },
    { totalBuckets: new Map(hdrPlan.included.map((i) => [i.significantDigits, i.totalBuckets])) },
  );
  if (!estimate.withinLimit) return err({ kind: 'over-limit', estimate });

  const common = {
    cases: [{ label: 'site', distribution: c.data.distribution, hdrRange: hdrPlan.range }],
    seed: c.data.seed,
    order: c.data.order,
    referenceDefinition: REFERENCE_DEFINITION,
  } satisfies Partial<RelativeErrorExperimentSpec>;
  const current = { alphas: [c.alpha], maxBucketsList: [c.maxBuckets], significantDigitsList: [currentDigits] };

  const specs: readonly RelativeErrorExperimentSpec[] = [
    {
      ...common,
      counts: [n],
      quantiles: SUMMARY_QUANTILES,
      alphas: alphaGrid(c.alpha),
      maxBucketsList: [c.maxBuckets],
      significantDigitsList: grid.filter((d) => !excludedDigits.has(d)),
    },
    { ...common, counts: countGrid(n), quantiles: SUMMARY_QUANTILES, ...current },
    { ...common, counts: [n], quantiles: DETAIL_QUANTILES, ...current },
  ];

  const results: RelativeErrorExperimentResult[] = [];
  for (const spec of specs) {
    const r = runRelativeErrorExperiment(spec);
    if (!r.ok) return err(invalid(fromExperimentError(r.error, relativeFieldMap)));
    results.push(r.value);
  }
  const [paramSweep, countSweep, detail] = results as [
    RelativeErrorExperimentResult,
    RelativeErrorExperimentResult,
    RelativeErrorExperimentResult,
  ];

  const inspection = inspect(c, data, hdrPlan, currentDigits);
  if (!inspection.ok) return err(invalid(inspection.error));
  return ok({ kind: 'relative', hdrRange: hdrPlan.range, hdrPlan, paramSweep, countSweep, detail, inspection: inspection.value });
}
