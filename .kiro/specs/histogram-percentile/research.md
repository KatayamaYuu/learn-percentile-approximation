# Research & Design Decisions

## Summary
- **Feature**: `histogram-percentile`
- **Discovery Scope**: Extension(percentile-lab-core の上に載る新規アルゴリズムの追加。軽量な発見調査)
- **Key Findings**:
  - core は、アルゴリズムの契約(`PercentileSketch`、`SketchSpec`)、値域の宣言(`supportedRange`)、範囲外の拒否(`unsupported-value`)、操作数の規則、ハーネスでの範囲外の記録(`stage: 'insert'`)をすでに備えている。ヒストグラムは新しい契約を作らずにこれらへ従える。
  - 目標順位の丸め(`nearestRank`)は core が公開している。バケットの選択に同じ関数を使えば、誤差指標と同じ順位でバケットを決められ、浮動小数点のずれで「厳密値と別のバケットを選ぶ」ことを避けられる。
  - 外部の新規ライブラリは不要。線形補間つきの固定バケットは単純な算術であり、既存の依存(`vitest`、`fast-check`)だけで足りる。

## Research Log

### core が提供する契約と規則
- **Context**: ヒストグラムを共通規約に載せるとき、新しく決めるべきことと、すでに決まっていることを分ける。
- **Sources Consulted**: `src/core/index.ts`、`contract/sketch.ts`、`exact/sort-exact.ts`、`conformance/conformance.ts`、`harness/run-benchmark.ts`、`harness/run-sweep.ts`、`quantile/definitions.ts`、`docs/core/cost-model.md`、`docs/core/error-metrics.md`
- **Findings**:
  - `SketchSpec` は `id`、`label`、`params`、`supportedRange`、`create(seed)` を持つ。`params` は `isParamRecord`(有限の数・文字列・真偽値の平坦な記録)を満たす必要がある。配列は入れられない。
  - 範囲外の値は `unsupported-value` で拒否し、状態を変えない。`runConformance` は `supportedRange` の外側の値でこれを確かめる。
  - 操作数は比較と移動の 2 種。引数の検査、四則演算、添字の計算、ループの制御は数えない。移動は記憶領域の 1 要素への書き込みごとに 1。
  - メモリ見積もりは `(数値の個数 + カウンタの個数) × 8` バイトで、保持している状態だけから求める。
  - ハーネスは、投入でエラーを返したアルゴリズムを `status: 'error'`(`stage: 'insert'`、`errorKind` に `SketchError['kind']`)として記録し、残りを続行する。
  - `runSweep` は件数の異なる条件を昇順に並べ、`seriesByAlgorithm` は `id` ごとに系列化する。
  - `nearestRank(n, q)` は `ceil(snap(n × q))` を 1 以上 `n` 以下に収めた順位。`snapToInteger` は公開されていない。
- **Implications**:
  - 配列を含む境界の指定は `params` に入れられない。`params` には先頭と末尾の境界、バケット数、境界の決め方だけを入れる。
  - 範囲外の拒否は、`supportedRange` の宣言と `unsupported-value` の返却で足りる。実験側に救済を設けず、ハーネスの記録をそのまま使う(要件 5.6)。
  - 補間の連続順位に `n × q` を使うと、`snap` が使えず丸めのずれが出る。バケットの選択には公開されている `nearestRank` を使い、補間の割合の計算にだけ `n × q` を使って、範囲に `clamp` する。

### 補間式とバケットの選択
- **Context**: 要件 3.1 は「目標順位 `q × n` で、累積件数が初めて目標順位以上になるバケット」と定める。実装では、`q × n` が整数のとき(例: `0.07 × 100`)に浮動小数点のずれが選択を 1 バケット動かしうる。
- **Findings**:
  - `0.07 * 100 = 7.000000000000001`。そのまま比較すると、累積件数 7 のバケットではなく次のバケットが選ばれる。core の `nearestRank` は `snap` でこれを 7 に戻す。
  - 選択に `k = nearestRank(n, q)` を使い、補間の連続順位 `r = clamp(n × q, prev, cum)` を使えば、`q = 0` でも同じ式で扱える(`k = 1`、`r = 0`、`prev = 0`)。要件 3.3 の特別扱いが不要になる。
  - `q > 0` で `n × q` が整数でないとき、`ceil(n × q) = k` なので、要件の「累積件数が初めて `q × n` 以上」と `k` による選択は一致する。整数のときの差は丸めの問題だけで、要件の観察可能な振る舞いは変わらない。
