# Research & Design Decisions

## Summary
- **Feature**: `percentile-lab-site`
- **Discovery Scope**: New Feature(既存のアルゴリズム群の上に載る、初めての UI と配信物。上流 2 系統は未実装で、設計書の公開契約だけに依存する)
- **Key Findings**:
  - 上流 4 spec は、すべて `src/<系統>/index.ts` だけを公開入口とし、実験の結果を core の `SweepResult` / `BenchmarkResult` の形のまま返す。パラメータを軸にした系列は `params` から利用側(このサイト)が組み立てる、と core の設計に明記されている。サイトは独自の誤差指標を持たず、`QueryRecord` の値をそのまま描けばよい。
  - 既存の `tsconfig.json` は `lib: ["ES2023"]` で DOM を含めず、アルゴリズムのコードが DOM に依存しないことを型チェックで機械的に守っている。サイトの DOM コードと Worker コードは、別の tsconfig で型チェックし、既存の保証を壊さない必要がある。
  - Chart.js 4 は tree-shaking 可能で、使う controller・element・scale・plugin だけを `Chart.register` する。`LogarithmicScale` が対数軸を提供する。Vite は `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })` の形だけを Worker として検出する。

## Research Log

### 上流の公開契約
- **Context**: サイトは上流のアルゴリズム実装を変更・再定義せずに統合する必要がある。
- **Sources Consulted**: `src/core/index.ts`、`src/core/harness/types.ts`、`src/core/harness/run-sweep.ts`、`src/histogram/index.ts`、`src/histogram/experiment.ts`、`src/histogram/histogram.ts`、`.kiro/specs/streaming-quantile-sketches/design.md`、`.kiro/specs/relative-error-sketches/design.md`、`.kiro/specs/percentile-lab-core/design.md`。
- **Findings**:
  - core: `generate`、`runBenchmark`、`runSweep`、`seriesByAlgorithm`、`withoutTiming`、`sortExactSpec`、`quickselectExactSpec`、`MAX_COUNT = 10,000,000`、`DEFAULT_DEFINITION = 'linear'`。`AlgorithmResult` は `status: 'ok' | 'error'` の判別共用体で、失敗は `stage`・`errorKind`・`message` を持つ。
  - histogram(実装済み): `runBucketExperiment`(`cases × counts × schemes × bucketCounts`)、`histogramSpec`(`id = histogram-<kind>-<buckets>`、`params = { scheme, buckets, lower, upper }`、`supportedRange` あり)、`MAX_BUCKETS = 100,000`。`inspect()` はない。
  - streaming(未実装、設計のみ): `runStreamingExperiment`(`cases × orders × counts × trialSeeds × sketches`)、`streamingSketchSpec(config)`、`createGk` / `createKll`(seed 付き)/ `createTDigest` と `inspect()`(`GkState`、`KllState`、`TDigestState`)、`EPSILON_RANGE {0.0001, 0.5}`、`K_RANGE {8, 65536}`、`COMPRESSION_RANGE {10, 10000}`、`SCALE_FUNCTIONS`。`params` は `algorithm` を先頭に持つ(`epsilon`、`k`、`compression`、`scale`)。
  - relative-error(未実装、設計のみ): `runRelativeErrorExperiment`(`alphas × maxBucketsList × significantDigitsList`、ケースごとに `hdrRange`、`bucketStats` 付き。呼び出しの前にすべての `case × significantDigitsList` を `createHdrLayout` で検証し、1 つでも失敗すると部分的な結果なしで全体がエラー)、`createHdrLayout`(`subBucketCount`、`totalBuckets`。総数が `MAX_HDR_BUCKETS` を超えると `invalid-config`、`field: 'significantDigits'`)、`ddsketchSpec` / `hdrSpec`、`createDDSketch` / `createHdrHistogram` と `inspect()`(`DDSketchSnapshot`、`HdrSnapshot`、`BucketView`)、`DEFAULT_MAX_BUCKETS = 2048`、`MAX_DD_BUCKETS = 100,000`、`MAX_HDR_BUCKETS = 2^22`。HDR の範囲外の値は `unsupported-value` として、その手法だけ `status: 'error'` になる。
  - 上流の実験関数は、検証エラーを `Result` の `err` で返す(`invalid-config`、`invalid-experiment`、`invalid-scheme`、`generate`、`harness`)。`field` と人が読む `reason` を持つ。実験のエラーの型名は histogram が `ExperimentError`、streaming が `StreamingExperimentError`、relative-error が `RelativeErrorExperimentError`(名前の衝突を避けるための改名後)。設定のエラーは streaming と relative-error がどちらも `ConfigError` で、サイトは別名で import する。relative-error の `field` は素の名前で、`invalid-config` は設定の項目名(`alpha`、`maxBuckets`、`significantDigits`、`lowest`、`highest`)、`invalid-experiment` は実験の項目名(`cases`、`counts`、`quantiles`、`alphas`、`maxBucketsList`、`significantDigitsList`)。
  - `AlgorithmResult.id` の書式(実物と設計で確認): `exact-sort-<定義>`、`exact-quickselect-<定義>`(`src/core/exact/`)、`histogram-<kind>-<buckets>`(`src/histogram/histogram.ts`)、`gk-eps-<ε>`、`kll-k-<k>`、`tdigest-<scale>-c<δ>`(streaming の設計)、`ddsketch-a<α>-m<m>`、`hdr-d<d>`(relative-error の設計)。最初の `-` までの接頭辞は 7 系統で重ならない。
