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
    expect(selected?.textContent).toContain('实时总览');
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
});
