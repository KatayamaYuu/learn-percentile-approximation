# Brief: histogram-percentile

## Problem
固定バケットのヒストグラムによる近似は監視系で広く使われるが、バケット幅や分布の形によって誤差がどう出るかを直感的に掴みにくい。学習者本人が実装と実験で確かめたい。

## Current State
共通基盤(percentile-lab-core)が前提で、ヒストグラム近似は未実装。

## Desired Outcome
- 固定幅と任意境界のバケットによるヒストグラム近似が実装されている。
- バケット内の線形補間で分位点を推定できる。
- バケット数、バケット幅、分布の形を変えたときの誤差を計測でき、裾やバケット境界付近で誤差が大きくなる理由を実験で説明できる。
- 計算量(挿入 O(1)、問い合わせ O(バケット数))とメモリを厳密解と比較できる。

## Approach
共通IFに従う純粋な TypeScript 実装とする。バケット境界の決め方(等幅、指数、事前指定)を差し替え可能にし、計測ハーネスで厳密解との誤差を測る。

## Scope
- **In**:
  - 固定バケットのヒストグラム(等幅、指数幅、任意境界)
  - 線形補間による分位点推定
  - 誤差と計算量の実験データの出力
  - 実装のテスト
- **Out**:
  - 学習ページと可視化(percentile-lab-site が担当)
  - 動的にバケットを調整する手法(t-digest 等は別spec)

## Boundary Candidates
- バケット境界の定義
- 挿入と問い合わせ
- 補間方式

## Out of Boundary
- 厳密解、データ生成、誤差指標の定義(core が担当)
- ストリーミング分位点、相対誤差保証型の実装

## Upstream / Downstream
- **Upstream**: percentile-lab-core
- **Downstream**: percentile-lab-site

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: relative-error-sketches(指数幅バケットが DDSketch と概念的に近いため、境界の定義を重複させない)

## Constraints
- 純粋な TypeScript で DOM 非依存。
- core の共通IFと誤差指標に従う。
