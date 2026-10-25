// @vitest-environment happy-dom
// site.css の確認: 色のトークンのコントラスト比(10.5)、必要な規則(10.1、10.7、10.8、11.4)、部品の class の定義。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, '..');
const css = readFileSync(join(HERE, 'site.css'), 'utf8');

function tokens(): Map<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  expect(root).not.toBeNull();
  const map = new Map<string, string>();
  for (const m of root![1]!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) map.set(m[1]!, m[2]!.trim());
  return map;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) throw new Error(`6 桁の #rrggbb で書く必要があります: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('色のトークン(10.5)', () => {
  const t = tokens();
  const text = ['text', 'text-muted', 'link', 'danger'];
  const backgrounds = ['bg', 'surface'];
  for (const fg of text) {
    for (const bg of backgrounds) {
      it(`${fg} と ${bg} の比は 4.5:1 以上`, () => {
        expect(t.has(fg), `--${fg}`).toBe(true);
        expect(t.has(bg), `--${bg}`).toBe(true);
        expect(contrast(t.get(fg)!, t.get(bg)!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('ボタンの文字と背景、現在のページの文字と背景の比は 4.5:1 以上', () => {
    expect(contrast(t.get('button-text')!, t.get('button-bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.get('nav-current-text')!, t.get('nav-current-bg')!)).toBeGreaterThanOrEqual(4.5);
  });
  it('フォーカスの輪郭の色は背景との比が 3:1 以上', () => {
    for (const bg of backgrounds) expect(contrast(t.get('focus')!, t.get(bg)!)).toBeGreaterThanOrEqual(3);
  });
});

describe('規則(10.1、10.7、10.8、11.4)', () => {
  it('フォーカスの輪郭を 2px 以上で示す', () => {
    const m = /:focus-visible\s*\{[^}]*outline:\s*(\d+)px/.exec(css);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
  });
  it('768px 未満で 1 列にする', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*767px\)/);
  });
  it('動きを減らす設定で遷移とアニメーションを止める', () => {
    const m = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/transition/);
    expect(m![1]).toMatch(/animation/);
  });
  it('本文が横にスクロールせず、表の枠は中でスクロールする', () => {
    expect(css).toMatch(/\.state-table-scroll[^{]*\{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.chart-table-scroll[^{]*\{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.chart-canvas-frame[^{]*\{[^}]*height:/);
  });
  it('システムフォントだけで、外部の URL・@import・@font-face を使わない', () => {
    expect(css).not.toMatch(/@import|@font-face|https?:|\/\/[a-z]/i);
    expect(css).not.toMatch(/url\(/);
    expect(css).toMatch(/font-family:[^;]*system-ui/);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('部品の class', () => {
  const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const required = [
    'field-reason', 'visually-hidden', 'control', 'control-choice', 'control-slider', 'control-number', 'control-distribution',
    'control-error-selector', 'control-option', 'control-params', 'control-row', 'chart-panel', 'chart-canvas-frame',
    'chart-controls', 'chart-notes', 'chart-table', 'chart-table-scroll', 'chart-title', 'chart-axis-toggle',
    'chart-axis-caption', 'status-bar', 'status-pending', 'status-failed', 'condition-summary', 'state-table',
    'state-table-scroll', 'state-table-notice', 'state-table-gap', 'state-table-rejected', 'state-table-facts',
    'explainer', 'explainer-item', 'explainer-algorithms', 'explainer-guide',
  ];
  for (const c of required) {
    it(`.${c} が定義されている`, () => {
      expect(defined.has(c)).toBe(true);
    });
  }
  it('ui のソースが使う class の文字列がすべて定義されている', () => {
    const prefix = /^(chart-|control|field-|status-|state-|condition-|explainer|visually-|site-|page-|nav-|home-)/;
    const missing = new Set<string>();
    for (const file of walk(UI_DIR)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/'([a-z][a-z0-9 -]*)'/g)) {
        for (const c of m[1]!.split(' ')) if (prefix.test(c) && !defined.has(c)) missing.add(`${c} (${file})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
