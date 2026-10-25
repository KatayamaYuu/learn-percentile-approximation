// ストリーミング分位点のページ(5.1〜5.9、9.2、9.6)。
// 共通のデータ条件、手法の選択、GK の ε・KLL の k・t-digest の δ とスケール関数、KLL の試行の回数、内部状態の対象の
// 操作部品を置き、ストリーミングの表示、内部状態の図と表、解説(GK、KLL、t-digest)と手引きを PageKit につなぐ。
import type { ScaleFunctionKind } from '../../../streaming';
import { ALGORITHM_EXPLAINERS } from '../../content/algorithms';
import { HOME_CONTENT } from '../../content/guides';
import { PAGE_DEFAULTS, type StreamingMethod, type StreamingPageCondition } from '../../shared/conditions';
import { formatInt, formatSig3 } from '../../shared/format';
import { compressionGrid, epsilonGrid, kGrid } from '../../shared/grids';
import { COMPRESSION_RANGE, EPSILON_RANGE, K_RANGE, TRIALS_RANGE } from '../../shared/limits';
import { validateStreamingPage } from '../../shared/validate';
import { buildStreamingCharts } from '../../shared/views/streaming-view';
import { createExplainer } from '../components/explainer';
import { createStateTable } from '../components/state-table';
import { createChoice } from '../controls/choice';
import { createSlider } from '../controls/slider';
import type { PageModule } from '../page-registry';
import { createDataControls } from './data-controls';
import { mountPageKit, reasonFor, type PageKitDeps, type PageSpec } from './page-kit';

const METHOD_CHOICES = [
  { value: 'gk', label: 'GK' },
  { value: 'kll', label: 'KLL' },
  { value: 'tdigest', label: 't-digest' },
] as const satisfies readonly { value: StreamingMethod; label: string }[];

const SCALE_CHOICES = [
  { value: 'k0', label: 'k0' },
  { value: 'k1', label: 'k1' },
  { value: 'k2', label: 'k2' },
] as const satisfies readonly { value: ScaleFunctionKind; label: string }[];

const STREAMING_TITLE = HOME_CONTENT.families.find((f) => f.page === 'streaming')?.title ?? 'ストリーミング分位点';

export const streamingPageSpec: PageSpec<'streaming'> = {
  id: 'streaming',
  defaults: PAGE_DEFAULTS.streaming,
  toJob: (condition) => ({ kind: 'streaming', condition }),
  validate: validateStreamingPage,
  createControls(host) {
    const initial = host.initial;
    const data = createDataControls({
      idPrefix: 'stream',
      host: { initial: initial.data, update: (fn) => host.update((c) => ({ ...c, data: fn(c.data) })) },
    });
    const methods = createChoice(
      { id: 'stream-methods', label: '表示する手法', choices: METHOD_CHOICES, multiple: true },
      initial.methods,
    );
    const epsilon = createSlider(
      {
        id: 'stream-epsilon',
        label: 'GK の ε(許容する順位誤差)',
        values: epsilonGrid(initial.epsilon),
        allowFreeInput: true,
        format: formatSig3,
        min: EPSILON_RANGE.min,
        max: EPSILON_RANGE.max,
      },
      initial.epsilon,
    );
    const k = createSlider(
      {
        id: 'stream-k',
        label: 'KLL の k(容量の基準)',
        values: kGrid(initial.k),
        allowFreeInput: true,
        format: formatInt,
        min: K_RANGE.min,
        max: K_RANGE.max,
        integer: true,
      },
      initial.k,
    );
    const compression = createSlider(
      {
        id: 'stream-compression',
        label: 't-digest の δ(圧縮度)',
        values: compressionGrid(initial.compression),
        allowFreeInput: true,
        format: formatSig3,
        min: COMPRESSION_RANGE.min,
        max: COMPRESSION_RANGE.max,
      },
      initial.compression,
    );
    const scales = createChoice(
      { id: 'stream-scales', label: 't-digest のスケール関数', choices: SCALE_CHOICES, multiple: true },
      initial.scales,
    );
    const trials = createSlider(
      {
        id: 'stream-trials',
        label: 'KLL の試行の回数',
        unit: '回',
        values: Array.from({ length: TRIALS_RANGE.max - TRIALS_RANGE.min + 1 }, (_, i) => TRIALS_RANGE.min + i),
        allowFreeInput: true,
        format: formatInt,
        min: TRIALS_RANGE.min,
        max: TRIALS_RANGE.max,
        integer: true,
      },
      initial.trials,
    );
    const inspect = createChoice(
      { id: 'stream-inspect', label: '内部状態を表示する手法', choices: METHOD_CHOICES, multiple: false },
      [initial.inspectTarget],
    );

    methods.onChange((v) => host.update((c) => ({ ...c, methods: v })));
    epsilon.onChange((v) => host.update((c) => ({ ...c, epsilon: v })));
    k.onChange((v) => host.update((c) => ({ ...c, k: v })));
    compression.onChange((v) => host.update((c) => ({ ...c, compression: v })));
    scales.onChange((v) => host.update((c) => ({ ...c, scales: v })));
    trials.onChange((v) => host.update((c) => ({ ...c, trials: v })));
    inspect.onChange((v) => host.update((c) => ({ ...c, inspectTarget: v[0] ?? c.inspectTarget })));

    return {
      elements: [
        ...data.elements,
        methods.element,
        epsilon.element,
        k.element,
        compression.element,
        scales.element,
        trials.element,
        inspect.element,
      ],
      setCondition(c: StreamingPageCondition) {
        data.setValue(c.data);
        methods.setValue(c.methods);
        epsilon.setValue(c.epsilon);
        k.setValue(c.k);
        compression.setValue(c.compression);
        scales.setValue(c.scales);
        trials.setValue(c.trials);
        inspect.setValue([c.inspectTarget]);
      },
      showIssues(issues) {
        data.showIssues(issues);
        methods.setIssue(reasonFor(issues, 'methods'));
        epsilon.setIssue(reasonFor(issues, 'epsilon'));
        k.setIssue(reasonFor(issues, 'k'));
        compression.setIssue(reasonFor(issues, 'compression'));
        scales.setIssue(reasonFor(issues, 'scales'));
        trials.setIssue(reasonFor(issues, 'trials'));
        inspect.setIssue(reasonFor(issues, 'inspectTarget'));
      },
    };
  },
  buildView(result, condition, selection) {
    if (result.kind !== 'streaming') return null;
    const built = buildStreamingCharts(result, condition, { selection });
    const table = createStateTable();
    table.show(built.inspection);
    return { charts: [...built.charts, built.inspection.chart], extras: [table.element] };
  },
  createExplainer: () =>
    createExplainer({
      page: 'streaming',
      explainers: ALGORITHM_EXPLAINERS.filter((e) => e.page === 'streaming'),
    }),
};

export const streamingPage: PageModule = {
  id: 'streaming',
  path: '/streaming',
  title: STREAMING_TITLE,
  navLabel: STREAMING_TITLE,
  mount(container, context) {
    return mountPageKit(streamingPageSpec, container, context);
  },
};

/** テスト用に、描画層を差し替えて組み立てる */
export function mountStreamingPage(container: HTMLElement, context: Parameters<PageModule['mount']>[1], deps: PageKitDeps) {
  return mountPageKit(streamingPageSpec, container, context, deps);
}