- **Implications**: 設計は要件を満たしたまま、丸めに対して堅牢になる。要件 3.7(厳密値と同じバケット)の保証は、`k` と `nearestRank` の一致から導ける。

### 誤差の上限と「同じバケット」
- **Context**: 要件 3.7 は「最近順位法の厳密値と推定値が同じバケットに含まれる」と定める。バケットは半開区間である。
- **Findings**:
  - 補間の割合が 1 のとき、推定値は上側の境界に等しい。この点は半開区間の規則では次のバケットに属する。
  - 厳密値(整列後の `k` 番目)は選ばれたバケットの半開区間に属する。推定値は閉区間 `[lower_i, upper_i]` に属する。差は `upper_i − lower_i` 以下で、要件の目的(絶対誤差がバケット幅を超えない)は変わらない。
- **Implications**: 設計とテストでは「同じバケットの閉区間に収まる」を検証の述語にする。要件の文言との差は観察可能な振る舞いに現れないので、要件の再生成は不要と判断した。

### バケットの特定と比較の数え方
- **Context**: 要件 4.1 は等幅・指数幅の投入の操作数を、件数にもバケット数にも依存させない。4.2 は任意境界を対数オーダーまでとする。
- **Findings**:
  - 等幅・指数幅は、算術で添字を推定できる。ただし浮動小数点の誤差で、境界のごく近くでは 1 バケットずれうる。推定した添字を境界の配列と比べて補正し、比較を数えれば、正しさを保ったまま比較回数は一定の上限に収まる(ずれが 1 バケット以内なら最大 3 回)。
  - 任意境界は、境界の配列に対する二分探索で `ceil(log2 B)` 回以下。
  - 引数の検査(範囲外の拒否)は core の規則では数えない。範囲外の値は状態・操作数を変えずに拒否される。
- **Implications**: 計算で推定した添字を「そのまま信じる」実装にしない。補正の比較を数える。投入の移動は、バケット件数と総件数の 2 回。

### 指数幅と DDSketch の境界
- **Context**: ブリーフは、指数幅が DDSketch と概念的に近いため、境界の定義を重複させないよう求める。
- **Findings**: ここでの指数幅は、下限・上限・バケット数から決まる固定の等比の境界列であり、相対誤差の上限(γ)を入力に取らない。DDSketch は相対誤差 α から比 γ を決め、境界を事前に持たず動的に確保する。
- **Implications**: 指数幅の境界は `boundaries.ts` に閉じる。relative-error-sketches は独自に対数バケットを実装し、この境界を import しない。重複ではなく、目的が異なる別の定義として扱う。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 層構造の小さなライブラリ(採用) | 境界生成・補間・ヒストグラム・実験を別ファイルにし、依存方向を固定 | core と同じ形。境界と補間を単体でテストできる | ファイル数が増える | 6 つのソースファイルに収まる |
| 単一クラスにすべてを持つ | `Histogram` クラスに境界生成・特定・補間を内包 | ファイルが少ない | 境界の決め方の差し替えと補間の単体検証がしにくい | 要件 1.1 と 3.x の独立検証に不利 |
| 境界の戦略をインターフェースにする | `BoundaryStrategy` を差し替え可能な型にする | 将来の戦略追加に強い | 実装が 1 つずつしかなく、過剰な抽象になる | 判別共用体 `BucketScheme` で足りる |

## Design Decisions

