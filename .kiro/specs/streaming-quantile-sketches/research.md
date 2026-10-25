# Research & Design Decisions

## Summary
- **Feature**: `streaming-quantile-sketches`
- **Discovery Scope**: Extension(percentile-lab-core の上に新しいアルゴリズム系統を足す。外部依存は追加しない)。アルゴリズム自体は新規実装なので、論文の定義の確認を合わせて行った。
- **Key Findings**:
  - core の `PercentileSketch` は「エラー時は状態を変えない」ことだけを求め、成功した問い合わせで状態が変わることは禁じていない。t-digest の問い合わせ時のまとめ(バッファの統合)は契約の範囲内で、適合確認の手順(拒否の直前・直後で操作数とメモリを読む)とも衝突しない。
  - core の順位誤差は `nearestRank(n, q)` を目標順位とし、重複値は推定値の順位を目標に最も近づける。GK と KLL の問い合わせも同じ目標順位を使えば、GK の保証「順位誤差 ≤ ε」を core の指標でそのまま検証できる。
  - histogram-percentile は「`src/<系統>/index.ts` を唯一の入口」「`xxxSpec()` が `Result<SketchSpec, 独自エラー>` を返す」「実験は core の `generate` と `runSweep` を呼び、厳密解 2 方式と並べる」「`docs/<系統>/` の数値を `docs-examples.test.ts` で検証する」という形を確立している。この spec も同じ形に揃える。

## Research Log

### core の共通契約と計測フック
- **Context**: 3 手法を core の規約・誤差指標・計測ハーネスに載せるため。
- **Sources Consulted**: `src/core/contract/sketch.ts`、`src/core/cost/op-counter.ts`、`src/core/cost/memory-model.ts`、`src/core/conformance/conformance.ts`、`src/core/harness/run-benchmark.ts`、`src/core/harness/types.ts`、`src/core/metrics/error-metrics.ts`、`src/core/quantile/definitions.ts`、`src/core/rng/sfc32.ts`、`src/core/data/generate.ts`、`.kiro/specs/percentile-lab-core/design.md`
- **Findings**:
  - `PercentileSketch` は `insert`、`query`、`memoryBytes`、`operationCounts`、`reset` の 5 操作。`reset` は乱数列も作成直後に戻す(適合確認 `reset-restores-initial-state` が、reset 後に同じ入力を入れ直した結果を新規作成と比べる)。
  - `SketchSpec.create(seed)` は `BenchmarkInput.seed` を受け取る。ハーネスは `create` の例外を `stage: 'create'`、`errorKind: 'exception'` として記録する。
  - `OperationCounter` は比較(値と値、区切り値を含む大小比較)と移動(1 要素への書き込み)だけを数える。histogram は「累積件数が k 以上か」を比較 1 回と数えている。
  - `estimateBytes({ numbers, counters })` は (数値 + カウンタ) × 8 バイト。厳密解は保持件数(容量ではない)で数える。
  - ハーネスは投入後と問い合わせ後のメモリ見積もりを記録し、問い合わせごとの操作数の増分を記録する。ピークのメモリは記録しない。
  - `generate` は乱数を標本ごとに消費し、並べ替えでは消費しない。同じシードなら `random`、`ascending`、`descending` は同じ値の集まりを並べ替えたものになる。
  - `createRng(seed)` は 0 以上 2^32 未満の整数だけを受け付け、`nextIntBelow(2)` で偏りのない 0/1 を返す。
- **Implications**: KLL は `createRng` をそのまま使う。順序の実験は `generate` の `order` を変えるだけで「同じ値の集まり」の条件を満たせる。試行のシードは `BenchmarkInput.seed` に入れ、データのシードは `meta` に記録する。

### histogram-percentile の構成
- **Context**: モジュール・文書・テストの置き方を揃えるため。
- **Sources Consulted**: `src/histogram/*.ts`、`docs/histogram/*.md`、`.kiro/specs/histogram-percentile/design.md`
- **Findings**:
  - `src/histogram/index.ts` だけが公開入口で、内部補助関数は再エクスポートしない。core は `src/core/index.ts` からだけ import する。
  - エラーは `{ kind: 'invalid-scheme'; field; reason }` のような判別可能な型で、`reason` は分岐に使わない。実験エラーは `SchemeError | invalid-experiment | generate | harness`。
  - `histogramSpec` は id に範囲を含めず、`seriesByAlgorithm` で件数をまたいだ系列が分断されないようにしている。
  - 実験は `cases × counts` ごとに `generate` → `SketchSpec` 列挙(厳密解 2 方式 + 対象)→ ケースごとに `runSweep`。`meta` は平坦な記録。結果は `{ schemaVersion: 1, cases: [{ label, sweep }] }`。
  - 文書の数値は先に実測し、`docs-examples.test.ts` が文書の表の行を読み取って実装の出力と比べる。
