// ページごとの最後の条件をメモリに保持する(2.9)。永続化しないので、再読み込みでは既定値に戻る。
import type { PageConditionMap } from '../shared/conditions';

export interface ConditionStore {
  get<T extends keyof PageConditionMap>(page: T): PageConditionMap[T] | undefined;
  set<T extends keyof PageConditionMap>(page: T, condition: PageConditionMap[T]): void;
}

export function createConditionStore(): ConditionStore {
  const map = new Map<keyof PageConditionMap, PageConditionMap[keyof PageConditionMap]>();
  return {
    get<T extends keyof PageConditionMap>(page: T): PageConditionMap[T] | undefined {
      return map.get(page) as PageConditionMap[T] | undefined;
    },
    set<T extends keyof PageConditionMap>(page: T, condition: PageConditionMap[T]): void {
      map.set(page, condition);
    },
  };
}
