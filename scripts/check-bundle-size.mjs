// dist/ 以下のすべての .js を gzip し、合計が 200 KB 以下か確かめる(11.5)。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_BYTES = 200 * 1024;
const distDir = fileURLToPath(new URL('../dist', import.meta.url));

function listJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listJs(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

let files;
try {
  files = listJs(distDir);
} catch {
  console.error('dist/ がありません。先に npm run build を実行してください。');
  process.exit(1);
}
if (files.length === 0) {
  console.error('dist/ に .js がありません。組み立てが成功したか確かめてください。');
  process.exit(1);
}

let total = 0;
for (const file of files.sort()) {
  const size = gzipSync(readFileSync(file)).length;
  total += size;
  console.log(`${(size / 1024).toFixed(2).padStart(8)} KB  ${relative(distDir, file)}`);
}
console.log(`合計(gzip): ${(total / 1024).toFixed(2)} KB / 上限 ${LIMIT_BYTES / 1024} KB`);
if (total > LIMIT_BYTES) {
  console.error('スクリプトの合計が上限を超えています。');
  process.exit(1);
}