- **Implications**: サイトは「条件 → 上流の実験関数 → 結果の構造のまま転送 → 表示用の変換」の一方向で組む。エラーは `field` を UI の項目に対応づけて表示する。横断比較は、上流の `xxxSpec()` で作った `SketchSpec` を 1 つの `BenchmarkInput` に並べて core の `runSweep` を呼ぶ(同じデータを全手法に与える最短の方法)。

### 型チェックと DOM の分離
- **Context**: 既存の `tsconfig.json` は DOM を含まず、`src/**/*.ts` を対象にしている。
- **Sources Consulted**: `tsconfig.json`、`vite.config.ts`、`.kiro/specs/percentile-lab-core/design.md`(Infra の節。「アプリのエントリはサイト基盤 spec が追加し、`vite.config.ts` はそのとき拡張される」)。
- **Findings**: DOM の型と WebWorker の型は同じ構成に同居させにくい(`self` などの宣言が衝突する)。
- **Implications**: 3 つの型チェック構成に分ける。ルート(ES2023 のみ)は `src/site/ui/`、`src/site/worker/`、`src/site/main.ts` を除外し、`src/site/shared/` と `src/site/content/` は DOM 非依存としてルートでも検査する。`tsconfig.site.json`(DOM)と `tsconfig.worker.json`(WebWorker)を追加し、`typecheck` で 3 つを順に実行する。

### Chart.js 4 の部品登録
- **Context**: brief の制約「Chart.js 4.x は使う部品だけ登録して bundle を小さくする」。
- **Sources Consulted**: https://www.chartjs.org/docs/latest/getting-started/integration.html、`npm view chart.js`。
- **Findings**: 折れ線は `LineController`・`LineElement`・`PointElement`、散布図は `ScatterController`、棒は `BarController`・`BarElement`、軸は `LinearScale`・`LogarithmicScale`・`CategoryScale`、プラグインは `Tooltip`・`Legend`・`Title`。依存は `@kurkle/color`(MIT)だけ。最新は 4.6.1(公開から 3 日)で、4.5.1(2025-10-13)が十分に枯れている。
- **Implications**: `chart.js@4.5.1` を固定する。登録は 1 ファイル(`chart-setup.ts`)に集め、`chart.js/auto` は使わない。canvas の描画は happy-dom では検証できないため、描画層は差し替え可能にし、テストは表示用の仕様(ChartSpec)と表・代替テキストで行う。

### Vite の Worker と配信パス
- **Context**: 重い計算を Worker に逃がし、GitHub Pages のサブパスで配信する。
- **Sources Consulted**: https://vite.dev/guide/features.html(Web Workers)、`npm view vite@8.3.5`。
- **Findings**: `new Worker(new URL(...), { type: 'module' })` の直書きだけが検出される。Worker 内の ESM import は本番ビルドで解決される。`base: './'` で相対パスの配信物になる。
- **Implications**: Worker の生成は 1 か所(`worker-factory.ts`)に閉じ込め、テストでは偽の Worker を注入する。`worker.format: 'es'` を指定し、Worker 側の code-splitting を許す。ルーティングはハッシュ(`#/streaming` など)にし、サーバーの書き換え設定なしで直接アクセスと再読み込みに対応する。

