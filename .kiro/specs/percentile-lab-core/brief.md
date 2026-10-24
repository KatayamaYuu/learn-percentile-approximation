# Brief: percentile-lab-core

## Problem
パーセンタイル近似アルゴリズムを比較して学ぶには、同じ入力で同じ指標を測れる共通の土台が要る。土台がないと系統ごとに誤差の定義や計測方法がずれ、結果を比較できない。学習者本人が困る。

## Current State
リポジトリにはまだコードがない(グリーンフィールド)。

## Desired Outcome
- すべてのアルゴリズムが従う共通インターフェースがある。
- 再現可能なデータ分布ジェネレータがある。
- 誤差、操作数、メモリを統一した定義で測れる。
- 基準となる厳密解(sort、quickselect)が実装され、計算量の違いを実測できる。
- 以上が DOM に依存せず、Vitest でテストできる。

## Approach
TypeScript の純粋なモジュール群として実装する。Vite と Vitest のプロジェクト雛形もこのspecで作る。乱数はシード指定可能な PRNG を使い、実験を再現可能にする。

## Scope
- **In**:
  - プロジェクト雛形(Vite、TypeScript、Vitest、Node 22.12+ 固定)
  - 共通IF(挿入、分位点問い合わせ、メモリ見積もり、操作数カウント)
  - データ分布ジェネレータ(一様、正規、対数正規、重い裾、多峰など)
  - 誤差指標(絶対誤差、順位誤差、相対誤差)と計測ハーネス
  - 厳密解(sort ベース、quickselect)と定義の違い(補間方式)の整理
- **Out**:
  - 近似アルゴリズム本体
  - UI、グラフ描画

## Boundary Candidates
- アルゴリズム共通IFと計測フック
- データ生成(シード付きPRNGと分布)
- 誤差指標と計測ハーネス
- 厳密解の実装

## Out of Boundary
- ヒストグラム、GK、KLL、t-digest、DDSketch、HDR Histogram の実装
- 学習ページや可視化

## Upstream / Downstream
- **Upstream**: なし
- **Downstream**: histogram-percentile、streaming-quantile-sketches、relative-error-sketches(共通IFと計測基盤を利用)、percentile-lab-site

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: なし

## Constraints
- Node.js 22.12 以上。
- 純粋な TypeScript で DOM 非依存。
- ライセンスは MIT / Apache-2.0 等の許容範囲。
- TypeScript 7 と lint / 型チェックツールの対応を確認する。
