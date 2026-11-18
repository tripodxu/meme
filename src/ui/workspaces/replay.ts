import { diffConfigPaths } from '../../core/config/diff.js';
import type { TickStats } from '../../core/macros/tick-metrics.js';
import type { WebRunBundle } from '../../app/types.js';
import {
  formatNumber,
  formatPercent,
  type PairedBatchForestSummary,
} from '../../app/view-model.js';
import { emptyChart, renderForestPlot, renderLineChart } from '../charts/core.js';
import { sampleRows } from '../charts/lttb.js';
import { append, badge, card, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

export function renderReplay(root: HTMLElement, app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  const reference = app.importedBundle;

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

  const compareFileInput = h('input', {
    id: 'compare-only-file',
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onChange: (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file !== undefined) void app.loadComparisonOnlyFile(file);
    },
  });

  const batchForestInput = h('input', {
    id: 'batch-forest-file',
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onChange: (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file !== undefined) void app.importBatchForestFile(file);
    },
  });

  const provenanceBanner =
    snapshot.forkProvenance === null
      ? null
      : h('div', { class: 'notice', style: 'margin-bottom:10px' }, [
          h('strong', { text: '🌿 平行宇宙微扰分叉溯源：' }),
          h('span', { text: `${snapshot.forkProvenance.description} · ` }),
          h('span', {
            class: 'mono muted',
            text: `唯一变更字段=${snapshot.forkProvenance.changedField} · 检查点=${snapshot.forkProvenance.checkpointStateHash.slice(0, 22)}…`,
          }),
        ]);

  append(root, [
    h('div', { class: 'span-12' }, [
      snapshot.replay === null
        ? null
        : h('div', { class: 'replay-banner', style: 'margin-bottom:10px' }, [
            h('strong', { text: `🎬 回放模式：${snapshot.replay.mode}` }),
            h('span', {
              text: ` · 原始策略 ${snapshot.replay.policyVersion} · 起点 tick ${snapshot.replay.fromTick} · 核心失效回退 replay_invalid=${snapshot.replay.replayInvalid}`,
            }),
          ]),
      provenanceBanner,
      card('离线归档导入、逐帧回放与双宇宙基准绑定', [
        h('div', { class: 'actions-row' }, [
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '⬇ 导出当前完整 Bundle',
            disabled: snapshot.runId === null,
            onClick: () => app.downloadBundle(),
          }),
          h('label', { class: 'btn', for: 'replay-file', text: '📂 导入并载入回放' }),
          fileInput,
          h('label', {
            class: 'btn',
            for: 'compare-only-file',
            text: '⚖ 导入作为右栏对照基准（不覆盖当前）',
          }),
          compareFileInput,
          h('button', {
            class: 'btn',
            type: 'button',
            text: '📌 将当前实验锁定为对照基准',
            disabled: snapshot.runId === null,
            onClick: () => app.pinCurrentAsBaseline(),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '▶ 从头回放',
            disabled: snapshot.replay === null,
            onClick: () => app.controller.startReplay(),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '⏸ 暂停回放',
            disabled: snapshot.status !== 'replaying',
            onClick: () => app.controller.pause(),
          }),
        ]),
        h('p', {
          class: 'muted',
          style: 'margin:10px 0 4px',
          text: '导入先校验 schemaVersion、RunConfig 与权威快照 stateHash；校验失败绝不污染当前实验。回放仅消费日志中的 selectedAction，不发起任何外部模型请求。',
        }),
        h('div', { class: 'actions-row' }, [
          badge('描述性差异（无 30 种子配对波动区间，不作结构显著性推断）', 'warn'),
        ]),
      ]),
    ]),
    h('div', { class: 'span-6' }, [
      card(
        '宇宙 A · 当前活动实验',
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
          subtitle: '浏览器本地权威状态；未上传云端',
        },
      ),
    ]),
    h('div', { class: 'span-6' }, [
      card(
        '宇宙 B · 对照基准实验',
        [
          reference === null
            ? h('p', {
                class: 'muted',
                text: '尚未绑定对照基准。可点击上方「锁定当前实验为基准」、在沙盒执行「🌿 微扰分叉」，或从外部导入 Bundle。',
              })
            : bundleSummary(
                reference.runId,
                reference.status,
                reference.latestSnapshot?.state.society.tick ?? 0,
                reference.config.schedule.totalTicks,
                reference.configHash,
                reference.seed,
                reference.policy,
                reference.endReason,
              ),
        ],
        { subtitle: '只读对照快照' },
      ),
    ]),
    h('div', { class: 'span-12' }, [
      card('双宇宙配对审计与并排指标矩阵（描述性）', [comparisonAudit(app, reference)], {
        subtitle: '自动核对配置叶子差异、种子配对与首次轨迹分叉 Tick',
      }),
    ]),
    reference !== null && snapshot.stats.length > 0 && reference.stats.length > 0
      ? h('div', { class: 'span-6' }, [
          card(
            '双宇宙 Gini 轨迹叠加对比',
            [overlayChart(snapshot.stats, reference.stats, 'gini', 'Gini')],
            {
              subtitle: '实线 = 当前宇宙 A · 虚线 = 对照基准 B',
            },
          ),
        ])
      : null,
    reference !== null && snapshot.stats.length > 0 && reference.stats.length > 0
      ? h('div', { class: 'span-6' }, [
          card(
            '双宇宙开放度 O 轨迹叠加对比',
            [overlayChart(snapshot.stats, reference.stats, 'openness', 'Openness O')],
            {
              subtitle: '实线 = 当前宇宙 A · 虚线 = 对照基准 B',
            },
          ),
        ])
      : null,
    h('div', { class: 'span-12' }, [
      card(
        '配对种子批次置信区间森林图（Forest Plot · 06 §7）',
        [batchForestSection(app, batchForestInput)],
        {
          subtitle: '仅当导入 ≥30 配对种子的离线批跑摘要 JSON 时开放 Bootstrap 置信区间可视化',
        },
      ),
    ]),
  ]);
}

