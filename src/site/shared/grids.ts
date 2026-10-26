// パラメータの格子、分位点の集合、基準の定義。
import type { PercentileDefinition } from '../../core';

/** 基準(厳密解)の定義: 最近順位法。上流の既定('linear')とは別に、サイトでは明示する */
export const REFERENCE_DEFINITION = 'nearest-rank' as const satisfies PercentileDefinition;

/** 要約用の分位点 */
export const SUMMARY_QUANTILES: readonly number[] = [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999];

/** 詳細用の分位点: 0, 0.001, 0.005, 0.01〜0.99(0.01 刻み), 0.995, 0.999, 1 */
export const DETAIL_QUANTILES: readonly number[] = [
  0,
  0.001,
  0.005,
  ...Array.from({ length: 99 }, (_, i) => (i + 1) / 100),
  0.995,
  0.999,
  1,
];

/** 値の集合に現在の値を加え、昇順・重複なしにする */
function withCurrent(base: readonly number[], current: number): number[] {
  return [...new Set([...base, current])].sort((a, b) => a - b);
}

const COUNT_BASE: readonly number[] = [100, 1_000, 10_000, 100_000, 1_000_000];
const BUCKETS_BASE: readonly number[] = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
const EPSILON_BASE: readonly number[] = [0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
const K_BASE: readonly number[] = [8, 16, 32, 64, 128, 256, 512, 1024];
const COMPRESSION_BASE: readonly number[] = [10, 20, 50, 100, 200, 500, 1000];
const ALPHA_BASE: readonly number[] = [0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
const DIGITS_BASE: readonly number[] = [0, 1, 2, 3, 4];

/** 件数の格子: 現在の件数以下の基本の件数 ∪ {現在の件数}。最大は現在の件数 */
export function countGrid(current: number): number[] {
  return withCurrent(
    COUNT_BASE.filter((n) => n <= current),
    current,
  );
}
export function bucketsGrid(current: number): number[] {
  return withCurrent(BUCKETS_BASE, current);
}
export function epsilonGrid(current: number): number[] {
  return withCurrent(EPSILON_BASE, current);
}
export function kGrid(current: number): number[] {
  return withCurrent(K_BASE, current);
}
/** t-digest の δ(圧縮度) */
export function compressionGrid(current: number): number[] {
  return withCurrent(COMPRESSION_BASE, current);
}
export function alphaGrid(current: number): number[] {
  return withCurrent(ALPHA_BASE, current);
}
export function digitsGrid(current: number): number[] {
  return withCurrent(DIGITS_BASE, current);
}
