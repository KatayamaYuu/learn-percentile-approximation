# Brief: relative-error-sketches

## Problem
レイテンシ計測では、値の大きさに対する相対誤差を保証する手法(DDSketch、HDR Histogram)が実用される。順位誤差型の sketch とは保証の意味が違い、どちらがどの場面に向くかを掴みにくい。学習者本人が実装と実験で確かめたい。

## Current State
共通基盤(percentile-lab-core)が前提で、これらの手法は未実装。

## Desired Outcome
- DDSketch と HDR Histogram(有効桁数ベースのバケット構造)が共通IFに従って実装されている。
- 相対誤差の許容値 α(DDSketch)や有効桁数(HDR)を変えたときの誤差、バケット数、メモリを計測できる。
- 対数マッピングによる相対誤差保証が、値の範囲によらず成り立つことを実験で確認できる。
- 順位誤差型の sketch と比べて、どの分布・分位点で有利か不利かを説明できる。

## Approach
純粋な TypeScript で自前実装する。DDSketch は対数マッピングによるバケット化とバケット数上限時の縮約を扱う。HDR Histogram は有効桁数に基づくバケット構造を扱う。内部のバケット状態を観察できる形で公開する。

## Scope
- **In**:
  - DDSketch(対数マッピング、バケット数上限時の縮約)
  - HDR Histogram(有効桁数ベース)
  - 内部状態の観察用API
  - 相対誤差、バケット数、メモリの実験データの出力
  - 実装のテスト
- **Out**:
  - 学習ページと可視化(percentile-lab-site が担当)
  - 分散環境でのマージ性能の厳密評価(概念説明に留める)
  - 順位誤差型の sketch

## Boundary Candidates
- DDSketch の実装
- HDR Histogram の実装
- 値マッピング(対数、有効桁数)の定義
- 内部状態の観察用API

## Out of Boundary
- 厳密解、データ生成、誤差指標の定義(core が担当)
- 固定バケットのヒストグラム近似(histogram-percentile が担当)
- GK、KLL、t-digest

## Upstream / Downstream
- **Upstream**: percentile-lab-core
- **Downstream**: percentile-lab-site

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: histogram-percentile(指数幅バケットとの概念的な近さ。境界の定義は重複させない)、streaming-quantile-sketches

## Constraints
- 純粋な TypeScript で DOM 非依存。
- core の共通IFと誤差指標に従う。