function batchForestSection(app: StratifyApp, fileInput: HTMLElement): HTMLElement {
  const summary: PairedBatchForestSummary | null = app.batchForestSummary;
  return h('div', {}, [
    h('div', { class: 'actions-row', style: 'margin-bottom:10px' }, [
      h('label', {
        class: 'btn',
        for: 'batch-forest-file',
        text: '📈 导入配对批次摘要 JSON (Forest Plot)',
      }),
      fileInput,
      summary !== null
        ? h('button', {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            text: '清除批次摘要',
            onClick: () => {
              app.batchForestSummary = null;
              app.render();
            },
          })
        : null,
    ]),
    summary === null
      ? h('p', {
          class: 'muted',
          style: 'margin:0',
          text: '支持导入包含 { title, pairedSeeds, metrics: [{ metric, estimate, ciLow, ciHigh }] } 的离线批跑配对对比结果。单次浏览器双世界对比不渲染显著性置信区间。',
        })
      : summary.eligibleForInference
        ? h('div', {}, [
            h('div', { class: 'actions-row', style: 'margin-bottom:8px' }, [
              badge(`${summary.title} · 配对种子 N=${summary.pairedSeeds}`, 'ok'),
              badge('满足 N≥30 配对区间展示门槛（仍需对照 docs/07 §8 全套口径）', 'info'),
            ]),
            renderForestPlot(summary.metrics, { title: summary.title }),
          ])
        : h('div', { class: 'notice notice-warn' }, [
            h('strong', {
              text: `配对种子不足（N=${summary.pairedSeeds} < 30）：已阻止显著性森林图展示。`,
            }),
            h('p', {
              style: 'margin:4px 0 0',
              text: '按 docs/06 §7 与 docs/07 §8，少于 30 个独立配对种子的批次不得展示推断性置信区间，仅可查看下方点估计表（exploratory）：',
            }),
            h('div', { style: 'margin-top:8px' }, [
              table(
                ['指标', '点估计 Δ', '区间下界', '区间上界'],
                summary.metrics.map((m) => [
                  m.metric,
                  formatNumber(m.estimate, 4),
                  formatNumber(m.ciLow, 4),
                  formatNumber(m.ciHigh, 4),
                ]),
              ),
            ]),
          ]),
  ]);
}

function overlayChart(
  statsA: readonly TickStats[],
  statsB: readonly TickStats[],
  key: 'gini' | 'openness',
  label: string,
): SVGSVGElement {
  const sA = sampleRows(statsA, 420);
  const sB = sampleRows(statsB, 420);
  if (sA.length === 0 && sB.length === 0) return emptyChart('尚无轨迹数据');
  return renderLineChart(
    [
      {
        label: `当前 A (${label})`,
        color: 'var(--accent)',
        points: sA.map((r) => ({ x: r.tick + 1, y: r[key] })),
      },
      {
        label: `基准 B (${label})`,
        color: 'var(--gold)',
        points: sB.map((r) => ({ x: r.tick + 1, y: r[key] })),
        dashed: true,
      },
    ],
    { height: 200, yMin: 0, yMax: 1, xLabel: 'tick', yLabel: label, title: `双宇宙 ${label} 对比` },
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
    h('dd', {
      text: configHash === null ? '—' : `${configHash.slice(0, 28)}…`,
      title: configHash ?? '',
    }),
  ]);
}

