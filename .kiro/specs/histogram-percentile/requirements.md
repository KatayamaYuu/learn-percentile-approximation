# Requirements Document

## Project Description (Input)
固定バケットのヒストグラムによる近似は監視系で広く使われるが、バケット幅や分布の形によって誤差がどう出るかを直感的に掴みにくい。学習者本人が実装と実験で確かめたい。

目指す状態は次のとおり。
- 固定幅と任意境界のバケットによるヒストグラム近似が実装されている。
- バケット内の線形補間で分位点を推定できる。
- バケット数、バケット幅、分布の形を変えたときの誤差を計測でき、裾やバケット境界付近で誤差が大きくなる理由を実験で説明できる。
- 計算量(挿入 O(1)、問い合わせ O(バケット数))とメモリを厳密解と比較できる。

詳細は同ディレクトリの `brief.md` を参照。

## Introduction
Histogram Percentile は、固定バケットのヒストグラムでパーセンタイルを近似するアルゴリズムと、その誤差・計算量を実験で確かめる仕組みを提供する。バケット境界の決め方(等幅、指数幅、任意境界)を切り替えながら、バケット数や分布の形が誤差に与える影響を、percentile-lab-core の共通規約・誤差指標・計測ハーネスの上で測れるようにする。利用者は、学習のために実験する作者本人である。

## Boundary Context
- **In scope**:
  - 固定バケットのヒストグラムによる近似アルゴリズム(境界の決め方は等幅、指数幅、任意境界の3種)
  - バケット内の線形補間による分位点の推定
  - バケット数・バケット幅・分布を変えた誤差と、操作数・メモリの実験データの出力
  - 誤差の出方(裾、バケット境界付近)と計算量・メモリの特性の文書化
- **Out of scope**:
  - 学習ページ、グラフ描画、パラメータ操作 UI
  - 動的にバケットを調整する手法(t-digest など)
  - 相対誤差の保証を目的とした手法(DDSketch、HDR Histogram)
  - 厳密解、データ生成、誤差指標の定義(percentile-lab-core の所掌)
  - バケット境界の範囲外にある値の扱いの拡張(範囲外は拒否する。下記 Requirement 1)
- **Adjacent expectations**:
  - この spec は percentile-lab-core の共通操作規約、誤差指標、計測ハーネス、データ生成、厳密解をそのまま利用し、独自の誤差定義を持たない。
  - 指数幅の境界は固定された境界列であり、相対誤差の上限は保証しない。相対誤差を保証する手法は relative-error-sketches の対象であり、この spec はその境界の定義を持たない。
  - percentile-lab-site は、この spec が出力する実験データを表示に使う。表示形式はこの spec の対象外である。

## Requirements

### Requirement 1: バケット境界の定義
**Objective:** As a 学習コンテンツの作者, I want 等幅・指数幅・任意境界のいずれかでバケット境界を決められること, so that 境界の決め方が誤差に与える影響を比べられる

#### Acceptance Criteria
1. The Histogram Percentile shall バケット境界の決め方として、等幅、指数幅、事前指定した任意境界の3種を提供する。
2. When 等幅が選ばれ、下限・上限・バケット数が指定されたとき, the Histogram Percentile shall 下限から上限までを等しい幅のバケットに分割する。
3. When 指数幅が選ばれ、下限・上限・バケット数が指定されたとき, the Histogram Percentile shall 隣り合う境界の比が一定になるようにバケットを分割する。
4. When 任意境界が選ばれ、昇順の境界列が指定されたとき, the Histogram Percentile shall 隣り合う境界の間をそれぞれ1つのバケットとする。
5. The Histogram Percentile shall 各バケットを、下側の境界を含み上側の境界を含まない区間とする。ただし最後のバケットは上側の境界も含む。
6. If 境界が有限の正の数でない、下限が上限以上である、バケット数が正の整数でない、あるいは任意境界が狭義単調増加でない・2個未満である, then the Histogram Percentile shall 不正な指定であることを示すエラーを返し、アルゴリズムを作成しない。
7. When 全体の下限以上かつ上限以下の値が投入されたとき, the Histogram Percentile shall その値を、含まれるバケットの件数に反映する。
8. If 全体の下限未満または上限より大きい有限の正の数が投入された, then the Histogram Percentile shall 扱える範囲外であることを示すエラーを返し、内部状態・操作数・メモリ見積もりを変更しない。
9. The Histogram Percentile shall 扱える値の範囲(下限以上、上限以下)を、共通規約が定める扱える値域として宣言する。