- **Implications**: `src/streaming/` と `docs/streaming/` を同じ形で作る。実験結果の各要素に挿入順序 `order` を足す以外は、histogram と同じ構造にする。

### GK(Greenwald-Khanna 2001)
- **Context**: 決定的な順位誤差の保証を、簡潔な実装で再現するため。
- **Sources Consulted**: M. Greenwald, S. Khanna, "Space-Efficient Online Computation of Quantile Summaries", SIGMOD 2001。広く使われる簡略版(バンドを使わない圧縮)の実装例。
- **Findings**:
  - 要素はタプル `(v, g, Δ)`。`rmin_i = Σ_{j≤i} g_j`、`rmax_i = rmin_i + Δ_i`。不変条件 `g_i + Δ_i ≤ max(1, ⌊2εn⌋)` が保たれれば、任意の目標順位 r に対し順位の誤差 εn 以内の値を返せる。
  - 挿入時の Δ は、論文では `⌊2εn⌋`、多くの実装では後続タプルの `g + Δ − 1`。後者は不変条件を保ったまま Δ を小さくでき、新しい最小値・最大値は Δ = 0。
  - 論文の圧縮はバンド(Δ の大きさによる階層)を使って空間 O((1/ε) log(εn)) を証明する。簡略版は「`g_i + g_{i+1} + Δ_{i+1} ≤ ⌊2εn⌋` なら i を i+1 に併合」を右から走査するだけで、誤差の保証は同じだが、空間の上限は証明されない(実測では同程度)。
  - 圧縮は ⌊1/(2ε)⌋ 件ごとに行うのが一般的。
- **Implications**: 簡略版を採用し、簡略化と保証への影響(誤差の保証は保たれ、空間の上限は証明されない)を文書に書く(8.6)。先頭(最小値)のタプルは併合しない、最後(最大値)のタプルは併合先にしかならない、とすることで最小値・最大値を正確に保つ(1.4)。

### KLL(Karnin, Lang, Liberty 2016)
- **Context**: 確率的な保証と、そのばらつきを観察できる形で実装するため。
- **Sources Consulted**: Z. Karnin, K. Lang, E. Liberty, "Optimal Quantile Approximation in Streams", FOCS 2016。Apache DataSketches の KLL の解説(既定 k = 200、最小 k = 8、c = 2/3)。
- **Findings**:
  - 段 h の要素の重みは 2^h。段 h の容量は `k × c^(H−1−h)`(H は段数、c = 2/3)で、上の段ほど大きい。容量を超えた段を整列し、乱数で偶数番目か奇数番目を選んで上の段に送る(compaction)。
  - 段の要素数が奇数のときは 1 個を残せば、重みの合計が保たれる。
  - 容量の合計は等比級数で `k / (1 − c) = 3k` に段数分の下限を足した程度に収まる。
  - 正規化順位誤差は O(1/k) で、確率 1 − δ の保証。DataSketches は k = 200 で単一の分位点の正規化順位誤差を約 1.65%(信頼度 99%)と案内している。これは参考値であり、この spec では定数を保証として扱わない。
- **Implications**: 1 回の投入で最大 1 回の compaction(容量の合計を超えたときだけ)という怠惰な方式を採る。保証は文書と複数試行の実験で示し、テストでは固定シードの集合で緩い上限を確認する。段の下限容量は 2 とする。

