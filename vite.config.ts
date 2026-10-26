import { relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * メインスレッドの bundle を構成するモジュールの一覧を dist/.vite/main-modules.json に書き出す。
 * `plugins` はメインの組み立てだけに効く(Worker は `worker.plugins` の別の組み立て)ので、
 * Worker の bundle に入る上流のモジュールは一覧に現れない。scripts/check-main-modules.mjs が読む。
 */
function mainModulesPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'percentile-lab:main-modules',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        for (const id of item.moduleIds) {
          if (id.startsWith('\0')) continue;
          modules.add(relative(root, id).split(sep).join('/'));
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: '.vite/main-modules.json',
        source: JSON.stringify([...modules].sort(), null, 2) + '\n',
      });
    },
  };
}

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
  worker: { format: 'es' },
  plugins: [mainModulesPlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
