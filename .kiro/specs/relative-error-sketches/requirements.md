# Requirements Document

## Project Description (Input)
レイテンシ計測では、値の大きさに対する相対誤差を保証する手法(DDSketch、HDR Histogram)が実用される。順位誤差型の sketch とは保証の意味が違い、どちらがどの場面に向くかを掴みにくい。学習者本人が実装と実験で確かめたい。

目指す状態は次のとおり。
- DDSketch と HDR Histogram(有効桁数ベースのバケット構造)が共通IFに従って実装されている。
- 相対誤差の許容値 α(DDSketch)や有効桁数(HDR)を変えたときの誤差、バケット数、メモリを計測できる。
- 対数マッピングによる相対誤差保証が、値の範囲によらず成り立つことを実験で確認できる。
- 順位誤差型の sketch と比べて、どの分布・分位点で有利か不利かを説明できる。

詳細は同ディレクトリの `brief.md` を参照。

## Introduction
Relative Error Sketches は、値の大きさに対する相対誤差を保証する2つの分位点近似手法、DDSketch と HDR Histogram を提供し、その誤差・バケット数・費用を実験で確かめる仕組みを提供する。DDSketch は対数マッピングでバケットを決め、バケット数の上限に達したときは小さい値の側を縮約する。HDR Histogram は有効桁数からバケットの構造を決める。どちらも percentile-lab-core の共通操作規約・誤差指標・計測ハーネスの上で、厳密解と同じ条件で測れるようにする。内部のバケットの状態は、学習のために観察できる形で公開する。利用者は、学習のために実験する作者本人である。

## Boundary Context
- **In scope**:
  - DDSketch(対数マッピング、バケット数の上限と縮約)
  - HDR Histogram(有効桁数に基づくバケット構造)
  - 値からバケットへの対応(対数マッピング、有効桁数ベースの構造)の定義と、その単体での計算
  - バケットの内部状態を観察する手段
  - 相対誤差の許容値・有効桁数・バケット数の上限・分布を変えた誤差、バケット数、操作数、メモリの実験データの出力
  - 相対誤差保証の成り立ち方、縮約の影響、順位誤差型の手法との向き不向きの文書化
- **Out of scope**:
  - 学習ページ、グラフ描画、パラメータ操作 UI(percentile-lab-site の所掌)
  - 順位誤差型の sketch(GK、KLL、t-digest)の実装と、それらとの数値による横断比較(streaming-quantile-sketches と percentile-lab-site の所掌)
  - 固定バケットのヒストグラム近似(histogram-percentile の所掌)
  - 厳密解、データ生成、誤差指標の定義(percentile-lab-core の所掌)
  - sketch 同士のマージの実装と、分散環境でのマージ性能の評価(マージは文書での概念説明に留める)
  - 0 以下の値の扱い(共通規約が有限の正の数だけを値として扱うため)
- **Adjacent expectations**:
  - この spec は percentile-lab-core の共通操作規約、誤差指標、計測ハーネス、データ生成、厳密解をそのまま利用し、独自の誤差定義やデータ生成を持たない。
  - histogram-percentile の指数幅の境界は、相対誤差の上限を保証しない固定の境界列である。この spec の対数マッピングは、それとは別に、相対誤差の許容値から導く独自の定義として持ち、histogram-percentile の境界の定義を再利用も変更もしない。
  - 順位誤差型の手法との比較は、この spec の実験で得られる相対誤差と順位誤差、および順位誤差型の手法の理論上の保証の性質に基づいて文書で説明する。GK などの実装を呼び出す比較は行わない。
  - percentile-lab-site は、この spec が出力する実験データと観察結果を表示に使う。表示形式はこの spec の対象外である。

## Requirements

### Requirement 1: DDSketch の対数マッピング
**Objective:** As a 学習コンテンツの作者, I want 相対誤差の許容値 α から値とバケットの対応を決められること, so that 対数マッピングが相対誤差を保証する仕組みを確かめられる

