import type { AgentId } from '../../core/control/ids.js';
import { SANDBOX_SCENARIOS, type SandboxScenario } from '../../app/presets.js';
import type { AvatarDecisionPrompt, ControllerSnapshot } from '../../app/types.js';
import { agentDetail, eventViews, formatNumber, formatPercent } from '../../app/view-model.js';
import { LivingArenaCanvas } from '../arena/living-canvas.js';
import { icon } from '../components/icon.js';
import { badge, card, classSymbol, classTitle, h } from '../dom.js';
import type { StratifyApp } from '../app.js';

/**
 * ✦ 交互沙盒剧场工作区（Playable Sociology Arena）：
 * 持久挂载实例，状态推进时仅做增量 DOM/Canvas 同步，零闪烁、零失焦。
 */
export class SandboxView {
  readonly root: HTMLElement;
  private readonly arena: LivingArenaCanvas;
  private readonly scenarioBar: HTMLElement;
  private readonly goalBanner: HTMLElement;
  private readonly stageSubtitle: HTMLElement;
  private readonly layoutWealthBtn: HTMLButtonElement;
  private readonly layoutNetworkBtn: HTMLButtonElement;
  private readonly toggleEdgesBtn: HTMLButtonElement;
  private readonly toggleDrawerBtn: HTMLButtonElement;
  private readonly drawerHost: HTMLElement;
  private readonly decisionOverlay: HTMLElement;
  private readonly avatarBody: HTMLElement;
  private readonly chronicleBody: HTMLElement;
  private drawerOpen = true;
  private activeScenarioId = SANDBOX_SCENARIOS[0]?.id ?? 'ascend-odyssey';
  private lastPromptKey = '';

