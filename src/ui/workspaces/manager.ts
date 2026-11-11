import { badge, card, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

export function renderManager(root: HTMLElement, app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  const storage = h('p', { class: 'muted', text: '正在读取存储配额…' });
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate !== undefined) {
    void navigator.storage
      .estimate()
      .then((estimate) => {
        const usage = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        storage.textContent = `已用 ${formatBytes(usage)} / 配额 ${formatBytes(quota)}（${quota === 0 ? '—' : ((usage / quota) * 100).toFixed(2)}%）。`;
      })
      .catch(() => {
        storage.textContent = '无法读取存储配额。';
      });
  } else {
    storage.textContent = '当前环境不支持 navigator.storage.estimate。';
  }

  const runRows = app.recentRuns.map((run) => [
    h('span', { class: 'mono', text: run.runId }),
    run.status,
    `${run.tick}/${run.totalTicks}`,
    run.seed,
    run.policy,
    h('div', { class: 'actions-row' }, [
      h('button', {
        class: 'btn btn-sm',
        text: '载入',
        onClick: () => void app.loadStoredRun(run.runId),
      }),
      h('button', {
        class: 'btn btn-sm btn-danger',
        text: '删除',
        onClick: () => {
          void app.store.remove(run.runId).then(() => app.refreshRuns());
        },
      }),
    ]),
  ]);

  root.append(
    h('div', { class: 'span-8' }, [
      card('当前 run 与导出', [
        h('dl', { class: 'detail-list' }, [
          h('dt', { text: 'runId' }),
          h('dd', { text: snapshot.runId ?? '—（尚未开始）' }),
          h('dt', { text: '状态' }),
          h('dd', {}, [badge(snapshot.status, snapshot.status === 'failed' ? 'danger' : 'muted')]),
          h('dt', { text: 'configHash' }),
          h('dd', { text: snapshot.configHash ?? '—' }),
          h('dt', { text: 'paramsHash' }),
          h('dd', { text: snapshot.paramsHash ?? '—' }),
          h('dt', { text: 'initialPopulationHash' }),
          h('dd', { text: snapshot.initialPopulationHash ?? '—' }),
          h('dt', { text: '决策日志' }),
          h('dd', {
            text: snapshot.decisionsTruncated
              ? `已截断（内存上限），共 ${snapshot.decisions.length} 条`
              : `完整，共 ${snapshot.decisions.length} 条`,
          }),
        ]),
        h('div', { class: 'actions-row', style: 'margin-top:12px' }, [
          h('button', {
            class: 'btn btn-primary',
            text: '导出完整 bundle',
            disabled: snapshot.runId === null,
            onClick: () => app.downloadBundle(),
          }),
          h('button', {
            class: 'btn',
            text: '下载诊断',
            disabled: snapshot.failure === null,
            onClick: () => downloadDiagnostics(app),
          }),
          h('button', {
            class: 'btn btn-danger',
            text: '清除本地实验',
            onClick: () => void app.clearStoredRuns(),
          }),
        ]),
        h('p', {
          class: 'muted',
          text: '离线 run 使用 local-<uuid>，只支持导出/回放；MVP 不支持把离线结果直接采纳为云端权威记录。',
        }),
        snapshot.failure === null
          ? null
          : h('div', { class: 'notice notice-danger' }, [
              h('strong', { text: `${snapshot.failure.code} · ${snapshot.failure.phase}` }),
              h('p', { text: snapshot.failure.message }),
              h('pre', {
                class: 'mono',
                style: 'white-space:pre-wrap;font-size:11px',
                text: JSON.stringify(snapshot.failure.diagnostics, null, 2),
              }),
            ]),
      ]),
      card(
        '本地实验注册表（IndexedDB）',
        [
          app.recentRuns.length === 0
            ? h('p', { class: 'muted', text: '暂无本地实验。运行后会自动写入最近 bundle。' })
            : table(['runId', '状态', 'tick', 'seed', '策略', '操作'], runRows),
          h('div', { class: 'actions-row', style: 'margin-top:8px' }, [
            h('button', {
              class: 'btn btn-sm',
              text: '刷新列表',
              onClick: () => void app.refreshRuns(),
            }),
          ]),
        ],
        { subtitle: '每 2 秒至多保存一次；刷新后可手动载入回放。' },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card('存储与显示', [
        storage,
        h('div', { style: 'height:8px' }),
        h('div', { class: 'field' }, [
          h('label', { class: 'field-label', text: '主题' }),
          h('div', { class: 'actions-row' }, [
            h('button', {
              class: `btn ${app.theme === 'obsidian' ? 'btn-primary' : ''}`,
              text: 'Obsidian Lab',
              onClick: () => app.setTheme('obsidian'),
            }),
            h('button', {
              class: `btn ${app.theme === 'paper' ? 'btn-primary' : ''}`,
              text: 'Paper Lab',
              onClick: () => app.setTheme('paper'),
            }),
          ]),
        ]),
        h('p', {
          class: 'muted',
          text: 'IndexedDB 保存完整 bundle（配置、快照、统计、决策）。关闭标签页不会上传；浏览器可能在配额不足时提示。',
        }),
      ]),
      card('版本与限制', [
        h('dl', { class: 'detail-list' }, [
          h('dt', { text: '规则' }),
          h('dd', { text: 'rules-v15' }),
          h('dt', { text: 'config' }),
          h('dd', { text: 'stratify-config-v9' }),
          h('dt', { text: 'state' }),
          h('dd', { text: 'stratify-state-v5' }),
          h('dt', { text: 'G6' }),
          h('dd', { text: '未通过 · P6 已停止' }),
        ]),
        h('p', {
          class: 'muted',
          text: '本界面不是校准证据。所有结构相关结论必须以 docs/07 的统计验收与预注册产物为准。',
        }),
      ]),
    ]),
  );
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
