# Research & Design Decisions

## Summary
- **Feature**: `relative-error-sketches`
- **Discovery Scope**: Extension(percentile-lab-core の上に載る新規アルゴリズムの追加。軽量な発見調査。histogram-percentile の構成を手本にする)
- **Key Findings**:
  - core は、アルゴリズムの契約(`PercentileSketch`、`SketchSpec`)、値域の宣言(`supportedRange`)、範囲外の拒否(`unsupported-value`)、操作数の 2 種別(比較・移動)、メモリ見積もり(`estimateBytes`)、目標順位(`nearestRank`)、ハーネスでの投入エラーの記録(`stage: 'insert'`)をすでに備えている。DDSketch と HDR Histogram は新しい契約を作らずにこれらへ従える。
  - 共通規約は値を有限の正の数に限る。DDSketch の負の値・0 用のストア、HDR の 0 の扱いは不要になる。一方、DDSketch は値域の制限を宣言しないので、`Number.MAX_VALUE` 付近や非正規化数の付近で、境界や代表値があふれる・0 に落ちる問題を設計で扱う必要がある。
  - 推定の規則(目標順位のバケットを選び、その代表値を返す)は DDSketch と HDR で共通であり、バケットの走査を 1 つの部品にまとめられる。histogram-percentile は補間を行うが、この spec は補間しない(代表値で保証を得る手法なので)。
  - 外部ライブラリは使わない。学習目的で自前実装することがロードマップの決定であり、既存の `vitest`、`fast-check` だけで足りる。

## Research Log

### core と histogram-percentile が決めていること
- **Context**: 新しく決めるべきことと、既存の規約・手本に合わせることを分ける。
- **Sources Consulted**: `src/core/index.ts`、`contract/sketch.ts`、`cost/op-counter.ts`、`cost/memory-model.ts`、`foundation/errors.ts`、`foundation/validation.ts`、`quantile/definitions.ts`、`conformance/conformance.ts`、`harness/run-benchmark.ts`、`harness/run-sweep.ts`、`harness/types.ts`、`docs/core/cost-model.md`、`docs/core/error-metrics.md`、`src/histogram/*.ts`、`.kiro/specs/histogram-percentile/design.md`、`docs/histogram/experiments.md`
- **Findings**:
  - `SketchSpec.params` は `isParamRecord`(有限の数・文字列・真偽値の平坦な記録)を満たす必要がある。`Infinity` や配列は入れられない。
  - `runConformance` は、`supportedRange` がなければ 1〜1000 の固定 20 点、あれば範囲内の 20 点で確認する。範囲外(`min / 2`、有限なら `max × 2`)の拒否、`reset` 後の一致、同じシードでの一致、操作数の単調増加と `reset` 後の 0、メモリ見積もりが非負の有限数であることを調べる。
  - ハーネスは `create` を条件ごとに 1 回呼び、投入でエラーが出たアルゴリズムを `status: 'error'`、`stage: 'insert'` で記録して続行する。`params` と `meta` は `isParamRecord` で検査される。
  - 既定の基準の定義は `linear` である。最近順位法以外では、厳密値が 2 つの順序統計量の間の値になり、別々のバケットにまたがりうる。
  - histogram-percentile の構成: `src/histogram/` に `errors → boundaries → estimate → histogram → experiment → index` の一方向の依存、`xxxSpec()` が `Result<SketchSpec, SchemeError>` を返す、実験は `cases × counts` ごとに `generate` → `BenchmarkInput` → ケースごとに `runSweep`、結果は `{ schemaVersion: 1, cases: [{ label, sweep }] }`、文書は `docs/histogram/`、文書の数値は `docs-examples.test.ts` が再実行で確かめる。
  - histogram-percentile は「内部状態を観察する API」を持たない。この spec はブリーフの要求により観察 API を持つ。
- **Implications**:
  - ディレクトリ、依存方向、`Result` によるエラー、`xxxSpec()`、実験結果の形、文書と数値検証のテストの組を histogram-percentile と同じ形に揃える。
  - 相対誤差の上限の検証には、基準の定義に `nearest-rank` を指定する。実験の既定は core の既定(`linear`)のままにし、文書とテストで明示的に `nearest-rank` を渡す(histogram-percentile と同じ運用)。

