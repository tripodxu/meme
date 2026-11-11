import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import type { RunConfig } from '../core/config/types.js';
import { WEB_PRESETS, findPreset, type WebPreset } from '../app/presets.js';
import { RunController } from '../app/run-controller.js';
import { IdbRunStore, type StoredRunMeta } from '../app/idb-store.js';
import { exceedsLiveSuggestion, type BrowserLiveOptions } from '../app/live-policy.js';
import type { ControllerSnapshot, OfflinePolicyId, WebRunBundle } from '../app/types.js';
import { buildKpis, formatNumber, formatTick } from '../app/view-model.js';
import { badge, clear, h } from './dom.js';
import { renderInspector } from './workspaces/inspector.js';
import { renderManager } from './workspaces/manager.js';
import { renderOverview } from './workspaces/overview.js';
import { renderReplay } from './workspaces/replay.js';
import { renderSetup } from './workspaces/setup.js';

export type TabId = 'setup' | 'overview' | 'inspector' | 'replay' | 'manager';

const TABS: readonly { id: TabId; label: string; hint: string }[] = [
  { id: 'setup', label: '① 实验设置', hint: '预设、参数与预检' },
  { id: 'overview', label: '② 实时总览', hint: '结构指纹、图表与事件' },
  { id: 'inspector', label: '③ 个体检查器', hint: '属性、决策与账本' },
  { id: 'replay', label: '④ 回放与对比', hint: '导入、回放与双窗口' },
  { id: 'manager', label: '⑤ 实验管理', hint: '本地存储、导出与诊断' },
];

const KEYBOARD_TABS: Record<string, TabId> = {
  '1': 'setup',
  '2': 'overview',
  '3': 'inspector',
  '4': 'replay',
  '5': 'manager',
};

const STATUS_TEXT: Record<ControllerSnapshot['status'], string> = {
  idle: '未配置',
  validating: '校验中',
  invalid: '校验失败',
  ready: '就绪（种子已派生）',
  running: '运行中',
  awaiting_decision: '等待决策',
  settling_tick: '结算中',
  paused: '已暂停',
  cancelling: '取消中',
  cancelled: '已取消',
  completed: '已完成',
  failed: '失败',
  replaying: '回放中',
};