function findFirstDivergenceTick(
  statsA: readonly TickStats[],
  statsB: readonly TickStats[],
): number | null {
  const byTickB = new Map<number, TickStats>();
  for (const row of statsB) byTickB.set(row.tick, row);
  for (const rowA of statsA) {
    const rowB = byTickB.get(rowA.tick);
    if (rowB === undefined) continue;
    if (
      rowA.gini !== rowB.gini ||
      rowA.openness !== rowB.openness ||
      rowA.segregation !== rowB.segregation ||
      rowA.aliveCount !== rowB.aliveCount ||
      rowA.mUp !== rowB.mUp
    ) {
      return rowA.tick;
    }
  }
  return null;
}

function comparisonAudit(app: StratifyApp, imported: WebRunBundle | null): HTMLElement {
  const snap = app.getSnapshot();
  const current = snap.latestStats;
  const other = imported?.stats[imported.stats.length - 1] ?? null;

  const auditBadges: HTMLElement[] = [];
  if (imported !== null && snap.config !== null) {
    const sameSeed = snap.seed === imported.seed;
    const changedPaths = diffConfigPaths(imported.config, snap.config);
    const firstDiv = findFirstDivergenceTick(snap.stats, imported.stats);
    auditBadges.push(
      badge(
        sameSeed ? `种子已配对 (${snap.seed})` : '非配对种子（含随机流差异）',
        sameSeed ? 'ok' : 'warn',
      ),
    );
    if (changedPaths.length === 0) {
      auditBadges.push(badge('RunConfig 逐字一致 (0 差异字段)', 'info'));
    } else if (changedPaths.length === 1) {
      auditBadges.push(badge(`单参数变更: ${changedPaths[0]}`, 'info'));
    } else {
      auditBadges.push(badge(`复合配置变更 (${changedPaths.length} 个字段)`, 'warn'));
    }
    auditBadges.push(
      badge(
        firstDiv === null ? '已对齐区间指标完全重合' : `首次统计偏离 @ Tick ${firstDiv}`,
        firstDiv === null ? 'muted' : 'violet',
      ),
    );
  }

  const rows: (readonly [string, string, string, string])[] = [];
  const add = (
    label: string,
    a: number | null | undefined,
    b: number | null | undefined,
    percent = false,
  ) => {
    const fmt = (v: number | null | undefined) =>
      v === null || v === undefined ? '—' : percent ? formatPercent(v) : formatNumber(v);
    let deltaText = '—';
    if (
      a !== null &&
      a !== undefined &&
      b !== null &&
      b !== undefined &&
      Number.isFinite(a) &&
      Number.isFinite(b)
    ) {
      const diff = a - b;
      const sign = diff >= 0 ? '+' : '';
      deltaText = percent ? `${sign}${(diff * 100).toFixed(1)}pp` : `${sign}${formatNumber(diff)}`;
    }
    rows.push([label, fmt(a), fmt(b), deltaText]);
  };

  add('财富基尼 Gini', current?.gini, other?.gini);
  add('前 10% 财富占比 Top10%', current?.topWealthShare, other?.topWealthShare, true);
  add('上升参与率 Mup', current?.mUp, other?.mUp);
  add('下降参与率 Mdown', current?.mDown, other?.mDown);
  add('调整后隔离度 S', current?.segregation, other?.segregation);
  add('制度开放度 O', current?.openness, other?.openness);
  add('存活人口 alive', current?.aliveCount, other?.aliveCount);
  add('网络连边数 edgeCount', current?.edgeCount, other?.edgeCount);

  return h('div', {}, [
    auditBadges.length > 0
      ? h('div', { class: 'actions-row', style: 'margin-bottom:10px' }, auditBadges)
      : null,
    table(['核心指标', '当前宇宙 A', '对照基准 B', '差值 (A − B)'], rows),
    h('p', {
      class: 'muted',
      style: 'margin:8px 0 0',
      text:
        imported === null
          ? '绑定或导入一个对照 Bundle 后自动计算双世界差值与首次偏离时刻。'
          : '注：单次双世界对比缺乏 30 种子配对 Bootstrap 波动区间，仅作轨迹机制洞察与描述性对照，不得据此声称“社会结构显著改变”（docs/06 §7 & docs/07 §8）。',
    }),
  ]);
}
