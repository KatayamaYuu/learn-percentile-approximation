# Research & Design Decisions

---
**Purpose**: 設計の根拠となった調査結果と、判断の経緯を記録する。

---

## Summary
- **Feature**: `percentile-lab-core`
- **Discovery Scope**: New Feature(グリーンフィールドのライブラリ。完全な調査を実施)
- **Key Findings**:
  - 実行時依存を持たずに実装できる。乱数は自前の sfc32 で足りる。
  - TypeScript 7.0.2 では typescript-eslint が使えない。型チェックは `tsc --noEmit` だけにする。
  - `Math.ceil(n * q)` は浮動小数点の誤差で順位がずれる(`0.1 × 10` など)。スナップ処理が必要である。
  - 順位誤差の定義には、推定値が実データにない場合の規定が要件にない。経験分布関数に基づく定義で補った。
  - 設計レビュー(2026-10-24)で、後続 spec が core の型を変えずに載るための補完を3点加えた。対応範囲外の値の拒否(`unsupported-value`)、推定値の定義域の検証(`invalid-estimate`)、実験条件の記録(`params`、`meta`)である。

## Research Log

### 乱数生成器(自前実装か既存ライブラリか)
- **Context**: シード付きの再現可能な乱数が要る(要件 1.8、2.9、3.4、7.4)。
- **Sources Consulted**: npm レジストリ(`pure-rand`、`seedrandom`)、サブエージェントの調査(2026-10-24)。
- **Findings**:
  - `pure-rand` 8.4.2: MIT、2026-07-10 更新、ESM と型あり、環境によらず決定的。
  - `seedrandom` 3.0.5: MIT、最終更新 2022-06。CJS で、型は別パッケージ。保守されていない。
  - 自前の mulberry32 / sfc32 / xoshiro128**: 約 15 行。整数演算だけで決定的。
- **Implications**: 学習用途で実行時依存を増やす理由がない。自前の sfc32 を採用し、既知の列をテストに固定する。

### ライセンスの確認ツール
- **Context**: 依存のライセンス一覧と判定が要る(要件 7.5)。
- **Findings**:
  - `license-checker` 25.0.1: 最終公開 2022-06。事実上保守されていない。
  - `license-checker-rseidelsohn` 5.0.1: 保守されているが Node 24 以上を要求する。4.4.2 は Node 18 以上で動く。
  - `license-report` 6.8.6: 保守されているが、許可リストで失敗させる機能は確認できていない。
- **Implications**: Node 22.12 を下限とするため、`license-checker-rseidelsohn` 4.4.2 を固定して使う。`--onlyAllow` で判定する。フラグは実装時に実際のツールの出力で確かめる。

### TypeScript 7.0 の設定と lint
- **Context**: TypeScript は 7.0.2 が最新で、ネイティブのコンパイラである。
- **Sources Consulted**: TypeScript 7.0 の告知記事(https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)。
- **Findings**:
  - `typescript` パッケージ自体がネイティブの `tsc` を提供する。`npx tsc --noEmit` で型チェックできる。
  - 7.0 の既定値の変更: `strict` が既定で有効、`types` の既定が空、`rootDir` の既定が `./`、`moduleResolution` の `node10` と `classic` は廃止。
  - typescript-eslint 8.72.0 の peer は `typescript >=4.8.4 <6.1.0` で、TypeScript 7 に未対応である。
- **Implications**: lint は導入せず、型チェックは `tsc --noEmit` のみとする。tsconfig には `types: ["node"]` と `lib: ["ES2023"]`(DOM なし)を明示する。DOM を含めない設定で、要件 7.1 を型チェックで機械的に守る。

### Vitest 5 と性質テスト
- **Findings**:
  - Vitest 5.0.5 は Node ^22.12 || ^24 || >=26、Vite ^6.4 || ^7 || ^8 を要求する。設定は `vite.config.ts` の `test` フィールドに置ける。
  - 破壊的変更(`clearMocks` の既定値、レポート出力先 `.vitest/` など)があるが、node 環境の単体テストには影響が小さい。
  - fast-check 4.10.2(MIT、保守されている)は、`fc.assert(fc.property(...))` を `it()` 内で使える。`@fast-check/vitest` は不要である。
