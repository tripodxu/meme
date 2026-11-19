import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import type { RunConfig } from '../core/config/types.js';
import type { AgentId } from '../core/control/ids.js';
import type { PromptStyle } from '../decision/types.js';
import { findPreset, SANDBOX_SCENARIOS, type SandboxScenario } from '../app/presets.js';
import { RunController } from '../app/run-controller.js';
import { IdbRunStore, type StoredRunMeta } from '../app/idb-store.js';
import { exceedsLiveSuggestion, type BrowserLiveOptions } from '../app/live-policy.js';
import type { ControllerSnapshot, OfflinePolicyId, WebRunBundle } from '../app/types.js';
import {
  buildKpis,
  formatNumber,
  formatTick,
  OVERVIEW_WINDOWS,
  parsePairedBatchForest,
  type PairedBatchForestSummary,
  type WindowKey,
} from '../app/view-model.js';
import { CommandPalette } from './components/command-palette.js';
import { confirmDialog } from './components/dialog.js';
import { icon, type IconName } from './components/icon.js';
import { ToastStack } from './components/toast.js';
import { CLAIMS } from './copy/claims.js';
import { append, badge, clear, h, setTextIfChanged } from './dom.js';
import {
  persistLastConfigFromDraft,
  persistRecentRunsMeta,
  persistSettingsToStorage,
  restoreLastConfigToDraft,
  restoreSettingsFromStorage,
} from './services/persistence.js';
import { DraftStore } from './state/draft-store.js';
import {
  UiStore,
  type AgentAliveFilter,
  type EventFilter,
  type SurfaceId,
  type TabId,
  type ThemeId,
} from './state/ui-store.js';
import { InspectorView, type AgentSortMode } from './workspaces/inspector.js';
import { renderManager } from './workspaces/manager.js';
import { renderOverview } from './workspaces/overview.js';
import { renderReplay } from './workspaces/replay.js';
import { SandboxView } from './workspaces/sandbox.js';
import { renderSetup } from './workspaces/setup.js';

export type { SurfaceId, TabId } from './state/ui-store.js';

const RAIL_ITEMS: readonly {
  id: 'field' | TabId;
  label: string;
  hint: string;
  icon: IconName;
  domId: string;
}[] = [
  {
    id: 'field',
    domId: 'tab-field',
    label: '生态场',
    hint: '社会分层生态场与化身博弈 (1 / 0)',
    icon: 'layers',
  },
  {
    id: 'overview',
    domId: 'tab-overview',
    label: '宏观分析',
    hint: '结构指纹、窗口曲线与流动流带 (2)',
    icon: 'activity',
  },
  {
    id: 'inspector',
    domId: 'tab-inspector',
    label: '个体',
    hint: '花名册、决策 X 光与复式账本 (3)',
    icon: 'users',
  },
  {
    id: 'setup',
    domId: 'tab-setup',
    label: '实验台',
    hint: '11 套预设、七维参数与成本预检 (4)',
    icon: 'sliders',
  },
  {
    id: 'replay',
    domId: 'tab-replay',
    label: '归档',
    hint: '双宇宙对比、回放、森林图与本地存储 (5)',
    icon: 'archive',
  },
];

const KEYBOARD_TABS: Record<string, TabId> = {
  '2': 'overview',
  '3': 'inspector',
  '4': 'setup',
  '5': 'replay',
};

const STATUS_TEXT: Record<ControllerSnapshot['status'], string> = {
  idle: '未配置',
  validating: '校验中',
  invalid: '校验失败',
  ready: '就绪',
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
  readonly snapDotsHost: HTMLElement;
  readonly snapPopoverBtn: HTMLButtonElement;
  readonly snapPopoverMenu: HTMLElement;
  readonly winButtons: ReadonlyMap<WindowKey, HTMLButtonElement>;
  readonly btnStart: HTMLButtonElement;
  readonly btnPause: HTMLButtonElement;
  readonly btnStep: HTMLButtonElement;
  readonly btnCycle: HTMLButtonElement;
  readonly btnStop: HTMLButtonElement;
  readonly btnReset: HTMLButtonElement;
  readonly btnTheme: HTMLButtonElement;
  readonly speedButtons: ReadonlyMap<number, HTMLButtonElement>;
  readonly hudPolicy: HTMLElement;
  readonly railButtons: ReadonlyMap<string, HTMLButtonElement>;
  readonly noticeHost: HTMLElement;
  readonly sandboxHost: HTMLElement;
  readonly inspectorHost: HTMLElement;
  readonly setupHost: HTMLElement;
  readonly dynamicTabHost: HTMLElement;
  readonly footerGini: HTMLElement;
  readonly footerConfig: HTMLButtonElement;
  readonly footerPop: HTMLButtonElement;
}