  constructor(private readonly app: StratifyApp) {
    this.arena = new LivingArenaCanvas({
      onSelectAgent: (id) => {
        this.app.selectAgent(id);
      },
      onPossessAgent: (id) => {
        this.app.possessAgent(id, true);
      },
    });

    this.scenarioBar = h('div', { class: 'scenario-deck', role: 'group', ariaLabel: '探索剧本' });
    this.goalBanner = h('div', { class: 'field-dossier-bar' });
    this.stageSubtitle = h('p', { class: 'card-subtitle' });

    this.layoutWealthBtn = h('button', {
      class: 'btn btn-sm btn-primary',
      type: 'button',
      text: '财富晋升阶梯',
      onClick: () => {
        this.arena.setLayoutMode('wealth');
        this.syncStageButtons();
      },
    }) as HTMLButtonElement;

    this.layoutNetworkBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      text: '社会关系星群',
      onClick: () => {
        this.arena.setLayoutMode('network');
        this.syncStageButtons();
      },
    }) as HTMLButtonElement;

    this.toggleEdgesBtn = h('button', {
      class: 'btn btn-sm btn-ghost',
      type: 'button',
      text: '连边: 全部',
      onClick: () => {
        this.arena.setShowAllEdges(!this.arena.getShowAllEdges());
        this.syncStageButtons();
      },
    }) as HTMLButtonElement;

    this.decisionOverlay = h('div', {
      class: 'destiny-deck-wrap',
      hidden: true,
      role: 'region',
      ariaLabel: '化身命运抉择面板',
    });

    this.avatarBody = h('div', { class: 'avatar-console-body' });
    this.chronicleBody = h('div', { class: 'chronicle-body' });
    this.drawerHost = h('aside', { class: 'context-drawer', ariaLabel: '生态场情境抽屉' }, [
      card('探索卷宗', [this.scenarioBar], {
        subtitle: '点击即刻重置并开局（完整 11 预设与 7 维参数在实验台）',
      }),
      card('玩家化身与焦点档案', [this.avatarBody], {
        subtitle: '只从核心合法行动集中做 Choice；不篡改任何结算公式',
      }),
      card('社会演化编年史', [this.chronicleBody], {
        subtitle: '近期关键阶层跨越、竞争博弈与重连播报',
      }),
    ]);

    this.toggleDrawerBtn = h(
      'button',
      {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        title: '展开或收起右侧情境抽屉',
        ariaExpanded: 'true',
        onClick: () => {
          this.drawerOpen = !this.drawerOpen;
          this.drawerHost.hidden = !this.drawerOpen;
          this.root.classList.toggle('is-drawer-collapsed', !this.drawerOpen);
          this.toggleDrawerBtn.setAttribute('aria-expanded', String(this.drawerOpen));
        },
      },
      [icon('sidebar', 13), h('span', { text: '抽屉' })],
    ) as HTMLButtonElement;

    const btnCycle = h(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        title: '按确定性顺序切换至下一位存活个体作为化身',
        onClick: () => this.app.cycleAvatar(),
      },
      [icon('refresh', 13), h('span', { text: '换人附身' })],
    );

    const btnFork = h(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        title: '克隆当前权威状态并对焦点个体施加 ΔValue=+0.0001 微扰，生成平行宇宙对照',
        onClick: () => this.app.forkFocusedAgent(0.0001),
      },
      [icon('fork', 13), h('span', { text: '微扰分叉' })],
    );

    const stagePanel = h('section', { class: 'field-stage-panel' }, [
      h('header', { class: 'field-toolbar' }, [
        h('div', { class: 'card-title-group' }, [
          h('h3', {
            class: 'card-title',
            text: '社会分层生态场',
          }),
          this.stageSubtitle,
        ]),
        h('div', { class: 'card-actions' }, [
          this.layoutWealthBtn,
          this.layoutNetworkBtn,
          this.toggleEdgesBtn,
          btnCycle,
          btnFork,
          this.toggleDrawerBtn,
        ]),
      ]),
      this.goalBanner,
      this.arena.root,
      this.decisionOverlay,
    ]);

    this.root = h('div', { class: 'field-layout' }, [stagePanel, this.drawerHost]);

    this.renderScenarioCards();
    this.syncStageButtons();
  }

  private syncStageButtons(): void {
    const mode = this.arena.getLayoutMode();
    this.layoutWealthBtn.className = `btn btn-sm ${mode === 'wealth' ? 'btn-primary' : ''}`.trim();
    this.layoutNetworkBtn.className =
      `btn btn-sm ${mode === 'network' ? 'btn-primary' : ''}`.trim();
    this.toggleEdgesBtn.textContent = this.arena.getShowAllEdges() ? '连边: 全部' : '连边: 仅焦点';
  }

  private renderScenarioCards(): void {
    this.scenarioBar.replaceChildren(
      ...SANDBOX_SCENARIOS.map((scenario) => {
        const active = scenario.id === this.activeScenarioId;
        return h(
          'button',
          {
            class: `scenario-card ${active ? 'is-active' : ''}`.trim(),
            type: 'button',
            ariaPressed: String(active),
            onClick: () => this.launchScenario(scenario),
          },
          [
            h('div', { class: 'scenario-card-top' }, [
              badge(scenario.badge, active ? 'info' : 'muted'),
              badge('未校准探索', 'warn'),
            ]),
            h('strong', { class: 'scenario-title', text: scenario.title }),
            h('span', { class: 'scenario-sub', text: scenario.subtitle }),
          ],
        );
      }),
    );
  }

  launchScenario(scenario: SandboxScenario): void {
    this.activeScenarioId = scenario.id;
    this.renderScenarioCards();
    this.app.launchSandboxScenario(scenario);
  }

  update(snapshot: ControllerSnapshot): void {
    const state = this.app.controller.getState();
    const scenario =
      SANDBOX_SCENARIOS.find((item) => item.id === this.activeScenarioId) ?? SANDBOX_SCENARIOS[0];

    // 1. 顶部挑战进度横幅
    const avatarAgent =
      snapshot.avatarId !== null && state !== null
        ? state.society.agents.find((a) => a.id === snapshot.avatarId)
        : undefined;
    const progressBadges = [
      badge(`开放度 O=${formatNumber(snapshot.latestStats?.openness, 3)}`, 'info'),
      badge(`基尼 G=${formatNumber(snapshot.latestStats?.gini, 3)}`, 'muted'),
      badge(`隔离度 S=${formatNumber(snapshot.latestStats?.segregation, 3)}`, 'muted'),
    ];
    if (avatarAgent !== undefined) {
      progressBadges.unshift(
        badge(
          `★ 化身 ${avatarAgent.id} · 当前 ${classTitle(avatarAgent.classIndex)} (最高 C${avatarAgent.maxClassIndex})`,
          avatarAgent.alive ? 'ok' : 'danger',
        ),
      );
    }
    const goalMessage =
      snapshot.status === 'completed'
        ? `探索已收口（Tick ${snapshot.tick}/${snapshot.totalTicks}）：可点击「微扰分叉」对照平行宇宙，或切换上方剧本开启新局。`
        : (scenario?.challengeGoal ?? '点击任意个体观察其社会关系，双击即可化身接管其决策。');
    this.goalBanner.replaceChildren(
      h('div', { class: 'goal-text' }, [
        h('strong', { text: '沙盒探索导引：' }),
        h('span', { text: goalMessage }),
      ]),
      h('div', { class: 'actions-row' }, progressBadges),
    );

    this.stageSubtitle.textContent =
      state === null
        ? '点击上方任意剧本卡立即开局，或点击顶栏「开始」运行当前配置'
        : `Tick ${snapshot.tick}/${snapshot.totalTicks} · 存活 ${snapshot.aliveCount} 人 · 单击节点检视，双击节点设为化身`;

    // 2. 更新高帧率生态画布
    this.arena.update(state, snapshot.events, {
      selectedAgentId: this.app.selectedAgentId,
      avatarId: snapshot.avatarId,
      theme: this.app.theme,
    });

    // 3. 玩家命运抉择卡牌浮层（仅当挂起或变化时重绘，防止按钮被吞点击）
    const prompt = snapshot.pendingAvatarPrompt;
    const promptKey = prompt === null ? '' : `${prompt.tick}:${prompt.agentId}`;
    if (promptKey !== this.lastPromptKey) {
      this.lastPromptKey = promptKey;
      if (prompt === null) {
        this.decisionOverlay.hidden = true;
        this.decisionOverlay.replaceChildren();
      } else {
        this.renderDecisionDeck(prompt);
        this.decisionOverlay.hidden = false;
      }
    }

    // 4. 更新右侧化身与焦点面板
    this.renderAvatarPanel(snapshot);

    // 5. 更新编年史事件播报
    this.renderChronicle(snapshot);
  }

  private renderDecisionDeck(prompt: AvatarDecisionPrompt): void {
    const cards: HTMLElement[] = [];

    // 日常积累卡
    const accProb = prompt.advisorProbabilities['accumulate'] ?? 0;
    cards.push(
      h(
        'button',
        {
          class: 'choice-card choice-accumulate',
          type: 'button',
          onClick: () => this.app.controller.submitAvatarAction('accumulate'),
        },
        [
          h('div', { class: 'choice-head' }, [
            h('span', { class: 'cmd-kbd', text: '1' }),
            badge(`参谋权重 ${formatPercent(accProb, 0)}`, 'muted'),
          ]),
          h('strong', { class: 'choice-title', text: '日常积累 (accumulate)' }),
          h('span', {
            class: 'choice-desc',
            text: '不支付阶层或竞争成本，稳健获取本阶级与邻里网络加成产出。',
          }),
        ],
      ),
    );

    // 向上跨越卡
    const canAscend = prompt.legal.actions.includes('ascend');
    const ascProb = prompt.advisorProbabilities['ascend'] ?? 0;
    if (canAscend) {
      cards.push(
        h(
          'button',
          {
            class: 'choice-card choice-ascend',
            type: 'button',
            onClick: () => this.app.controller.submitAvatarAction('ascend'),
          },
          [
            h('div', { class: 'choice-head' }, [
              h('span', { class: 'choice-icon', text: '▲' }),
              badge(`参谋权重 ${formatPercent(ascProb, 0)}`, 'info'),
            ]),
            h('strong', {
              class: 'choice-title',
              text: `向上跨越 → C${prompt.classIndex + 1} (ascend)`,
            }),
            h('span', {
              class: 'choice-desc',
              text: `应付跨越净额 ${formatNumber(prompt.legal.ascendCost, 2)} Value；若开启位移准入将与上层在位者守擂对决。`,
            }),
          ],
        ),
      );
    } else if (prompt.legal.ascendCost !== null) {
      cards.push(
        h(
          'div',
          {
            class: 'choice-card choice-disabled',
            title: '当前财富尚未满足跨越费用 + 持有裕度 + 占用壁垒门槛',
          },
          [
            h('div', { class: 'choice-head' }, [icon('lock', 13), badge('门槛未达', 'muted')]),
            h('strong', { class: 'choice-title', text: `向上跨越 → C${prompt.classIndex + 1}` }),
            h('span', {
              class: 'choice-desc',
              text: `基础跨越费 ${formatNumber(prompt.legal.ascendCost, 2)}（另需满足目标层持有裕度与壁垒余额）。`,
            }),
          ],
        ),
      );
    }

    // 主动降阶卡
    if (prompt.legal.actions.includes('descend')) {
      const descProb = prompt.advisorProbabilities['descend'] ?? 0;
      cards.push(
        h(
          'button',
          {
            class: 'choice-card choice-descend',
            type: 'button',
            onClick: () => this.app.controller.submitAvatarAction('descend'),
          },
          [
            h('div', { class: 'choice-head' }, [
              h('span', { class: 'choice-icon', text: '▼' }),
              badge(`参谋权重 ${formatPercent(descProb, 0)}`, 'warn'),
            ]),
            h('strong', {
              class: 'choice-title',
              text: `主动降阶 → C${prompt.classIndex - 1} (descend)`,
            }),
            h('span', {
              class: 'choice-desc',
              text: `支付 ${formatNumber(prompt.legal.descendCost, 2)} Value 退回低持有成本阶层并重置任期。`,
            }),
          ],
        ),
      );
    }

    // 竞争挑战候选卡（最多展示前 4 名高区分度合法候选，其余通过紧凑按钮列出）
    for (const target of prompt.targets) {
      const key = `compete:${target.id}`;
      const prob = prompt.advisorProbabilities[key] ?? 0;
      const diffLabel =
        target.classIndex > prompt.classIndex
          ? '跨层向上挑战'
          : target.classIndex < prompt.classIndex
            ? '跨层向下博弈'
            : '同层博弈';
      cards.push(
        h(
          'button',
          {
            class: 'choice-card choice-compete',
            type: 'button',
            onClick: () => this.app.controller.submitAvatarAction(key),
          },
          [
            h('div', { class: 'choice-head' }, [
              h('span', { class: 'choice-icon', text: '▲▼' }),
              badge(target.isNeighbor ? `邻居 · ${diffLabel}` : diffLabel, 'violet'),
            ]),
            h('strong', {
              class: 'choice-title',
              text: `竞争 ${target.id} (C${target.classIndex})`,
            }),
            h('span', {
              class: 'choice-desc',
              text: `对手财富 ${formatNumber(target.value, 2)} vs 你 ${formatNumber(prompt.value, 2)} · 先验 ${formatPercent(prob, 0)}`,
            }),
          ],
        ),
      );
    }

    this.decisionOverlay.replaceChildren(
      h('div', { class: 'destiny-header' }, [
        h('div', {}, [
          h('strong', {
            class: 'destiny-title',
            text: `命运抉择 · Tick ${prompt.tick} · 化身 ${prompt.agentId} (${classTitle(prompt.classIndex)})`,
          }),
          h('p', {
            class: 'destiny-sub',
            text: `当前财富 ${formatNumber(prompt.value, 2)} · 需求线 ${formatNumber(prompt.need, 2)} (${formatPercent(prompt.needRatio, 0)}) · 连续低于阈值 ${prompt.belowNeedStreak} 天`,
          }),
        ]),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          text: '切回 AI 托管本局',
          onClick: () => this.app.controller.setAvatar(prompt.agentId, false),
        }),
      ]),
      h('div', { class: 'choice-grid' }, cards),
    );
  }

  private renderAvatarPanel(snapshot: ControllerSnapshot): void {
    const state = this.app.controller.getState();
    if (state === null) {
      this.avatarBody.replaceChildren(
        h('p', {
          class: 'muted',
          text: '尚未启动世界。点击上方任意探索剧本卡，即可一键开启可交互沙盒！',
        }),
        h('div', { class: 'actions-row', style: 'margin-top:10px' }, [
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '▶ 立即开启寒门跃迁剧本',
            onClick: () => {
              const first = SANDBOX_SCENARIOS[0];
              if (first !== undefined) this.launchScenario(first);
            },
          }),
        ]),
      );
      return;
    }

    const focusId =
      this.app.selectedAgentId ??
      snapshot.avatarId ??
      state.society.agents.find((a) => a.alive)?.id ??
      state.society.agents[0]?.id ??
      null;
    const detail = focusId === null ? null : agentDetail(state, focusId);
    if (detail === null) {
      this.avatarBody.replaceChildren(h('p', { class: 'muted', text: '暂无可检视个体。' }));
      return;
    }

    const isAvatar = snapshot.avatarId === detail.id;
    const limit = state.config.need.belowNeedLimit;
    const dangerPct = Math.min(
      100,
      Math.round((detail.belowNeedStreak / Math.max(1, limit)) * 100),
    );

    this.avatarBody.replaceChildren(
      h('div', { class: 'avatar-header-row' }, [
        h('div', {}, [
          h('strong', {
            class: 'mono',
            style: 'font-size:15px',
            text: `${classSymbol(detail.classIndex)} ${detail.id} · ${classTitle(detail.classIndex)}`,
          }),
          h('div', { class: 'actions-row', style: 'margin-top:4px' }, [
            badge(detail.alive ? '存活' : '已故', detail.alive ? 'ok' : 'danger'),
            isAvatar
              ? badge(snapshot.avatarInteractive ? '★ 玩家手动操控' : '★ 玩家关注 (AI托管)', 'info')
              : badge(`历史最高 C${detail.maxClassIndex}`, 'muted'),
          ]),
        ]),
        h('div', { class: 'actions-row' }, [
          isAvatar
            ? h('button', {
                class: `btn btn-sm ${snapshot.avatarInteractive ? 'btn-primary' : ''}`.trim(),
                type: 'button',
                text: snapshot.avatarInteractive ? '🎮 手动出牌中' : '🤖 切换手动出牌',
                onClick: () =>
                  this.app.controller.setAvatar(detail.id as AgentId, !snapshot.avatarInteractive),
              })
            : h('button', {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                disabled: !detail.alive,
                text: '★ 化身此人',
                onClick: () => this.app.possessAgent(detail.id as AgentId, true),
              }),
        ]),
      ]),
      h('dl', { class: 'detail-list compact-dl', style: 'margin-top:10px' }, [
        h('dt', { text: '当前财富 / 需求线' }),
        h('dd', { text: `${formatNumber(detail.value, 2)} / ${formatNumber(detail.need, 2)}` }),
        h('dt', { text: '需求覆盖比' }),
        h('dd', { text: detail.needRatio === null ? '—' : formatPercent(detail.needRatio, 1) }),
        h('dt', { text: '天赋 ge / 努力 hard' }),
        h('dd', {
          text: `${formatNumber(detail.ge, 2)} / ${formatNumber(detail.hard, 2)} (F=${formatNumber(detail.effortValue, 2)})`,
        }),
        h('dt', { text: '剩余寿命 / 推算年龄' }),
        h('dd', {
          text: `${Math.round(detail.remainingLife)}d · 约 ${detail.derivedAgeYears.toFixed(1)} 岁`,
        }),
        h('dt', { text: '社交邻居 / 邻里中位' }),
        h('dd', {
          text: `${detail.ties} 人 · V_med=${formatNumber(detail.neighborMedianValue, 2)}`,
        }),
      ]),
      h('div', { class: 'streak-meter', style: 'margin-top:10px' }, [
        h('div', { class: 'kpi-label' }, [
          h('span', { text: '被动跌落预警 (belowNeedStreak)' }),
          h('span', { class: 'mono', text: `${detail.belowNeedStreak} / ${limit} 日` }),
        ]),
        h('div', { class: 'prob-track' }, [
          h('div', {
            class: 'prob-fill',
            style: `width:${dangerPct}%;background:${dangerPct > 50 ? 'var(--action-descend)' : 'var(--status-ok)'}`,
          }),
        ]),
      ]),
      h('div', { class: 'actions-row', style: 'margin-top:12px' }, [
        h(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            onClick: () => {
              this.app.selectedAgentId = detail.id;
              this.app.setTab('inspector');
            },
          },
          [icon('search', 13), h('span', { text: '检查器档案' })],
        ),
        h(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            disabled: snapshot.status !== 'ready' && snapshot.status !== 'paused',
            onClick: () => void this.app.controller.stepDecisionCycle(),
          },
          [icon('fast-forward', 13), h('span', { text: '下一决策日' })],
        ),
      ]),
    );
  }

  private renderChronicle(snapshot: ControllerSnapshot): void {
    // 筛选具有强叙事意义的社会结构事件（升降阶、竞争胜负、网络重连、死亡）
    const notable = snapshot.events.filter(
      (ev) =>
        ev.type === 'class_ascended' ||
        ev.type === 'class_descended' ||
        ev.type === 'competition_resolved' ||
        ev.type === 'agent_died' ||
        ev.type === 'network_rewired',
    );
    if (notable.length === 0) {
      const recent = eventViews(snapshot.events, 8);
      if (recent.length === 0) {
        this.chronicleBody.replaceChildren(
          h('p', { class: 'muted', text: '社会尚处宁静期，推进 Tick 后将实时播报阶层变迁。' }),
        );
        return;
      }
    }

    const list = h('ul', { class: 'chronicle-list' });
    const slice = notable.slice(-18).reverse();
    for (const ev of slice) {
      let tagText: string = ev.type;
      let tone: 'info' | 'warn' | 'violet' | 'muted' | 'danger' = 'muted';
      let desc = '';
      let actorId: string | null = null;

      if (ev.type === 'class_ascended') {
        tagText = '▲ 跃升';
        tone = 'info';
        actorId = ev.agentId;
        desc = `${ev.agentId} 支付 ${formatNumber(ev.cost, 1)} 升入 C${ev.to}`;
      } else if (ev.type === 'class_descended') {
        tagText = '▼ 降阶';
        tone = 'warn';
        actorId = ev.agentId;
        desc = `${ev.agentId} 从 C${ev.from} 跌入 C${ev.to} (${ev.reason === 'passive' ? '被动跌落' : '主动止损'})`;
      } else if (ev.type === 'competition_resolved') {
        tagText = '博弈';
        tone = 'violet';
        actorId = ev.initiatorId;
        const winId = ev.winner === 'initiator' ? ev.initiatorId : ev.targetId;
        desc = `${ev.initiatorId} 挑战 ${ev.targetId} → ${winId} 胜 (+${formatNumber(ev.gain, 1)})`;
      } else if (ev.type === 'network_rewired') {
        tagText = '⇄ 重连';
        tone = 'muted';
        actorId = ev.agentId;
        desc = ev.restored
          ? `${ev.agentId} 尝试重连未果，保留原关系`
          : `${ev.agentId} 断开 ${ev.removedNeighbor ?? '—'} → 结识 ${ev.addedNeighbor ?? '—'}`;
      } else if (ev.type === 'agent_died') {
        tagText = '◌ 谢幕';
        tone = 'danger';
        actorId = ev.agentId;
        desc = `${ev.agentId} 寿元耗尽离世`;
      }

      const item = h(
        'li',
        {
          class: 'chronicle-item',
          style: actorId !== null ? 'cursor:pointer' : '',
          onClick: () => {
            if (actorId !== null) this.app.selectAgent(actorId);
          },
        },
        [
          h('span', { class: 'mono muted', text: `t${ev.tick}` }),
          badge(tagText, tone),
          h('span', { class: 'chronicle-desc', text: desc }),
        ],
      );
      list.append(item);
    }
    this.chronicleBody.replaceChildren(list);
  }
}