### DDSketch の定義
- **Context**: 要件 1、2、4 の写像・代表値・縮約の規則を確定する。
- **Sources Consulted**: Masson, Rim, Lee, "DDSketch: A Fast and Fully-Mergeable Quantile Sketch with Relative-Error Guarantees", PVLDB 12(12), 2019。DataDog の参照実装(sketches-java、sketches-go)の `LogarithmicMapping`、`CollapsingLowestDenseStore` の公開ドキュメント。
- **Findings**:
  - `γ = (1 + α) / (1 − α)`。値 `x > 0` のバケット番号は `i = ceil(log_γ x)` で、バケットは `(γ^(i−1), γ^i]`。代表値 `2γ^i / (γ + 1)` は、区間の両端で相対誤差がちょうど `α` になり、内部ではそれ未満になる。
  - バケット数の上限 `m` を超えたら、最も小さい番号のバケット同士を合算する(collapsing lowest)。高い分位点の保証を残し、低い分位点の保証を捨てる。論文は、`x_max / x_q` が `γ^(m−1)` 程度に収まる分位点では保証が残ると示している。
  - 参照実装の既定の上限は 2048 である。参照実装の dense store は「最小番号から最大番号までの連続した範囲の長さ」を上限と比べる。
  - マージは、同じ `γ` のスケッチ同士なら、同じ番号のバケットの件数を足すだけでよい(完全にマージ可能)。
- **Implications**:
  - 保持するバケット数は「連続した範囲の長さ」で数える(要件 2.2)。疎な辞書ではなく連続配列のストアにする。
  - 既定の上限は 2048、防御的な上限は 100,000(histogram-percentile の `MAX_BUCKETS` と同じ値だが、import はせず独自に定義する)。

### HDR Histogram の定義
- **Context**: 要件 3 の副バケット数とバケット構造を確定し、実数値への拡張方法を決める。
- **Sources Consulted**: HdrHistogram(Java 実装)の `AbstractHistogram` の公開ドキュメントとソース(`subBucketCount`、`getBucketsNeededToCoverValue`、`countsArrayIndex`、`highestEquivalentValue`、`medianEquivalentValue`、`getValueAtPercentile`)。
- **Findings**:
  - 有効桁数 `d`(0〜5)から `subBucketCount = 2^ceil(log2(2 × 10^d))`。最初の区間は `0..subBucketCount−1` 単位を幅 1 単位で持ち、以降は 2 倍ごとの区間を `subBucketCount / 2` 個の副バケットで持つ。配列の長さは `(bucketCount + 1) × subBucketCount / 2`。
  - 元の実装は整数値を扱い、最小の識別単位は 2 のべき乗(`unitMagnitude`)に切り下げる。`highestTrackableValue >= 2 × lowestDiscernibleValue` を要求する。
  - `getValueAtPercentile` は、選ばれたバケットの「同値とみなす最大値」(`highestEquivalentValue`)を返す。平均の計算などでは中点(`medianEquivalentValue`)を使う。
- **Implications**:
  - 共通規約の値は実数なので、`u = floor(x / L)` で L 単位の整数に変換してから元の構造に載せる。L を 2 のべき乗に切り下げない(学習者が指定した L がそのまま解像度になる方が分かりやすい)。
  - 代表値は中点にする(下記の決定)。
  - 単位の数 `H / L` が有限で表せないと、`floor(x / L)` があふれる。要件 3.9 に「`H ÷ L` が有限の数で表せない」を加えた。

### 浮動小数点の端の扱い
- **Context**: DDSketch は値域の制限を宣言しない(要件 1.4)。推定値は常に有限の正の数でなければならない(要件 4.2)。
- **Findings**:
  - `x = Number.MAX_VALUE` のバケットの上側の境界 `γ^i` は `Number.MAX_VALUE` を超えうるため、`Math.pow` が `Infinity` になる。代表値 `2γ^i / (γ + 1)` も、`γ^i` が有限でも `Number.MAX_VALUE` を超えうる。
  - 非正規化数(約 `2.2e−308` 未満)では有効桁が減り、境界・代表値の計算の精度が落ちる。`γ^(i−1)` は 0 に落ちうる。
  - `ceil(log(x) / log(γ))` は、境界のごく近くで 1 だけずれうる。
- **Implications**:
  - 上側の境界と代表値を `Number.MAX_VALUE` 以下に、代表値を `Number.MIN_VALUE` 以上に収める。`x <= Number.MAX_VALUE` なので、上限への切り詰めは相対誤差を増やさない。
  - 番号は計算で推定したあと、計算した境界と比べて補正する(histogram-percentile の `refine` と同じ考え方)。補正の比較は操作数に数える。
  - 非正規化数の範囲では、保証が丸めの範囲で破れうることを文書とテストの前提に書く。性質テストの入力は正規化数の範囲に限る。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 層構造のライブラリ(採用) | 写像(純粋)→ ストア → 推定 → sketch → 実験 → 入口の一方向の依存 | histogram-percentile と同じ形で読める。写像とストアを単体で検証できる | ファイル数が増える | 依存方向はレビューで検査する |