### DOM テスト環境
- **Context**: 操作部品、ルーター、計算の打ち切りを、ブラウザなしで検証したい。
- **Sources Consulted**: `npm view vitest@5.0.5 peerDependencies`、`npm view happy-dom time`、`npm view jsdom`。
- **Findings**: Vitest 5 は `happy-dom` と `jsdom` を任意の版で受け付ける。`happy-dom` 21.x は公開から 2 週間未満で、20.14.5(2026-09-12)が安定。jsdom 29 系は Node の engines が `^22.13.0` で、プロジェクトの `>=22.12.0` と合わない。
- **Implications**: `happy-dom@20.14.5`(MIT)を開発時依存に加え、DOM が必要なテストファイルだけ `// @vitest-environment happy-dom` を付ける。既存のテストは node 環境のまま。Playwright などの E2E は導入せず、組み立て後の手動の確認を最終タスクに置く。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 3 層(shared・worker・ui)+ 上流の公開入口 | DOM 非依存の型と変換を shared に置き、worker が上流を呼び、ui が描く | 変換をすべて node のテストで検証できる。Worker と UI の依存が片方向 | ファイル数が多い | 採用 |
| UI から上流を直接呼ぶ(Worker なし) | 計算をメインスレッドで実行 | 単純 | 1,000,000 件でスライダーが固まる(3.1 違反) | 不採用 |
| 系統ごとに独立した HTML(多ページ) | ページごとにエントリを分ける | ページ単位で bundle が小さい | 共通のレイアウト・状態の保持が重複する。サブパスでの相互リンクが増える | 不採用 |
| UI フレームワーク(Lit など) | 部品化を任せる | 部品が書きやすい | roadmap の「UI フレームワークは使わない」に反する | 不採用 |

## Design Decisions

### Decision: 横断比較は core の `runSweep` を直接呼ぶ
- **Context**: 8.2 は、選んだ全手法に同じデータを与えることを求める。各系統の実験関数を別々に呼ぶと、厳密解が 3 回計算され、結果の統合も必要になる。
- **Alternatives Considered**:
  1. 系統ごとの実験関数を同じ条件で 3 回呼び、結果を件数ごとに合わせる。
  2. 各系統の `xxxSpec()` / `streamingSketchSpec()` で `SketchSpec` を作り、1 つの `BenchmarkInput` に並べて core の `runSweep` を呼ぶ。
- **Selected Approach**: 2。ヒストグラムの範囲はデータの最小値・最大値(histogram の `'data-extent'` と同じ意味)を件数ごとに求め、HDR の範囲は自動(データの桁から決める)または手動にする。
- **Rationale**: 上流の公開契約の組み合わせだけで、1 つのデータと 1 つの厳密解に揃う。
- **Trade-offs**: 最小値・最大値の計算と HDR の自動範囲の決め方はサイトが持つ(アルゴリズムの論理ではなく、実験条件の決め方)。
- **Follow-up**: `dataExtent` の結果が histogram の `'data-extent'` と一致することをテストする。

### Decision: 1 ページ 1 ジョブ、ジョブの中は上流の実験関数を複数回呼ぶ
- **Context**: 各ページは、パラメータ軸、件数軸、分位点軸、内部状態の 4 種類の表示を持つ。
- **Alternatives Considered**:
  1. 表示ごとに別のジョブを送る。
  2. ページの条件 1 つを 1 ジョブとし、Worker の中で「パラメータの掃引」「件数の掃引」「詳細(細かい分位点、順序、試行)」「内部状態」を順に計算して 1 つの結果で返す。
- **Selected Approach**: 2。
- **Rationale**: 最新の条件だけを表示する規則(3.3)を、ジョブの番号 1 つで守れる。表示の一部だけが新しい条件になる不整合が起きない。
- **Trade-offs**: 1 ジョブの時間が長くなる。計算量の見積もり(`estimateWork`)で上限を設けて抑える。

### Decision: 打ち切りは Worker の終了と作り直し
- **Context**: 上流の実験関数は同期的で、途中で止める口がない(3.3、3.7)。
- **Alternatives Considered**:
  1. 古い結果を捨てるだけ(計算は最後まで走る)。
  2. 実行中のジョブがあるときに新しい条件が来たら、Worker を `terminate()` して作り直す。
