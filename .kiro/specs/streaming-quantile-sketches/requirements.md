# Requirements Document

## Project Description (Input)
メモリを制限してストリームから分位点を求める手法(GK、KLL、t-digest)は、保証の種類(順位誤差か、裾の精度か)が手法ごとに違う。式を読むだけでは違いが分からない。学習者本人が実装と実験で確かめたい。

目指す状態は次のとおり。
- GK、KLL、t-digest がそれぞれ共通IFに従って実装されている。
- ε、圧縮パラメータ、データ件数を変えたときの誤差とメモリを計測できる。
- GK の順位誤差保証、KLL の確率的保証、t-digest の裾での精度の高さと保証の弱さを、実験結果で比較して説明できる。
- 挿入順序の影響(整列済み、逆順、ランダム)も確認できる。

詳細は同ディレクトリの `brief.md` を参照。

## Introduction
Streaming Quantile Sketches は、メモリを制限してストリームから分位点を近似する3つの手法(GK、KLL、t-digest)と、その誤差・メモリ・挿入順序の影響を実験で確かめる仕組みを提供する。3つの手法は percentile-lab-core の共通操作規約、誤差指標、操作数・メモリの数え方、計測ハーネスの上で動き、厳密解と入れ替えて同じ実験コードで比べられる。学習のために、各手法の内部状態(GK のタプル、KLL の compactor、t-digest の centroid)を観察できるようにする。利用者は、学習のために実験する作者本人である。

## Boundary Context
- **In scope**:
  - GK(Greenwald-Khanna)、KLL、t-digest(スケール関数の切り替えを含む)の実装
  - 各手法の内部状態を観察する手段
  - パラメータ(ε、k、圧縮パラメータ)、データ件数、挿入順序、試行のシードを変えた誤差・操作数・メモリの実験データの出力
  - 3つの手法の保証の違い(決定的な順位誤差の保証、確率的な保証、裾での精度と保証の弱さ)と挿入順序の影響の文書化
  - 実装の自動テスト
- **Out of scope**:
  - 学習ページ、グラフ描画、パラメータ操作 UI(percentile-lab-site の所掌)
  - sketch 同士のマージ機能と、分散環境でのマージ性能の評価(文書での概念説明に留める)
  - 相対誤差保証型(DDSketch、HDR Histogram。relative-error-sketches の所掌)、固定バケットのヒストグラム近似(histogram-percentile の所掌)
  - 厳密解、データ生成、誤差指標の定義(percentile-lab-core の所掌)
  - 論文の実装を厳密に再現すること(挙動の理解を優先し、簡略化した点は文書に記す)
- **Adjacent expectations**:
  - この spec は percentile-lab-core の共通操作規約、誤差指標、計測ハーネス、データ生成、乱数生成、厳密解をそのまま利用し、独自の誤差定義を持たない。
  - 相対誤差保証型との横断比較の定義は percentile-lab-site が揃える。この spec は、横断比較に使える形(core の結果の形式)で実験データを出すところまでを担う。
  - percentile-lab-site は、この spec が出力する実験データと内部状態の観察結果を表示に使う。表示形式はこの spec の対象外である。

## Requirements

### Requirement 1: GK による分位点の近似
**Objective:** As a 学習コンテンツの作者, I want 順位誤差 ε を指定して GK で分位点を近似できること, so that 決定的な順位誤差の保証が実際に守られることを確かめられる

#### Acceptance Criteria
1. When 順位誤差の許容値 ε が指定されたとき, the Streaming Quantile Sketches shall その ε を保証の目標とする GK を作成する。
2. If ε が有限の数でない、または定められた下限未満か上限より大きい, then the Streaming Quantile Sketches shall 不正な指定であることを示すエラーを返し、アルゴリズムを作成しない。
3. When n 件を投入したあとに分位点 q が問い合わせられたとき, the Streaming Quantile Sketches shall 投入済みの値の1つを推定値として返し、その推定値の順位と、目標順位(最近順位法の順位)との差を ε × n 以下に収める。
4. The Streaming Quantile Sketches shall 分位点 0 には投入済みの最小値を、分位点 1 には投入済みの最大値を返す。
5. When 投入件数が増えるとき, the Streaming Quantile Sketches shall 保持する要素数を、投入件数より少なく保てるように、保証を崩さない範囲で隣り合う要素をまとめる。
6. The Streaming Quantile Sketches shall 乱数を使わず、同じ ε と同じ入力列に対して、同じ推定値、操作数、メモリ見積もり、内部状態を返す。

