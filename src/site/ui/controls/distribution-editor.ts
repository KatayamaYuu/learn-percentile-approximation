// 分布の種類とパラメータの入力。多峰は 2 山(重み・平均・標準偏差)を編集する(2.1、2.5)。
// パラメータの条件(正の値など)は上流が検証するので、ここでは数値であることだけを確かめる。
import type { Distribution } from '../../../core';
import { DISTRIBUTION_PRESETS } from '../../shared/conditions';
import type { DistributionKind } from '../../shared/conditions';
import { createEmitter } from './control';
import type { ControlBase } from './control';
import { createFieldReason } from './field-errors';
import { createNumberField } from './number-field';

export interface DistributionEditor extends ControlBase<Distribution> {
  /** パラメータ 1 つのそばに理由を出す。キーは 'sigma'、上流の 'modes[1].mean' など。山の全体('modes')など項目のないキーは分布全体の理由に出す。null で消す */
  setParamIssue(key: string, reason: string | null): void;
}

const KIND_LABELS: Readonly<Record<DistributionKind, string>> = {
  uniform: '一様',
  normal: '正規',
  lognormal: '対数正規',
  'heavy-tail': '重い裾',
  multimodal: '多峰',
};
const KINDS = Object.keys(KIND_LABELS) as DistributionKind[];

interface ParamSpec {
  readonly key: string;
  readonly label: string;
}

function paramSpecs(d: Distribution): ParamSpec[] {
  switch (d.kind) {
    case 'uniform':
      return [
        { key: 'min', label: '最小値' },
        { key: 'max', label: '最大値' },
      ];
    case 'normal':
      return [
        { key: 'mean', label: '平均' },
        { key: 'stdDev', label: '標準偏差' },
      ];
    case 'lognormal':
      return [
        { key: 'mu', label: 'μ(対数の平均)' },
        { key: 'sigma', label: 'σ(対数の標準偏差)' },
      ];
    case 'heavy-tail':
      return [
        { key: 'scale', label: '尺度' },
        { key: 'shape', label: '形状' },
      ];
    case 'multimodal':
      return d.modes.flatMap((_, i) => [
        { key: `modes.${i}.weight`, label: `山 ${i + 1} の重み` },
        { key: `modes.${i}.mean`, label: `山 ${i + 1} の平均` },
        { key: `modes.${i}.stdDev`, label: `山 ${i + 1} の標準偏差` },
      ]);
  }
}

function getParam(d: Distribution, key: string): number {
  if (d.kind === 'multimodal') {
    const [, i, f] = key.split('.');
    const mode = d.modes[Number(i)]!;
    return mode[f as 'weight' | 'mean' | 'stdDev'];
  }
  return (d as unknown as Record<string, number>)[key]!;
}

function withParam(d: Distribution, key: string, value: number): Distribution {
  if (d.kind === 'multimodal') {
    const [, i, f] = key.split('.');
    return {
      kind: 'multimodal',
      modes: d.modes.map((m, idx) => (idx === Number(i) ? { ...m, [f as string]: value } : m)),
    };
  }
  return { ...d, [key]: value } as Distribution;
}

export function createDistributionEditor(initial: Distribution, idPrefix = 'distribution'): DistributionEditor {
  const root = document.createElement('fieldset');
  root.className = 'control control-distribution';
  const legend = document.createElement('legend');
  legend.textContent = '分布';
  root.append(legend);

  const kindId = `${idPrefix}-kind`;
  const kindRow = document.createElement('div');
  kindRow.className = 'control';
  const kindLabel = document.createElement('label');
  kindLabel.htmlFor = kindId;
  kindLabel.textContent = '分布の種類';
  const kindSelect = document.createElement('select');
  kindSelect.id = kindId;
  for (const k of KINDS) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = KIND_LABELS[k];
    kindSelect.append(o);
  }
  kindRow.append(kindLabel, kindSelect);

  const params = document.createElement('div');
  params.className = 'control-params';
  const whole = createFieldReason(idPrefix, [root]);
  root.append(kindRow, params, whole.element);

  let current: Distribution = initial;
  const fields = new Map<string, ControlBase<number>>();
  const emitter = createEmitter<Distribution>();

  const build = (): void => {
    params.replaceChildren();
    fields.clear();
    kindSelect.value = current.kind;
    for (const spec of paramSpecs(current)) {
      const field = createNumberField(
        { id: `${idPrefix}-${spec.key.replace(/\./g, '-')}`, label: spec.label, integer: false },
        getParam(current, spec.key),
      );
      field.onChange((v) => {
        current = withParam(current, spec.key, v);
        emitter.emit(current);
      });
      fields.set(spec.key, field);
      params.append(field.element);
    }
  };
  build();

  kindSelect.addEventListener('change', () => {
    current = DISTRIBUTION_PRESETS[kindSelect.value as DistributionKind];
    whole.show(null);
    build();
    emitter.emit(current);
  });

  return {
    element: root,
    value: () => current,
    setValue(value) {
      current = value;
      whole.show(null);
      build();
    },
    setIssue: (r) => whole.show(r),
    setParamIssue(key, r) {
      // 上流の書式 'modes[1].stdDev' を内部のキー 'modes.1.stdDev' に直す
      const k = key.replace(/\[(\d+)\]/g, '.$1');
      const field = fields.get(k);
      // 項目に対応しないキー('modes' 全体など)は分布全体の理由に出す
      if (field !== undefined) field.setIssue(r);
      else whole.show(r);
    },
    onChange: emitter.on,
  };
}