- **Selected Approach**: 2。スライダーの操作は 250ms の待ち合わせでまとめる。
- **Rationale**: 古い計算が CPU を使い続けず、最新の条件の結果がもっとも早く出る。
- **Trade-offs**: Worker の起動の分だけ遅れる(モジュールはキャッシュされるので小さい)。

### Decision: 表示の仕様(ChartSpec)と描画を分ける(一般化)
- **Context**: グラフはパラメータ軸、件数軸、分位点軸、メモリと誤差の関係、順序の比較、試行のばらつき、バケットの状態と多様だが、どれも「軸 2 本 + 系列 + 基準線 + 注記」で表せる。
- **Selected Approach**: shared に `ChartSpec` を定義し、ページごとの変換(view builder)は `ChartSpec[]` を返す。ui の `chart-panel` が Chart.js の設定に変換し、同じ `ChartSpec` から表と代替テキストも作る。対数軸での 0 以下の点の除外と注記(7.6)も `ChartSpec` 上の純粋関数で行う。
- **Rationale**: 変換の正しさを node のテストで確かめられる。表(10.3)とグラフが同じ数値になる。

### Decision: 基準の分位点の定義は `nearest-rank`
- **Context**: core の既定は `linear`。histogram と relative-error の文書は `nearest-rank` で数値を示し、DDSketch の上限の検証も `nearest-rank` を前提にする。
- **Selected Approach**: サイトのすべてのジョブで `referenceDefinition: 'nearest-rank'` を渡し、条件の表示に定義を出す。
- **Rationale**: 基準線(GK の ε、DDSketch の α)と文書の数値に揃う。

### Decision: HDR の自動範囲は `L = 10^floor(log10(minPositive / half))`
- **Context**: HDR の相対誤差 `1 / S` の保証は `x >= half × L` だけに成り立ち、それ未満は絶対誤差 `L / 2` になる。当初の規則 `L = 10^floor(log10(min))` では、対数正規(0, 1)・件数 10,000 で約 6 割の値が保証の外に入り、相対誤差のグラフが保証どおりに見えない。
- **Alternatives Considered**:
  1. 当初の規則のまま、注記だけ出す。
  2. `L <= minPositive / half` となるよう、基準の有効桁数の `half` で割ってから 10 の累乗に丸める。総数が上限を超えるときは基準の有効桁数を下げる。
  3. 有効桁数ごとに別の範囲(別のケース)で実験する。
- **Selected Approach**: 2。基準の有効桁数は使う有効桁数の最大値から始める。グラフに保証の始まり(half × L)と 1/S の基準線を出す。
- **Rationale**: データ全体が保証の領域に入り、1 回の実験(1 ケース)で全有効桁数を比べられる。3 はケースごとにデータと厳密解を作り直すので計算量が増え、有効桁数の間で範囲が変わって比較しにくい。
- **Trade-offs**: L が小さくなるのでバケットの総数が増える(既定のデータで d = 4 は約 23 万、d = 5 は約 180 万)。総数は計算量の見積もりに含める。
- **Follow-up(極端な値の幅と基準の開始値)**: core の `generate` は正の有限の値だけを返す(そうでなければ `non-finite-sample`)が、対数正規で σ ≈ 175 のように約 1e-300〜1e300 の値を作りうる。このとき L が 0 に下位桁あふれするか `highest / lowest` が有限でなくなり、d = 0 でも `createHdrLayout` が失敗するので、「基準を下げればどこかで止まる」は成り立たない。d = 0 でも失敗したら、比が 10^300 以下になるよう L を切り詰め(`lowestClamped`)、d = 0 の総数(約 1,000)を上限内に収める。L 未満の値は HDR の範囲外としてハーネスが記録し、ページ全体は失敗しない。上流の実験は HDR の範囲を必ず検証するので、HDR を選んでいない相対誤差型のページを失敗させないためにも、自動の範囲は常に作れる必要がある。`digits` に 0〜5 の整数がないとき(横断比較の手入力の 2.5 など)は、基準の開始値を既定の 2 にする。