### Requirement 2: KLL による分位点の近似
**Objective:** As a 学習コンテンツの作者, I want 容量パラメータ k を指定して KLL で分位点を近似できること, so that 乱数に基づく確率的な保証と、そのばらつきを確かめられる

#### Acceptance Criteria
1. When 容量パラメータ k が指定されたとき, the Streaming Quantile Sketches shall その k で各段の容量を決める KLL を作成する。
2. If k が整数でない、または定められた下限未満か上限より大きい, then the Streaming Quantile Sketches shall 不正な指定であることを示すエラーを返し、アルゴリズムを作成しない。
3. When 段の要素数が容量を超えたとき, the Streaming Quantile Sketches shall その段の要素を整列し、乱数で選んだ半分を重みが2倍の上の段に送り、残りを捨てる。
4. The Streaming Quantile Sketches shall 保持する要素の重みの合計を、常に投入件数と等しく保つ。
5. When 分位点 q が問い合わせられたとき, the Streaming Quantile Sketches shall 保持する要素を値の順に並べ、重みの累計が初めて目標順位(最近順位法の順位)以上になる要素の値を推定値として返す。
6. The Streaming Quantile Sketches shall 保持する要素数を、投入件数によらず k に比例する範囲(と段数に比例するわずかな上乗せ)に収める。
7. When 同じ k、同じシード、同じ入力列が与えられたとき, the Streaming Quantile Sketches shall 同じ推定値、操作数、メモリ見積もり、内部状態を返す。
8. When シードだけを変えたとき, the Streaming Quantile Sketches shall 段の圧縮で選ばれる要素が変わりうるようにし、推定値と誤差のばらつきを観察できるようにする。

### Requirement 3: t-digest による分位点の近似
**Objective:** As a 学習コンテンツの作者, I want 圧縮パラメータとスケール関数を指定して t-digest で分位点を近似できること, so that 裾で精度が高くなる仕組みと、その保証の弱さを確かめられる

#### Acceptance Criteria
1. When 圧縮パラメータ δ とスケール関数が指定されたとき, the Streaming Quantile Sketches shall その δ とスケール関数で centroid の大きさの上限を決める t-digest を作成する。
2. The Streaming Quantile Sketches shall スケール関数として、分位点によらず centroid の大きさを揃えるもの(k0)、裾で centroid を小さくするもの(k1)、裾でさらに強く小さくするもの(k2)の3種を提供する。
3. If δ が有限の数でない、定められた下限未満か上限より大きい、またはスケール関数が提供する3種のいずれでもない, then the Streaming Quantile Sketches shall 不正な指定であることを示すエラーを返し、アルゴリズムを作成しない。
4. When 投入された値が一定数たまったとき、または分位点が問い合わせられたとき, the Streaming Quantile Sketches shall たまった値を既存の centroid と値の順に合わせ、スケール関数が許す大きさを超えない範囲で centroid にまとめる。
5. The Streaming Quantile Sketches shall centroid の重みの合計とたまった値の件数の和を、常に投入件数と等しく保つ。
6. The Streaming Quantile Sketches shall 投入済みの最小値と最大値を保持し、分位点 0 には最小値を、分位点 1 には最大値を返す。
7. When 0 より大きく 1 未満の分位点 q が問い合わせられたとき, the Streaming Quantile Sketches shall centroid の平均値を、各 centroid の重みの中心の位置で結んだ線形補間により、目標位置 q × n の推定値を返す。
8. The Streaming Quantile Sketches shall 推定値を、常に投入済みの最小値以上、最大値以下に収め、同じ状態に対して分位点が大きくなるほど推定値が減らない結果を返す。
9. The Streaming Quantile Sketches shall 乱数を使わず、同じ δ、同じスケール関数、同じ入力列に対して、同じ推定値、操作数、メモリ見積もり、内部状態を返す。

### Requirement 4: 共通規約への適合
**Objective:** As a 学習コンテンツの作者, I want 3つの手法が他のアルゴリズムと同じ操作で扱えること, so that 厳密解やヒストグラム近似と入れ替えて同じ実験コードで比較できる