### Requirement 2: 共通規約への適合
**Objective:** As a 学習コンテンツの作者, I want ヒストグラム近似が他のアルゴリズムと同じ操作で扱えること, so that 厳密解と入れ替えて同じ実験コードで比較できる

#### Acceptance Criteria
1. The Histogram Percentile shall percentile-lab-core の共通操作規約(値の投入、分位点の問い合わせ、メモリ見積もり、操作数、初期化)に従う。
2. The Histogram Percentile shall percentile-lab-core の適合確認を、3種の境界の決め方のそれぞれについて通過する。
3. When 同じ境界の指定と同じ入力列が与えられたとき, the Histogram Percentile shall 同じ推定値、操作数、メモリ見積もりを返す。この性質は乱数を使わず、シードに依存しない。
4. When 初期化が実行されたとき, the Histogram Percentile shall 境界の指定を保ったまま、件数・操作数を作成直後の状態に戻す。
5. The Histogram Percentile shall バケット数・下限・上限・境界の決め方など、実験条件を表すパラメータを結果に写せる形で公開する。

### Requirement 3: 線形補間による分位点の推定
**Objective:** As a 学習コンテンツの作者, I want バケット内で線形補間して分位点を推定できること, so that バケット幅より細かい精度の推定と、その限界を確かめられる

#### Acceptance Criteria
1. When 0 より大きく 1 以下の分位点 q が指定され、投入済みの件数が n のとき, the Histogram Percentile shall 目標順位を q × n とし、累積件数が初めて目標順位以上になるバケットを選ぶ。
2. When バケットが選ばれたとき, the Histogram Percentile shall 推定値を、選ばれたバケットの下側の境界から上側の境界までを、(目標順位 − 選ばれたバケットより前の累積件数) ÷ 選ばれたバケットの件数 の割合で線形補間した値とする。
3. When 分位点 0 が指定されたとき, the Histogram Percentile shall 件数が 1 以上の最初のバケットの下側の境界を返す。
4. When 同じバケットに全件が入っているとき, the Histogram Percentile shall 分位点に応じて、そのバケットの下側の境界から上側の境界までの間の値を返す。
5. The Histogram Percentile shall 推定値を、常に有限の正の数、かつ選ばれたバケットの下側の境界以上、上側の境界以下の値とする。
6. When 分位点が大きくなるとき, the Histogram Percentile shall 同じ投入済みの値に対して、推定値が単調に減少しない結果を返す。
7. The Histogram Percentile shall 最近順位法による厳密値と、その推定値が同じバケットに含まれることを保つ。したがって絶対誤差は、そのバケットの幅を超えない。
8. If 1 件も投入されていない状態で分位点が問い合わせられた, then the Histogram Percentile shall 共通規約が定める、データが空であることを示すエラーを返す。
9. If 0 未満または 1 より大きい分位点が指定された, then the Histogram Percentile shall 共通規約が定める、範囲外であることを示すエラーを返し、内部状態を変更しない。

### Requirement 4: 計算量とメモリの特性
**Objective:** As a 学習コンテンツの作者, I want 挿入と問い合わせの計算量とメモリを厳密解と比べられること, so that ヒストグラムが件数によらず小さい費用で済む理由を実測で確かめられる

#### Acceptance Criteria
1. While 等幅または指数幅が選ばれている間, the Histogram Percentile shall 値の投入1回あたりの操作数を、投入済みの件数にもバケット数にも依存しない一定の上限に収める。
2. While 任意境界が選ばれている間, the Histogram Percentile shall 値の投入1回あたりの操作数を、投入済みの件数に依存せず、バケット数に対して対数オーダーまでしか増やさない。
3. When 分位点が問い合わせられたとき, the Histogram Percentile shall 問い合わせ1回あたりの操作数を、投入済みの件数に依存させず、バケット数に比例する範囲に収める。
4. The Histogram Percentile shall メモリ見積もりを、percentile-lab-core の見積もり規則に従って、保持しているバケットの件数と境界の個数だけから算出し、投入済みの件数に依存させない。
5. When 投入件数を増やして同じ条件で計測したとき, the Histogram Percentile shall 厳密解では件数とともに増える操作数・メモリ見積もりが、ヒストグラムでは件数に対して増えない(投入の操作数の合計は件数に比例してのみ増える)ことを、実測で比較できるようにする。
6. When バケット数を増やして同じ条件で計測したとき, the Histogram Percentile shall 問い合わせの操作数とメモリ見積もりがバケット数に応じて増えることを、実測で確認できるようにする。