export class StratifyApp {
  readonly controller = new RunController();
  readonly store = new IdbRunStore();
  readonly ui = new UiStore();
  readonly draft = new DraftStore();
  readonly toasts = new ToastStack();
  private readonly palette = new CommandPalette();
  recentRuns: readonly StoredRunMeta[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedSignature = '';

  get surface(): SurfaceId {
    return this.ui.surface.get();
  }
  set surface(v: SurfaceId) {
    this.ui.surface.set(v);
  }
  get activeTab(): TabId {
    return this.ui.activeTab.get();
  }
  set activeTab(v: TabId) {
    this.ui.activeTab.set(v);
  }
  get overviewWindow(): WindowKey {
    return this.ui.overviewWindow.get();
  }
  set overviewWindow(v: WindowKey) {
    this.ui.overviewWindow.set(v);
  }
  get overviewTableMode(): boolean {
    return this.ui.overviewTableMode.get();
  }
  set overviewTableMode(v: boolean) {
    this.ui.overviewTableMode.set(v);
  }
  get wealthLogScale(): boolean {
    return this.ui.wealthLogScale.get();
  }
  set wealthLogScale(v: boolean) {
    this.ui.wealthLogScale.set(v);
  }
  get zoomRange(): readonly [number, number] {
    return this.ui.zoomRange.get();
  }
  set zoomRange(v: readonly [number, number]) {
    this.ui.zoomRange.set(v);
  }
  get eventFilter(): EventFilter {
    return this.ui.eventFilter.get();
  }
  set eventFilter(v: EventFilter) {
    this.ui.eventFilter.set(v);
  }
  get selectedAgentId(): string | null {
    return this.ui.selectedAgentId.get();
  }
  set selectedAgentId(v: string | null) {
    this.ui.selectedAgentId.set(v);
  }
  get agentQuery(): string {
    return this.ui.agentQuery.get();
  }
  set agentQuery(v: string) {
    this.ui.agentQuery.set(v);
  }
  get agentFilter(): AgentAliveFilter {
    return this.ui.agentFilter.get();
  }
  set agentFilter(v: AgentAliveFilter) {
    this.ui.agentFilter.set(v);
  }
  get agentClass(): number {
    return this.ui.agentClass.get();
  }
  set agentClass(v: number) {
    this.ui.agentClass.set(v);
  }
  get agentSort(): AgentSortMode {
    return this.ui.agentSort.get();
  }
  set agentSort(v: AgentSortMode) {
    this.ui.agentSort.set(v);
  }
  get theme(): ThemeId {
    return this.ui.theme.get();
  }
  set theme(v: ThemeId) {
    this.ui.theme.set(v);
  }
  get speed(): number {
    return this.ui.speed.get();
  }
  set speed(v: number) {
    this.ui.speed.set(v);
  }
  get notice(): string | null {
    return this.ui.notice.get();
  }
  set notice(v: string | null) {
    this.ui.notice.set(v);
  }
  get importedBundle(): WebRunBundle | null {
    return this.ui.importedBundle.get();
  }
  set importedBundle(v: WebRunBundle | null) {
    this.ui.importedBundle.set(v);
  }
  get batchForestSummary(): PairedBatchForestSummary | null {
    return this.ui.batchForestSummary.get();
  }
  set batchForestSummary(v: PairedBatchForestSummary | null) {
    this.ui.batchForestSummary.set(v);
  }

  get draftConfig(): RunConfig {
    return this.draft.draftConfig.get();
  }
  set draftConfig(v: RunConfig) {
    this.draft.draftConfig.set(v);
  }
  get draftSeed(): string {
    return this.draft.draftSeed.get();
  }
  set draftSeed(v: string) {
    this.draft.draftSeed.set(v);
  }
  get draftPolicy(): OfflinePolicyId {
    return this.draft.draftPolicy.get();
  }
  set draftPolicy(v: OfflinePolicyId) {
    this.draft.draftPolicy.set(v);
  }
  get selectedPresetId(): string {
    return this.draft.selectedPresetId.get();
  }
  set selectedPresetId(v: string) {
    this.draft.selectedPresetId.set(v);
  }
  get liveApiKey(): string {
    return this.draft.liveApiKey;
  }
  set liveApiKey(v: string) {
    this.draft.liveApiKey = v;
  }
  get liveModel(): string {
    return this.draft.liveModel;
  }
  set liveModel(v: string) {
    this.draft.liveModel = v;
  }
  get livePromptStyle(): PromptStyle {
    return this.draft.livePromptStyle;
  }
  set livePromptStyle(v: PromptStyle) {
    this.draft.livePromptStyle = v;
  }
  get liveMaxCalls(): number {
    return this.draft.liveMaxCalls;
  }
  set liveMaxCalls(v: number) {
    this.draft.liveMaxCalls = v;
  }
  get liveMaxInputTokens(): number {
    return this.draft.liveMaxInputTokens;
  }
  set liveMaxInputTokens(v: number) {
    this.draft.liveMaxInputTokens = v;
  }
  get liveMaxMinutes(): number {
    return this.draft.liveMaxMinutes;
  }
  set liveMaxMinutes(v: number) {
    this.draft.liveMaxMinutes = v;
  }
  get liveScaleConfirmed(): boolean {
    return this.draft.liveScaleConfirmed;
  }
  set liveScaleConfirmed(v: boolean) {
    this.draft.liveScaleConfirmed = v;
  }

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
    restoreLastConfigToDraft(this.draft);
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
    const restored = restoreSettingsFromStorage();
    this.theme = restored.theme;
    this.speed = restored.speed;
    this.controller.setSpeed(restored.speed);
    this.buildPersistentShell(root);
    root.append(this.toasts.el);
    this.bindKeyboard();
    // 默认首屏进入生态场；仅在未自定义草稿时预备默认生态场状态，且不启用阻断自动运行的手动托管
    if (this.controller.snapshot().status === 'idle') {
      const prepared = this.controller.prepare(
        this.draftConfig,
        this.draftSeed,
        this.draftPolicy,
        this.liveOptions(),
      );
      if (prepared.ok) {
        const state = this.controller.getState();
        const firstAlive = state?.society.agents.find((a) => a.alive);
        if (firstAlive !== undefined) {
          this.selectedAgentId = firstAlive.id;
          this.controller.setAvatar(firstAlive.id, false);
        }
      }
      this.surface = 'sandbox';
    }
    void this.refreshRuns();
    void this.tryAutoRestoreLastSession();
    this.render(true);
  }