#### Acceptance Criteria
1. The Relative Error Sketches shall DDSketch の相対誤差の許容値 α を、0 より大きく 1 より小さい数として受け付ける。
2. When α が指定されたとき, the Relative Error Sketches shall γ = (1 + α) / (1 − α) とし、有限の正の数 x を、γ^(i−1) < x ≤ γ^i を満たす整数 i の番号のバケットに対応させる。
3. The Relative Error Sketches shall 番号 i のバケットの代表値を 2γ^i / (γ + 1) とし、そのバケットに入るどの値に対しても、代表値の相対誤差が α 以下になるようにする。
4. The Relative Error Sketches shall DDSketch では有限の正の数すべてを受け付け、扱える値域の制限を宣言しない。
5. When 学習のためにマッピングだけが要求されたとき, the Relative Error Sketches shall sketch を作らずに、値からバケット番号、バケット番号から下側の境界・上側の境界・代表値を計算できるようにする。
6. If α が有限の数でない、または 0 以下か 1 以上である, then the Relative Error Sketches shall 不正な指定であることを示すエラーを返し、sketch もマッピングも作成しない。

### Requirement 2: DDSketch のバケット数の上限と縮約
**Objective:** As a 学習コンテンツの作者, I want バケット数の上限を設け、上限に達したときの縮約の影響を確かめられること, so that メモリを固定したときに保証が失われる範囲を理解できる

#### Acceptance Criteria
1. The Relative Error Sketches shall DDSketch のバケット数の上限 m を、1 以上かつ設計が定める上限以下の整数として受け付け、指定がないときは設計が定める既定値を使う。
2. The Relative Error Sketches shall 保持するバケット数を、保持している最小のバケット番号から最大のバケット番号までの連続した範囲の長さとして数え、m を超えないように保つ。
3. When 投入された値のバケット番号が保持している範囲より大きく、そのまま保持すると範囲の長さが m を超えるとき, the Relative Error Sketches shall 小さい番号の側のバケットの件数を、範囲の長さがちょうど m になる位置の最小番号のバケットへ合算する(縮約)。
4. When 投入された値のバケット番号が保持している範囲より小さく、そのまま保持すると範囲の長さが m を超えるとき, the Relative Error Sketches shall その値を、範囲の長さが m を超えない位置にある最小番号のバケットの件数に数える。
5. The Relative Error Sketches shall 縮約の前後で総件数を変えず、大きい番号の側のバケットは縮約しない。
6. While 縮約が一度も起きていない間, the Relative Error Sketches shall すべての分位点で、Requirement 4 の相対誤差の上限を保つ。
7. When 縮約が起きたとき, the Relative Error Sketches shall 縮約の影響を受けた値の上限(この値以下の推定は相対誤差の上限を保証しない)と、縮約が起きた回数を観察できるようにする。
8. If m が整数でない、1 未満である、または設計が定める上限を超える, then the Relative Error Sketches shall 不正な指定であることを示すエラーを返し、sketch を作成しない。

### Requirement 3: HDR Histogram の有効桁数ベースのバケット構造
**Objective:** As a 学習コンテンツの作者, I want 有効桁数と追跡する値の範囲からバケット構造を決められること, so that 有効桁数による相対誤差の保証と、その構造が持つ制約を確かめられる

#### Acceptance Criteria
1. The Relative Error Sketches shall HDR Histogram の設定として、最小の識別単位 L(有限の正の数)、追跡する最大値 H(有限の正の数で、2L 以上)、有効桁数 d(0 以上 5 以下の整数)を受け付ける。
2. When 設定が指定されたとき, the Relative Error Sketches shall 副バケット数 S を 2 × 10^d 以上の最小の 2 のべき乗とし、値 x を L 単位の整数 floor(x / L) に変換したうえで、0 以上 S 未満の単位は幅 1 単位のバケットに、S 以上の単位は 2 倍ごとに区切った各区間を S / 2 個の等しい幅のバケットに対応させる。
3. The Relative Error Sketches shall 各バケットの代表値を、そのバケットが覆う値の範囲の中点とする。
4. The Relative Error Sketches shall (S / 2) × L 以上の値に対しては代表値の相対誤差を 1 / S 以下(したがって 10^(−d) / 2 以下)とし、それ未満の値に対しては代表値の絶対誤差を L / 2 以下とする。
5. The Relative Error Sketches shall 扱える値の範囲(L 以上、H 以下)を、共通規約が定める扱える値域として宣言する。
6. If L 未満または H より大きい有限の正の数が投入された, then the Relative Error Sketches shall 扱える範囲外であることを示すエラーを返し、内部状態・操作数・メモリ見積もりを変更しない。
7. The Relative Error Sketches shall バケットの総数を作成時に設定から決め、値の投入によって増減させない。
8. When 学習のために構造だけが要求されたとき, the Relative Error Sketches shall sketch を作らずに、設定からの副バケット数とバケットの総数、値からバケット番号、バケット番号から下側の境界・上側の境界・代表値を計算できるようにする。
9. If L または H が有限の正の数でない、H が 2L 未満である、H ÷ L が有限の数で表せない、d が 0 以上 5 以下の整数でない、または必要なバケットの総数が設計の定める上限を超える, then the Relative Error Sketches shall 不正な指定であることを示すエラーを返し、sketch も構造も作成しない。

