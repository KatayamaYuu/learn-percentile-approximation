import { err, type Result, type SketchSpec } from '../core';
import type { ConfigError } from './errors';
import { gkSpec, type GkOptions } from './gk';
import { kllSpec, type KllOptions } from './kll';
import { tdigestSpec, type TDigestOptions } from './tdigest';

/** 手法の指定。kind で GK、KLL、t-digest を判別する */
export type StreamingSketchConfig =
  | ({ readonly kind: 'gk' } & GkOptions)
  | ({ readonly kind: 'kll' } & KllOptions)
  | ({ readonly kind: 'tdigest' } & TDigestOptions);

/**
 * kind に応じて gkSpec、kllSpec、tdigestSpec を呼び、その結果(成功も ConfigError も)をそのまま返す。
 * 未知の kind(kind がない、オブジェクトでない場合を含む)は ConfigError(field: 'kind')
 */
export function streamingSketchSpec(config: StreamingSketchConfig): Result<SketchSpec, ConfigError> {
  const kind: unknown = config === null || typeof config !== 'object' ? undefined : config.kind;
  switch (kind) {
    case 'gk': {
      const c = config as Extract<StreamingSketchConfig, { kind: 'gk' }>;
      return gkSpec({ epsilon: c.epsilon });
    }
    case 'kll': {
      const c = config as Extract<StreamingSketchConfig, { kind: 'kll' }>;
      return kllSpec({ k: c.k });
    }
    case 'tdigest': {
      const c = config as Extract<StreamingSketchConfig, { kind: 'tdigest' }>;
      return tdigestSpec({ compression: c.compression, scale: c.scale });
    }
    default:
      return err({
        kind: 'invalid-config',
        field: 'kind',
        reason: 'gk / kll / tdigest のいずれかです',
      });
  }
}