### Requirement 5: 誤差と計算量の実験データの出力
**Objective:** As a 学習コンテンツの作者, I want バケット数・バケット幅・分布を変えた誤差と費用を同じ条件で測り、構造化された形で得られること, so that 誤差の出方を再現可能に確かめ、後続のサイトで表示できる

#### Acceptance Criteria
1. When 分布、件数、シード、分位点の一覧、バケット数の一覧、境界の決め方が指定されたとき, the Histogram Percentile shall バケット数ごとにヒストグラム近似を作り、percentile-lab-core の計測ハーネスで厳密解と同じデータに対して計測する。
2. When 計測が完了したとき, the Histogram Percentile shall 条件ごとに、絶対誤差、順位誤差、相対誤差、操作数、メモリ見積もりを、percentile-lab-core の結果の形式のまま返す。
3. The Histogram Percentile shall 実験の結果を、保存や他の実行環境への受け渡しができる直列化可能な構造で返し、バケット数・境界の決め方・分布などの実験条件を結果から読み取れるようにする。
4. When 同じ実験条件で再度実行されたとき, the Histogram Percentile shall 処理時間を除くすべての項目で同じ結果を返す。
5. When 複数の分布(少なくとも一様、正規、対数正規、重い裾、多峰)が指定されたとき, the Histogram Percentile shall 分布ごとの結果を並べて取得できるようにする。
6. If 指定された境界の範囲が、生成したデータの値の一部を扱えない範囲である, then the Histogram Percentile shall 範囲外の値が投入できなかったことを、その条件の結果にエラーとして記録し、残りの条件の計測を続ける。
7. If 実験条件の指定が不正である(バケット数の一覧が空である、バケット数が正の整数でない、など), then the Histogram Percentile shall 不正な指定であることを示すエラーを返す。

### Requirement 6: 誤差の出方の検証と文書化
**Objective:** As a 学習コンテンツの作者, I want 裾やバケット境界付近で誤差が大きくなる理由を実験で説明できること, so that バケットの決め方と分布の形から誤差を予測できるようになる

#### Acceptance Criteria
1. The Histogram Percentile shall バケット幅と絶対誤差の上限の関係(誤差が選ばれたバケットの幅を超えないこと)を文書化する。
2. The Histogram Percentile shall 等幅の境界では、値の分布が偏る裾で隣り合う値の間隔がバケット幅より大きく、バケットあたりの件数が少なくなるために、線形補間の前提(バケット内で値が一様に散らばる)が崩れて誤差が大きくなることを、実験結果を添えて文書化する。
3. The Histogram Percentile shall 分位点がバケット境界の付近にあるとき、近傍の件数の偏りによって推定値が隣のバケット側にずれうることを、数値例を添えて文書化する。
4. The Histogram Percentile shall 重い裾の分布で、等幅の境界と指数幅の境界の相対誤差がどう異なるかを、同じ条件の実験結果で比較して文書化する。
5. The Histogram Percentile shall 文書中の数値例が、実際の実装の出力と一致していることを、自動テストで確認する。
6. The Histogram Percentile shall 文書化した関係(バケット幅と誤差の上限、バケット数と費用の増え方)が成り立つことを、複数の分布とシードに対する性質テストで確認する。

### Requirement 7: 実行環境とテスト可能性
**Objective:** As a 学習コンテンツの作者, I want ヒストグラム近似がブラウザなしで動かせ、自動テストで確かめられること, so that 後続のサイト基盤が安心して依存できる

#### Acceptance Criteria
1. The Histogram Percentile shall ブラウザや画面描画の機能がない実行環境でも、すべての機能を実行できるようにする。
2. When 開発者がテストの実行を指示したとき, the Histogram Percentile shall この spec のすべての機能の自動テストを percentile-lab-core のテストと同じ1つの操作で実行し、成功または失敗を報告する。
3. The Histogram Percentile shall 新たな外部依存を追加せず、追加する場合は percentile-lab-core のライセンス判定を通過する範囲に限る。
4. When 後続の spec がこの機能を利用するとき, the Histogram Percentile shall 内部の構成を知らなくても、ヒストグラム近似の作成と実験データの取得を行えるようにする。