  private persistSettingsToStorage(): void {
    persistSettingsToStorage(this.theme, this.speed);
  }

  private persistLastConfigToStorage(): void {
    persistLastConfigFromDraft(this.draft);
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
    const current = this.controller.snapshot();
    if (current.status !== 'idle' && !(current.status === 'ready' && current.tick === 0)) return;
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

    const btnStart = h(
      'button',
      {
        class: 'btn btn-primary btn-sm',
        type: 'button',
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
      },
      [icon('play', 12), h('span', { text: '开始' })],
    ) as HTMLButtonElement;

    const btnPause = h(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        onClick: () => this.controller.pause(),
      },
      [icon('pause', 12), h('span', { text: '暂停' })],
    ) as HTMLButtonElement;

    const btnStep = h('button', {
      class: 'btn btn-sm hud-step-extra',
      type: 'button',
      text: '+1',
      title: '推进 1 个 tick（快捷键 N）',
      onClick: () => this.step(),
    }) as HTMLButtonElement;

    const btnCycle = h('button', {
      class: 'btn btn-sm hud-step-extra',
      type: 'button',
      text: '决策步',
      title: '推进至下一个决策周期',
      onClick: () => void this.stepDecision(),
    }) as HTMLButtonElement;

    const btnStop = h(
      'button',
      {
        class: 'btn btn-danger btn-sm',
        type: 'button',
        title: '停止运行',
        onClick: () => this.controller.stop(),
      },
      [icon('square', 11)],
    ) as HTMLButtonElement;