- **Implications**: 性質テストに fast-check を開発時依存として採用する。シードを固定して再現できるようにする。`.vitest/` を `.gitignore` に追加する。

### 浮動小数点による順位のずれ
- **Findings**: `Math.ceil(10 * 0.1)` は 2 になる(`10 * 0.1 = 1.0000000000000002`)。`0.7 × 10 = 7.000000000000001`、`0.29 × 100 = 28.999999999999996` も同様にずれる。
- **Implications**: 最近傍の整数との差が `1e-9 × max(1, |x|)` 以内なら整数に丸めてから切り上げ・切り捨てをする。有理数で受け取る API(分子と分母の整数)も候補だが、呼び出しが煩雑になるため採用しない。補間は `lo + (hi - lo) × frac` の安定した形を使い、結果を `[lo, hi]` に収める。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 層構造のライブラリ(採用) | Foundation → Primitives → Domain → Harness → Entry の一方向依存 | 後続 spec が単一の入口に依存できる。各層を独立にテストできる | 層の数が多く見える | 小さなファイルに分け、1ファイル1責務を保つ |
| クラス継承による基底クラス | 共通の基底クラスから各アルゴリズムを派生 | 共通処理を再利用できる | 検証・計数の実装が継承に縛られ、テストが難しい | 採用しない。インターフェースと小さな補助部品で足りる |
| 単一ファイル | すべてを1ファイルにまとめる | 小さく見える | 後続 spec と並行して作業できない | 採用しない |

## Design Decisions

### Decision: 順位誤差における、推定値が実データにない場合の順位
- **Context**: 要件 4.3 は「推定値の順位」を使うが、近似アルゴリズムは実データにない値(補間値、バケット境界、中心値など)を返す。要件 4.5 は同値が複数あるときだけを規定している。
- **Alternatives Considered**:
  1. 推定値を最も近い実データの値に置き換えて順位を決める。
  2. 経験分布関数に基づき、推定値以下の値の個数を順位とする。
- **Selected Approach**: 2。推定値より小さい値の個数を `a`、推定値以下の値の個数を `b` とし、`b > a` なら範囲 `a + 1` から `b` に目標順位を収めた値、`b = a` なら `a` を順位とする。
- **Rationale**: 経験分布関数は順位誤差の標準的な定義と整合し、置き換え(案1)のように最近傍の選び方に依存しない。要件 4.5 の同値の扱いとも自然につながる。
- **Trade-offs**: 要件の文面に明示がない補完である。`error-metrics.md` に明記し、定義の変更は Revalidation Trigger とする。
- **Follow-up**: 後続 spec の設計時に、この定義で差し支えないか確認する。要件 4.3 に補足を入れる選択肢もある。

### Decision: 正規分布・多峰分布は平均を正に限り、棄却で正の値に限定する
- **Context**: 要件 3.3 は、0 以下を採用しない分布として扱うことを求める。パラメータによっては棄却が極端に多くなる。
- **Alternatives Considered**:
  1. 棄却のみで、パラメータは制限しない。
  2. 平均が正であることを要求し、棄却の期待回数を 2 以内にする。
  3. 絶対値を取る、または 0 付近で打ち切る。
- **Selected Approach**: 2。`mean > 0` を必須とする。
- **Rationale**: 棄却の効率が保証され、生成が必ず有限回で終わる。3 は分布の形をゆがめる。
- **Trade-offs**: 平均が 0 以下の正規分布は使えない。値が正の分布を学ぶ目的では支障がない。
- **Follow-up**: `distributions.md` に、平均を十分大きくすると本来の正規分布に近づくことを記す。

