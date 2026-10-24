# パーセンタイル定義

このリポジトリは、パーセンタイルの値を5種類の定義で計算できる。基準値(厳密解)を求める関数は`exactQuantileSorted(data, q, definition)`で、昇順に整列したFloat64Arrayと0以上1以下の分位点qを受け取る。定義を省略すると`linear`を使う。実装は`src/core/quantile/definitions.ts`と`src/core/quantile/reference.ts`にある。

## 5つの定義

件数をn、昇順に並べた値をx[0]からx[n-1]とする。添字は0始まりで書く。

nearest-rankはceil(n·q)番目の値を返す。順位は1始まりで、1未満なら1、n超ならnに収める。補間をしないので、返す値は必ずデータの中にある。

残りの4つは、位置h = (n-1)·qを使う。hを0以上n-1以下に収め、下側の添字をlo = floor(h)、上側の添字をhi = ceil(h)、小数部をfrac = h - loとする。hiはloかlo+1になる。

- linearはx[lo] + (x[hi] - x[lo])·fracを返す
- lowerはx[lo]を返す
- higherはx[hi]を返す
- midpointは(x[lo] + x[hi]) / 2を返す

linearとmidpointの結果は、浮動小数点の誤差でx[lo]とx[hi]の外に出ないよう、この範囲に収めてから返す。

## 例[10, 20, 30, 40]とq = 0.4

n = 4なので(n-1)·q = 3 × 0.4からh = 1.2になり、lo = 1、hi = 2、fracは約0.2になる。下側の値は20、上側の値は30である。nearest-rankはceil(4 × 0.4) = ceil(1.6) = 2より2番目の値を取る。

|定義|値|
| --- | --- |
| nearest-rank | 20 |
| linear | 22 |
| lower | 20 |
| higher | 30 |
| midpoint | 25 |

この表の値は`src/core/docs-examples.test.ts`が実装から再計算して確かめている。

## 浮動小数点の丸め処理

n·qや(n-1)·qは、数学的には整数になる場合でも、2進数の浮動小数点では整数からわずかにずれることがある。たとえば100 × 0.07は7.000000000000001になる。そのまま切り上げると8番目の値を選んでしまい、数学的に正しい7番目と食い違う。

そこで実装は、n·qと(n-1)·qを使う前に次の規則で整数へ丸める。最も近い整数rを求め、元の値xとの差が1e-9 × max(1, |x|)以下ならrを採用し、そうでなければxのまま使う。この許容幅はxの大きさに比例し、xが1以下でも1e-9を下回らない。丸めの対象は順位と位置の計算だけで、データの値には手を加えない。

この規則により、n = 100、q = 0.07のnearest-rankは7番目になる。linearでもn = 101、q = 0.07のときhは7に丸まり、fracは0になってx[7]をそのまま返す。

## NumPyとの対応

linear、lower、higher、midpointは、`numpy.percentile`の`method`に同名の値を指定した結果と、浮動小数点の丸め規則を除いて一致する。このリポジトリは位置が整数に近いとき前節の許容幅で整数へ丸めるが、NumPyはこの丸めをしないので、境界の分位点では結果がごくわずかにずれることがある。たとえば`numpy.percentile([10, 20, 30, 40], 40, method="linear")`は22.0を返す。NumPyはqを0から100の百分率で受け取り、このリポジトリは0から1の割合で受け取る点も異なる。

nearest-rankはNumPyの`nearest`と別の定義である。nearest-rankはceil(n·q)番目の値を取る古典的な最近順位法で、NumPyでは`inverted_cdf`に対応する。NumPyの`nearest`は位置(n-1)·qを最も近い整数へ丸め、ちょうど中間のときは偶数側へ丸めて選ぶ。[10, 20, 30, 40]とq=0.5では、nearest-rankはceil(4 × 0.5) = 2より2番目の値20を返す。一方NumPyの`nearest`はh = 1.5を偶数側の2へ丸めてx[2] = 30を返す。誤差指標の目標順位には、一貫してnearest-rankを使う(error-metrics.mdを参照)。
