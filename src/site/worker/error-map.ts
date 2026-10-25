// 上流のエラーを、UI の項目の識別と上流の理由の文(FieldIssue)に変換する(2.5)。
// 上流の理由は日本語の説明なので、そのまま表示に使う。対応のない項目は 'general'。
import type { GenerateError, HarnessError } from '../../core';
import type { ExperimentError as HistogramExperimentError } from '../../histogram';
import type { RelativeErrorExperimentError, ConfigError as RelativeConfigError } from '../../relative-error';
import type { ConfigError as StreamingConfigError, StreamingExperimentError } from '../../streaming';
import type { FieldIssue } from '../shared/validate';

export const GENERAL_FIELD = 'general';

const NON_FINITE_REASON =
  'この分布のパラメータでは、正の有限の数にならない値ができました。パラメータ(σ など)を小さくしてください';

/** generate のエラー。prefix は分布の項目の接頭辞(例: 'data.distribution') */
export function fromGenerateError(e: GenerateError, prefix: string): FieldIssue {
  switch (e.kind) {
    case 'invalid-parameter':
      return { field: `${prefix}.${e.field}`, reason: e.reason };
    case 'invalid-count':
      return { field: 'data.count', reason: '件数が範囲外です。' };
    case 'invalid-seed':
      return { field: 'data.seed', reason: 'シードが範囲外です。' };
    case 'non-finite-sample':
      return { field: prefix, reason: NON_FINITE_REASON };
  }
}

/** ハーネスのエラーは利用者の入力の誤りではないので、全般の項目にする */
export function fromHarnessError(e: HarnessError): FieldIssue {
  switch (e.kind) {
    case 'invalid-data':
      return { field: GENERAL_FIELD, reason: 'データが空か、正の有限の数でない値を含みます。' };
    case 'invalid-quantile':
      return { field: GENERAL_FIELD, reason: '分位点が範囲外です。' };
    case 'no-sketches':
      return { field: GENERAL_FIELD, reason: '計算する手法がありません。' };
    case 'invalid-params':
      return { field: GENERAL_FIELD, reason: `手法のパラメータ(${e.field})を結果に記録できません。` };
  }
}

/** 設定のエラー(createGk など、xxxSpec、planHdr の createHdrLayout が返す) */
export function fromConfigError(
  e: StreamingConfigError | RelativeConfigError,
  fieldMap: (upstreamField: string) => string,
): FieldIssue {
  return { field: fieldMap(e.field), reason: e.reason };
}

/** 実験のエラー(3 系統)。fieldMap は上流の項目名を UI の項目に対応づける */
export function fromExperimentError(
  e: HistogramExperimentError | StreamingExperimentError | RelativeErrorExperimentError,
  fieldMap: (upstreamField: string) => string,
): FieldIssue {
  switch (e.kind) {
    case 'invalid-scheme':
    case 'invalid-config':
    case 'invalid-experiment':
      return { field: fieldMap(e.field), reason: e.reason };
    case 'generate':
      return fromGenerateError(e.error, 'data.distribution');
    case 'harness':
      return fromHarnessError(e.error);
  }
}

const lookup = (table: Readonly<Record<string, string>>, key: string): string =>
  Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as string) : GENERAL_FIELD;

const HISTOGRAM_FIELDS: Readonly<Record<string, string>> = {
  buckets: 'buckets',
  lower: 'range.lower',
  upper: 'range.upper',
};

/** histogram の invalid-scheme の buckets・lower・upper */
export function histogramFieldMap(upstreamField: string): string {
  return lookup(HISTOGRAM_FIELDS, upstreamField);
}

const STREAMING_FIELDS: Readonly<Record<string, string>> = {
  epsilon: 'epsilon',
  k: 'k',
  compression: 'compression',
  scale: 'scales',
};

/** streaming の `sketches[<i>].<項目>`(接頭辞なしも可)の epsilon・k・compression・scale */
export function streamingFieldMap(upstreamField: string): string {
  return lookup(STREAMING_FIELDS, upstreamField.replace(/^sketches\[\d+\]\./, ''));
}

/** relative-error の設定の項目名(接頭辞・添字のない素の名前を完全一致で引く) */
const RELATIVE_CONFIG_FIELDS: Readonly<Record<string, string>> = {
  alpha: 'alpha',
  maxBuckets: 'maxBuckets',
  significantDigits: 'significantDigits',
  lowest: 'hdrRange.lowest',
  highest: 'hdrRange.highest',
};

/** relative-error の実験の指定の項目名 */
const RELATIVE_EXPERIMENT_FIELDS: Readonly<Record<string, string>> = {
  alphas: 'alpha',
  maxBucketsList: 'maxBuckets',
  significantDigitsList: 'significantDigits',
  cases: GENERAL_FIELD,
  counts: GENERAL_FIELD,
  quantiles: GENERAL_FIELD,
};

/**
 * relative-error のエラーの項目の対応。設定の 5 項目と実験の 6 項目は名前が重ならない
 * (alpha と alphas など)ので、2 組を完全一致で引く。histogram の lower・upper とは別。
 */
export function relativeFieldMap(upstreamField: string): string {
  if (Object.prototype.hasOwnProperty.call(RELATIVE_CONFIG_FIELDS, upstreamField)) {
    return RELATIVE_CONFIG_FIELDS[upstreamField] as string;
  }
  return lookup(RELATIVE_EXPERIMENT_FIELDS, upstreamField);
}

/** 横断比較: ddsketchSpec・hdrSpec の設定のエラーを algorithms[<i>].<項目> に対応づける。範囲の誤りは共通の項目 */
export function relativeCompareFieldMap(index: number): (upstreamField: string) => string {
  return (upstreamField) => {
    const mapped = relativeFieldMap(upstreamField);
    if (mapped === GENERAL_FIELD || mapped.startsWith('hdrRange.')) return mapped;
    return `algorithms[${index}].${mapped}`;
  };
}