### Decision: ハーネスの基準値はアルゴリズムの外で計算する
- **Context**: 誤差の基準値を、厳密解のアルゴリズムで求めると、操作数に含まれてしまう。
- **Selected Approach**: 整列したコピーから、計数なしで `exactQuantileSorted` により求める。厳密解のアルゴリズムと同じ `resolvePosition` / `combineOrderStatistics` を共有する。
- **Rationale**: 比較対象の操作数を汚さず、2方式と基準値が同じ規則に従う。
- **Trade-offs**: 整列を1回余分に行うが、計測対象の外なので影響しない。

### Decision: 厳密解の整列は自前の併合整列で、計数付きにする
- **Context**: `Array.prototype.sort` は比較回数を数えられても、移動の回数を数えられない。
- **Selected Approach**: ボトムアップの併合整列を自前で実装し、比較と移動を数える。
- **Rationale**: 操作数の定義(比較と移動)を、整列と quickselect の両方で揃えられる。
- **Trade-offs**: 作業領域として整列中だけ同じ長さの配列が必要になる。見積もりには含めない旨を文書化する。

### Decision: 単純化 — 厳密解の基準を `SketchSpec` として公開し、別の基準 API は作らない
- **Context**: 後続 spec が基準値を使う方法を、増やしすぎない。
- **Selected Approach**: 公開するのは `PercentileSketch`、`SketchSpec`、ハーネス、`exactQuantileSorted` に絞る。オブザーバー、プラグイン登録、イベントなどの仕組みは作らない。
- **Rationale**: 現在の要件に必要な最小の設計に保つ。

### Decision: 値域内だがアルゴリズムが扱えない値を `unsupported-value` で拒否する
- **Context**: 設計レビューで指摘された。`SketchError` の `invalid-value` は core の値域(有限の正の数)の違反しか表せない。後続 spec の HDR Histogram には追跡できる上限があり、DDSketch には索引できる最小値がある。固定範囲のヒストグラムにも範囲外の値がある。どれも値域内だが拒否が必要である(要件 1.1、1.5、6.6)。
- **Alternatives Considered**:
  1. 後続 spec がそれぞれ `SketchError` に種別を足す。
  2. 例外を投げ、ハーネスに捕捉させる。
  3. 汎用の種別 `unsupported-value` を core に1つ用意し、受け付ける範囲を `SketchSpec.supportedRange` で宣言させる。
  4. 範囲外の値を端の値に丸めて受け付ける(クランプ)。
- **Selected Approach**: 3。`{ kind: 'unsupported-value'; detail: string }` を追加する。`supportedRange` の外の値だけをこの種別で拒否してよく、拒否後に状態を変えない。適合確認は、範囲の外の値が拒否されること、範囲の内の値が拒否されないことを確かめる。
- **Rationale**: 1 は core の型を変えるため、全 spec の再確認が要る。2 は「失敗は Result で返す」という方針から外れ、状態が変わっていないことを契約で保証できない。3 なら型を一度決めれば後続 spec は core を変えずに済み、範囲の宣言によって適合確認も機械的にできる。
- **Trade-offs**: 4 のクランプを使うかどうかは各アルゴリズムの選択として残る。クランプする実装は `supportedRange` を省略すればよい。ただしクランプは誤差の出方を変えるので、その spec の文書に書く必要がある。
- **Follow-up**: relative-error-sketches と histogram-percentile の設計で、`supportedRange` の値と、クランプするか拒否するかを決める。

### Decision: 推定値にも値域を課し、違反はハーネスが `invalid-estimate` として記録する
- **Context**: 設計レビューで指摘された。下端が 0 のバケットで線形補間すると、近似アルゴリズムは推定値 0 を返すことがある。誤差指標は要件 4.6 に従って `MetricError` を返すが、ハーネスがその場合にどうするかは決まっていなかった。結果に `NaN` が入ったり `QueryRecord` が欠けたりすると、要件 6.3 と 6.6 を守れない。
- **Alternatives Considered**:
  1. 誤差指標を緩め、推定値が 0 以下でも計算できるようにする(相対誤差は推定値が 0 でも定義できる)。
  2. 誤差の項目を `null` にした `QueryRecord` を記録し、計測を続ける。
  3. `query` の事後条件に「推定値は有限の正の数」を加え、違反はそのアルゴリズムのエラーとして記録する。
