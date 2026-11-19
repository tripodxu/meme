// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../src/core/config/defaults.js';
import { StratifyApp } from '../../src/ui/app.js';

function mountApp(): { app: StratifyApp; root: HTMLElement } {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  if (root === null) throw new Error('缺少 #app');
  const app = new StratifyApp();
  app.draftConfig = createDemoConfig({
    population: { initialPopulation: 8 },
    schedule: { totalTicks: 6, statsStride: 1, snapshotStride: 2 },
    decision: { interval: 2 },
  });
  app.draftSeed = 'p3-e2e-seed';
  app.mount(root);
  return { app, root };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.dataset['theme'] = 'obsidian';
});

describe('P3 浏览器工作台 E2E（jsdom）', () => {
  it('离线 mock 从设置页启动到完成，并渲染总览图表', async () => {
    const { app, root } = mountApp();
    expect(root.querySelector('.command-hud')).not.toBeNull();
    expect(root.querySelectorAll('.tab').length).toBe(5);
    app.start();
    await waitFor(() => app.getSnapshot().status === 'completed');
    const snapshot = app.getSnapshot();
    expect(snapshot.tick).toBe(6);
    expect(snapshot.stats).toHaveLength(6);
    expect(snapshot.decisions.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('svg.chart').length).toBeGreaterThan(0);
    const classChart = document.querySelector('svg[aria-label="阶级结构堆叠"]');
    expect(classChart).not.toBeNull();
    const viewBox = (classChart?.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    const chartHeight = viewBox[3] ?? 0;
    expect(chartHeight).toBeGreaterThan(0);
    const polygons = [...(classChart?.querySelectorAll('polygon') ?? [])];
    expect(polygons.length).toBeGreaterThan(0);
    for (const polygon of polygons) {
      const ys = (polygon.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .map((point) => Number(point.split(',')[1]));
      expect(ys.every((y) => y >= -0.5 && y <= chartHeight + 0.5)).toBe(true);
    }
    expect(document.body.textContent).toContain('结构指纹与核心指标');
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('选择 jev_live 显示内存 Key 字段，且 Key 不进入 snapshot/本地存储', () => {
    const { app, root } = mountApp();
    const select = root.querySelector('#setup-policy') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    if (select === null) return;
    select.value = 'jev_live';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const keyInput = root.querySelector('#setup-live-key') as HTMLInputElement | null;
    expect(keyInput).not.toBeNull();
    expect(keyInput?.type).toBe('password');
    if (keyInput !== null) {
      keyInput.value = 'e2e-memory-key';
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(app.draftPolicy).toBe('jev_live');
    expect(app.liveApiKey).toBe('e2e-memory-key');
    expect(JSON.stringify(app.getSnapshot())).not.toContain('e2e-memory-key');
    expect(JSON.stringify(localStorage)).not.toContain('e2e-memory-key');
    expect(JSON.stringify(sessionStorage)).not.toContain('e2e-memory-key');

    select.value = 'mock-weighted-v1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('#setup-live-key')).toBeNull();
  });

  it('live 超建议规模时阻止启动，勾选确认后才解除', () => {
    const { app, root } = mountApp();
    app.draftConfig = createDemoConfig({
      population: { initialPopulation: 50 },
      schedule: { totalTicks: 20 },
    });
    app.liveApiKey = 'e2e-fake-key';
    const select = root.querySelector('#setup-policy') as HTMLSelectElement | null;
    if (select === null) throw new Error('缺少策略选择');
    select.value = 'jev_live';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const confirm = root.querySelector('#setup-live-scale-confirm') as HTMLInputElement | null;
    expect(confirm).not.toBeNull();
    app.start();
    expect(['idle', 'ready']).toContain(app.getSnapshot().status);
    expect(app.notice).toContain('建议上限');
    if (confirm !== null) {
      confirm.checked = true;
      confirm.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(app.liveScaleConfirmed).toBe(true);
    expect(JSON.stringify(app.getSnapshot())).not.toContain('e2e-fake-key');
  });

  it('个体检查器可筛选并展示决策与执行记录', async () => {
    const { app } = mountApp();
    app.start();
    await waitFor(() => app.getSnapshot().status === 'completed');
    app.setTab('inspector');
    expect(document.querySelectorAll('.agent-list button').length).toBe(8);
    expect(document.body.textContent).toContain('决策 X 光');
    expect(document.body.textContent).toContain('核心实际执行');
    const search = document.querySelector('#agent-search') as HTMLInputElement | null;
    expect(search).not.toBeNull();
    if (search !== null) {
      search.value = 'a-0001';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(document.querySelectorAll('.agent-list button').length).toBe(1);
    }
  });

  it('导出/导入后从初始快照回放，结果与原 run 一致', async () => {
    const { app } = mountApp();
    app.start();
    await waitFor(() => app.getSnapshot().status === 'completed');
    const original = app.getSnapshot();
    const bundle = app.controller.exportBundle(true);
    expect(bundle).not.toBeNull();
    const imported = app.controller.importBundle(JSON.parse(JSON.stringify(bundle)));
    expect(imported.ok).toBe(true);
    expect(app.getSnapshot().tick).toBe(0);
    app.controller.startReplay();
    await waitFor(() => app.getSnapshot().status === 'completed');
    expect(app.getSnapshot().tick).toBe(original.tick);
    expect(app.getSnapshot().latestStats?.gini).toBe(original.latestStats?.gini);
    expect(app.getSnapshot().replay?.replayInvalid).toBe(0);
  });

  it('主题切换与键盘工作区切换生效', async () => {
    const { app } = mountApp();
    app.setTheme('paper');
    expect(document.documentElement.dataset['theme']).toBe('paper');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const selected = document.querySelector('.tab[aria-selected="true"]');
    expect(selected?.textContent).toContain('宏观分析');
  });

  it('非法导入不覆盖当前实验', async () => {
    const { app } = mountApp();
    app.start();
    await waitFor(() => app.getSnapshot().status === 'completed');
    const before = app.getSnapshot().runId;
    const result = app.controller.importBundle({ schemaVersion: 'unknown' });
    expect(result.ok).toBe(false);
    expect(app.getSnapshot().runId).toBe(before);
  });

  it('交互沙盒剧场可切换、加载探索剧本并通过命运抉择卡出牌推进', async () => {
    const { app, root } = mountApp();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    expect(app.surface).toBe('sandbox');
    expect(root.querySelector('.arena-canvas')).not.toBeNull();
    expect(root.querySelectorAll('.scenario-card').length).toBeGreaterThanOrEqual(4);

    // 启动手动化身探索：到决策 tick 会挂起并渲染命运抉择行动卡
    app.controller.start();
    await waitFor(() => app.getSnapshot().pendingAvatarPrompt !== null);
    const choiceBtn = root.querySelector('.choice-accumulate') as HTMLButtonElement | null;
    expect(choiceBtn).not.toBeNull();
    choiceBtn?.click();
    await waitFor(() => app.getSnapshot().tick >= 1);
    app.controller.pause();
    expect(app.getSnapshot().tick).toBeGreaterThanOrEqual(1);
  });

  it('检查器持久化外壳在状态刷新时保持搜索输入焦点不丢失，微扰分叉可同步对比页', async () => {
    const { app } = mountApp();
    await app.stepDecision();
    app.setTab('inspector');
    const search = document.querySelector('#agent-search') as HTMLInputElement | null;
    expect(search).not.toBeNull();
    if (search === null) return;
    search.focus();
    search.value = 'a-000';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.activeElement).toBe(search);

    // 推进单步触发后台通知与增量刷新，搜索框节点和焦点必须原位保持
    await app.controller.stepOnce();
    app.render(false);
    expect(document.querySelector('#agent-search')).toBe(search);
    expect(document.activeElement).toBe(search);

    // 执行微扰分叉并跳转到回放对比页校验配对审计徽章
    app.forkFocusedAgent(0.01);
    app.setTab('replay');
    expect(document.body.textContent).toContain('平行宇宙微扰分叉溯源');
    expect(document.body.textContent).toContain('种子已配对');
    expect(document.body.textContent).toContain('描述性差异');
  });

  it('高阶向量参数编辑、历史快照跳转、洛伦兹/对数切换与 ≥30 种子森林图护栏生效', async () => {
    const { app, root } = mountApp();
    // 设置页存在五阶层向量编辑器且归一化按钮可用
    expect(root.querySelector('#setup-env0-0')).not.toBeNull();
    expect(root.querySelector('#setup-share-c0')).not.toBeNull();

    app.start();
    await waitFor(() => app.getSnapshot().status === 'completed');
    expect(root.querySelector('svg[aria-label="财富洛伦兹曲线"]')).not.toBeNull();

    // 切换对数中位数财富曲线
    app.wealthLogScale = true;
    app.render(true);
    expect(root.querySelector('svg[aria-label="中位数财富对数轨迹"]')).not.toBeNull();

    // 跳转到周期快照 Tick 2
    app.jumpToSnapshot(2);
    expect(app.getSnapshot().tick).toBe(2);
    expect(app.getSnapshot().status).toBe('paused');

    // 回放页：导入 <30 种子阻止渲染森林图，导入 >=30 种子渲染森林图
    app.batchForestSummary = {
      title: '不足样本',
      pairedSeeds: 10,
      eligibleForInference: false,
      metrics: [{ metric: 'Gini', estimate: 0.04, ciLow: -0.01, ciHigh: 0.09 }],
    };
    app.setTab('replay');
    expect(document.body.textContent).toContain('已阻止显著性森林图展示');
    expect(root.querySelector('svg[aria-label="不足样本"]')).toBeNull();

    app.batchForestSummary = {
      title: '三十种子配对森林图',
      pairedSeeds: 30,
      eligibleForInference: true,
      metrics: [{ metric: 'Gini', estimate: 0.12, ciLow: 0.05, ciHigh: 0.19 }],
    };
    app.render(true);
    expect(root.querySelector('svg[aria-label="三十种子配对森林图"]')).not.toBeNull();
  });
});
