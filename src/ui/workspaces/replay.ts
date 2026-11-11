import type { WebRunBundle } from '../../app/types.js';
import { formatNumber, formatPercent } from '../../app/view-model.js';
import { badge, card, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

export function renderReplay(root: HTMLElement, app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  const imported = app.importedBundle;
  const fileInput = h('input', {
    id: 'replay-file',
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onChange: (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file !== undefined) void app.importFile(file);
    },
  });

  root.append(
    h('div', { class: 'span-12' }, [
      snapshot.replay === null
        ? null
        : h('div', { class: 'replay-banner' }, [
            h('strong', { text: `回放模式：${snapshot.replay.mode}` }),
            h('span', {
              text: ` · 策略 ${snapshot.replay.policyVersion} · 起始 tick ${snapshot.replay.fromTick} · replay_invalid ${snapshot.replay.replayInvalid}`,
            }),
          ]),
      h('div', { style: 'height:12px' }),
      card('导入、导出与回放', [
        h('div', { class: 'actions-row' }, [
          h('button', {
            class: 'btn btn-primary',
            text: '导出当前 run',
            disabled: snapshot.runId === null,
            onClick: () => app.downloadBundle(),
          }),
          h('label', { class: 'btn', for: 'replay-file', text: '导入离线 bundle' }),
          fileInput,
          h('button', {
            class: 'btn',
            text: '从头回放',
            disabled: snapshot.replay === null,
            onClick: () => app.controller.startReplay(),
          }),
          h('button', {
            class: 'btn',
            text: '暂停回放',
            disabled: snapshot.status !== 'replaying',
            onClick: () => app.controller.pause(),
          }),
        ]),
        h('p', {
          class: 'muted',
          text: '导入先校验 schema、配置与快照 hash；失败不会覆盖当前实验。回放只消费已保存的 selectedAction，不重新调用策略。',
        }),
        h('p', {
          class: 'muted',
          text: '单次运行对比没有同策略 30 种子配对波动区间，只能表述为“描述性差异”，不得据此声称结构显著改变。',
        }),
      ]),
    ]),
    h('div', { class: 'span-6' }, [
      card(
        '当前实验',
        [
          bundleSummary(
            snapshot.runId,
            snapshot.status,
            snapshot.tick,
            snapshot.totalTicks,
            snapshot.configHash,
            snapshot.seed,
            snapshot.policy,
            snapshot.endReason,
          ),
        ],
        {
          subtitle: '本地权威状态；未上传，未通过独立验证。',
        },
      ),
    ]),
    h('div', { class: 'span-6' }, [
      card(
        '导入的实验',
        [
          imported === null
            ? h('p', { class: 'muted', text: '尚未导入 bundle。' })
            : bundleSummary(
                imported.runId,
                imported.status,
                imported.latestSnapshot?.state.society.tick ?? 0,
                imported.config.schedule.totalTicks,
                imported.configHash,
                imported.seed,
                imported.policy,
                imported.endReason,
              ),
        ],
        { subtitle: '导入文件只读展示；进入回放后状态从初始快照重建。' },
      ),
    ]),
    h('div', { class: 'span-12' }, [
      card('并排指标（描述性）', [comparisonTable(app, imported)], {
        subtitle: '窗口：各自 run 的全周期；不做显著性推断。',
      }),
    ]),
  );
}

function bundleSummary(
  runId: string | null,
  status: string,
  tick: number,
  totalTicks: number,
  configHash: string | null,
  seed: string | null,
  policy: string,
  endReason: string | null,
): HTMLElement {
  return h('dl', { class: 'detail-list' }, [
    h('dt', { text: 'runId' }),
    h('dd', { text: runId ?? '—' }),
    h('dt', { text: '状态' }),
    h('dd', {}, [badge(status, status === 'completed' ? 'ok' : 'muted')]),
    h('dt', { text: '进度' }),
    h('dd', { text: `${tick} / ${totalTicks} tick` }),
    h('dt', { text: 'seed / policy' }),
    h('dd', { text: `${seed ?? '—'} / ${policy}` }),
    h('dt', { text: '结束原因' }),
    h('dd', { text: endReason ?? '—' }),
    h('dt', { text: 'configHash' }),
    h('dd', { text: configHash ?? '—' }),
  ]);
}

function comparisonTable(app: StratifyApp, imported: WebRunBundle | null): HTMLElement {
  const current = app.getSnapshot().latestStats;
  const other = imported?.stats[imported.stats.length - 1] ?? null;
  const rows: (readonly [string, string, string])[] = [];
  const add = (
    label: string,
    a: number | null | undefined,
    b: number | null | undefined,
    percent = false,
  ) => {
    rows.push([
      label,
      a === null || a === undefined ? '—' : percent ? formatPercent(a) : formatNumber(a),
      b === null || b === undefined ? '—' : percent ? formatPercent(b) : formatNumber(b),
    ]);
  };
  add('Gini', current?.gini, other?.gini);
  add('Top10%', current?.topWealthShare, other?.topWealthShare, true);
  add('Mup', current?.mUp, other?.mUp);
  add('Mdown', current?.mDown, other?.mDown);
  add('S', current?.segregation, other?.segregation);
  add('O', current?.openness, other?.openness);
  add('alive', current?.aliveCount, other?.aliveCount);
  add('edgeCount', current?.edgeCount, other?.edgeCount);
  return h('div', {}, [
    table(['指标', '当前', '导入'], rows),
    h('p', {
      class: 'muted',
      text:
        imported === null
          ? '导入一个 bundle 后显示并排指标。'
          : '两列分别来自各自 run 的最终 tick；若 seed/config 不同，差异同时包含配置与随机性，不能归因。',
    }),
  ]);
}