| 手法ごとに 1 ファイル | `ddsketch.ts` と `hdr.ts` に写像・状態・推定をすべて入れる | ファイルが少ない | 写像を sketch なしで計算する要件(1.5、3.8)が満たしにくい。推定の走査が重複する | 不採用 |
| 汎用の「写像 + ストア」抽象 | 1 つの sketch 実装に、写像を差し替えて DDSketch と HDR を作る | 重複が最小 | HDR は固定長配列で縮約がなく、DDSketch は可変範囲と縮約がある。共通化すると片方にない概念が漏れる | 共通化は推定の走査だけに留める |

## Design Decisions

### Decision: 推定の規則を両手法で共通にし、走査だけを共有する
- **Context**: 要件 4.1 は両手法に同じ推定規則を課す。
- **Alternatives Considered**:
  1. 手法ごとに推定を実装する
  2. 「件数列から目標順位のスロットを選ぶ」関数だけを共有する
  3. 写像とストアを抽象化した 1 つの sketch にする
- **Selected Approach**: 2。`selectSlot(counts, total, quantile, counter)` が、`nearestRank` で目標順位を決め、先頭から累積件数が初めて目標順位以上になるスロットの位置を返す。代表値への変換は各 sketch が自分の写像で行う。
- **Rationale**: 目標順位の丸めと比較の数え方を 1 か所で決められる。写像やストアの違いは各 sketch に閉じる。
- **Trade-offs**: 小さな部品が 1 つ増える。
- **Follow-up**: `0.07 × 100` など丸めの境目で、厳密値と同じスロットを選ぶことを単体テストで確かめる。

### Decision: HDR の代表値は中点にする
- **Context**: 要件 3.3、3.4、4.6。元の実装の百分位の問い合わせは、バケットの上端(`highestEquivalentValue`)を返す。
- **Alternatives Considered**:
  1. 上端(元の実装と同じ): 相対誤差の上限は `2 / S`(≒ `10^−d`)
  2. 中点(`medianEquivalentValue`): 相対誤差の上限は `1 / S`(≒ `10^−d / 2`)
- **Selected Approach**: 2。
- **Rationale**: DDSketch も区間の中で誤差が両側に均等になる代表値を使う。同じ考え方で揃えると、比較のときに「保証の差」が代表値の選び方の差と混ざらない。元の実装との違いは文書に明記する。
- **Trade-offs**: 元の HdrHistogram の出力とは一致しない。
- **Follow-up**: `docs/relative-error/hdr-histogram.md` に、上端を返す元の実装との違いと、上限が 2 倍になることを書く。

### Decision: DDSketch のストアは「保持範囲ちょうどの長さ」の連続配列にする
- **Context**: 要件 2.2(範囲の長さで数える)、7.1、7.2(範囲内の投入は一定、拡張・縮約は上限 m に比例)、7.5(メモリは範囲の長さで決まる)。
- **Alternatives Considered**:
  1. 疎な辞書(番号 → 件数)
  2. 容量を倍々に増やす連続配列(余白あり)
  3. 範囲が変わるたびに範囲ちょうどの長さで作り直す連続配列
- **Selected Approach**: 3。範囲が広がるとき、既存の件数を新しい配列にコピーし、コピー 1 件ごとに移動を 1 回数える。縮約は、縮約される件数を合計して 1 つのバケットへ書き込み、残る件数をコピーする。
- **Rationale**: 費用の上限(1 回あたり `m + 2` の移動)が明確で、文書で説明しやすい。辞書は操作数の数え方が実装依存になる。倍々の配列は下側への拡張でずらしが必要になり、規則が複雑になる。
- **Trade-offs**: 昇順の入力では、範囲が広がるたびにコピーが起きる。合計は `O(m^2)`(`m = 2048` で約 400 万回)に収まり、学習用途では許容する。
- **Follow-up**: 昇順・降順・ランダムの入力で、1 回あたりの移動が `m + 2` 以下であることを費用のテストで確かめる。

