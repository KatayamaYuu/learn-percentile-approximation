# Roadmap

## Overview
系列(数値データ列)からパーセンタイル値を導出するアルゴリズムについて、計算効率と誤差の出方を学ぶためのインタラクティブな学習サイトを作る。厳密解、固定バケットのヒストグラム近似、ストリーミング分位点(GK / KLL / t-digest)、相対誤差保証型(DDSketch / HDR Histogram)の4系統を扱う。

すべてのアルゴリズムを TypeScript で自前実装し、ブラウザ上で動かす。分布、データ件数、バケット数、ε などをスライダーで変えながら、誤差・操作数・メモリがどう変わるかをグラフで確認できるようにする。読者は作者本人で、理解を深めるための学習記録として使う。

## Approach Decision
- **Chosen**: 案B。TypeScript + Vite の静的サイトで、共通コアと系統別の学習モジュールに分割する。可視化は Chart.js 4.x(tree-shaking で必要部品のみ登録)、テストは Vitest、UIフレームワークは使わない。
- **Why**: 学習記録が目的なので、実装の中身を自分で書いて読めることと、パラメータを動かして誤差の出方を体感できることが最も効く。ブラウザ内で完結するため配布も静的ホスティングだけで済む。コアが固まれば各系統を独立に進められる。
- **Rejected alternatives**:
  - 案A(単一specで素朴に実装): タスクが20件を超えやすく、系統ごとの独立レビューや差し替えができない。
  - 案C(Pythonで計算しWebは表示のみ): スライダーで即座に結果が変わる操作ができず、既存ライブラリの呼び出しになってアルゴリズムの中身が学べない。

## Scope
- **In**:
  - 厳密解(sort / quickselect)、固定バケットヒストグラム近似(線形補間)、GK、KLL、t-digest、DDSketch、HDR Histogram
  - データ分布ジェネレータ(一様、正規、対数正規、重い裾、多峰など)
  - 誤差(絶対・順位・相対)、操作数、メモリ使用量の計測
  - 系統別の学習ページと横断比較ビュー
- **Out**:
  - サーバーサイド実装、永続化、ユーザー認証
  - 本番用ライブラリとしての公開・npm配布
  - 分散環境でのマージ性能の厳密評価(sketch のマージは概念説明に留める)
  - 日本語以外の多言語対応

## Constraints
- Node.js 22.12 以上に固定する(`engines` と `.nvmrc`)。Vite 8 は ^20.19 || >=22.12、Vitest 5 は ^22.12 || ^24 || >=26 を要求する。
- TypeScript 7 系を使う場合は、型チェックと lint のツールが対応しているか確認する。問題があれば 5.x / 6.x に固定する。
- 依存ライブラリは MIT / Apache-2.0 等の許容ライセンスのみ。導入後に `license-checker` で推移的依存も確認する。
- アルゴリズム実装は DOM に依存しない純粋な TypeScript とし、Vitest の node 環境でテストできるようにする。重い計算は Web Worker に逃がせる構造にする。
- 解説文などのドキュメントは日本語で書く。

## Boundary Strategy
- **Why this split**: 共通の計測基盤(データ生成、誤差・計算量の測定、アルゴリズム共通IF)を先に1つのspecに集約し、アルゴリズム系統は互いに依存しない3つのspecに分ける。これにより系統ごとに独立して実装・レビューでき、サイト基盤は最後に統合に専念できる。
- **Shared seams to watch**:
  - アルゴリズム共通インターフェース(挿入、分位点問い合わせ、メモリ見積もり、操作数カウント)
  - 誤差指標の定義(絶対誤差、順位誤差、相対誤差)を各系統で統一すること
  - 操作数・メモリ計測の方法(計測フックの置き場所)
  - サイト基盤が各系統のページを取り込むための登録方法

## Specs (dependency order)
- [x] percentile-lab-core -- アルゴリズム共通IF、データ分布ジェネレータ、誤差・操作数・メモリ計測、厳密解(sort / quickselect)。Dependencies: none
- [x] histogram-percentile -- 固定バケットのヒストグラム近似と線形補間、バケット幅と誤差の関係。Dependencies: percentile-lab-core
- [ ] streaming-quantile-sketches -- GK、KLL、t-digest の実装と、ε・圧縮パラメータと誤差の関係。Dependencies: percentile-lab-core
- [ ] relative-error-sketches -- DDSketch と HDR Histogram の実装と、相対誤差保証の挙動。Dependencies: percentile-lab-core
- [ ] percentile-lab-site -- サイト基盤、各系統の学習ページ、横断比較ビュー。Dependencies: percentile-lab-core, histogram-percentile, streaming-quantile-sketches, relative-error-sketches
