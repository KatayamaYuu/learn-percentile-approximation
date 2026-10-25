// 起動ファイル。スタイル・グラフ部品の登録・ルーティング・実際の Worker の生成をつなぐ。
import './ui/styles/site.css';
import { setupChart } from './ui/components/chart-setup';
import { createComputeClient } from './ui/compute/compute-client';
import { createWorker } from './ui/compute/worker-factory';
import { createConditionStore } from './ui/condition-store';
import { startRouter } from './ui/router';

const root = document.getElementById('app');
if (root !== null) {
  setupChart();
  startRouter(root, {
    store: createConditionStore(),
    announce: () => {},
    createCompute: () => createComputeClient(createWorker),
  });
}
