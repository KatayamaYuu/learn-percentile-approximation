# Brief: percentile-lab-site

## Problem
各アルゴリズムの実装があっても、パラメータを動かしながら誤差と計算量の変化を見られなければ学習にならない。系統をまたいだ比較もできない。学習者本人が困る。

## Current State
core と3つのアルゴリズム系統のspecが完了している前提で、サイト基盤、学習ページ、可視化は未実装。

## Desired Outcome
- ブラウザで開ける静的サイトがあり、系統別の学習ページ(厳密解とヒストグラム、ストリーミング分位点、相対誤差型)がある。
- 各ページで分布、件数、パラメータをスライダーで変え、誤差・操作数・メモリのグラフがその場で更新される。
- 横断比較ビューで、同じデータに対して複数アルゴリズムの誤差、メモリ、速度を並べて比較できる。
- 各アルゴリズムの要点(定義、保証、計算量、向き不向き)が日本語で解説されている。

## Approach
Vite の静的サイトとして構築し、UIフレームワークは使わない。Chart.js 4.x を tree-shaking して使い、対数軸、誤差のパラメータ依存グラフ、CDF 表示に対応する。重い計算は Web Worker に逃がし、スライダー操作中も UI を止めない。ホスティングは静的配信のみ(GitHub Pages 等を想定)。

## Scope
- **In**:
  - サイト基盤(ルーティングまたはページ構成、共通レイアウト、ビルド設定)
  - 系統別の学習ページと解説文
  - パラメータ操作UIと Chart.js による可視化
  - 横断比較ビュー
  - Web Worker による計算の分離
  - アクセシビリティと基本的なレスポンシブ対応
- **Out**:
  - アルゴリズム実装とその単体テスト(各系統のspecが担当)
  - サーバーサイド機能、永続化、ユーザー認証
  - 日本語以外の多言語対応

## Boundary Candidates
- ページ構成と共通レイアウト
- 可視化コンポーネント(グラフ、パラメータ操作)
- Worker 経由の実験実行
- 横断比較ビュー

## Out of Boundary
- 各アルゴリズムの実装と誤差指標の定義
- 新しいアルゴリズムの追加

## Upstream / Downstream
- **Upstream**: histogram-percentile、streaming-quantile-sketches、relative-error-sketches(および間接的に percentile-lab-core)
- **Downstream**: なし

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: 各アルゴリズムspec(実験データの出力形式を揃える。各系統のページ登録方法は共通IF側で決める)

## Constraints
- Node.js 22.12 以上。
- Chart.js 4.x は使う部品だけ登録して bundle を小さくする。
- ライセンスは MIT / Apache-2.0 等の許容範囲。
