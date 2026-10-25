import { describe, expect, it } from 'vitest';
import { isParamRecord } from '../core';
import { streamingSketchSpec, type StreamingSketchConfig } from './config';
import { createGk, gkSpec } from './gk';
import type { KllSketch } from './kll';
import type { TDigestSketch } from './tdigest';
import { createKll, kllSpec } from './kll';
import { createTDigest, tdigestSpec } from './tdigest';

function specOf(config: StreamingSketchConfig) {
  const r = streamingSketchSpec(config);
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function direct<T, E>(r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }): T {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf(config: unknown) {
  const r = streamingSketchSpec(config as StreamingSketchConfig);
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

describe('streamingSketchSpec: 種類ごとの変換(4.7)', () => {
  it('gk は gkSpec と同じ id・label・params になる', () => {
    const s = specOf({ kind: 'gk', epsilon: 0.01 });
    const d = direct(gkSpec({ epsilon: 0.01 }));
    expect(s.id).toBe('gk-eps-0.01');
    expect(s.label).toBe('GK(ε=0.01)');
    expect(s.params).toEqual({ algorithm: 'gk', epsilon: 0.01 });
    expect(s.id).toBe(d.id);
    expect(s.label).toBe(d.label);
    expect(s.params).toEqual(d.params);
  });

  it('kll は kllSpec と同じ id・label・params になる', () => {
    const s = specOf({ kind: 'kll', k: 200 });
    const d = direct(kllSpec({ k: 200 }));
    expect(s.id).toBe('kll-k-200');
    expect(s.label).toBe('KLL(k=200)');
    expect(s.params).toEqual({ algorithm: 'kll', k: 200, c: 2 / 3 });
    expect(s.id).toBe(d.id);
    expect(s.label).toBe(d.label);
    expect(s.params).toEqual(d.params);
  });

  it('tdigest は tdigestSpec と同じ id・label・params になる', () => {
    const s = specOf({ kind: 'tdigest', compression: 100, scale: 'k1' });
    const d = direct(tdigestSpec({ compression: 100, scale: 'k1' }));
    expect(s.id).toBe('tdigest-k1-c100');
    expect(s.label).toBe('t-digest(k1, δ=100)');
    expect(s.params).toEqual({
      algorithm: 'tdigest',
      compression: 100,
      scale: 'k1',
      bufferCapacity: 500,
    });
    expect(s.id).toBe(d.id);
    expect(s.label).toBe(d.label);
    expect(s.params).toEqual(d.params);
  });

  it('params は ParamRecord で、kind は含まない', () => {
    for (const c of [
      { kind: 'gk', epsilon: 0.1 },
      { kind: 'kll', k: 8 },
      { kind: 'tdigest', compression: 10, scale: 'k0' },
    ] as const) {
      const s = specOf(c);
      expect(isParamRecord(s.params)).toBe(true);
      expect(s.params).not.toHaveProperty('kind');
    }
  });

  it('create が各手法のスケッチを作る(gk は挿入できる)', () => {
    const gk = specOf({ kind: 'gk', epsilon: 0.1 }).create(1);
    expect(gk.insert(5).ok).toBe(true);
    const gq = gk.query(0.5);
    expect(gq).toEqual({ ok: true, value: 5 });
    expect(direct(createGk({ epsilon: 0.1 })).insert(5).ok).toBe(true);
  });

  it('create に渡したシードは kll に届く(同じシードは同じ状態、違うシードは異なる状態)', () => {
    const run = (config: StreamingSketchConfig, seed: number) => {
      const sk = specOf(config).create(seed) as KllSketch;
      for (let i = 0; i < 200; i++) sk.insert((i * 37) % 101);
      return JSON.stringify(sk.inspect());
    };
    const kll = { kind: 'kll', k: 8 } as const;
    expect(run(kll, 1)).toBe(run(kll, 1));
    expect(run(kll, 1)).not.toBe(run(kll, 2));
    const ref = direct(createKll({ k: 8, seed: 2 }));
    for (let i = 0; i < 200; i++) ref.insert((i * 37) % 101);
    expect(run(kll, 2)).toBe(JSON.stringify(ref.inspect()));
  });

  it('tdigest の create は tdigest を作る', () => {
    const sk = specOf({ kind: 'tdigest', compression: 50, scale: 'k2' }).create(1) as TDigestSketch;
    const ref = direct(createTDigest({ compression: 50, scale: 'k2' }));
    for (let i = 0; i < 300; i++) {
      sk.insert(i);
      ref.insert(i);
    }
    expect(JSON.stringify(sk.inspect())).toBe(JSON.stringify(ref.inspect()));
  });
});

describe('streamingSketchSpec: 識別子の区別(7.1)', () => {
  it('ε・k・圧縮パラメータ・スケール関数が違えば id が違う', () => {
    const ids = [
      specOf({ kind: 'gk', epsilon: 0.01 }).id,
      specOf({ kind: 'gk', epsilon: 0.02 }).id,
      specOf({ kind: 'kll', k: 8 }).id,
      specOf({ kind: 'kll', k: 9 }).id,
      specOf({ kind: 'tdigest', compression: 100, scale: 'k0' }).id,
      specOf({ kind: 'tdigest', compression: 100, scale: 'k1' }).id,
      specOf({ kind: 'tdigest', compression: 101, scale: 'k1' }).id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('同じ指定は同じ id になる', () => {
    expect(specOf({ kind: 'kll', k: 64 }).id).toBe(specOf({ kind: 'kll', k: 64 }).id);
  });

  it('余分な項目(kind 以外の未知の項目)は結果に影響しない', () => {
    const s = specOf({
      kind: 'kll',
      k: 8,
      extra: 1,
    } as unknown as StreamingSketchConfig);
    expect(s.params).toEqual({ algorithm: 'kll', k: 8, c: 2 / 3 });
  });
});

describe('streamingSketchSpec: 誤りの返し方', () => {
  it('未知の kind は invalid-config(field: kind)', () => {
    const e = errorOf({ kind: 'histogram', k: 8 });
    expect(e.kind).toBe('invalid-config');
    expect(e.field).toBe('kind');
    expect(typeof e.reason).toBe('string');
    expect(e.reason.length).toBeGreaterThan(0);
  });

  it('kind がない・null・非オブジェクト・大文字違いも kind の誤り', () => {
    for (const bad of [{}, { k: 8 }, null, undefined, 'gk', 3, { kind: 'GK', epsilon: 0.1 }, { kind: 1 }]) {
      const e = errorOf(bad);
      expect(e.kind).toBe('invalid-config');
      expect(e.field).toBe('kind');
    }
  });

  it('Object.prototype のプロパティ名の kind も未知として扱う', () => {
    expect(errorOf({ kind: 'toString' }).field).toBe('kind');
    expect(errorOf({ kind: '__proto__' }).field).toBe('kind');
  });

  it('不正な ε は gkSpec の ConfigError をそのまま返す', () => {
    for (const epsilon of [0, 0.00009, 0.51, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = gkSpec({ epsilon });
      if (d.ok) throw new Error('expected error');
      const e = errorOf({ kind: 'gk', epsilon });
      expect(e).toEqual(d.error);
      expect(e.field).toBe('epsilon');
    }
  });

  it('不正な k は kllSpec の ConfigError をそのまま返す', () => {
    for (const k of [7, 65537, 8.5, Number.NaN]) {
      const d = kllSpec({ k });
      if (d.ok) throw new Error('expected error');
      const e = errorOf({ kind: 'kll', k });
      expect(e).toEqual(d.error);
      expect(e.field).toBe('k');
    }
  });

  it('不正な圧縮パラメータ・スケール関数は tdigestSpec の ConfigError をそのまま返す', () => {
    const cases = [
      { compression: 9, scale: 'k1', field: 'compression' },
      { compression: 10001, scale: 'k1', field: 'compression' },
      { compression: Number.NaN, scale: 'k1', field: 'compression' },
      { compression: 100, scale: 'k3', field: 'scale' },
    ] as const;
    for (const c of cases) {
      const d = tdigestSpec({
        compression: c.compression,
        scale: c.scale as 'k1',
      });
      if (d.ok) throw new Error('expected error');
      const e = errorOf({
        kind: 'tdigest',
        compression: c.compression,
        scale: c.scale,
      });
      expect(e).toEqual(d.error);
      expect(e.field).toBe(c.field);
    }
  });

  it('範囲の端は受け入れる', () => {
    expect(specOf({ kind: 'gk', epsilon: 0.0001 }).id).toBe('gk-eps-0.0001');
    expect(specOf({ kind: 'gk', epsilon: 0.5 }).id).toBe('gk-eps-0.5');
    expect(specOf({ kind: 'kll', k: 8 }).id).toBe('kll-k-8');
    expect(specOf({ kind: 'kll', k: 65536 }).id).toBe('kll-k-65536');
    expect(specOf({ kind: 'tdigest', compression: 10, scale: 'k0' }).id).toBe('tdigest-k0-c10');
    expect(specOf({ kind: 'tdigest', compression: 10000, scale: 'k2' }).id).toBe('tdigest-k2-c10000');
  });
});