### Requirement 4: 分位点の推定と誤差の上限
**Objective:** As a 学習コンテンツの作者, I want 両手法が同じ規則で分位点を推定し、その誤差の上限が保たれること, so that 保証の内容を実測で確かめられる

#### Acceptance Criteria
1. When 0 以上 1 以下の分位点 q が指定され、投入済みの件数が n のとき, the Relative Error Sketches shall 目標順位を最近順位法の順位(ceil(q × n) を 1 以上 n 以下に収めた値。丸めの規則は共通規約の誤差指標と同じ)とし、番号の小さい順に累積件数が初めて目標順位以上になるバケットを選び、その代表値を推定値とする。
2. The Relative Error Sketches shall 推定値を、常に有限の正の数とする。
3. When 分位点が大きくなるとき, the Relative Error Sketches shall 同じ投入済みの値に対して、推定値が単調に減少しない結果を返す。
4. The Relative Error Sketches shall 最近順位法による厳密値が数えられたバケットと、推定に使ったバケットが一致することを保つ。
5. While 推定に使ったバケットが縮約の影響を受けていない間, the Relative Error Sketches shall DDSketch の推定値の、最近順位法による厳密値に対する相対誤差を α 以下に保つ。
6. The Relative Error Sketches shall HDR Histogram の推定値の、最近順位法による厳密値に対する誤差を、Requirement 3 の 3.4 の上限以下に保つ。
7. If 1 件も投入されていない状態で分位点が問い合わせられた, then the Relative Error Sketches shall 共通規約が定める、データが空であることを示すエラーを返す。
8. If 0 未満または 1 より大きい分位点が指定された, then the Relative Error Sketches shall 共通規約が定める、範囲外であることを示すエラーを返し、内部状態を変更しない。

### Requirement 5: 共通規約への適合
**Objective:** As a 学習コンテンツの作者, I want 両手法が他のアルゴリズムと同じ操作で扱えること, so that 厳密解と入れ替えて同じ実験コードで比較できる

#### Acceptance Criteria
1. The Relative Error Sketches shall percentile-lab-core の共通操作規約(値の投入、分位点の問い合わせ、メモリ見積もり、操作数、初期化)に従う。
2. The Relative Error Sketches shall percentile-lab-core の適合確認を、DDSketch(縮約が起きない設定と、縮約が起きる小さいバケット数の上限の設定を含む)と HDR Histogram(複数の有効桁数)のそれぞれについて通過する。
3. When 同じ設定と同じ入力列が与えられたとき, the Relative Error Sketches shall 同じ推定値、操作数、メモリ見積もり、観察結果を返す。この性質は乱数を使わず、シードに依存しない。
4. When 初期化が実行されたとき, the Relative Error Sketches shall 設定を保ったまま、件数・操作数・縮約の記録を作成直後の状態に戻す。
5. The Relative Error Sketches shall α、γ、バケット数の上限、L、H、有効桁数、副バケット数など、実験条件を表す設定を結果に写せる形で公開する。
6. The Relative Error Sketches shall 各アルゴリズムに、設定から決まり、データの範囲やデータ件数に依存しない識別子を付け、件数の異なる計測結果を同じ系列として並べられるようにする。

### Requirement 6: 内部状態の観察
**Objective:** As a 学習コンテンツの作者, I want バケットの内部状態を観察できること, so that 値がどのバケットに入り、縮約がどこで起きたかを確かめ、後続のサイトで表示できる