- **Selected Approach**: 3。ハーネスは推定値を `checkPositiveFinite` で検査する。違反があれば `status: 'error'`、`stage: 'query'`、`errorKind: 'invalid-estimate'` とし、次のアルゴリズムへ進む。
- **Rationale**: 1 は要件 4.6 と値域の統一に反する。2 では結果の型に `null` が混ざり、表示側の分岐が増える。3 は値域の規則を推定値にもそのまま当てはめるので、core の一貫性が保たれる。違反は適合確認でも早めに見つかる。
- **Trade-offs**: 1 つの分位点で違反があるだけで、そのアルゴリズムの結果は全部エラーになる。部分的な結果は残らないが、契約違反を目立たせる効果のほうが大きいと判断した。
- **Follow-up**: histogram-percentile の設計で、最初のバケットの下端を正の値にするか、推定値を最小の観測値以上に収めるかを決める。

### Decision: 実験条件を結果に記録する(`params`、`meta`)
- **Context**: 設計レビューで指摘された。roadmap の主な目的は、ε やバケット数を変えて誤差の変化を見ることである。しかし `SketchSpec` にも `BenchmarkResult` にもパラメータやデータの生成条件の欄がなく、保存した JSON からはどの条件の結果なのかがわからなかった(要件 6.3、6.4、6.7)。
- **Alternatives Considered**:
  1. 条件は `id` と `label` の文字列に埋め込む。
  2. `SketchSpec.params` と `BenchmarkInput.meta` を平坦な記録として加え、結果にそのまま写す。
  3. 2 に加えて、パラメータを軸にした系列化(`seriesByParam`)を core で提供する。
- **Selected Approach**: 2。値は有限の数、文字列、真偽値に限る。ハーネスは `meta` を解釈しない。パラメータを軸にした系列化はサイト基盤 spec が行う。
- **Rationale**: 1 は文字列を解析しないと系列を作れない。3 はどのパラメータを軸にするかが表示の都合で決まるので、core の責務から外れる。2 なら、保存した結果だけで条件を判別でき、表示側は自由に系列を組める。
- **Trade-offs**: `params` は `create` に閉じ込めた実際の値の写しなので、両者が食い違うおそれがある。各 spec が `SketchSpec` を作る関数の中で、同じ変数から両方を作るよう設計段階で定める。
- **Follow-up**: Web Worker で計測するときは、`SketchSpec` が関数を含むため `postMessage` で送れない。Worker の中で `id` と `params` から `SketchSpec` を作り直す登録表を、サイト基盤 spec が持つ前提とする。`params` はその再構築の鍵としても使える。

## Risks & Mitigations
- 操作数の計数が実装ごとにずれる — `cost-model.md` に数える箇所を例示し、適合確認で単調性と再現性を検査する。
- 乱数列の変更で保存済みの実験結果が再現できなくなる — known-answer テストで固定し、変更は Revalidation Trigger とする。
- ライセンスの許可リストが厳しすぎて開発時依存で失敗する — 失敗時に内容を確認してから許可リストを広げる。
- TypeScript 7 のツール互換性 — 型チェックは `tsc` のみに限る。lint を後で追加する場合は、typescript-eslint の対応状況を再確認する。
- `params` とアルゴリズムの実際の設定が食い違う — 各 spec の `SketchSpec` を作る関数で、同じ値から両方を作る。
- 近似アルゴリズムが推定値 0 を返して結果全体がエラーになる — 適合確認で推定値の定義域を検査し、ハーネスより前の段階で見つける。

## References
- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) — ネイティブ `tsc` と既定値の変更
- [Vitest 5 migration](https://v5.cn.vitest.dev/guide/migration/) — Vitest 5 の破壊的変更(公式ページの確認は未了)
- npm レジストリ: `pure-rand`、`seedrandom`、`license-checker-rseidelsohn`、`license-report`、`fast-check`、`vitest`、`vite`(2026-10-24 時点)