export class StratifyApp {
  readonly controller = new RunController();
  readonly store = new IdbRunStore();
  recentRuns: readonly StoredRunMeta[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedSignature = '';
  activeTab: TabId = 'setup';
  draftConfig: RunConfig;
  draftSeed: string;
  draftPolicy: OfflinePolicyId;
  /** live Key 只驻留内存；不写 localStorage/IndexedDB/导出 bundle。 */
  liveApiKey = '';
  liveModel = 'jev-small';
  liveMaxCalls = 200;
  liveMaxInputTokens = 200_000;
  liveMaxMinutes = 30;
  /** 超出 06 建议规模时，必须显式勾选后才能启动 live。 */
  liveScaleConfirmed = false;
  selectedPresetId: string;
  notice: string | null = null;
  importedBundle: WebRunBundle | null = null;
  selectedAgentId: string | null = null;
  agentQuery = '';
  agentFilter: 'all' | 'alive' | 'dead' = 'all';
  agentClass = -1;
  theme: 'obsidian' | 'paper' = 'obsidian';
  speed = 1;
  private root: HTMLElement | null = null;
  private renderQueued = false;
  private keyboardBound = false;
  private snapshot: ControllerSnapshot;

  constructor() {
    const preset = WEB_PRESETS[0] as WebPreset;
    this.selectedPresetId = preset.id;
    this.draftConfig = preset.config;
    this.draftSeed = preset.seed;
    this.draftPolicy = preset.policy;
    this.snapshot = this.controller.snapshot();
    this.controller.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.queueSave(snapshot);
      this.queueRender();
    });
  }

  mount(root: HTMLElement): void {
    this.root = root;
    clear(root);
    root.classList.add('app-shell');
    try {
      const saved = localStorage.getItem('stratify.theme.v1');
      if (saved === 'paper' || saved === 'obsidian') {
        this.theme = saved;
        document.documentElement.dataset['theme'] = saved;
      }
    } catch {
      // 忽略本地偏好读取失败。
    }
    this.bindKeyboard();
    void this.refreshRuns();
    this.render();
  }

  private bindKeyboard(): void {
    if (this.keyboardBound) return;
    this.keyboardBound = true;
    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea' || target.isContentEditable) {
          return;
        }
      }
      const tab = KEYBOARD_TABS[event.key];
      if (tab !== undefined) {
        event.preventDefault();
        this.setTab(tab);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        const status = this.controller.snapshot().status;
        if (status === 'running' || status === 'awaiting_decision' || status === 'replaying') {
          this.controller.pause();
        } else if (status === 'paused') {
          if (this.controller.snapshot().replay !== null) this.controller.startReplay();
          else this.controller.start();
        } else if (status === 'ready') {
          this.controller.start();
        } else {
          this.start();
        }
        return;
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        this.step();
        return;
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault();
        this.downloadBundle();
      }
    });
  }

  /** 保存节流：每个 run 最多每 2 秒写一次完整 bundle。 */
  private queueSave(snapshot: ControllerSnapshot): void {
    if (
      snapshot.runId === null ||
      snapshot.status === 'idle' ||
      snapshot.status === 'invalid' ||
      snapshot.failure !== null
    ) {
      return;
    }
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const bundle = this.controller.exportBundle(true);
      if (bundle === null) return;
      const signature = `${bundle.runId}:${bundle.latestSnapshot?.state.society.tick ?? 0}:${bundle.status}`;
      if (signature === this.lastSavedSignature) return;
      this.lastSavedSignature = signature;
      void this.store.save(bundle).then(() => {
        try {
          sessionStorage.setItem('stratify.lastRunId.v1', bundle.runId);
        } catch {
          // sessionStorage 不可用时仍保留 IndexedDB 副本。
        }
      });
    }, 2000);
  }

  async refreshRuns(): Promise<void> {
    this.recentRuns = await this.store.list();
    this.render();
  }

  async loadStoredRun(runId: string): Promise<void> {
    const bundle = await this.store.load(runId);
    if (bundle === null) {
      this.notify(`未找到本地 run ${runId}。`);
      return;
    }
    const result = this.controller.importBundle(bundle);
    if (!result.ok) {
      this.notify(`恢复失败：${result.issues[0]?.message ?? '未知错误'}`);
      return;
    }
    this.importedBundle = bundle;
    this.activeTab = 'replay';
    this.notify(`已从 IndexedDB 恢复 ${runId}，停在最终快照。`);
    this.render();
  }

  async clearStoredRuns(): Promise<void> {
    if (!window.confirm('清除全部本地实验？该操作只影响浏览器 IndexedDB，不影响服务器数据。')) {
      return;
    }
    await this.store.clear();
    this.recentRuns = [];
    this.notify('已清除本地实验记录。');
    this.render();
  }

  setTab(tab: TabId): void {
    this.activeTab = tab;
    this.render();
  }

  selectPreset(id: string): void {
    const preset = findPreset(id);
    if (preset === undefined) return;
    this.selectedPresetId = id;
    this.draftConfig = preset.config;
    this.draftSeed = preset.seed;
    this.draftPolicy = preset.policy;
    this.notice = `已载入预设「${preset.name}」（未校准）。`;
    this.render();
  }

  updateDraft(
    patch: Partial<Pick<StratifyApp, 'draftConfig' | 'draftSeed' | 'draftPolicy'>>,
  ): void {
    if (patch.draftConfig !== undefined) this.draftConfig = patch.draftConfig;
    if (patch.draftSeed !== undefined) this.draftSeed = patch.draftSeed;
    if (patch.draftPolicy !== undefined) this.draftPolicy = patch.draftPolicy;
    if (patch.draftConfig !== undefined || patch.draftPolicy !== undefined) {
      this.liveScaleConfirmed = false;
    }
    this.selectedPresetId = 'custom';
  }

  private liveScaleBlocked(): boolean {
    return (
      this.draftPolicy === 'jev_live' &&
      exceedsLiveSuggestion(this.draftConfig) &&
      !this.liveScaleConfirmed
    );
  }

  private liveOptions(): BrowserLiveOptions | undefined {
    if (this.draftPolicy !== 'jev_live') return undefined;
    return {
      apiKey: this.liveApiKey,
      model: this.liveModel,
      maxCalls: this.liveMaxCalls,
      maxInputTokens: this.liveMaxInputTokens,
      maxRunMinutes: this.liveMaxMinutes,
    };
  }

  start(): void {
    if (this.liveScaleBlocked()) {
      this.notice =
        '当前规模超过浏览器 live 建议上限（40 人 / 730 tick / 决策间隔 30）；请在设置页勾选确认后再启动。';
      this.render();
      return;
    }
    const result = this.controller.prepare(
      this.draftConfig,
      this.draftSeed,
      this.draftPolicy,
      this.liveOptions(),
    );
    if (!result.ok) {
      this.notice = null;
      this.render();
      return;
    }
    this.notice = null;
    this.activeTab = 'overview';
    this.controller.start();
  }

  step(): void {
    if (this.liveScaleBlocked()) {
      this.notice =
        '当前规模超过浏览器 live 建议上限（40 人 / 730 tick / 决策间隔 30）；请在设置页勾选确认后再单步。';
      this.render();
      return;
    }
    if (this.controller.snapshot().status === 'idle') {
      const result = this.controller.prepare(
        this.draftConfig,
        this.draftSeed,
        this.draftPolicy,
        this.liveOptions(),
      );
      if (!result.ok) {
        this.render();
        return;
      }
    }
    this.activeTab = 'overview';
    void this.controller.stepOnce();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.controller.setSpeed(speed);
    this.render();
  }

  notify(message: string): void {
    this.notice = message;
    this.render();
  }

  setTheme(theme: 'obsidian' | 'paper'): void {
    this.theme = theme;
    document.documentElement.dataset['theme'] = theme;
    try {
      localStorage.setItem('stratify.theme.v1', theme);
    } catch {
      // 本地偏好不可用时仍允许切换本次会话主题。
    }
    this.render();
  }

  downloadBundle(bundle: WebRunBundle | null = this.controller.exportBundle(true)): void {
    if (bundle === null) {
      this.notify('当前没有可导出的 run。');
      return;
    }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const anchor = h('a', {
      href: URL.createObjectURL(blob),
      download: `${bundle.runId}.stratify.json`,
    });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    this.notify(`已导出 ${bundle.runId}（完整离线 bundle）。`);
  }

  async importFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const result = this.controller.importBundle(parsed);
      if (!result.ok) {
        this.importedBundle = null;
        this.notify(`导入失败：${result.issues[0]?.message ?? '未知错误'}`);
        return;
      }
      this.importedBundle = this.controller.exportBundle(true);
      this.activeTab = 'replay';
      this.notify('导入成功；已停在最终快照，可点击「从头回放」。');
      this.render();
    } catch (error) {
      this.notify(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getSnapshot(): ControllerSnapshot {
    return this.snapshot;
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 0);
  }

  render(): void {
    if (this.root === null) return;
    const snapshot = this.snapshot;
    const header = this.renderHeader(snapshot);
    const tabs = this.renderTabs();
    const main = h('main', {
      class: 'main-viewport',
      id: 'main-viewport',
      tabIndex: -1,
    });
    const workspace = h('div', { class: 'workspace' });
    switch (this.activeTab) {
      case 'setup':
        renderSetup(workspace, this);
        break;
      case 'overview':
        renderOverview(workspace, this);
        break;
      case 'inspector':
        renderInspector(workspace, this);
        break;
      case 'replay':
        renderReplay(workspace, this);
        break;
      case 'manager':
        renderManager(workspace, this);
        break;
    }
    main.append(workspace);
    const footer = this.renderFooter(snapshot);
    clear(this.root);
    this.root.append(header, tabs, main, footer);
    if (this.notice !== null) {
      main.prepend(h('div', { class: 'notice', role: 'status', text: this.notice }));
    }
  }

  private renderHeader(snapshot: ControllerSnapshot): HTMLElement {
    const status = snapshot.status;
    const active =
      status === 'running' || status === 'awaiting_decision' || status === 'settling_tick';
    const canStart =
      status === 'ready' || status === 'paused' || status === 'idle' || status === 'invalid';
    const canPause = status === 'running' || status === 'awaiting_decision';
    const canStep = status === 'ready' || status === 'paused';
    const canStop =
      status === 'running' ||
      status === 'paused' ||
      status === 'awaiting_decision' ||
      status === 'settling_tick';
    const transport = h('div', { class: 'transport', role: 'toolbar', ariaLabel: '仿真控制' }, [
      h('button', {
        class: 'btn btn-primary',
        disabled: !canStart,
        text: status === 'paused' ? '继续' : '开始',
        onClick: () => {
          if (status === 'paused' && snapshot.generation > 0) this.controller.start();
          else this.start();
        },
        title: '开始/继续（Space 在总览页暂停）',
      }),
      h('button', {
        class: 'btn',
        disabled: !canPause,
        text: '暂停',
        onClick: () => this.controller.pause(),
      }),
      h('button', {
        class: 'btn',
        disabled: !canStep,
        text: '单步 +1',
        onClick: () => this.step(),
      }),
      h('button', {
        class: 'btn btn-danger',
        disabled: !canStop,
        text: '停止',
        onClick: () => this.controller.stop(),
      }),
      h('button', {
        class: 'btn btn-ghost',
        disabled: status === 'idle',
        text: '重置',
        onClick: () => {
          this.controller.reset();
          this.activeTab = 'setup';
          this.render();
        },
      }),
      h(
        'div',
        { class: 'speed', role: 'group', ariaLabel: '速度' },
        [1, 5, 20, 0].map((speed) =>
          h('button', {
            text: speed === 0 ? 'Max' : `${speed}x`,
            ariaPressed: String(this.speed === speed),
            onClick: () => this.setSpeed(speed),
          }),
        ),
      ),
    ]);

    return h('header', { class: 'command-hud' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-mark', text: 'S' }),
        h('div', {}, [
          h('h1', { text: 'Stratify' }),
          h('div', { class: 'brand-meta' }, [
            badge('rules-v15', 'info'),
            badge('未校准 · G6 未通过', 'warn'),
            badge('Obsidian Lab', 'muted'),
          ]),
        ]),
      ]),
      h('div', {}, [
        h('div', { class: 'status-row' }, [
          h('span', { class: 'status-beacon', data: { status } }, [
            h('span', { class: 'status-dot' }),
            h('span', {
              text: `${STATUS_TEXT[status]} · ${formatTick(snapshot.tick, snapshot.totalTicks)}`,
            }),
          ]),
          snapshot.replay === null
            ? null
            : badge(`${snapshot.replay.mode} · 失效 ${snapshot.replay.replayInvalid}`, 'info'),
        ]),
        h('div', { style: 'height:4px' }),
        transport,
      ]),
      h('div', { class: 'hud-right' }, [
        h('div', { class: 'hash-line', text: `policy ${this.currentPolicyLabel(snapshot)}` }),
        h('div', { class: 'hash-line', text: `run ${snapshot.runId ?? '—'}` }),
        h('div', {
          class: 'hash-line',
          title: snapshot.configHash ?? '',
          text: `config ${shortHash(snapshot.configHash)} · params ${shortHash(snapshot.paramsHash)}`,
        }),
        h('div', {
          class: 'hash-line',
          text: active ? `alive ${snapshot.aliveCount}` : '本地权威 · 未上传',
        }),
      ]),
    ]);
  }

  private currentPolicyLabel(snapshot: ControllerSnapshot): string {
    return snapshot.runId === null ? this.draftPolicy : snapshot.policy;
  }

  private renderTabs(): HTMLElement {
    const nav = h('nav', { class: 'workspace-tabs', role: 'tablist', ariaLabel: '工作区' });
    for (const tab of TABS) {
      nav.append(
        h('button', {
          class: 'tab',
          role: 'tab',
          id: `tab-${tab.id}`,
          ariaSelected: String(this.activeTab === tab.id),
          text: tab.label,
          title: tab.hint,
          onClick: () => this.setTab(tab.id),
        }),
      );
    }
    return nav;
  }

  private renderFooter(snapshot: ControllerSnapshot): HTMLElement {
    const kpis = buildKpis(snapshot);
    const gini = kpis.find((kpi) => kpi.id === 'gini')?.value ?? '—';
    return h('footer', { class: 'footer-bar' }, [
      h('span', { text: `状态 ${snapshot.status}` }),
      h('span', { text: `G ${gini}` }),
      h('span', {
        title: snapshot.configHash ?? '',
        text: `config ${shortHash(snapshot.configHash)}`,
      }),
      h('span', {
        title: snapshot.initialPopulationHash ?? '',
        text: `initPop ${shortHash(snapshot.initialPopulationHash)}`,
      }),
      h('span', { text: snapshot.decisionsTruncated ? '决策日志已截断' : '决策日志完整' }),
      h('span', { class: 'muted', text: '仅本地 · 未上传 · 结构结论未通过 G6' }),
    ]);
  }
}

function shortHash(hash: string | null): string {
  if (hash === null || hash === '') return '—';
  return `${hash.slice(0, 14)}…`;
}

export function configPreview(config: RunConfig): { configHash: string; paramsHash: string } {
  return { configHash: computeConfigHash(config), paramsHash: computeParamsHash(config) };
}

export function numeric(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatValue(value: number): string {
  return formatNumber(value);
}