#### Acceptance Criteria
1. The Streaming Quantile Sketches shall GK、KLL、t-digest のいずれも、percentile-lab-core の共通操作規約(値の投入、分位点の問い合わせ、メモリ見積もり、操作数、初期化)に従う。
2. The Streaming Quantile Sketches shall percentile-lab-core の適合確認を、GK、KLL、t-digest(3種のスケール関数のそれぞれ)について通過する。
3. The Streaming Quantile Sketches shall 有限の正の数であれば値の大きさによらず受け入れ、扱える値域を制限しない。
4. If 有限の正の数でない値が投入された、または 0 未満か 1 より大きい分位点が指定された, then the Streaming Quantile Sketches shall 共通規約が定めるエラーを返し、内部状態・操作数・メモリ見積もりを変更しない。
5. If 1 件も投入されていない状態で分位点が問い合わせられた, then the Streaming Quantile Sketches shall 共通規約が定める、データが空であることを示すエラーを返す。
6. When 初期化が実行されたとき, the Streaming Quantile Sketches shall パラメータの指定を保ったまま、保持する要素、操作数、乱数列を作成直後の状態に戻す。
7. The Streaming Quantile Sketches shall 手法の種類と、ε・k・δ・スケール関数など実験条件を表すパラメータを、結果に写せる形で公開する。
8. The Streaming Quantile Sketches shall 推定値を、常に有限の正の数で返す。

### Requirement 5: 内部状態の観察
**Objective:** As a 学習コンテンツの作者, I want 各手法の内部状態をそのまま観察できること, so that 要素がどうまとめられ、どこで情報が失われるかを自分の目で追える

#### Acceptance Criteria
1. When GK の内部状態が要求されたとき, the Streaming Quantile Sketches shall 保持しているタプルの一覧(値、直前のタプルとの最小順位の差、順位の幅)を値の順に、投入件数と ε とともに返す。
2. When KLL の内部状態が要求されたとき, the Streaming Quantile Sketches shall 段ごとに、要素の重み、容量、保持している要素の値の一覧を、投入件数、k、それまでの圧縮の回数とともに返す。
3. When t-digest の内部状態が要求されたとき, the Streaming Quantile Sketches shall centroid の一覧(平均値と重み)を値の順に、まだまとめていない値の件数、最小値、最大値、投入件数、δ、スケール関数とともに返す。
4. When 内部状態が要求されたとき, the Streaming Quantile Sketches shall 内部状態、操作数、メモリ見積もり、以後の推定値を変更しない。
5. The Streaming Quantile Sketches shall 返す内部状態を、保存や他の実行環境への受け渡しができる直列化可能な構造とし、呼び出し側が書き換えてもアルゴリズムの状態に影響しないようにする。
6. The Streaming Quantile Sketches shall 返す内部状態の要素数とメモリ見積もりが、同じ時点の状態について矛盾しないようにする。

### Requirement 6: 計算量とメモリの特性
**Objective:** As a 学習コンテンツの作者, I want 3つの手法の操作数とメモリを厳密解と同じ尺度で比べられること, so that メモリを制限する代わりに何を払っているかを実測で確かめられる

#### Acceptance Criteria
1. The Streaming Quantile Sketches shall 値の投入と分位点の問い合わせで行った比較と移動を、percentile-lab-core の操作数の数え方に従って数える。
2. The Streaming Quantile Sketches shall 要素の整列、まとめ、段の圧縮など、投入や問い合わせの中で行う処理の操作数を、それを引き起こした投入または問い合わせの操作数に含める。
3. The Streaming Quantile Sketches shall メモリ見積もりを、percentile-lab-core の見積もり規則に従い、その時点で保持している要素と管理用のカウンタの個数から算出する。
4. When 投入件数を増やして同じ条件で計測したとき, the Streaming Quantile Sketches shall 厳密解のメモリ見積もりが件数に比例して増えるのに対し、3つの手法のメモリ見積もりが件数よりはるかに緩やかにしか増えないことを、実測で比較できるようにする。
5. When ε を小さくする、k を大きくする、または δ を大きくして計測したとき, the Streaming Quantile Sketches shall メモリ見積もりが増え、誤差が減る傾向を実測で確認できるようにする。

### Requirement 7: 誤差・費用・挿入順序の実験データの出力
**Objective:** As a 学習コンテンツの作者, I want パラメータ、データ件数、挿入順序、試行のシードを変えた誤差と費用を同じ条件で測り、構造化された形で得られること, so that 保証の違いと順序の影響を再現可能に確かめ、後続のサイトで表示できる