#### Acceptance Criteria
1. When DDSketch の観察が要求されたとき, the Relative Error Sketches shall α、γ、バケット数の上限、総件数、保持している範囲の長さ、件数が 1 以上のバケットの個数、件数が 1 以上の各バケットの番号・下側の境界・上側の境界・代表値・件数、縮約の有無、縮約の影響を受けた値の上限、縮約の回数を返す。
2. When HDR Histogram の観察が要求されたとき, the Relative Error Sketches shall L、H、有効桁数、副バケット数、バケットの総数、総件数、件数が 1 以上のバケットの個数、件数が 1 以上の各バケットの番号・下側の境界・上側の境界・代表値・件数を返す。
3. The Relative Error Sketches shall 観察によって、内部状態・操作数・メモリ見積もりを変更しない。
4. The Relative Error Sketches shall 観察結果を、保存や他の実行環境への受け渡しができる直列化可能な値として返し、その後に sketch を操作しても観察結果が変わらないようにする。
5. The Relative Error Sketches shall 観察結果の各バケットの件数の合計を総件数と一致させ、バケットを番号の昇順に並べる。

### Requirement 7: 計算量とメモリの特性
**Objective:** As a 学習コンテンツの作者, I want 挿入と問い合わせの計算量とメモリを厳密解と比べられること, so that 相対誤差型の手法が件数によらず小さい費用で済む理由と、精度との引き換えを実測で確かめられる

#### Acceptance Criteria
1. While 投入された値のバケットが DDSketch の保持している範囲に収まる間, the Relative Error Sketches shall 値の投入1回あたりの操作数を、投入済みの件数にもバケット数にも依存しない一定の上限に収める。
2. When DDSketch への投入で保持している範囲の拡張または縮約が起きたとき, the Relative Error Sketches shall その投入1回の操作数を、投入済みの件数に依存させず、バケット数の上限に比例する範囲に収める。
3. The Relative Error Sketches shall HDR Histogram の値の投入1回あたりの操作数を、投入済みの件数にもバケットの総数にも依存しない一定の上限に収める。
4. When 分位点が問い合わせられたとき, the Relative Error Sketches shall 問い合わせ1回あたりの操作数を、投入済みの件数に依存させず、保持しているバケット数(DDSketch は保持している範囲の長さ、HDR Histogram はバケットの総数)に比例する範囲に収める。
5. The Relative Error Sketches shall メモリ見積もりを、percentile-lab-core の見積もり規則に従って、保持しているバケットの件数と設定値の個数だけから算出し、投入済みの件数に依存させない。DDSketch の見積もりはバケット数の上限で決まる値を超えず、HDR Histogram の見積もりは作成時から変わらない。
6. When α を小さくする、または有効桁数を大きくして同じ条件で計測したとき, the Relative Error Sketches shall バケット数とメモリ見積もりが増えることを、実測で確認できるようにする。
7. When 投入件数を増やして同じ条件で計測したとき, the Relative Error Sketches shall 厳密解では件数とともに増えるメモリ見積もりが、両手法では件数に対して増えないことを、実測で比較できるようにする。

### Requirement 8: 誤差・バケット数・費用の実験データの出力
**Objective:** As a 学習コンテンツの作者, I want 設定と分布を変えた誤差・バケット数・費用を同じ条件で測り、構造化された形で得られること, so that 相対誤差保証の挙動を再現可能に確かめ、後続のサイトで表示できる

#### Acceptance Criteria
1. When 分布、件数、シード、分位点の一覧、α の一覧、バケット数の上限の一覧、有効桁数の一覧、HDR Histogram の値の範囲が指定されたとき, the Relative Error Sketches shall 設定ごとに両手法を作り、percentile-lab-core の計測ハーネスで厳密解と同じデータに対して計測する。
2. When 計測が完了したとき, the Relative Error Sketches shall 条件ごとに、絶対誤差、順位誤差、相対誤差、操作数、メモリ見積もりを、percentile-lab-core の結果の形式のまま返す。
3. When 計測が完了したとき, the Relative Error Sketches shall 条件と手法の組ごとに、全件投入後の保持しているバケット数、件数が 1 以上のバケットの個数、縮約の有無(DDSketch のみ)を、どの条件のどの手法の値かを読み取れる形で返す。
4. The Relative Error Sketches shall 実験の結果を、保存や他の実行環境への受け渡しができる直列化可能な構造で返し、設定・分布などの実験条件を結果から読み取れるようにする。
5. When 同じ実験条件で再度実行されたとき, the Relative Error Sketches shall 処理時間を除くすべての項目で同じ結果を返す。
6. When 複数の分布(少なくとも一様、正規、対数正規、重い裾、多峰)が指定されたとき, the Relative Error Sketches shall 分布ごとの結果を並べて取得できるようにする。
7. Where 厳密解の定義が指定されたとき, the Relative Error Sketches shall その定義で厳密値を計算する。相対誤差の上限の検証には最近順位法を使えるようにする。
8. If HDR Histogram の値の範囲が、生成したデータの値の一部を扱えない範囲である, then the Relative Error Sketches shall 範囲外の値が投入できなかったことを、その条件のその手法の結果にエラーとして記録し、残りの手法と条件の計測を続ける。
9. If 実験条件の指定が不正である(一覧が空である、α やバケット数の上限や有効桁数が不正である、など), then the Relative Error Sketches shall 不正な指定であることを示すエラーを返し、部分的な結果を返さない。

