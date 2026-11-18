import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import type { RunConfig } from '../core/config/types.js';
import { validateRunConfig } from '../core/config/validate.js';
import type { AgentId } from '../core/control/ids.js';
import type { PromptStyle } from '../decision/types.js';
import {
  findPreset,
  SANDBOX_SCENARIOS,
  WEB_PRESETS,
  type SandboxScenario,
  type WebPreset,
} from '../app/presets.js';
import { RunController } from '../app/run-controller.js';
import { IdbRunStore, type StoredRunMeta } from '../app/idb-store.js';
import { exceedsLiveSuggestion, type BrowserLiveOptions } from '../app/live-policy.js';
import type { ControllerSnapshot, OfflinePolicyId, WebRunBundle } from '../app/types.js';
import {
  buildKpis,
  formatNumber,
  formatTick,
  parsePairedBatchForest,
  type PairedBatchForestSummary,
  type WindowKey,
} from '../app/view-model.js';
import { append, badge, clear, h, setTextIfChanged } from './dom.js';
import { InspectorView, type AgentSortMode } from './workspaces/inspector.js';
import { renderManager } from './workspaces/manager.js';
import { renderOverview } from './workspaces/overview.js';
import { renderReplay } from './workspaces/replay.js';
import { SandboxView } from './workspaces/sandbox.js';
import { renderSetup } from './workspaces/setup.js';

export type SurfaceId = 'testbench' | 'sandbox';
export type TabId = 'setup' | 'overview' | 'inspector' | 'replay' | 'manager';

