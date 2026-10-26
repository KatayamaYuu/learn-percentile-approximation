// Chart.js の部品登録。使う部品だけを登録し、chart.js/auto は使わない(11.5)。
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  LogarithmicScale,
  PointElement,
  ScatterController,
  Title,
  Tooltip,
} from 'chart.js';

let registered = false;

/** 何度呼んでも登録は 1 回だけ */
export function setupChart(): void {
  if (registered) return;
  registered = true;
  Chart.register(
    LineController,
    ScatterController,
    BarController,
    LineElement,
    PointElement,
    BarElement,
    LinearScale,
    LogarithmicScale,
    CategoryScale,
    Tooltip,
    Legend,
    Title,
  );
}
