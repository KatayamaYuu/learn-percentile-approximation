# Brief: streaming-quantile-sketches

## Problem
メモリを制限してストリームから分位点を求める手法(GK、KLL、t-digest)は、保証の種類(順位誤差か、裾の精度か)が手法ごとに違う。式を読むだけでは違いが分からない。学習者本人が実装と実験で確かめたい。

## Current State
共通基盤(percentile-lab-core)が前提で、これらの sketch は未実装。

## Desired Outcome
- GK、KLL、t-digest がそれぞれ共通IFに従って実装されている。
- ε、圧縮パラメータ、データ件数を変えたときの誤差とメモリを計測できる。
- GK の順位誤差保証、KLL の確率的保証、t-digest の裾での精度の高さと保証の弱さを、実験結果で比較して説明できる。
- 挿入順序の影響(整列済み、逆順、ランダム)も確認できる。

## Approach
3つの手法を純粋な TypeScript で自前実装する。シード付き PRNG を使い、KLL のような確率的手法でも実験を再現可能にする。論文の定義を参照しつつ、学習用に内部状態(タプル、compactor、centroid)を観察できる形で公開する。

## Scope
- **In**:
  - GK(Greenwald-Khanna)
  - KLL
  - t-digest(スケール関数を含む)
  - 内部状態の観察用API
  - 誤差、メモリ、挿入順序の影響を測る実験データの出力
  - 実装のテスト
- **Out**:
  - 学習ページと可視化(percentile-lab-site が担当)
  - 分散環境でのマージ性能の厳密評価(概念説明に留める)
  - 相対誤差保証型(DDSketch、HDR Histogram)

## Boundary Candidates
- 手法ごとの実装(GK、KLL、t-digest は互いに独立)
- 内部状態の観察用API
- 順序依存性の実験

## Out of Boundary
- 厳密解、データ生成、誤差指標の定義(core が担当)
- ヒストグラム近似、DDSketch、HDR Histogram

## Upstream / Downstream
- **Upstream**: percentile-lab-core
- **Downstream**: percentile-lab-site

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: relative-error-sketches(誤差保証の種類が異なるので、横断比較の定義は site 側で揃える)

## Constraints
- 純粋な TypeScript で DOM 非依存。
- core の共通IFと誤差指標に従う。
- 論文実装の厳密な再現より、挙動の理解を優先する。
