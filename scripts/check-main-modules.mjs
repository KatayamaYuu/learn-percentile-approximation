// dist/.vite/main-modules.json(メインの bundle を構成するモジュールの一覧)を読み、
// 起動ファイルを含むこと、上流 4 系統のファイルが 1 つもないことを確かめる(11.5)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const listPath = fileURLToPath(new URL('../dist/.vite/main-modules.json', import.meta.url));
const UPSTREAM_PREFIXES = ['src/core/', 'src/histogram/', 'src/streaming/', 'src/relative-error/'];
const ENTRY = 'src/site/main.ts';

let modules;
try {
  modules = JSON.parse(readFileSync(listPath, 'utf8'));
} catch {
  console.error('dist/.vite/main-modules.json を読めません。先に npm run build を実行してください。');
  process.exit(1);
}
if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string')) {
  console.error('main-modules.json の形式が不正です(文字列の配列が必要です)。');
  process.exit(1);
}

let failed = false;
if (!modules.includes(ENTRY)) {
  console.error(`メインの bundle に ${ENTRY} が含まれていません(一覧が空か、別の組み立ての結果です)。`);
  failed = true;
}
const violations = modules.filter((m) => UPSTREAM_PREFIXES.some((p) => m.startsWith(p)));
for (const v of violations) console.error(`メインの bundle に上流のモジュールがあります: ${v}`);
if (violations.length > 0) failed = true;

if (failed) process.exit(1);
console.log(`メインの bundle のモジュール ${modules.length} 件: 起動ファイルを含み、上流のモジュールはありません。`);