### Decision: 総数の上限を超える有効桁数はサイトが先に除く
- **Context**: relative-error の実験は、呼び出しの前にすべての有効桁数を `createHdrLayout` で検証し、1 つでも失敗すると部分的な結果を返さない。広い範囲で格子の 1 つの有効桁数が上限を超えるだけで、相対誤差型のページ全体が失敗する。
- **Selected Approach**: Worker で範囲を決めた後、各有効桁数を `createHdrLayout` で検証し、総数の超過(`field: 'significantDigits'`)の有効桁数を除いてから実験を呼ぶ。除いた値は通知する。現在の有効桁数が除かれ、HDR を選んでいるときは項目の失敗にする。
- **Rationale**: 上流の検証の規則を書き写さず、上流の関数で判定できる。

### Decision: メインスレッドのコードは上流を型だけで参照する
- **Context**: `shared` は `ui` から読まれてメインの bundle に入る。`shared` が上流の定数や `seriesByAlgorithm` を実行時に import すると、上流の `index.ts` を経てアルゴリズムのコードがメインの bundle に入りうる(tree-shaking に頼ると副作用の判定しだいで漏れる)。
- **Alternatives Considered**:
  1. 上流の値を実行時に import し、tree-shaking に任せる。
  2. メインスレッドのコードは `import type` だけにし、小さな定数は書き写して上流との一致をテストで確かめ、`seriesByAlgorithm` 相当の数行は自前で持って結果の一致をテストする。組み立て後にメインの bundle のモジュールの一覧を検査する。
- **Selected Approach**: 2。
- **Rationale**: 「アルゴリズムは Worker の bundle だけ」と 200 KB の予算を、組み立ての結果で機械的に守れる。書き写しのずれはテストで検出できる。
- **Trade-offs**: 定数と系列化の規則が 2 か所に書かれる。テストで一致を保証する。

### Decision: ビルドとの両立(Build vs Adopt)
- グラフ: Chart.js を採用(brief の指定)。ルーティング・状態管理・部品は小さく自作(UI フレームワーク不使用の方針)。Markdown の文書を読み込んで描く仕組みは作らず、解説は TypeScript のデータとして書き、詳しい文書は名前で示す(依存を増やさない)。
- bundle の大きさの確認は、依存を増やさず、Node 標準の `zlib.gzipSync` を使う小さなスクリプトで行う。

### Simplification
- URL への条件の保存、結果の書き出し、テーマの切り替えは要件にないので作らない。
- 解説の Markdown 化、E2E の自動テストは作らない。
- ページの登録は、5 ページの配列(`PageModule[]`)だけにし、動的な読み込みの仕組みは作らない。

## Risks & Mitigations
- 上流 2 系統が未実装で、実装時に公開契約が変わる — 上流の型だけを import し、変換は shared に集める。上流の Revalidation Triggers を design.md に転記し、変更時に見直す。実装タスクの前提に上流の完了を置く。
- 重い条件で計算が長い — `estimateWork` で上限(4,000 万単位)を設け、超えたら計算しない。既定の件数は 10,000。
- canvas を描けないテスト環境 — 描画層を差し替え可能にし、`ChartSpec` と表で検証する。描画そのものは組み立て後の手動確認で見る。
- bundle の肥大 — Chart.js は部品登録、上流の実装は Worker 側の bundle に入れる。メインスレッドのコードは上流を `import type` だけで参照し、`bundle:check` でメインの bundle に上流のモジュールがないことを、`size:check` で圧縮後 200 KB を超えないことを確かめる。
- HDR のバケットの総数 — 自動範囲で L を小さくした分だけ総数が増え、問い合わせの走査も増える。総数を `estimateWork` に含め、上限を超える有効桁数は除いて通知する。
- happy-dom の脆弱性 — 20.x 系の修正済みの版を固定し、開発時のテストだけで使う(配信物に含まれない)。

## References
- [Chart.js Integration](https://www.chartjs.org/docs/latest/getting-started/integration.html) — tree-shaking と部品の登録
- [Vite Features: Web Workers](https://vite.dev/guide/features.html) — Worker の生成構文と検出条件
- `.kiro/specs/percentile-lab-core/design.md` — 結果の構造、パラメータ軸の系列はサイトが組み立てること、`vite.config.ts` の拡張
- `.kiro/specs/streaming-quantile-sketches/design.md`、`.kiro/specs/relative-error-sketches/design.md` — 公開入口、`inspect()`、実験関数、Revalidation Triggers
