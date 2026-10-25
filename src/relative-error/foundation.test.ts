import { describe, expect, it } from 'vitest';
import type { ConfigError, RelativeErrorExperimentError } from './errors';
import type { BucketView, SketchSpecOptions } from './snapshot';

describe('エラー型', () => {
  it('各区分を構築し、kind で判別できる', () => {
    const errors: RelativeErrorExperimentError[] = [
      { kind: 'invalid-config', field: 'alpha', reason: 'x' },
      { kind: 'invalid-experiment', field: 'cases', reason: 'x' },
      { kind: 'generate', error: { kind: 'invalid-count' } },
      { kind: 'harness', error: { kind: 'no-sketches' } },
    ];
    const kinds = errors.map((e) => {
      switch (e.kind) {
        case 'invalid-config':
          return `config:${e.field}`;
        case 'invalid-experiment':
          return `experiment:${e.field}`;
        case 'generate':
          return `generate:${e.error.kind}`;
        case 'harness':
          return `harness:${e.error.kind}`;
      }
    });
    expect(kinds).toEqual(['config:alpha', 'experiment:cases', 'generate:invalid-count', 'harness:no-sketches']);
  });

  it('ConfigError は実験のエラーとしても使える', () => {
    const e: ConfigError = { kind: 'invalid-config', field: 'maxBuckets', reason: 'x' };
    const wrapped: RelativeErrorExperimentError = e;
    expect(wrapped.kind).toBe('invalid-config');
  });
});

describe('観察結果の型', () => {
  it('見本の値を作れ、JSON を往復できる', () => {
    const bucket: BucketView = { index: 3, lower: 1, upper: 2, representative: 1.5, count: 4 };
    const options: SketchSpecOptions = { id: 'a', label: 'b' };
    expect(JSON.parse(JSON.stringify(bucket))).toEqual(bucket);
    expect(JSON.parse(JSON.stringify(options))).toEqual(options);
  });
});
