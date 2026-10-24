import { err, ok, type Result } from '../foundation/result';

export interface Rng {
  nextUint32(): number;
  /** [0, 1) */
  nextFloat(): number;
  /** (0, 1]。対数や割り算に使う */
  nextFloatOpen(): number;
  /** [0, bound)。bound は 1 以上 2^32 以下の整数 */
  nextIntBelow(bound: number): number;
}

const TWO_32 = 2 ** 32;
// 混合後の状態の先頭を読み捨てる個数(シード間の相関を除く)
const WARMUP = 20;

/** splitmix32 風の混合。state を進め、混合した 32 ビット値を返す。 */
function mixStep(state: number): { readonly state: number; readonly out: number } {
  const next = (state + 0x9e3779b9) >>> 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z = (z ^ (z >>> 16)) >>> 0;
  return { state: next, out: z };
}

export function createRng(seed: number): Result<Rng, { readonly kind: 'invalid-seed' }> {
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed >= TWO_32) {
    return err({ kind: 'invalid-seed' });
  }

  let s = seed;
  const init: number[] = [];
  for (let i = 0; i < 4; i++) {
    const m = mixStep(s);
    s = m.state;
    init.push(m.out);
  }
  let a = init[0]! >>> 0;
  let b = init[1]! >>> 0;
  let c = init[2]! >>> 0;
  let d = init[3]! >>> 0;

  const nextUint32 = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = (((c << 21) | (c >>> 11)) + t) >>> 0;
    return t;
  };
  for (let i = 0; i < WARMUP; i++) nextUint32();

  const rng: Rng = {
    nextUint32,
    nextFloat: () => nextUint32() / TWO_32,
    nextFloatOpen: () => (nextUint32() + 1) / TWO_32,
    nextIntBelow: (bound: number): number => {
      if (!Number.isInteger(bound) || bound < 1 || bound > TWO_32) {
        throw new RangeError('bound must be an integer in [1, 2^32]');
      }
      // 剰余の偏りを避けるため、bound の倍数に収まらない端を棄却する
      const limit = Math.floor(TWO_32 / bound) * bound;
      let x = nextUint32();
      while (x >= limit) x = nextUint32();
      return x % bound;
    },
  };
  return ok(rng);
}