#### Acceptance Criteria
1. When 分布、データ件数の一覧、データのシード、分位点の一覧、手法とパラメータの一覧が指定されたとき, the Streaming Quantile Sketches shall 各手法を作り、percentile-lab-core の計測ハーネスで厳密解と同じデータに対して計測する。
2. When 挿入順序の一覧(整列済み、逆順、ランダムのいずれか)が指定されたとき, the Streaming Quantile Sketches shall 同じ値の集まりを各順序で並べたデータに対して計測し、順序ごとの結果を並べて取得できるようにする。
3. When 試行のシードの一覧が指定されたとき, the Streaming Quantile Sketches shall 同じデータに対して、試行のシードごとに手法を作り直して計測し、乱数を使う手法の誤差のばらつきを取得できるようにする。
4. When 計測が完了したとき, the Streaming Quantile Sketches shall 条件ごとに、絶対誤差、順位誤差、相対誤差、操作数、メモリ見積もりを、percentile-lab-core の結果の形式のまま返す。
5. The Streaming Quantile Sketches shall 実験の結果を直列化可能な構造で返し、分布、挿入順序、データのシード、試行のシード、手法とパラメータなどの実験条件を結果から読み取れるようにする。
6. When 同じ実験条件で再度実行されたとき, the Streaming Quantile Sketches shall 処理時間を除くすべての項目で同じ結果を返す。
7. When 複数の分布(少なくとも一様、正規、対数正規、重い裾、多峰)が指定されたとき, the Streaming Quantile Sketches shall 分布ごとの結果を並べて取得できるようにする。
8. If 実験条件の指定が不正である(一覧が空である、識別が重複する、手法のパラメータが不正である、など), then the Streaming Quantile Sketches shall 不正な指定であることを示すエラーを返し、部分的な結果を返さない。

### Requirement 8: 保証の違いと挿入順序の影響の検証と文書化
**Objective:** As a 学習コンテンツの作者, I want 3つの手法の保証の違いを実験結果で説明できること, so that 用途に応じて手法を選ぶ根拠を自分の言葉で持てる

#### Acceptance Criteria
1. The Streaming Quantile Sketches shall GK の順位誤差の保証(どの分位点でも順位誤差が ε 以下)と、その保証がまとめの規則からどう導かれるかを、実験結果を添えて文書化する。
2. The Streaming Quantile Sketches shall KLL の保証が確率的であること(試行のシードによって誤差がばらつき、k を大きくするとばらつきが小さくなること)を、複数の試行の実験結果を添えて文書化する。
3. The Streaming Quantile Sketches shall t-digest が裾の分位点で中央付近より小さい誤差になりやすいこと、スケール関数によってその傾向が変わること、順位誤差の上限を保証しないことを、実験結果を添えて文書化する。
4. The Streaming Quantile Sketches shall 挿入順序(整列済み、逆順、ランダム)によって、各手法の誤差とメモリ見積もりがどう変わるか、あるいは変わらないかを、同じ値の集まりに対する実験結果で比較して文書化する。
5. The Streaming Quantile Sketches shall sketch のマージの考え方と、この spec がマージ機能を提供しないことを、概念の説明として文書化する。
6. The Streaming Quantile Sketches shall 論文の定義から簡略化した点と、その簡略化が保証に与える影響を文書化する。
7. The Streaming Quantile Sketches shall 文書中の数値例と実験結果が、実際の実装の出力と一致していることを、自動テストで確認する。
8. The Streaming Quantile Sketches shall 文書化した性質(GK の順位誤差の上限、KLL の重みの保存と保持要素数の上限、t-digest の重みの保存と推定値の範囲・単調性)が成り立つことを、複数の分布、挿入順序、シードに対する性質テストで確認する。

### Requirement 9: 実行環境とテスト可能性
**Objective:** As a 学習コンテンツの作者, I want 3つの手法がブラウザなしで動かせ、自動テストで確かめられること, so that 後続のサイト基盤が安心して依存できる

#### Acceptance Criteria
1. The Streaming Quantile Sketches shall ブラウザや画面描画の機能がない実行環境でも、すべての機能を実行できるようにする。
2. When 開発者がテストの実行を指示したとき, the Streaming Quantile Sketches shall この spec のすべての機能の自動テストを、既存の spec のテストと同じ1つの操作で実行し、成功または失敗を報告する。
3. The Streaming Quantile Sketches shall 新たな外部依存を追加せず、追加する場合は percentile-lab-core のライセンス判定を通過する範囲に限る。
4. When 後続の spec がこの機能を利用するとき, the Streaming Quantile Sketches shall 内部の構成を知らなくても、各手法の作成、内部状態の観察、実験データの取得を行えるようにする。