### Decision: 範囲外の値は拒否する
- **Context**: 固定バケットは範囲の外の値を持てない。端のバケットに寄せる、境界を広げる、拒否する、の選択がある。
- **Alternatives Considered**:
  1. 範囲外を端のバケットに寄せる — 受け入れるが、端のバケットの誤差が説明できなくなる。
  2. 境界を自動で広げる — 動的な手法に近づき、この spec の対象外になる。
  3. 拒否する(`unsupported-value`) — core の契約に従い、誤差の出方が観察できる。
- **Selected Approach**: 3。`supportedRange` で範囲を宣言し、範囲外は拒否する。
- **Rationale**: 誤差の理由を実験で説明するという目的に合う。実験で範囲が足りないときは、ハーネスがエラーとして記録するので、範囲の設定の誤りに気づける。
- **Trade-offs**: 範囲の設定を呼び出し側が考える必要がある。`'data-extent'` を用意して、実験の手間を減らす。
- **Follow-up**: 文書に、範囲外を拒否する理由と `'data-extent'` の使い分けを書く。

### Decision: 件数の観察 API を設けない
- **Context**: ヒストグラムの棒グラフを描くには、バケットごとの件数が要る。
- **Alternatives Considered**:
  1. `bucketCounts()` を公開する — サイトの表示には便利。
  2. 公開しない — 要件にない。
- **Selected Approach**: 2。要件に含まれないため設けない。
- **Rationale**: 設計は最小にする。サイト基盤の spec が必要とした時点で、その要件とともに追加する。
- **Trade-offs**: 文書の「バケットあたりの件数が少ない」という説明は、テスト側で `buildBoundaries` と生成データから独立に数えて裏づける。
- **Follow-up**: `percentile-lab-site` の要件定義で必要になった場合は、再検討する(Revalidation Triggers に記録)。

### Decision: 実験は等幅・指数幅だけを対象にする
- **Context**: 任意境界は配列を含み、`params` や実験条件の平坦な記録に収まらない。
- **Selected Approach**: 実験の組み立ては `equal` と `exponential` に限る。任意境界は `histogramSpec` を直接 core のハーネスに渡して使う。
- **Rationale**: 実験の結果から条件を読み取れる(要件 5.3)ことと、任意境界の表現を両立させるため。
- **Trade-offs**: 任意境界の比較実験は、呼び出し側が `BenchmarkInput` を組む必要がある。

### Decision: `id` に範囲を含めない
- **Context**: `data-extent` では、件数ごとに範囲が変わる。`seriesByAlgorithm` は `id` で系列化する。
- **Selected Approach**: `id` は `histogram-<kind>-<B>`。範囲は `params` に入れる。
- **Trade-offs**: 同じ実験で `kind` と `B` が同じ別の境界を並べるときは、`options.id` を指定する必要がある。

## Risks & Mitigations
- 文書に載せる実験の主張が、実測と食い違う(例: 指数幅の相対誤差が常に有利とは限らない。高い分位点では、指数幅のバケットは等幅より粗くなりうる) — 先に固定のシードで実測し、結果から主張を書く。`docs-examples.test.ts` が文書の数値と実測の一致を確認する。
- 浮動小数点の丸めで、バケットの特定や補間が 1 バケットずれる — 補正の比較を数えて正しさを保つ。性質テストで境界ちょうどの値を重点的に確認する。
- 指数幅の `Math.pow` と `Math.log` が環境により最下位ビットで異なる — 端の境界を指定値そのままにし、等式ではなく性質で検証する。
- 実験の組み合わせが多く、実行に時間がかかる — 上限を設けず、呼び出し側の責任とする。重い実験は後続 spec が Web Worker に載せる。
- core の `nearestRank` の丸めが変わる — Revalidation Triggers に記録し、変更時に 3.7 の性質テストが検出する。

## References
- 要件: `.kiro/specs/histogram-percentile/requirements.md`
- 上流の設計: `.kiro/specs/percentile-lab-core/design.md`
- core の定義文書: `docs/core/cost-model.md`、`docs/core/error-metrics.md`、`docs/core/percentile-definitions.md`