const TABS: readonly { id: TabId; label: string; hint: string }[] = [
  { id: 'setup', label: '① 实验设置', hint: '预设、七维参数与预检' },
  { id: 'overview', label: '② 实时总览', hint: '结构指纹、窗口曲线与事件' },
  { id: 'inspector', label: '③ 个体检查器', hint: '花名册、决策 X 光与复式账本' },
  { id: 'replay', label: '④ 回放与对比', hint: '归档导入、逐帧回放与双宇宙对比' },
  { id: 'manager', label: '⑤ 实验管理', hint: '本地注册表、配额与权威诊断' },
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

interface ShellRefs {
  readonly statusBeacon: HTMLElement;
  readonly statusLabel: HTMLElement;
  readonly extraStatusHost: HTMLElement;
  readonly progressFill: HTMLElement;
  readonly btnStart: HTMLButtonElement;
  readonly btnPause: HTMLButtonElement;
  readonly btnStep: HTMLButtonElement;
  readonly btnCycle: HTMLButtonElement;
  readonly btnStop: HTMLButtonElement;
  readonly btnReset: HTMLButtonElement;
  readonly btnTheme: HTMLButtonElement;
  readonly snapshotSelect: HTMLSelectElement;
  readonly speedButtons: ReadonlyMap<number, HTMLButtonElement>;
  readonly hudPolicy: HTMLElement;
  readonly hudRun: HTMLElement;
  readonly hudHashes: HTMLElement;
  readonly hudStateLine: HTMLElement;
  readonly modeSandboxBtn: HTMLButtonElement;
  readonly modeBenchBtn: HTMLButtonElement;
  readonly tabButtons: ReadonlyMap<TabId, HTMLButtonElement>;
  readonly noticeHost: HTMLElement;
  readonly sandboxHost: HTMLElement;
  readonly inspectorHost: HTMLElement;
  readonly dynamicTabHost: HTMLElement;
  readonly footerStatus: HTMLElement;
  readonly footerGini: HTMLElement;
  readonly footerConfig: HTMLElement;
  readonly footerPop: HTMLElement;
  readonly footerDecisions: HTMLElement;
}

export class StratifyApp {
  readonly controller = new RunController();
  readonly store = new IdbRunStore();
  recentRuns: readonly StoredRunMeta[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedSignature = '';

  surface: SurfaceId = 'testbench';
  activeTab: TabId = 'setup';
  overviewWindow: WindowKey = 'all';
  overviewTableMode = false;
  wealthLogScale = false;
  zoomRange: readonly [number, number] = [0, 100];
  eventFilter: 'all' | 'mobility' | 'compete' | 'death' = 'all';

  draftConfig: RunConfig;
  draftSeed: string;
  draftPolicy: OfflinePolicyId;
  /** live Key 只驻留内存；不写 localStorage/IndexedDB/导出 bundle。 */
  liveApiKey = '';
  liveModel = 'jev-1.13.0';
  livePromptStyle: PromptStyle = 'neutral';
  liveMaxCalls = 200;
  liveMaxInputTokens = 200_000;
  liveMaxMinutes = 30;
  /** 超出 06 建议规模时，必须显式勾选后才能启动 live。 */
  liveScaleConfirmed = false;
  selectedPresetId: string;
  notice: string | null = null;
  importedBundle: WebRunBundle | null = null;
  batchForestSummary: PairedBatchForestSummary | null = null;
  selectedAgentId: string | null = null;
  agentQuery = '';
  agentFilter: 'all' | 'alive' | 'dead' = 'all';
  agentClass = -1;
  agentSort: AgentSortMode = 'id';
  theme: 'obsidian' | 'paper' = 'obsidian';
  speed = 1;
  private lastSnapshotOptionsSig = '';

  private root: HTMLElement | null = null;
  private shell: ShellRefs | null = null;
  private sandboxView: SandboxView | null = null;
  private inspectorView: InspectorView | null = null;
  private renderedDynamicTab: TabId | null = null;
  private renderQueued = false;
  private keyboardBound = false;
  private snapshot: ControllerSnapshot;

  constructor() {
    const preset = WEB_PRESETS[0] as WebPreset;
    this.selectedPresetId = preset.id;
    this.draftConfig = preset.config;
    this.draftSeed = preset.seed;
    this.draftPolicy = preset.policy;
    this.restoreLastConfigFromStorage();
    this.snapshot = this.controller.snapshot();
    this.controller.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.queueSave(snapshot);
      if (
        snapshot.pendingAvatarPrompt !== null ||
        snapshot.status === 'completed' ||
        snapshot.status === 'failed'
      ) {
        this.render(false);
      } else {
        this.queueRender();
      }
    });
  }

  mount(root: HTMLElement): void {
    this.root = root;
    clear(root);
    root.classList.add('app-shell');
    this.restoreSettingsFromStorage();
    this.buildPersistentShell(root);
    this.bindKeyboard();
    void this.refreshRuns();
    void this.tryAutoRestoreLastSession();
    this.render(true);
  }

  private restoreSettingsFromStorage(): void {
    try {
      const settingsRaw = localStorage.getItem('stratify.settings.v1');
      if (settingsRaw !== null) {
        const parsed = JSON.parse(settingsRaw) as Record<string, unknown>;
        if (parsed['theme'] === 'paper' || parsed['theme'] === 'obsidian') {
          this.theme = parsed['theme'];
        }
        if (typeof parsed['speed'] === 'number' && [0, 1, 5, 20].includes(parsed['speed'])) {
          this.speed = parsed['speed'];
          this.controller.setSpeed(this.speed);
        }
      } else {
        const legacyTheme = localStorage.getItem('stratify.theme.v1');
        if (legacyTheme === 'paper' || legacyTheme === 'obsidian') {
          this.theme = legacyTheme;
        }
      }
      document.documentElement.dataset['theme'] = this.theme;
    } catch {
      // 忽略本地偏好读取异常
    }
  }

  private persistSettingsToStorage(): void {
    try {
      localStorage.setItem(
        'stratify.settings.v1',
        JSON.stringify({ theme: this.theme, speed: this.speed }),
      );
      localStorage.setItem('stratify.theme.v1', this.theme);
    } catch {
      // 本地存储受限时忽略
    }
  }

  private restoreLastConfigFromStorage(): void {
    try {
      const raw = localStorage.getItem('stratify.lastConfig.v1');
      if (raw === null) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const check = validateRunConfig(parsed['config']);
      if (!check.ok) return;
      this.draftConfig = check.config;
      if (typeof parsed['seed'] === 'string' && parsed['seed'].trim() !== '') {
        this.draftSeed = parsed['seed'];
      }
      if (
        parsed['policy'] === 'mock-weighted-v1' ||
        parsed['policy'] === 'mock-weighted-v2' ||
        parsed['policy'] === 'random-uniform-v1' ||
        parsed['policy'] === 'jev_live'
      ) {
        this.draftPolicy = parsed['policy'];
      }
      if (parsed['promptStyle'] === 'neutral' || parsed['promptStyle'] === 'survival_hint') {
        this.livePromptStyle = parsed['promptStyle'];
      }
      if (typeof parsed['presetId'] === 'string') {
        this.selectedPresetId = parsed['presetId'];
      }
    } catch {
      // 忽略损坏草案
    }
  }

  private persistLastConfigToStorage(): void {
    try {
      // 严格禁止写入 liveApiKey 等任何密钥字段（06 §8）
      localStorage.setItem(
        'stratify.lastConfig.v1',
        JSON.stringify({
          presetId: this.selectedPresetId,
          seed: this.draftSeed,
          policy: this.draftPolicy,
          promptStyle: this.livePromptStyle,
          config: this.draftConfig,
        }),
      );
    } catch {
      // 本地存储受限时忽略
    }
  }

  private async tryAutoRestoreLastSession(): Promise<void> {
    let lastRunId: string | null = null;
    try {
      lastRunId = sessionStorage.getItem('stratify.lastRunId.v1');
    } catch {
      return;
    }
    if (lastRunId === null || lastRunId.trim() === '') return;
    if (!IdbRunStore.available()) return;
    const bundle = await this.store.load(lastRunId);
    // 若异步加载期间用户已主动启动新实验，绝不覆盖用户操作
    if (this.controller.snapshot().status !== 'idle') return;
    if (bundle === null) {
      try {
        sessionStorage.removeItem('stratify.lastRunId.v1');
      } catch {
        // ignore
      }
      this.notify(
        `上次同标签页会话 (${lastRunId}) 在 IndexedDB 中无完整分块记录，未假装恢复成功。`,
      );
      return;
    }
    const res = this.controller.restoreSessionBundle(bundle);
    if (!res.ok) {
      this.notify(`上次会话校验未通过，未自动恢复：${res.issues[0]?.message ?? '未知原因'}`);
      return;
    }
    if (this.activeTab === 'setup') {
      this.activeTab = 'overview';
    }
    this.notify(
      `已自动恢复同标签页会话 ${bundle.runId}（Tick ${bundle.latestSnapshot?.state.society.tick ?? 0}，${bundle.status === 'completed' ? '已完成' : '已暂停'}）。`,
    );
    this.render(true);
  }

  private buildPersistentShell(root: HTMLElement): void {
    const statusBeacon = h('span', { class: 'status-beacon', data: { status: 'idle' } });
    const statusDot = h('span', { class: 'status-dot' });
    const statusLabel = h('span', { text: '' });
    statusBeacon.append(statusDot, statusLabel);
    const extraStatusHost = h('span', { class: 'actions-row' });

    const progressFill = h('div', { class: 'timeline-progress-fill', style: 'width:0%' });
    const progressBar = h('div', { class: 'timeline-progress-track', ariaLabel: '实验进度条' }, [
      progressFill,
    ]);

    const btnStart = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: '开始',
      title: '开始/继续（快捷键 Space）',
      onClick: () => {
        const snap = this.controller.snapshot();
        if (snap.status === 'paused' && snap.generation > 0) {
          if (snap.replay !== null) this.controller.startReplay();
          else this.controller.start();
        } else {
          this.start(this.surface);
        }
      },
    }) as HTMLButtonElement;

    const btnPause = h('button', {
      class: 'btn',
      type: 'button',
      text: '暂停',
      onClick: () => this.controller.pause(),
    }) as HTMLButtonElement;

    const btnStep = h('button', {
      class: 'btn',
      type: 'button',
      text: '单步 +1',
      title: '推进 1 个 tick（快捷键 N）',
      onClick: () => this.step(),
    }) as HTMLButtonElement;

    const btnCycle = h('button', {
      class: 'btn',
      type: 'button',
      text: '决策步',
      title: '推进至下一个决策周期',
      onClick: () => void this.stepDecision(),
    }) as HTMLButtonElement;

    const btnStop = h('button', {
      class: 'btn btn-danger',
      type: 'button',
      text: '停止',
      onClick: () => this.controller.stop(),
    }) as HTMLButtonElement;

    const btnReset = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '重置',
      onClick: () => {
        this.controller.reset();
        if (this.surface === 'testbench') {
          this.activeTab = 'setup';
        }
        this.render(true);
      },
    }) as HTMLButtonElement;

    const speedButtons = new Map<number, HTMLButtonElement>();
    const speedGroup = h('div', { class: 'speed', role: 'group', ariaLabel: '速度' });
    for (const spd of [1, 5, 20, 0]) {
      const btn = h('button', {
        type: 'button',
        text: spd === 0 ? 'Max' : `${spd}x`,
        ariaPressed: String(this.speed === spd),
        onClick: () => this.setSpeed(spd),
      }) as HTMLButtonElement;
      speedButtons.set(spd, btn);
      speedGroup.append(btn);
    }

    const snapshotSelect = h('select', {
      class: 'snapshot-select',
      ariaLabel: '跳转已存历史快照点',
      title: '回滚/跳转至已记录的周期快照点（暂停态）',
      disabled: true,
      onChange: (event) => {
        const val = (event.target as HTMLSelectElement).value;
        if (val === '') return;
        const tick = Number(val);
        if (Number.isFinite(tick)) {
          this.jumpToSnapshot(tick);
        }
        (event.target as HTMLSelectElement).value = '';
      },
    }) as HTMLSelectElement;
    snapshotSelect.append(h('option', { value: '', text: '⏱ 快照点' }));

    const btnTheme = h('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      title: '切换深色/浅色科研主题',
      text: this.theme === 'obsidian' ? '☀ Paper' : '🌙 Obsidian',
      onClick: () => this.setTheme(this.theme === 'obsidian' ? 'paper' : 'obsidian'),
    }) as HTMLButtonElement;

    const transport = h('div', { class: 'transport', role: 'toolbar', ariaLabel: '仿真控制' }, [
      btnStart,
      btnPause,
      btnStep,
      btnCycle,
      btnStop,
      btnReset,
      snapshotSelect,
      speedGroup,
      btnTheme,
    ]);

    const hudPolicy = h('div', { class: 'hash-line' });
    const hudRun = h('div', { class: 'hash-line' });
    const hudHashes = h('div', { class: 'hash-line' });
    const hudStateLine = h('div', { class: 'hash-line' });

    const header = h('header', { class: 'command-hud' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-mark', text: 'S' }),
        h('div', {}, [
          h('div', { class: 'brand-title-row' }, [
            h('h1', { text: 'Stratify' }),
            h('span', { class: 'brand-sub', text: 'Sociology Observatory' }),
          ]),
          h('div', { class: 'brand-meta' }, [
            badge('rules-v18', 'info'),
            badge('G6 已通过（D1 两体制）', 'ok'),
          ]),
        ]),
      ]),
      h('div', { class: 'hud-center' }, [
        h('div', { class: 'status-row' }, [statusBeacon, extraStatusHost]),
        progressBar,
        transport,
      ]),
      h('div', { class: 'hud-right' }, [hudPolicy, hudRun, hudHashes, hudStateLine]),
    ]);

    const modeSandboxBtn = h('button', {
      class: 'mode-pill',
      type: 'button',
      ariaPressed: 'false',
      text: '✦ 交互沙盒剧场',
      title: '沉浸式五阶层动态舞台 · 主角化身抉择 · 微扰分叉（快捷键 0）',
      onClick: () => this.setSurface('sandbox'),
    }) as HTMLButtonElement;

    const modeBenchBtn = h('button', {
      class: 'mode-pill',
      type: 'button',
      ariaPressed: 'true',
      text: '◈ 精密科研试验台',
      title: '五大专业工作区：参数、曲线、检查器、回放对比与存储诊断',
      onClick: () => this.setSurface('testbench'),
    }) as HTMLButtonElement;

    const tabButtons = new Map<TabId, HTMLButtonElement>();
    const tabList = h('div', { class: 'tabs-group', role: 'tablist', ariaLabel: '工作区' });
    for (const tab of TABS) {
      const btn = h('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${tab.id}`,
        ariaSelected: String(this.activeTab === tab.id),
        text: tab.label,
        title: tab.hint,
        onClick: () => this.setTab(tab.id),
      }) as HTMLButtonElement;
      tabButtons.set(tab.id, btn);
      tabList.append(btn);
    }

    const navBar = h('nav', { class: 'workspace-tabs', ariaLabel: '视图与工作区导航' }, [
      h('div', { class: 'mode-switcher', role: 'group', ariaLabel: '界面模式切换' }, [
        modeSandboxBtn,
        modeBenchBtn,
      ]),
      h('span', { class: 'nav-divider', ariaLabel: '分隔线' }),
      tabList,
    ]);

    const noticeHost = h('div', { class: 'notice-host' });
    this.sandboxView = new SandboxView(this);
    this.inspectorView = new InspectorView(this);
    const sandboxHost = h('div', { hidden: true }, [this.sandboxView.root]);
    const inspectorHost = h('div', { hidden: true }, [this.inspectorView.root]);
    const dynamicTabHost = h('div', { class: 'workspace' });

    const main = h(
      'main',
      {
        class: 'main-viewport',
        id: 'main-viewport',
        tabIndex: -1,
      },
      [noticeHost, sandboxHost, inspectorHost, dynamicTabHost],
    );

    const footerStatus = h('span', {});
    const footerGini = h('span', {});
    const footerConfig = h('span', {});
    const footerPop = h('span', {});
    const footerDecisions = h('span', {});

    const footer = h('footer', { class: 'footer-bar' }, [
      footerStatus,
      footerGini,
      footerConfig,
      footerPop,
      footerDecisions,
      h('span', { class: 'muted', text: '仅本地 · 未上传 · 结构结论未通过 G6' }),
    ]);

    root.append(header, navBar, main, footer);

    this.shell = {
      statusBeacon,
      statusLabel,
      extraStatusHost,
      progressFill,
      btnStart,
      btnPause,
      btnStep,
      btnCycle,
      btnStop,
      btnReset,
      btnTheme,
      snapshotSelect,
      speedButtons,
      hudPolicy,
      hudRun,
      hudHashes,
      hudStateLine,
      modeSandboxBtn,
      modeBenchBtn,
      tabButtons,
      noticeHost,
      sandboxHost,
      inspectorHost,
      dynamicTabHost,
      footerStatus,
      footerGini,
      footerConfig,
      footerPop,
      footerDecisions,
    };
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
      if (event.key === '0') {
        event.preventDefault();
        this.setSurface('sandbox');
        return;
      }
      const tab = KEYBOARD_TABS[event.key];
      if (tab !== undefined) {
        event.preventDefault();
        this.setTab(tab);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        const snap = this.controller.snapshot();
        const status = snap.status;
        if (status === 'running' || status === 'awaiting_decision' || status === 'replaying') {
          this.controller.pause();
        } else if (status === 'paused') {
          if (snap.replay !== null) this.controller.startReplay();
          else this.controller.start();
        } else if (status === 'ready') {
          this.controller.start();
        } else {
          this.start(this.surface);
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
    const isActiveLoop =
      snapshot.status === 'running' ||
      snapshot.status === 'awaiting_decision' ||
      snapshot.status === 'settling_tick' ||
      snapshot.status === 'replaying';
    const delayMs = isActiveLoop ? 4500 : 80;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveCurrentBundleNow();
    }, delayMs);
  }

  /** 立即将当前权威状态按 v3 分块持久化到 IndexedDB 并登记同标签页恢复键。 */
  async saveCurrentBundleNow(): Promise<boolean> {
    const bundle = this.controller.exportBundle(true);
    if (bundle === null) return false;
    const signature = `${bundle.runId}:${bundle.latestSnapshot?.state.society.tick ?? 0}:${bundle.status}`;
    if (signature === this.lastSavedSignature) return true;
    this.lastSavedSignature = signature;
    await this.store.save(bundle);
    try {
      sessionStorage.setItem('stratify.lastRunId.v1', bundle.runId);
    } catch {
      // sessionStorage 受限时仍保留 IndexedDB
    }
    return true;
  }

  async refreshRuns(): Promise<void> {
    this.recentRuns = await this.store.list();
    try {
      localStorage.setItem('stratify.recentRuns.v1', JSON.stringify(this.recentRuns.slice(0, 10)));
    } catch {
      // ignore
    }
    if (this.surface === 'testbench' && this.activeTab === 'manager') {
      this.render(true);
    }
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
    this.surface = 'testbench';
    this.activeTab = 'replay';
    this.notify(`已从 IndexedDB 恢复 ${runId}，可点击「从头回放」。`);
    this.render(true);
  }

  async pinStoredRunAsBaseline(runId: string): Promise<void> {
    const bundle = await this.store.load(runId);
    if (bundle === null) {
      this.notify(`未找到本地 run ${runId}。`);
      return;
    }
    this.importedBundle = bundle;
    this.surface = 'testbench';
    this.activeTab = 'replay';
    this.notify(`已将 ${runId} 绑定为右栏对照基准。`);
    this.render(true);
  }

  pinCurrentAsBaseline(): void {
    const bundle = this.controller.exportBundle(true);
    if (bundle === null) {
      this.notify('当前没有可锁定的活动实验。');
      return;
    }
    this.importedBundle = bundle;
    this.notify(
      `已将当前实验 ${bundle.runId} (Tick ${bundle.latestSnapshot?.state.society.tick ?? 0}) 锁定为对照基准。`,
    );
    this.render(true);
  }

  async clearStoredRuns(): Promise<void> {
    if (!window.confirm('清除全部本地实验？该操作只影响浏览器 IndexedDB，不影响服务器数据。')) {
      return;
    }
    await this.store.clear();
    this.recentRuns = [];
    this.notify('已清除本地实验记录。');
    this.render(true);
  }

  setSurface(surface: SurfaceId): void {
    this.surface = surface;
    if (surface === 'sandbox' && this.controller.snapshot().status === 'idle') {
      const first = SANDBOX_SCENARIOS[0];
      if (first !== undefined) {
        this.prepareScenarioWithoutAutoRun(first);
      }
    }
    this.render(true);
  }

  setTab(tab: TabId): void {
    this.surface = 'testbench';
    this.activeTab = tab;
    if (tab === 'manager') {
      void this.refreshRuns();
    }
    this.render(true);
  }

  selectAgent(agentId: string): void {
    this.selectedAgentId = agentId;
    this.render(false);
  }

  possessAgent(agentId: AgentId, interactive = true): void {
    this.selectedAgentId = agentId;
    this.controller.setAvatar(agentId, interactive);
    this.notify(
      interactive
        ? `已化身个体 ${agentId}：每逢决策日将暂停弹出「命运抉择行动卡」。`
        : `已关注个体 ${agentId}（AI 自动托管）。`,
    );
  }

  cycleAvatar(): void {
    const state = this.controller.getState();
    if (state === null) {
      this.notify('尚未初始化世界，请先点击剧本或「开始」。');
      return;
    }
    const alive = state.society.agents.filter((a) => a.alive);
    if (alive.length === 0) {
      this.notify('当前已无存活个体可附身。');
      return;
    }
    const currentId = this.controller.snapshot().avatarId;
    const idx = alive.findIndex((a) => a.id === currentId);
    const next = alive[(idx + 1) % alive.length];
    if (next !== undefined) {
      this.possessAgent(next.id, this.controller.snapshot().avatarInteractive || true);
    }
  }

  forkFocusedAgent(deltaValue = 0.0001): void {
    const state = this.controller.getState();
    if (state === null) {
      this.notify('请先开始运行并推进若干 Tick 后再执行平行宇宙分叉。');
      return;
    }
    const targetId =
      (this.selectedAgentId as AgentId | null) ??
      this.controller.snapshot().avatarId ??
      state.society.agents.find((a) => a.alive)?.id ??
      null;
    if (targetId === null) {
      this.notify('当前无存活个体可供微扰分叉。');
      return;
    }
    const outcome = this.controller.forkAgentValuePerturbation(targetId, deltaValue);
    if (outcome.ok && outcome.baselineBundle !== null) {
      this.importedBundle = outcome.baselineBundle;
    }
    this.notify(outcome.message);
    this.render(true);
  }

  private prepareScenarioWithoutAutoRun(scenario: SandboxScenario): void {
    this.draftConfig = scenario.config;
    this.draftSeed = scenario.seed;
    this.draftPolicy = scenario.policy;
    this.selectedPresetId = 'custom';
    const res = this.controller.prepare(scenario.config, scenario.seed, scenario.policy);
    if (res.ok) {
      const state = this.controller.getState();
      const candidate =
        state?.society.agents.find(
          (a) => a.alive && a.classIndex === scenario.suggestedAvatarClass,
        ) ?? state?.society.agents.find((a) => a.alive);
      if (candidate !== undefined) {
        this.selectedAgentId = candidate.id;
        this.controller.setAvatar(candidate.id, scenario.interactiveDefault);
      }
    }
  }

  launchSandboxScenario(scenario: SandboxScenario): void {
    this.surface = 'sandbox';
    this.prepareScenarioWithoutAutoRun(scenario);
    this.notice = `已装载探索剧本「${scenario.title}」（未校准探索沙盒）。`;
    this.controller.start();
    this.render(true);
  }

  selectPreset(id: string): void {
    const preset = findPreset(id);
    if (preset === undefined) return;
    this.selectedPresetId = id;
    this.draftConfig = preset.config;
    this.draftSeed = preset.seed;
    this.draftPolicy = preset.policy;
    this.persistLastConfigToStorage();
    this.notice = preset.calibrated
      ? `已载入 G6 校准预设「${preset.name}」（D1 两体制，rules-v16）。`
      : `已载入预设「${preset.name}」（未校准）。`;
    this.render(true);
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
    this.persistLastConfigToStorage();
  }

  jumpToSnapshot(targetTick: number): void {
    const ok = this.controller.jumpToSnapshot(targetTick);
    if (!ok) {
      this.notify(`未找到 Tick ${targetTick} 的有效周期快照。`);
      return;
    }
    this.notify(`已跳转至历史快照 Tick ${targetTick}（已暂停，后续轨迹已裁剪）。`);
    this.render(true);
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
      promptStyle: this.livePromptStyle,
      maxCalls: this.liveMaxCalls,
      maxInputTokens: this.liveMaxInputTokens,
      maxRunMinutes: this.liveMaxMinutes,
    };
  }

  start(targetSurface?: SurfaceId): void {
    if (this.liveScaleBlocked()) {
      this.notice =
        '当前规模超过浏览器 live 建议上限（40 人 / 730 tick / 决策间隔 30）；请在设置页勾选确认后再启动。';
      this.surface = 'testbench';
      this.activeTab = 'setup';
      this.render(true);
      return;
    }
    const result = this.controller.prepare(
      this.draftConfig,
      this.draftSeed,
      this.draftPolicy,
      this.liveOptions(),
    );
    if (!result.ok) {
      this.notice = `配置未通过校验：${result.issues[0]?.path ?? '$'} ${result.issues[0]?.message ?? ''}`;
      this.render(true);
      return;
    }
    this.notice = null;
    if (targetSurface === 'sandbox') {
      this.surface = 'sandbox';
      const state = this.controller.getState();
      if (this.controller.snapshot().avatarId === null && state !== null) {
        const firstAlive = state.society.agents.find((a) => a.alive);
        if (firstAlive !== undefined) {
          this.selectedAgentId = firstAlive.id;
          this.controller.setAvatar(firstAlive.id, false);
        }
      }
    } else {
      this.surface = 'testbench';
      this.activeTab = 'overview';
    }
    this.controller.start();
    this.render(true);
  }

  step(): void {
    if (this.liveScaleBlocked()) {
      this.notice =
        '当前规模超过浏览器 live 建议上限（40 人 / 730 tick / 决策间隔 30）；请在设置页勾选确认后再单步。';
      this.surface = 'testbench';
      this.activeTab = 'setup';
      this.render(true);
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
        this.render(true);
        return;
      }
    }
    if (this.surface === 'testbench' && this.activeTab === 'setup') {
      this.activeTab = 'overview';
    }
    void this.controller.stepOnce();
  }

  async stepDecision(): Promise<void> {
    if (this.liveScaleBlocked()) {
      this.notice =
        '当前规模超过浏览器 live 建议上限（40 人 / 730 tick / 决策间隔 30）；请在设置页勾选确认。';
      this.render(true);
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
        this.render(true);
        return;
      }
    }
    if (this.surface === 'testbench' && this.activeTab === 'setup') {
      this.activeTab = 'overview';
    }
    await this.controller.stepDecisionCycle();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.controller.setSpeed(speed);
    this.persistSettingsToStorage();
    this.updateShellChrome();
  }

  notify(message: string): void {
    this.notice = message;
    this.updateNoticeHost();
  }

  setTheme(theme: 'obsidian' | 'paper'): void {
    this.theme = theme;
    document.documentElement.dataset['theme'] = theme;
    this.persistSettingsToStorage();
    this.render(false);
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
        this.notify(`导入失败：${result.issues[0]?.message ?? '未知错误'}`);
        return;
      }
      this.importedBundle = this.controller.exportBundle(true);
      this.surface = 'testbench';
      this.activeTab = 'replay';
      this.notify('导入成功；已载入快照，可点击「从头回放」。');
      this.render(true);
    } catch (error) {
      this.notify(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadComparisonOnlyFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const probe = new RunController();
      const res = probe.importBundle(parsed);
      if (!res.ok) {
        this.notify(`对照文件校验失败：${res.issues[0]?.message ?? '未知错误'}`);
        return;
      }
      this.importedBundle = probe.exportBundle(true);
      this.surface = 'testbench';
      this.activeTab = 'replay';
      this.notify(`已载入对照基准 ${this.importedBundle?.runId ?? ''}（未覆盖当前实验）。`);
      this.render(true);
    } catch (error) {
      this.notify(`对照文件读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async importBatchForestFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const summary = parsePairedBatchForest(parsed);
      if (summary === null) {
        this.notify('批次摘要格式无效：需含 pairedSeeds/seeds 与非空 metrics 区间数组。');
        return;
      }
      this.batchForestSummary = summary;
      this.surface = 'testbench';
      this.activeTab = 'replay';
      this.notify(
        summary.eligibleForInference
          ? `已载入配对批次摘要「${summary.title}」(N=${summary.pairedSeeds}，已渲染森林图)。`
          : `已载入批次摘要「${summary.title}」(N=${summary.pairedSeeds} < 30，已按护栏阻止推断性区间图)。`,
      );
      this.render(true);
    } catch (error) {
      this.notify(`批次摘要读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getSnapshot(): ControllerSnapshot {
    return this.snapshot;
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const flush = (): void => {
      this.renderQueued = false;
      this.render(false);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }

  private updateNoticeHost(): void {
    if (this.shell === null) return;
    if (this.notice === null) {
      this.shell.noticeHost.replaceChildren();
    } else {
      this.shell.noticeHost.replaceChildren(
        h('div', { class: 'notice notice-dismissible', role: 'status' }, [
          h('span', { text: this.notice }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: '✕',
            ariaLabel: '关闭提示',
            onClick: () => {
              this.notice = null;
              this.updateNoticeHost();
            },
          }),
        ]),
      );
    }
  }

  private updateShellChrome(): void {
    const s = this.shell;
    if (s === null) return;
    const snap = this.snapshot;
    const status = snap.status;
    const active =
      status === 'running' || status === 'awaiting_decision' || status === 'settling_tick';
    const canStart =
      status === 'ready' ||
      status === 'paused' ||
      status === 'idle' ||
      status === 'invalid' ||
      status === 'completed' ||
      status === 'cancelled';
    const canPause =
      status === 'running' || status === 'awaiting_decision' || status === 'replaying';
    const canStep = status === 'ready' || status === 'paused' || status === 'idle';
    const canStop =
      status === 'running' ||
      status === 'paused' ||
      status === 'awaiting_decision' ||
      status === 'settling_tick' ||
      status === 'replaying';

    s.statusBeacon.dataset['status'] = status;
    let statusDetail = `${STATUS_TEXT[status]} · ${formatTick(snap.tick, snap.totalTicks)}`;
    if (status === 'awaiting_decision') {
      if (snap.pendingAvatarPrompt !== null) {
        statusDetail = `等待玩家出牌 (${snap.pendingAvatarPrompt.agentId}) · Tick ${snap.tick}`;
      } else if (snap.decisionProgress !== null) {
        statusDetail = `等待决策 (${snap.decisionProgress.completed}/${snap.decisionProgress.total}) · Tick ${snap.tick}`;
      }
    }
    setTextIfChanged(s.statusLabel, statusDetail);

    s.extraStatusHost.replaceChildren();
    append(s.extraStatusHost, [
      snap.replay === null
        ? null
        : badge(`${snap.replay.mode} · 失效 ${snap.replay.replayInvalid}`, 'info'),
      snap.forkProvenance === null
        ? null
        : badge(`🌿 分叉 @t${snap.forkProvenance.forkTick}`, 'violet'),
    ]);

    const pct =
      snap.totalTicks > 0 ? Math.min(100, Math.max(0, (snap.tick / snap.totalTicks) * 100)) : 0;
    s.progressFill.style.width = `${pct.toFixed(1)}%`;

    s.btnStart.disabled = !canStart;
    setTextIfChanged(s.btnStart, status === 'paused' ? '继续' : '开始');
    s.btnPause.disabled = !canPause;
    s.btnStep.disabled = !canStep;
    s.btnCycle.disabled = !canStep;
    s.btnStop.disabled = !canStop;
    s.btnReset.disabled = status === 'idle';
    setTextIfChanged(s.btnTheme, this.theme === 'obsidian' ? '☀ Paper' : '🌙 Obsidian');

    const snapTicks = snap.availableSnapshotTicks;
    const snapSig = snapTicks.join(',');
    s.snapshotSelect.disabled = snapTicks.length === 0;
    if (snapSig !== this.lastSnapshotOptionsSig) {
      this.lastSnapshotOptionsSig = snapSig;
      s.snapshotSelect.replaceChildren(
        h('option', {
          value: '',
          text: snapTicks.length === 0 ? '⏱ 无快照' : `⏱ 快照 (${snapTicks.length})`,
        }),
      );
      for (const t of snapTicks) {
        s.snapshotSelect.append(h('option', { value: String(t), text: `跳转 Tick ${t}` }));
      }
    }

    for (const [spd, btn] of s.speedButtons) {
      btn.setAttribute('aria-pressed', String(this.speed === spd));
    }

    const policyLabel = snap.runId === null ? this.draftPolicy : snap.policy;
    setTextIfChanged(s.hudPolicy, `policy ${policyLabel}`);
    setTextIfChanged(s.hudRun, `run ${snap.runId ?? '—'}`);
    setTextIfChanged(
      s.hudHashes,
      `config ${shortHash(snap.configHash)} · params ${shortHash(snap.paramsHash)}`,
    );
    s.hudHashes.title = snap.configHash ?? '';
    setTextIfChanged(
      s.hudStateLine,
      active ? `alive ${snap.aliveCount} · deaths ${snap.cumulativeDeaths}` : '本地权威 · 未上传',
    );

    const inSandbox = this.surface === 'sandbox';
    s.modeSandboxBtn.setAttribute('aria-pressed', String(inSandbox));
    s.modeSandboxBtn.className = `mode-pill ${inSandbox ? 'is-active' : ''}`.trim();
    s.modeBenchBtn.setAttribute('aria-pressed', String(!inSandbox));
    s.modeBenchBtn.className = `mode-pill ${!inSandbox ? 'is-active' : ''}`.trim();

    for (const [id, btn] of s.tabButtons) {
      btn.setAttribute('aria-selected', String(!inSandbox && this.activeTab === id));
    }

    const kpis = buildKpis(snap);
    const gini = kpis.find((kpi) => kpi.id === 'gini')?.value ?? '—';
    setTextIfChanged(s.footerStatus, `状态 ${snap.status}`);
    setTextIfChanged(s.footerGini, `G ${gini}`);
    setTextIfChanged(s.footerConfig, `config ${shortHash(snap.configHash)}`);
    s.footerConfig.title = snap.configHash ?? '';
    setTextIfChanged(s.footerPop, `initPop ${shortHash(snap.initialPopulationHash)}`);
    s.footerPop.title = snap.initialPopulationHash ?? '';
    setTextIfChanged(
      s.footerDecisions,
      snap.decisionsTruncated ? '决策日志已截断' : '决策日志完整',
    );
  }

  render(forceTabRebuild = true): void {
    if (this.root === null || this.shell === null) return;
    this.updateShellChrome();
    this.updateNoticeHost();

    if (this.surface === 'sandbox') {
      this.shell.sandboxHost.hidden = false;
      this.shell.inspectorHost.hidden = true;
      this.shell.dynamicTabHost.hidden = true;
      this.sandboxView?.update(this.snapshot);
      return;
    }

    this.shell.sandboxHost.hidden = true;

    if (this.activeTab === 'inspector') {
      this.shell.inspectorHost.hidden = false;
      this.shell.dynamicTabHost.hidden = true;
      this.inspectorView?.update();
      return;
    }

    this.shell.inspectorHost.hidden = true;
    this.shell.dynamicTabHost.hidden = false;

    if (this.activeTab === 'setup' && this.renderedDynamicTab === 'setup' && !forceTabRebuild) {
      return;
    }

    this.renderedDynamicTab = this.activeTab;
    this.shell.dynamicTabHost.replaceChildren();
    switch (this.activeTab) {
      case 'setup':
        renderSetup(this.shell.dynamicTabHost, this);
        break;
      case 'overview':
        renderOverview(this.shell.dynamicTabHost, this);
        break;
      case 'replay':
        renderReplay(this.shell.dynamicTabHost, this);
        break;
      case 'manager':
        renderManager(this.shell.dynamicTabHost, this);
        break;
    }
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
  if (value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatValue(value: number): string {
  return formatNumber(value);
}