    const btnReset = h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        title: '重置世界',
        onClick: () => {
          this.controller.reset();
          if (this.surface === 'testbench') {
            this.activeTab = 'setup';
          }
          this.render(true);
        },
      },
      [icon('rotate-ccw', 12)],
    ) as HTMLButtonElement;

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

    const transport = h('div', { class: 'transport', role: 'toolbar', ariaLabel: '仿真控制' }, [
      btnStart,
      btnPause,
      btnStep,
      btnCycle,
      btnStop,
      btnReset,
      speedGroup,
    ]);

    const hudPolicy = h('span', { class: 'hud-policy-pill' });

    const btnPalette = h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        title: '打开命令面板 (⌘K / Ctrl+K)',
        ariaLabel: '命令面板',
        onClick: () => this.openCommandPalette(),
      },
      [icon('command', 13)],
    );

    const btnTheme = h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        title: '切换暖纸/石墨暗房主题',
        onClick: () => this.setTheme(this.theme === 'obsidian' ? 'paper' : 'obsidian'),
      },
      [icon(this.theme === 'obsidian' ? 'sun' : 'moon', 13)],
    ) as HTMLButtonElement;

    const header = h('header', { class: 'command-hud' }, [
      h('div', { class: 'hud-left' }, [
        h('div', { class: 'brand' }, [
          h('div', { class: 'brand-mark', text: 'S' }),
          h('h1', { text: 'Stratify' }),
        ]),
        statusBeacon,
        extraStatusHost,
      ]),
      h('div', { class: 'hud-center' }, [transport]),
      h('div', { class: 'hud-right' }, [hudPolicy, btnPalette, btnTheme]),
    ]);

    const railButtons = new Map<string, HTMLButtonElement>();
    const navRail = h('nav', { class: 'nav-rail', role: 'tablist', ariaLabel: '主工作区导航' });
    for (const item of RAIL_ITEMS) {
      const btn = h(
        'button',
        {
          class: 'rail-item tab',
          type: 'button',
          role: 'tab',
          id: item.domId,
          title: item.hint,
          ariaSelected: 'false',
          onClick: () => {
            if (item.id === 'field') this.setSurface('sandbox');
            else this.setTab(item.id);
          },
        },
        [icon(item.icon, 16), h('span', { class: 'rail-label', text: item.label })],
      ) as HTMLButtonElement;
      railButtons.set(item.id, btn);
      navRail.append(btn);
    }

    const noticeHost = h('div', { class: 'notice-host' });
    this.sandboxView = new SandboxView(this);
    this.inspectorView = new InspectorView(this);
    const sandboxHost = h('div', { hidden: true }, [this.sandboxView.root]);
    const inspectorHost = h('div', { hidden: true }, [this.inspectorView.root]);
    const setupHost = h('div', { class: 'workspace', hidden: true });
    renderSetup(setupHost, this);
    const dynamicTabHost = h('div', { class: 'workspace', hidden: true });

    const main = h(
      'main',
      {
        class: 'main-viewport',
        id: 'main-viewport',
        tabIndex: -1,
      },
      [noticeHost, sandboxHost, inspectorHost, setupHost, dynamicTabHost],
    );

    const shellBody = h('div', { class: 'shell-body' }, [navRail, main]);

    // 底部精密时间轴 & 审计状态栏
    const winButtons = new Map<WindowKey, HTMLButtonElement>();
    const winBar = h('div', { class: 'timeline-windows', role: 'group', ariaLabel: '观察窗口' });
    for (const spec of OVERVIEW_WINDOWS) {
      const btn = h('button', {
        class: 'win-pill',
        type: 'button',
        text: spec.shortLabel,
        title: spec.label,
        ariaPressed: String(this.overviewWindow === spec.id),
        onClick: () => {
          this.overviewWindow = spec.id;
          this.render(false);
        },
      }) as HTMLButtonElement;
      winButtons.set(spec.id, btn);
      winBar.append(btn);
    }

    const progressFill = h('div', { class: 'timeline-progress-fill', style: 'width:0%' });
    const snapDotsHost = h('div', {});
    const progressTrack = h('div', { class: 'timeline-progress-track', ariaLabel: '实验时间轴' }, [
      progressFill,
      snapDotsHost,
    ]);

    const snapPopoverMenu = h('div', { class: 'popover-panel', hidden: true });
    const snapPopoverBtn = h('button', {
      class: 'hash-chip',
      type: 'button',
      text: '快照 (0)',
      title: '选择并跳转历史周期快照',
      onClick: () => {
        snapPopoverMenu.hidden = !snapPopoverMenu.hidden;
      },
    }) as HTMLButtonElement;
    const snapWrap = h('div', { class: 'popover-wrap' }, [snapPopoverBtn, snapPopoverMenu]);

    const footerGini = h('span', {});
    const footerConfig = h('button', {
      class: 'hash-chip',
      type: 'button',
      text: 'cfg —',
      onClick: () => copyHashToast(this, this.snapshot.configHash, 'configHash'),
    }) as HTMLButtonElement;
    const footerPop = h('button', {
      class: 'hash-chip',
      type: 'button',
      text: 'pop —',
      onClick: () =>
        copyHashToast(this, this.snapshot.initialPopulationHash, 'initialPopulationHash'),
    }) as HTMLButtonElement;

    const claimsBtn = h('button', {
      class: 'claims-pill',
      type: 'button',
      text: '声明范围',
      onClick: () =>
        void confirmDialog({
          title: `${CLAIMS.rulesVersion} · ${CLAIMS.g6Badge}`,
          message: `${CLAIMS.g6BoundaryNote}（Schema: ${CLAIMS.schemaSummary}）`,
          confirmLabel: '已知晓',
          cancelLabel: '关闭',
        }),
    });

    const footer = h('footer', { class: 'timeline-bar' }, [
      h('div', { class: 'timeline-track-group' }, [
        winBar,
        h('div', { class: 'timeline-scrubber' }, [progressTrack]),
        snapWrap,
      ]),
      h('div', { class: 'timeline-meta' }, [footerGini, footerConfig, footerPop, claimsBtn]),
    ]);

    root.append(header, shellBody, footer);

    this.shell = {
      statusBeacon,
      statusLabel,
      extraStatusHost,
      progressFill,
      snapDotsHost,
      snapPopoverBtn,
      snapPopoverMenu,
      winButtons,
      btnStart,
      btnPause,
      btnStep,
      btnCycle,
      btnStop,
      btnReset,
      btnTheme,
      speedButtons,
      hudPolicy,
      railButtons,
      noticeHost,
      sandboxHost,
      inspectorHost,
      setupHost,
      dynamicTabHost,
      footerGini,
      footerConfig,
      footerPop,
    };
  }

  private bindKeyboard(): void {
    if (this.keyboardBound) return;
    this.keyboardBound = true;
    window.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (this.palette.isOpen()) this.palette.close();
        else this.openCommandPalette();
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea' || target.isContentEditable) {
          return;
        }
      }
      if (
        this.surface === 'sandbox' &&
        this.snapshot.pendingAvatarPrompt !== null &&
        ['1', '2', '3', '4'].includes(event.key)
      ) {
        const cards = this.shell?.sandboxHost.querySelectorAll(
          '.choice-card:not(.choice-disabled)',
        );
        const chosen = cards?.[Number(event.key) - 1] as HTMLButtonElement | undefined;
        if (chosen !== undefined) {
          event.preventDefault();
          chosen.click();
          return;
        }
      }
      if (event.key === '0' || event.key === '1') {
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

  openCommandPalette(): void {
    this.palette.open(() => [
      {
        id: 'tab-setup',
        label: '前往 ① 实验设置',
        shortcut: '1',
        icon: 'sliders',
        run: () => this.setTab('setup'),
      },
      {
        id: 'tab-overview',
        label: '前往 ② 实时总览',
        shortcut: '2',
        icon: 'activity',
        run: () => this.setTab('overview'),
      },
      {
        id: 'tab-inspector',
        label: '前往 ③ 个体检查器',
        shortcut: '3',
        icon: 'users',
        run: () => this.setTab('inspector'),
      },
      {
        id: 'tab-replay',
        label: '前往 ④ 回放与对比',
        shortcut: '4',
        icon: 'git-compare',
        run: () => this.setTab('replay'),
      },
      {
        id: 'tab-manager',
        label: '前往 ⑤ 实验管理',
        shortcut: '5',
        icon: 'archive',
        run: () => this.setTab('manager'),
      },
      {
        id: 'surface-sandbox',
        label: '切至交互沙盒剧场',
        shortcut: '0',
        icon: 'sparkles',
        run: () => this.setSurface('sandbox'),
      },
      {
        id: 'run-step',
        label: '单步推进 +1 Tick',
        shortcut: 'N',
        icon: 'step-forward',
        run: () => this.step(),
      },
      {
        id: 'export-bundle',
        label: '导出完整离线 Bundle',
        shortcut: 'E',
        icon: 'download',
        run: () => this.downloadBundle(),
      },
      {
        id: 'toggle-theme',
        label: this.theme === 'obsidian' ? '切换为 Paper 浅色主题' : '切换为 Obsidian 深色主题',
        icon: this.theme === 'obsidian' ? 'sun' : 'moon',
        run: () => this.setTheme(this.theme === 'obsidian' ? 'paper' : 'obsidian'),
      },
    ]);
  }

  async refreshRuns(): Promise<void> {
    this.recentRuns = await this.store.list();
    persistRecentRunsMeta(this.recentRuns);
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
    const ok = await confirmDialog({
      title: '清除全部本地实验',
      message: '该操作只影响浏览器 IndexedDB，不影响服务器数据。确认继续？',
      confirmLabel: '确认清除',
      cancelLabel: '取消',
      danger: true,
    });
    if (!ok) return;
    await this.store.clear();
    this.recentRuns = [];
    this.notify('已清除本地实验记录。');
    this.render(true);
  }

  setSurface(surface: SurfaceId): void {
    this.surface = surface;
    const snap = this.controller.snapshot();
    if (
      surface === 'sandbox' &&
      (snap.status === 'idle' ||
        (snap.status === 'ready' && snap.tick === 0 && !snap.avatarInteractive))
    ) {
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
      ? CLAIMS.calibratedPresetNotice(preset.name, preset.config.rulesVersion)
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
    this.toasts.push(message, 'info');
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

  private isActiveLoopStatus(): boolean {
    const s = this.snapshot.status;
    return (
      s === 'running' || s === 'awaiting_decision' || s === 'settling_tick' || s === 'replaying'
    );
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
        : badge(`分叉 @t${snap.forkProvenance.forkTick}`, 'violet'),
    ]);

    const pct =
      snap.totalTicks > 0 ? Math.min(100, Math.max(0, (snap.tick / snap.totalTicks) * 100)) : 0;
    s.progressFill.style.width = `${pct.toFixed(1)}%`;

    s.btnStart.disabled = !canStart;
    setTextIfChanged(s.btnStart.lastElementChild, status === 'paused' ? '继续' : '开始');
    s.btnPause.disabled = !canPause;
    s.btnStep.disabled = !canStep;
    s.btnCycle.disabled = !canStep;
    s.btnStop.disabled = !canStop;
    s.btnReset.disabled = status === 'idle';
    s.btnTheme.replaceChildren(icon(this.theme === 'obsidian' ? 'sun' : 'moon', 13));

    for (const spec of OVERVIEW_WINDOWS) {
      const btn = s.winButtons.get(spec.id);
      if (btn !== undefined) {
        const outOfRange = snap.totalTicks > 0 && snap.totalTicks <= spec.startTick;
        btn.disabled = outOfRange;
        btn.setAttribute('aria-pressed', String(this.overviewWindow === spec.id));
      }
    }

    const snapTicks = snap.availableSnapshotTicks;
    const snapSig = snapTicks.join(',');
    s.snapPopoverBtn.disabled = snapTicks.length === 0;
    setTextIfChanged(s.snapPopoverBtn, `快照 (${snapTicks.length})`);
    if (snapSig !== this.lastSnapshotOptionsSig) {
      this.lastSnapshotOptionsSig = snapSig;
      s.snapDotsHost.replaceChildren(
        ...snapTicks.map((t) => {
          const leftPct = snap.totalTicks > 0 ? Math.min(100, (t / snap.totalTicks) * 100) : 0;
          return h('button', {
            class: 'timeline-snap-dot',
            type: 'button',
            style: `left:${leftPct.toFixed(1)}%`,
            title: `跳转快照 Tick ${t}`,
            ariaLabel: `跳转快照 Tick ${t}`,
            onClick: () => this.jumpToSnapshot(t),
          });
        }),
      );
      s.snapPopoverMenu.replaceChildren(
        ...snapTicks.map((t) =>
          h('button', {
            class: 'cmd-item',
            type: 'button',
            text: `跳转 Tick ${t}`,
            onClick: () => {
              s.snapPopoverMenu.hidden = true;
              this.jumpToSnapshot(t);
            },
          }),
        ),
      );
    }

    for (const [spd, btn] of s.speedButtons) {
      btn.setAttribute('aria-pressed', String(this.speed === spd));
    }

    const policyLabel = snap.runId === null ? this.draftPolicy : snap.policy;
    setTextIfChanged(s.hudPolicy, policyLabel);

    const inSandbox = this.surface === 'sandbox';
    const selectedRailId = inSandbox
      ? 'field'
      : this.activeTab === 'manager'
        ? 'replay'
        : this.activeTab;
    for (const [id, btn] of s.railButtons) {
      btn.setAttribute('aria-selected', String(id === selectedRailId));
    }

    const kpis = buildKpis(snap);
    const gini = kpis.find((kpi) => kpi.id === 'gini')?.value ?? '—';
    setTextIfChanged(s.footerGini, `G ${gini}`);
    setTextIfChanged(s.footerConfig, `cfg ${shortHash(snap.configHash)}`);
    s.footerConfig.title = snap.configHash ?? '';
    setTextIfChanged(s.footerPop, `pop ${shortHash(snap.initialPopulationHash)}`);
    s.footerPop.title = snap.initialPopulationHash ?? '';
  }

  render(forceTabRebuild = true): void {
    if (this.root === null || this.shell === null) return;
    this.updateShellChrome();
    this.updateNoticeHost();

    const inSandbox = this.surface === 'sandbox';
    const inInspector = !inSandbox && this.activeTab === 'inspector';
    const inSetup = !inSandbox && this.activeTab === 'setup';
    const inDynamic = !inSandbox && !inInspector && !inSetup;

    this.shell.sandboxHost.hidden = !inSandbox;
    this.shell.inspectorHost.hidden = !inInspector;
    this.shell.setupHost.hidden = !inSetup;
    this.shell.dynamicTabHost.hidden = !inDynamic;

    if (forceTabRebuild && (inSetup || !this.isActiveLoopStatus())) {
      this.shell.setupHost.replaceChildren();
      renderSetup(this.shell.setupHost, this);
    }

    if (inSandbox) {
      this.sandboxView?.update(this.snapshot);
      return;
    }
    if (inInspector) {
      this.inspectorView?.update();
      return;
    }
    if (inSetup) {
      return;
    }

    this.renderedDynamicTab = this.activeTab;
    this.shell.dynamicTabHost.replaceChildren();
    switch (this.activeTab) {
      case 'overview':
        renderOverview(this.shell.dynamicTabHost, this);
        break;
      case 'replay':
      case 'manager':
        renderReplay(this.shell.dynamicTabHost, this);
        renderManager(this.shell.dynamicTabHost, this);
        break;
    }
  }
}

function copyHashToast(app: StratifyApp, hash: string | null, label: string): void {
  if (hash === null || hash === '') return;
  void navigator.clipboard?.writeText(hash).catch(() => undefined);
  app.toasts.push(`已复制 ${label}: ${hash.slice(0, 18)}…`, 'ok');
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