### Decision: 範囲より下への投入で範囲を超える場合も「縮約」として記録する
- **Context**: 要件 2.4、2.7。
- **Selected Approach**: 値を範囲の長さが m を超えない最小番号(`最大番号 − m + 1`)のバケットに数え、縮約の回数を 1 増やし、縮約の影響を受けた値の上限を、そのバケットの上側の境界との大きい方に更新する。
- **Rationale**: どちらの場合も「本来のバケットより大きい番号に数えられた値」が生まれ、そのバケットに入る分位点の保証が失われる。観察する側から見て同じ現象なので、同じ記録にまとめる。

### Decision: 実験は両手法を同じ条件に並べ、バケットの統計を別の配列で返す
- **Context**: 要件 8.2(core の結果の形式のまま)と 8.3(バケット数、縮約の有無)。core の `AlgorithmResult` には、バケット数を入れる場所がない。
- **Alternatives Considered**:
  1. `params` にバケット数を入れる(`params` は作成時に決まるので、投入後の値は入れられない)
  2. core の結果を拡張する(core の所掌を侵す)
  3. 同じデータを観察用の sketch にもう一度投入し、`inspect()` の結果を別の配列で返す
- **Selected Approach**: 3。各ケースの結果を `{ label, sweep, bucketStats }` とする。`bucketStats` は、件数と sketch の識別子で core の結果と対応づける。
- **Rationale**: core の結果の形式を変えずに、決定的な再投入で同じ状態を得られる(乱数を使わないため)。
- **Trade-offs**: 投入の計算が 2 回になる。実験の実行時間は増えるが、操作数の計測には影響しない(観察用の sketch の操作数は使わない)。

## Synthesis Outcomes
- **Generalization**: 推定の規則は両手法で同じ「目標順位のバケットの代表値」である。走査を `selectSlot` に一般化し、代表値の計算は写像の側に残した。写像(`LogMapping`、`HdrLayout`)は「値 → 番号」「番号 → 下側・上側の境界・代表値」という同じ形の契約を持つが、HDR は番号の総数が固定、DDSketch は無制限という違いがあるため、共通の型は導入しない(同じ形の名前に揃えるだけにする)。
- **Build vs. Adopt**: npm には DDSketch(`@datadog/sketches-js`)と HdrHistogram(`hdr-histogram-js`)の実装がある。ロードマップの方針(アルゴリズムの中身を自分で書いて読む、操作数を共通規則で数える)と合わないため採用しない。参照実装は、定義の確認だけに使う。
- **Simplification**: 0 と負の値のストア、HDR の自動範囲拡張、マージ API、DDSketch の写像の近似版(線形補間による対数の近似)は、要件にないため設けない。

## Risks & Mitigations
- 対数と累乗の浮動小数点誤差で、境界のごく近くの値の番号がずれる — 推定した番号を計算した境界と比べて補正し、写像の内部で一貫させる。テストでは境界の値そのものの等式ではなく、`lowerBound(i) < x <= upperBound(i)` の性質を確かめる。
- `Math.log`、`Math.pow` の結果が実行環境で最下位ビットだけ違いうる — 文書の数値は有効数字 3 桁で示し、テストは相対許容誤差で比べる。誤差の上限の検証は `α × (1 + 1e−9)` の許容幅で行う。
- DDSketch の範囲が極端に広い入力(`Number.MIN_VALUE` と `Number.MAX_VALUE` の混在)で、範囲の長さが上限 m に張り付き縮約が続く — 仕様どおりの挙動として扱い、観察 API で見えるようにする。
- 実験の組み合わせ(`cases × counts × (2 + alphas × maxBucketsList + significantDigitsList)`)が多いと時間がかかる — 上限は設けず、呼び出し側の責任とする(histogram-percentile と同じ)。

## References
- Masson, C., Rim, J. E., Lee, H. K. "DDSketch: A Fast and Fully-Mergeable Quantile Sketch with Relative-Error Guarantees." PVLDB 12(12), 2019 — 写像、代表値、縮約、マージの定義。
- DataDog sketches-java / sketches-go(Apache-2.0)— `LogarithmicMapping`、`CollapsingLowestDenseStore`、既定の上限 2048 の確認に使う(依存には加えない)。
- HdrHistogram(Java, CC0 / BSD-2-Clause)— `subBucketCount`、バケット数、配列の添字の計算、`getValueAtPercentile` の振る舞いの確認に使う(依存には加えない)。
- `.kiro/specs/percentile-lab-core/design.md`、`.kiro/specs/histogram-percentile/design.md` — 共通規約と手本の構成。