### Requirement 9: 保証の検証と文書化
**Objective:** As a 学習コンテンツの作者, I want 相対誤差保証の成り立ち方と、順位誤差型の手法との向き不向きを、実験に基づいて説明できること, so that 場面に応じて手法を選べるようになる

#### Acceptance Criteria
1. The Relative Error Sketches shall DDSketch の対数マッピングと代表値の決め方、相対誤差が α 以下になる理由、それが値の大きさ(桁)によらず成り立つ理由を、数値例を添えて文書化する。
2. The Relative Error Sketches shall HDR Histogram の副バケット数とバケット構造、有効桁数と相対誤差の上限の関係、(S / 2) × L 未満の値では絶対誤差の上限に変わることを、数値例を添えて文書化する。
3. The Relative Error Sketches shall 値の大きさが桁で異なる複数の分布の条件で、縮約が起きない DDSketch の最近順位法に対する相対誤差の最大値が α 以下であることを、実験結果を添えて文書化する。
4. The Relative Error Sketches shall α と有効桁数を変えたときの相対誤差、バケット数、メモリ見積もりの変化を、理論上のバケット数の目安と並べて、実験結果を添えて文書化する。
5. The Relative Error Sketches shall バケット数の上限が小さく縮約が起きた場合に、低い分位点では相対誤差の上限が破れ、高い分位点では保たれることを、実験結果を添えて文書化する。
6. The Relative Error Sketches shall 相対誤差型の手法が有利な場面(値の範囲が広い分布、重い裾、高い分位点)と不利な場面(狭い範囲に値が集中し、多くの値が同じバケットに入るため順位誤差が大きくなる分布)を、この spec の実験で得た相対誤差と順位誤差、および順位誤差型の手法の保証の性質(順位のずれを件数の一定割合以下に抑える)と対比して文書化する。
7. The Relative Error Sketches shall sketch 同士のマージが可能である理由を、概念の説明として文書化する。マージの実装と性能評価は行わない。
8. The Relative Error Sketches shall 文書中の数値例と実験結果が、実際の実装の出力と一致していることを、自動テストで確認する。
9. The Relative Error Sketches shall 文書化した関係(誤差の上限、縮約が起きない間の保証、バケット数とメモリの増え方)が成り立つことを、複数の分布とシードに対する性質テストで確認する。

### Requirement 10: 実行環境とテスト可能性
**Objective:** As a 学習コンテンツの作者, I want 両手法がブラウザなしで動かせ、自動テストで確かめられること, so that 後続のサイト基盤が安心して依存できる

#### Acceptance Criteria
1. The Relative Error Sketches shall ブラウザや画面描画の機能がない実行環境でも、すべての機能を実行できるようにする。
2. When 開発者がテストの実行を指示したとき, the Relative Error Sketches shall この spec のすべての機能の自動テストを、既存の spec のテストと同じ1つの操作で実行し、成功または失敗を報告する。
3. The Relative Error Sketches shall 新たな外部依存を追加せず、追加する場合は percentile-lab-core のライセンス判定を通過する範囲に限る。
4. When 後続の spec がこの機能を利用するとき, the Relative Error Sketches shall 内部の構成を知らなくても、両手法の作成、マッピングの計算、内部状態の観察、実験データの取得を行えるようにする。