### t-digest(Dunning, Ertl 2019)
- **Context**: スケール関数による裾の精度と、保証の弱さを示すため。
- **Sources Consulted**: T. Dunning, O. Ertl, "Computing Extremely Accurate Quantiles Using t-Digests", arXiv:1902.04023。T. Dunning, "The t-digest: Efficient estimates of distributions", Software Impacts 2021。参照実装(MergingDigest)の構成。
- **Findings**:
  - スケール関数: `k0(q) = δq/2`(大きさ一定)、`k1(q) = (δ/2π) asin(2q − 1)`(裾で小さい)、`k2(q) = (δ/Z(n)) log(q/(1−q))`、`Z(n) = 4 log(n/δ) + 24`(裾でさらに小さい)。centroid の区間 `[q_left, q_right]` は `k(q_right) − k(q_left) ≤ 1` を満たす。
  - MergingDigest は投入をバッファにため、満杯または問い合わせ時に整列して既存 centroid と値の順に合わせ、上限まで貪欲にまとめる。参照実装はまとめる向きを交互に変えて偏りを抑える。
  - 推定は centroid の平均値を重みの中心に置いた点を線形補間する。重み 1 の centroid は実データそのもの。最小値・最大値を別に保持して両端を補間する。
  - 順位誤差の最悪ケースの上限は証明されていない。整列済みの入力や特定の分布で誤差が大きくなる例が報告されている。
- **Implications**: k0、k1、k2 を提供する(3.2)。`Z(n)` は `n < δ` で小さくなりすぎないよう `max(n/δ, 1)` で下を抑え、まとめる向きは常に昇順にする(簡略化として文書に書く)。推定は「(0, 最小値)、(各 centroid の重みの中心, 平均値)、(n, 最大値)」を結ぶ折れ線とし、単調性と範囲(3.8)を構成から保証する。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 手法ごとのファイル + 共有の整列・スケール関数 | `gk.ts`、`kll.ts`、`tdigest.ts` を独立させ、計数付き整列とスケール関数だけを共有する | 手法が互いに独立し、並行に実装・レビューできる。brief の境界候補と一致する | 共有部品の変更が 2 手法に及ぶ | 採用 |
| 手法ごとにサブディレクトリ | `src/streaming/gk/` などに分ける | 手法ごとの文書やテストもまとまる | ファイル数が少ないのに階層が増える。histogram の平坦な構成と揃わない | 不採用 |
| 共通の基底クラス | 検証・計数・reset を基底クラスにまとめる | 重複が減る | 3 手法の状態がまったく違い、基底に入るのは検証の数行だけ。core の関数の呼び出しで足りる | 不採用 |

## Design Decisions

### Decision: 内部状態の観察は `inspect()` でスナップショットを返す
- **Context**: 5.1〜5.6。学習のためにタプル・compactor・centroid を見たいが、状態を壊されたくない。
- **Alternatives Considered**:
  1. 内部の配列を読み取り専用の型で直接公開する
  2. 深い複製のスナップショットを返す
  3. 状態変化のたびにイベントを発行する
- **Selected Approach**: 2。各手法の作成関数は `PercentileSketch` を拡張した型(`GkSketch` など)を返し、`inspect()` が平坦な配列とオブジェクトだけからなる複製を返す。
- **Rationale**: 直列化可能(5.5)で、書き換えても影響しない。イベントは要件にない。
- **Trade-offs**: 呼ぶたびに保持要素数に比例する複製が起きる。観察用であり、操作数には数えない。
- **Follow-up**: `inspect()` の前後で操作数・メモリ見積もり・推定値が変わらないことをテストする(5.4)。

### Decision: t-digest は問い合わせ時にバッファをまとめる
- **Context**: 3.4、4.1。問い合わせ前のバッファを無視すると推定が投入と合わない。
- **Alternatives Considered**:
  1. 問い合わせ時にまとめ、状態を更新する
  2. 問い合わせ時に複製の上でまとめ、状態は変えない
  3. 投入ごとにまとめる(バッファなし)
- **Selected Approach**: 1。検証を通った問い合わせでだけまとめる。
- **Rationale**: 参照実装と同じ挙動で、まとめの費用が「最初の問い合わせの操作数」として実測に現れる。core の契約は成功時の状態変化を禁じていない。
- **Trade-offs**: 問い合わせ後のメモリ見積もりが投入後と異なりうる。ハーネスは両方を記録するので、違いはむしろ観察対象になる。
- **Follow-up**: 適合確認(拒否時の状態不変)が通ることをテストで確認する。

### Decision: 実験は試行のシードとデータのシードを分ける
- **Context**: 7.3、8.2。KLL の乱数によるばらつきを、データの違いと切り分けて見たい。
- **Alternatives Considered**:
  1. データのシード = 試行のシードとして、シードごとにデータも変える
  2. データは `seed` で 1 回だけ作り、`trialSeeds` を `BenchmarkInput.seed` として手法の乱数だけを変える
