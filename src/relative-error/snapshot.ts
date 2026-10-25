/** 件数が 1 以上のバケット 1 個の観察結果。値はすべて有限の数で、JSON にできる */
export interface BucketView {
  readonly index: number;
  readonly lower: number;
  readonly upper: number;
  readonly representative: number;
  readonly count: number;
}

/** SketchSpec の識別子と表示名の上書き */
export interface SketchSpecOptions {
  readonly id?: string;
  readonly label?: string;
}
