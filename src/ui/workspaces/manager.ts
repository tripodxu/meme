import { IdbRunStore } from '../../app/idb-store.js';
import { detectRuntimeAuthority } from '../../app/view-model.js';
import { append, badge, card, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

export function renderManager(root: HTMLElement, app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  const authority = detectRuntimeAuthority();
  const idbAvailable = IdbRunStore.available();

  const storageText = h('p', {
    class: 'muted',
    style: 'margin:0',
    text: '正在估算浏览器存储配额…',
  });
  const quotaFill = h('div', { class: 'prob-fill', style: 'width:0%' });

  if (typeof navigator !== 'undefined' && navigator.storage?.estimate !== undefined) {
    void navigator.storage
      .estimate()
      .then((estimate) => {
        const usage = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        const pct = quota === 0 ? 0 : (usage / quota) * 100;
        quotaFill.style.width = `${Math.min(100, Math.max(1, pct)).toFixed(2)}%`;
        storageText.textContent = `已用 ${formatBytes(usage)} / 配额上限 ${formatBytes(quota)}（${quota === 0 ? '—' : pct.toFixed(2)}%）。`;
      })
      .catch(() => {
        storageText.textContent = '无法读取浏览器存储配额。';
      });
  } else {
    storageText.textContent = '当前宿主环境不支持 navigator.storage.estimate。';
  }

  const runRows = app.recentRuns.map((run) => [
    h('span', { class: 'mono', text: run.runId }),
    badge(run.status, run.status === 'completed' ? 'ok' : 'muted'),
    `${run.tick}/${run.totalTicks}`,
    run.seed,
    run.policy,
    run.chunkCounts === undefined
      ? '单包(v2)'
      : `S${run.chunkCounts.snapshots}·M${run.chunkCounts.stats}·D${run.chunkCounts.decisions}·E${run.chunkCounts.events}`,
    h('div', { class: 'actions-row' }, [
      h('button', {
        class: 'btn btn-sm btn-primary',
        type: 'button',
        text: '载入回放',
        onClick: () => void app.loadStoredRun(run.runId),
      }),
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '设为对比基准',
        onClick: () => void app.pinStoredRunAsBaseline(run.runId),
      }),
      h('button', {
        class: 'btn btn-sm btn-danger',
        type: 'button',
        text: '删除',
        onClick: () => {
          void app.store.remove(run.runId).then(() => app.refreshRuns());
        },
      }),
    ]),
  ]);

  append(root, [
    !idbAvailable
      ? h('div', { class: 'span-12 notice notice-warn' }, [
          h('strong', { text: '⚠ IndexedDB 不可用：' }),
          h('span', {
            text: '刷新或关闭标签页将丢失当前内存中的实验数据，请及时导出完整 JSON Bundle。',
          }),
        ])
      : null,
    h('div', { class: 'span-8' }, [
      card('当前活动实验身份与归档导出', [
        h('dl', { class: 'detail-list' }, [
          h('dt', { text: 'runId' }),
          h('dd', { text: snapshot.runId ?? '—（尚未开始）' }),
          h('dt', { text: '运行状态' }),
          h('dd', {}, [
            badge(snapshot.status, snapshot.status === 'failed' ? 'danger' : 'info'),
            h('span', { class: 'muted', text: ' · 仅本地权威 · 未上传云端' }),
          ]),
          h('dt', { text: 'configHash' }),
          h('dd', { text: snapshot.configHash ?? '—' }),
          h('dt', { text: 'paramsHash' }),
          h('dd', { text: snapshot.paramsHash ?? '—' }),
          h('dt', { text: 'initialPopulationHash' }),
          h('dd', { text: snapshot.initialPopulationHash ?? '—' }),
          h('dt', { text: '内存决策日志' }),
          h('dd', {
            text: snapshot.decisionsTruncated
              ? `已达内存环形上限截断，保留最近 ${snapshot.decisions.length} 条`
              : `完整无截断，共 ${snapshot.decisions.length} 条`,
          }),
        ]),
        h('div', { class: 'actions-row', style: 'margin-top:14px' }, [
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '⬇ 导出完整离线 Bundle',
            disabled: snapshot.runId === null,
            onClick: () => app.downloadBundle(),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '☁ 云端上传说明',
            onClick: () =>
              app.notify(
                '离线 run (local-*) 仅限本地导出与回放；为防篡改，MVP 不支持将浏览器离线结果直接采纳为云端权威记录，受控上传请使用本地 runner + pnpm upload。',
              ),
          }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: '🩺 下载失败诊断包',
            disabled: snapshot.failure === null,
            onClick: () => downloadDiagnostics(app),
          }),
          h('button', {
            class: 'btn btn-danger',
            type: 'button',
            text: '🗑 清除本地实验库',
            onClick: () => void app.clearStoredRuns(),
          }),
        ]),
        snapshot.failure === null
          ? null
          : h('div', { class: 'notice notice-danger', style: 'margin-top:12px' }, [
              h('strong', { text: `${snapshot.failure.code} · 阶段=${snapshot.failure.phase}` }),
              h('p', { style: 'margin:4px 0', text: snapshot.failure.message }),
              h('pre', {
                class: 'mono code-preview',
                text: JSON.stringify(snapshot.failure.diagnostics, null, 2),
              }),
            ]),
      ]),
      card(
        '本地实验注册表（IndexedDB v3 分块快表）',
        [
          app.recentRuns.length === 0
            ? h('p', {
                class: 'muted',
                text: '暂无本地保存记录。实验运行或完成时会自动按分块写入 IndexedDB。',
              })
            : table(['runId', '状态', '进度', 'seed', '策略', '分块计数', '操作'], runRows),
          h('div', { class: 'actions-row', style: 'margin-top:10px' }, [
            h('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: '↻ 刷新注册表',
              onClick: () => void app.refreshRuns(),
            }),
          ]),
        ],
        { subtitle: 'v3 分块原子持久化（snapshots / stats / decisions / events）+ 秒级元数据读取' },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card('存储健康与视觉主题', [
        storageText,
        h('div', { class: 'prob-track', style: 'margin:8px 0 14px' }, [quotaFill]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field-label', text: '精密观测站主题 (Theme)' }),
          h('div', { class: 'actions-row' }, [
            h('button', {
              class: `btn ${app.theme === 'obsidian' ? 'btn-primary' : ''}`.trim(),
              type: 'button',
              text: '🌙 Obsidian Lab (深空黑曜)',
              onClick: () => app.setTheme('obsidian'),
            }),
            h('button', {
              class: `btn ${app.theme === 'paper' ? 'btn-primary' : ''}`.trim(),
              type: 'button',
              text: '☀ Paper Lab (学术出版)',
              onClick: () => app.setTheme('paper'),
            }),
          ]),
        ]),
        h('p', {
          class: 'muted',
          style: 'margin:10px 0 0',
          text: '主题偏好保存在 localStorage；真实 Jev API Key 永不落盘。',
        }),
      ]),
      card('协议版本与运行时权威边界', [
        h('dl', { class: 'detail-list' }, [
          h('dt', { text: '规则版本' }),
          h('dd', { text: 'rules-v16' }),
          h('dt', { text: '配置 / 状态 Schema' }),
          h('dd', { text: 'stratify-config-v10 / stratify-state-v5' }),
          h('dt', { text: '浏览器引擎权威性' }),
          h('dd', {}, [badge(authority.label, authority.authoritative ? 'ok' : 'warn')]),
          h('dt', { text: '统计校准闸门' }),
          h('dd', { text: 'G6 已通过（D1 两体制 · P6-09 + R4）' }),
        ]),
        h('p', {
          class: 'muted',
          style: 'margin:10px 0 0',
          text: authority.detail,
        }),
      ]),
    ]),
  ]);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index] ?? 'B'}`;
}

function downloadDiagnostics(app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  if (snapshot.failure === null) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    runId: snapshot.runId,
    failure: snapshot.failure,
    configHash: snapshot.configHash,
    paramsHash: snapshot.paramsHash,
    initialPopulationHash: snapshot.initialPopulationHash,
    tick: snapshot.tick,
    statsTail: snapshot.stats.slice(-20),
    recentEvents: snapshot.events.slice(-50),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const anchor = h('a', {
    href: URL.createObjectURL(blob),
    download: `${snapshot.runId ?? 'stratify'}-diagnostics.json`,
  });
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}