- **Selected Approach**: 2。データのシードは `meta.dataSeed`、試行のシードは core の `BenchmarkResult.seed` に記録する。
- **Rationale**: 同じデータで乱数だけを変えれば、ばらつきは手法の乱数に由来する。決定的な手法(GK、t-digest)は試行間で同じ結果になり、それ自体が「確率的でない」ことの証拠になる。
- **Trade-offs**: 厳密解も試行ごとに再計測され、実行時間が試行数倍になる。
- **Follow-up**: 決定的な手法の試行間の一致をテストで確認する。

### Decision: 一般化 — 手法の指定を判別可能な共用体 `StreamingSketchConfig` にする
- **Context**: 7.1 の「手法とパラメータの一覧」と、4.7 のパラメータの公開。
- **Selected Approach**: `{ kind: 'gk', epsilon } | { kind: 'kll', k } | { kind: 'tdigest', compression, scale }` を 1 つの型にまとめ、`streamingSketchSpec(config)` で `SketchSpec` に変換する。実験は設定の一覧を受け取るだけで、手法ごとの分岐を持たない。
- **Rationale**: 実験の入力が平坦になり、パラメータの直積を呼び出し側が自由に組める。後続のサイトも同じ型でスライダーの値を渡せる。
- **Trade-offs**: 手法を足すたびに共用体の変更が要る(この spec の範囲では 3 種で固定)。

### Decision: 自前実装(採用でなく構築)
- **Context**: 学習目的で、内部状態の観察と操作数の計数が必要。
- **Alternatives Considered**: `tdigest`(npm)、Apache DataSketches の JS 移植などの既存ライブラリ。
- **Selected Approach**: 3 手法とも自前で実装し、外部依存を追加しない(9.3)。
- **Rationale**: 既存ライブラリは内部状態を公開せず、core の操作数を数えられない。roadmap の方針(実装の中身を自分で書いて読む)とも一致する。

### Decision: 簡略化 — 不要な抽象を置かない
- **Context**: 設計の最小化。
- **Selected Approach**: 基底クラスや手法の登録機構は置かない。共有するのは計数付き整列(KLL と t-digest が使う)とスケール関数(t-digest だけが使うが、純粋関数として単体で検証したいので分ける)だけにする。マージ API は作らない(Out of scope)。

## Risks & Mitigations
- GK の配列への挿入は保持タプル数に比例する移動が起き、ε が小さいと遅い — 移動は正直に操作数に数え、文書で「投入の費用がタプル数に比例する」ことを説明する。ε の下限 1e-4 で極端な条件を防ぐ。
- KLL の誤差の上限は確率的で、テストが偶然に依存しうる — テストは固定シードの集合で行い、上限は実測より十分緩く置く。文書の数値は固定シードの実測値として載せる。
- t-digest の `k1`、`k2` の逆関数が浮動小数点の誤差で 1 を超える・0 を下回る — 逆関数の結果を [0, 1] に収め、少なくとも 1 件は各 centroid に入れる規則で進行を保証する。
- 実験の組み合わせ(ケース × 順序 × 件数 × 試行 × 手法)が大きいと時間がかかる — 上限は設けず、呼び出し側の責任とする(重い実験は後続 spec が Web Worker に載せる)。
- 兄弟 spec(relative-error-sketches)と並行に実装される — `src/streaming/` と `docs/streaming/` だけを使い、core と他の系統のファイルを変更しない。共有の登録機構を作らない。

## References
- M. Greenwald, S. Khanna, "Space-Efficient Online Computation of Quantile Summaries", SIGMOD 2001 — GK のタプル、不変条件、問い合わせ規則。
- Z. Karnin, K. Lang, E. Liberty, "Optimal Quantile Approximation in Streams", FOCS 2016 — KLL の compactor と容量の等比減少。
- Apache DataSketches, KLL Sketch の解説 — 既定 k、最小 k、c = 2/3、誤差の目安。
- T. Dunning, O. Ertl, "Computing Extremely Accurate Quantiles Using t-Digests", arXiv:1902.04023 — スケール関数 k0〜k3、MergingDigest、補間。
- `.kiro/specs/percentile-lab-core/design.md`、`.kiro/specs/histogram-percentile/design.md` — 共通契約と系統モジュールの構成。
