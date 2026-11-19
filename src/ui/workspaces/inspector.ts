import type { AgentId } from '../../core/control/ids.js';
import type { AgentRow } from '../../app/view-model.js';
import {
  agentDetail,
  agentEvents,
  agentLifeTimeline,
  agentLineage,
  agentMechanismAnatomy,
  agentRows,
  agentWealthLedger,
  decisionsForAgent,
  formatNumber,
  formatPercent,
  latestExecution,
} from '../../app/view-model.js';
import { renderEgoNetwork } from '../charts/core.js';
import {
  renderAccumulationAnatomy,
  renderAscentWaterfall,
  renderLifeTrajectoryStrip,
} from '../charts/mechanism-mini.js';
import { badge, card, classSymbol, classTitle, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

export type AgentSortMode = 'id' | 'value_desc' | 'need_asc' | 'ties_desc';

/** 单页最大直接挂载行数：小人口全量展示，千人规模分页切片防 DOM 膨胀卡顿（06 §6）。 */
const PAGE_SIZE = 200;

/**
 * 持久化个体检查器视图（Zero-Focus-Loss Inspector）：
 * 搜索框、状态/阶级/排序下拉框与列表滚动容器常驻 DOM，运行推进时仅局部更新列表项与右侧档案！
 */
export class InspectorView {
  readonly root: HTMLElement;
  private readonly emptyNotice: HTMLElement;
  private readonly mainGrid: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly aliveSelect: HTMLSelectElement;
  private readonly classSelect: HTMLSelectElement;
  private readonly sortSelect: HTMLSelectElement;
  private readonly pageBar: HTMLElement;
  private readonly listContainer: HTMLElement;
  private readonly detailContainer: HTMLElement;
  private pageIndex = 0;
  private lastClassCount = -1;

  constructor(private readonly app: StratifyApp) {
    this.emptyNotice = h('div', { class: 'span-12' }, [
      card('个体显微镜检查器', [
        h('p', {
          class: 'muted',
          text: '尚未初始化世界。可先在「实验台」或「生态场」启动一次运行。',
        }),
        h('div', { class: 'actions-row', style: 'margin-top:10px' }, [
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '用当前草稿配置立即启动',
            onClick: () => this.app.start(),
          }),
        ]),
      ]),
    ]);

    this.searchInput = h('input', {
      id: 'agent-search',
      type: 'text',
      placeholder: '搜索 a-0001…',
      value: this.app.agentQuery,
      onInput: (event) => {
        this.app.agentQuery = (event.target as HTMLInputElement).value;
        this.pageIndex = 0;
        this.refreshRosterOnly();
      },
    }) as HTMLInputElement;

    this.aliveSelect = h('select', {
      id: 'agent-filter',
      onChange: (event) => {
        this.app.agentFilter = (event.target as HTMLSelectElement)
          .value as StratifyApp['agentFilter'];
        this.pageIndex = 0;
        this.refreshRosterOnly();
      },
    }) as HTMLSelectElement;
    for (const [value, label] of [
      ['all', '全部状态'],
      ['alive', '● 仅存活'],
      ['dead', '○ 仅已故'],
    ] as const) {
      this.aliveSelect.append(
        h('option', { value, text: label, selected: this.app.agentFilter === value }),
      );
    }

    this.classSelect = h('select', {
      id: 'agent-class',
      onChange: (event) => {
        this.app.agentClass = Number((event.target as HTMLSelectElement).value);
        this.pageIndex = 0;
        this.refreshRosterOnly();
      },
    }) as HTMLSelectElement;

    this.sortSelect = h('select', {
      id: 'agent-sort',
      onChange: (event) => {
        this.app.agentSort = (event.target as HTMLSelectElement).value as AgentSortMode;
        this.pageIndex = 0;
        this.refreshRosterOnly();
      },
    }) as HTMLSelectElement;
    for (const [value, label] of [
      ['id', '按编号升序'],
      ['value_desc', '按财富 Value ↓'],
      ['need_asc', '按需求比 ↑ (濒危优先)'],
      ['ties_desc', '按社交连边 ↓'],
    ] as const) {
      this.sortSelect.append(
        h('option', { value, text: label, selected: this.app.agentSort === value }),
      );
    }

    this.pageBar = h('div', { class: 'roster-page-bar actions-row', hidden: true });
    this.listContainer = h('ul', {
      class: 'agent-list',
      role: 'listbox',
      ariaLabel: '个体名册',
    });
    this.detailContainer = h('div', { class: 'detail-grid' });

    this.mainGrid = h('div', { class: 'span-12 workspace' }, [
      h('div', { class: 'span-3' }, [
        card('个体花名册', [
          h('div', { class: 'field' }, [
            h('label', { class: 'field-label', for: 'agent-search', text: '编号检索' }),
            this.searchInput,
          ]),
          h('div', { class: 'form-grid', style: 'grid-template-columns:1fr 1fr;margin-top:8px' }, [
            h('div', { class: 'field' }, [
              h('label', { class: 'field-label', for: 'agent-filter', text: '生存状态' }),
              this.aliveSelect,
            ]),
            h('div', { class: 'field' }, [
              h('label', { class: 'field-label', for: 'agent-class', text: '所属阶级' }),
              this.classSelect,
            ]),
          ]),
          h('div', { class: 'field', style: 'margin-top:8px' }, [
            h('label', { class: 'field-label', for: 'agent-sort', text: '排序维度' }),
            this.sortSelect,
          ]),
          this.pageBar,
          h('div', { class: 'roster-scroll-box', style: 'margin-top:8px' }, [this.listContainer]),
        ]),
      ]),
      h('div', { class: 'span-9' }, [this.detailContainer]),
    ]);

    this.root = h('div', { class: 'workspace' }, [this.emptyNotice, this.mainGrid]);
  }

  private ensureClassOptions(classCount: number): void {
    if (this.lastClassCount === classCount) return;
    this.lastClassCount = classCount;
    this.classSelect.replaceChildren(
      h('option', { value: '-1', text: '全部阶级', selected: this.app.agentClass === -1 }),
    );
    for (let index = 0; index < classCount; index += 1) {
      this.classSelect.append(
        h('option', {
          value: String(index),
          text: `Class ${index}`,
          selected: this.app.agentClass === index,
        }),
      );
    }
  }

  private computeFilteredRows(rows: readonly AgentRow[]): AgentRow[] {
    const query = this.app.agentQuery.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (query !== '' && !row.id.toLowerCase().includes(query)) return false;
      if (this.app.agentFilter === 'alive' && !row.alive) return false;
      if (this.app.agentFilter === 'dead' && row.alive) return false;
      if (this.app.agentClass >= 0 && row.classIndex !== this.app.agentClass) return false;
      return true;
    });
    const sortMode = this.app.agentSort;
    if (sortMode === 'value_desc') {
      filtered.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    } else if (sortMode === 'need_asc') {
      filtered.sort(
        (a, b) => (a.needRatio ?? 999) - (b.needRatio ?? 999) || a.id.localeCompare(b.id),
      );
    } else if (sortMode === 'ties_desc') {
      filtered.sort((a, b) => b.ties - a.ties || a.id.localeCompare(b.id));
    }
    return filtered;
  }

  private refreshRosterOnly(): void {
    const state = this.app.controller.getState();
    const rows = agentRows(state);
    this.renderList(rows);
  }

  private renderList(rows: readonly AgentRow[]): void {
    const filtered = this.computeFilteredRows(rows);
    this.listContainer.replaceChildren();
    if (filtered.length === 0) {
      this.pageBar.hidden = true;
      this.listContainer.append(
        h('li', { class: 'muted', style: 'padding:8px', text: '无匹配个体。' }),
      );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (this.pageIndex >= totalPages) this.pageIndex = totalPages - 1;
    const start = this.pageIndex * PAGE_SIZE;
    const pageSlice = filtered.slice(start, start + PAGE_SIZE);

    if (totalPages > 1) {
      this.pageBar.hidden = false;
      this.pageBar.replaceChildren(
        h('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          disabled: this.pageIndex === 0,
          text: '‹ 上页',
          onClick: () => {
            this.pageIndex = Math.max(0, this.pageIndex - 1);
            this.refreshRosterOnly();
          },
        }),
        h('span', {
          class: 'mono muted',
          style: 'font-size:11px',
          text: `${start + 1}–${start + pageSlice.length} / ${filtered.length}`,
        }),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          disabled: this.pageIndex >= totalPages - 1,
          text: '下页 ›',
          onClick: () => {
            this.pageIndex = Math.min(totalPages - 1, this.pageIndex + 1);
            this.refreshRosterOnly();
          },
        }),
      );
    } else {
      this.pageBar.hidden = true;
    }

    const avatarId = this.app.getSnapshot().avatarId;
    for (const row of pageSlice) {
      const isAvatar = avatarId === row.id;
      this.listContainer.append(
        h('li', {}, [
          h(
            'button',
            {
              type: 'button',
              ariaCurrent: String(this.app.selectedAgentId === row.id),
              onClick: () => {
                this.app.selectedAgentId = row.id;
                this.refreshRosterOnly();
                this.renderDetail();
              },
            },
            [
              h('div', { class: 'roster-item-top' }, [
                h('span', {
                  text: `${row.alive ? '●' : '○'} ${classSymbol(row.classIndex)} C${row.classIndex} ${row.id}`,
                }),
                isAvatar ? badge('★ 化身', 'info') : null,
              ]),
              h('span', {
                class: 'roster-item-sub',
                text: `V ${formatNumber(row.value, 1)} · ${row.needRatio === null ? '—' : formatPercent(row.needRatio, 0)} · ${Math.round(row.remainingLife)}d · ${row.ties}边`,
              }),
            ],
          ),
        ]),
      );
    }
  }

  private renderDetail(): void {
    this.detailContainer.replaceChildren();
    const state = this.app.controller.getState();
    const agentId = this.app.selectedAgentId;
    if (state === null || agentId === null) return;
    const detail = agentDetail(state, agentId);
    if (detail === null) {
      this.detailContainer.append(h('p', { class: 'muted', text: '个体不存在。' }));
      return;
    }
    const snapshot = this.app.getSnapshot();
    const decisions = decisionsForAgent(snapshot, agentId, 6);
    const execution = latestExecution(snapshot, agentId);
    const ledger = agentWealthLedger(snapshot.events, agentId, 20);
    const events = agentEvents(snapshot.events, agentId, 20);
    const anatomy = agentMechanismAnatomy(state, agentId);
    const lifePts = agentLifeTimeline(snapshot.events, agentId, detail.classIndex);
    const lineage = agentLineage(snapshot.events, state, agentId);
    const isAvatar = snapshot.avatarId === detail.id;

    const lineageStrip =
      lineage.parent === null && lineage.children.length === 0
        ? null
        : h('div', { class: 'anatomy-block' }, [
            h('div', { class: 'anatomy-head' }, [
              h('span', { class: 'muted', text: '代际血脉谱系 (rules-v16/v18)' }),
            ]),
            h('div', { class: 'actions-row' }, [
              lineage.parent === null
                ? null
                : h('button', {
                    class: 'btn btn-sm btn-ghost',
                    type: 'button',
                    text: `父代 ${lineage.parent.id} (C${lineage.parent.classIndex}, ge=${formatNumber(lineage.parent.ge, 2)})`,
                    onClick: () => {
                      this.app.selectedAgentId = lineage.parent!.id;
                      this.refreshRosterOnly();
                      this.renderDetail();
                    },
                  }),
              ...lineage.children.map((ch) =>
                h('button', {
                  class: 'btn btn-sm btn-ghost',
                  type: 'button',
                  text: `子代 ${ch.id} (t${ch.tick}, C${ch.classIndex})`,
                  onClick: () => {
                    this.app.selectedAgentId = ch.id;
                    this.refreshRosterOnly();
                    this.renderDetail();
                  },
                }),
              ),
            ]),
          ]);

    this.detailContainer.append(
      // 象限 A：核心生存与阶级状态
      card(
        `${classSymbol(detail.classIndex)} ${detail.id} · 生存与阶级任期`,
        [
          h('dl', { class: 'detail-list' }, [
            h('dt', { text: '状态 / 推算年龄' }),
            h('dd', {}, [
              badge(detail.alive ? '存活' : '已故', detail.alive ? 'ok' : 'muted'),
              h('span', { text: ` · 约 ${detail.derivedAgeYears.toFixed(1)} 岁` }),
            ]),
            h('dt', { text: '当前阶级 / 历史最高' }),
            h('dd', {
              text: `${classTitle(detail.classIndex)} / C${detail.maxClassIndex} (重返距离 d=${detail.returnDistance})`,
            }),
            h('dt', { text: 'Value / 当前需求线 need' }),
            h('dd', { text: `${formatNumber(detail.value)} / ${formatNumber(detail.need)}` }),
            h('dt', { text: 'needRatio / 低于阈值连日' }),
            h('dd', {
              text: `${detail.needRatio === null ? '—' : formatPercent(detail.needRatio)} · streak ${detail.belowNeedStreak}/${state.config.need.belowNeedLimit}d`,
            }),
            h('dt', { text: '升阶净额 / 降阶费用' }),
            h('dd', {
              text: `${formatNumber(detail.ascendCost)} / ${formatNumber(detail.descendCost)}`,
            }),
            h('dt', { text: '剩余寿命 / 初始寿命' }),
            h('dd', {
              text: `${Math.round(detail.remainingLife)} / ${Math.round(detail.initialLife)} d`,
            }),
            h('dt', { text: '天赋 ge / 努力 hard (F)' }),
            h('dd', {
              text: `${formatNumber(detail.ge)} / ${formatNumber(detail.hard)} (F=${formatNumber(detail.effortValue)})`,
            }),
            h('dt', { text: '特质 risk / crossOpen' }),
            h('dd', {
              text: `${formatNumber(detail.riskTolerance)} / ${formatNumber(detail.crossClassOpenness)}`,
            }),
            h('dt', { text: '最近跨越 (asc / desc)' }),
            h('dd', {
              text: `${detail.lastAscentTick ?? '—'} / ${detail.lastDescentTick ?? '—'}`,
            }),
          ]),
        ],
        {
          actions: [
            h('button', {
              class: `btn btn-sm ${isAvatar ? 'btn-primary' : ''}`.trim(),
              type: 'button',
              disabled: !detail.alive,
              text: isAvatar ? '已设为化身' : '设为化身',
              onClick: () => {
                this.app.possessAgent(detail.id as AgentId, true);
                this.app.setSurface('sandbox');
              },
            }),
            h('button', {
              class: 'btn btn-sm',
              type: 'button',
              disabled: !detail.alive,
              title: '从当前检查点对该个体施加 ΔValue=+0.0001 微扰克隆',
              text: '微扰克隆',
              onClick: () => this.app.forkFocusedAgent(0.0001),
            }),
          ],
        },
      ),

      // 象限 B：决策 X 光
      card('决策 X 光', [decisionView(decisions), executionView(execution)], {
        subtitle: '枚举候选 → 策略概率 → 选定行动 → 核心结算实际执行',
      }),

      // 象限 C：人生阶梯带、代际血脉与复式账本
      card(
        '人生轨迹与财富复式账本',
        [
          renderLifeTrajectoryStrip(
            lifePts,
            Math.max(1, snapshot.tick),
            state.config.population.classCount,
          ),
          lineageStrip,
          anatomy === null ? null : renderAccumulationAnatomy(anatomy),
          anatomy === null ? null : renderAscentWaterfall(anatomy),
          wealthLedgerView(ledger),
          eventLedger(events),
        ],
        {
          subtitle: '阶层升降阶梯带 · 代际血脉 · 机制因子 · 逐笔 Value 复式账本',
        },
      ),

      // 象限 D：自我中心关系网拓扑
      card(
        '自我中心关系网 (Ego-Network)',
        [
          detail.neighbors.length === 0
            ? h('p', { class: 'muted', text: '当前无存活连边（孤立节点，Opportunity=1）。' })
            : renderEgoNetwork(
                { id: detail.id, classIndex: detail.classIndex },
                detail.neighbors,
                (neighborId) => {
                  this.app.selectedAgentId = neighborId;
                  this.refreshRosterOnly();
                  this.renderDetail();
                },
              ),
          h('p', {
            class: 'muted',
            style: 'margin:6px 0 0',
            text: `邻居 ${detail.neighbors.length}/${state.config.network.maxDegree} 人 · 邻居中位数财富 ${formatNumber(detail.neighborMedianValue)}（点击拓扑节点可直接跳转）。界面只读，微扰通过专门分叉操作完成。`,
          }),
        ],
        {
          subtitle: '金色实线为跨阶层连边，灰色虚线为同阶层连边',
        },
      ),
    );
  }

  update(): void {
    const state = this.app.controller.getState();
    const rows = agentRows(state);
    if (rows.length === 0 || state === null) {
      this.emptyNotice.hidden = false;
      this.mainGrid.hidden = true;
      return;
    }
    this.emptyNotice.hidden = true;
    this.mainGrid.hidden = false;
    this.ensureClassOptions(state.config.population.classCount);

    if (
      this.app.selectedAgentId === null ||
      !rows.some((row) => row.id === this.app.selectedAgentId)
    ) {
      this.app.selectedAgentId = rows.find((row) => row.alive)?.id ?? rows[0]?.id ?? null;
    }
    if (this.searchInput.value !== this.app.agentQuery) {
      this.searchInput.value = this.app.agentQuery;
    }
    this.renderList(rows);
    this.renderDetail();
  }
}

export function renderInspector(root: HTMLElement, app: StratifyApp): void {
  const view = new InspectorView(app);
  view.update();
  root.append(view.root);
}

function decisionView(decisions: ReturnType<typeof decisionsForAgent>): HTMLElement {
  if (decisions.length === 0) {
    return h('p', { class: 'muted', text: '尚无该个体的决策记录（可能尚未到达决策 tick）。' });
  }
  const list = h('div', { class: 'decision-xray-list' });
  for (const decision of decisions) {
    const bars = h('div', { class: 'prob-bars-wrap' });
    for (const probability of decision.probabilities.slice(0, 6)) {
      const isChosen = probability.action === decision.selectedAction;
      bars.append(
        h('div', { class: 'prob-bar' }, [
          h('span', {
            class: isChosen ? 'prob-action-chosen' : '',
            text: `${isChosen ? '▸ ' : ''}${probability.action}`,
          }),
          h('div', { class: 'prob-track' }, [
            h('div', {
              class: 'prob-fill',
              style: `width:${Math.max(1, probability.value * 100).toFixed(2)}%;background:${isChosen ? 'var(--accent)' : 'var(--text-muted)'}`,
            }),
          ]),
          h('span', { text: formatPercent(probability.value) }),
        ]),
      );
    }
    list.append(
      h('div', { class: 'decision-xray-item' }, [
        h('div', { class: 'actions-row' }, [
          badge(`tick ${decision.tick}`, 'muted'),
          badge(decision.policyVersion, 'info'),
          decision.promptStyle === null ? null : badge(decision.promptStyle, 'muted'),
          badge(decision.source, decision.source === 'fallback' ? 'warn' : 'muted'),
          decision.fallbackReason === null ? null : badge(decision.fallbackReason, 'danger'),
        ]),
        h('p', { style: 'margin:4px 0' }, [
          h('span', { class: 'muted', text: '选定行动 selectedAction: ' }),
          h('strong', { class: 'mono', text: decision.selectedAction }),
          h('span', {
            class: 'muted',
            text: ` · 请求=${decision.requestedAction ?? '—'} · 合法候选 ${decision.legalActions.length} 项`,
          }),
        ]),
        bars,
        h('details', { style: 'margin-top:6px' }, [
          h('summary', {
            class: 'muted',
            style: 'cursor:pointer;font-size:11px',
            text: '展开脱敏决策审计 JSON（stateHash / actionSetHash / rawResponse）',
          }),
          h('pre', {
            class: 'mono code-preview',
            text: JSON.stringify(
              {
                promptVersion: decision.promptVersion,
                promptStyle: decision.promptStyle,
                latencyMs: decision.latencyMs,
                stateHash: decision.stateHash,
                actionSetHash: decision.actionSetHash,
                rawResponse: decision.sanitizedRawResponse,
              },
              null,
              2,
            ),
          }),
        ]),
      ]),
    );
  }
  return list;
}

function executionView(execution: ReturnType<typeof latestExecution>): HTMLElement {
  if (execution === null) return h('p', { class: 'muted', text: '尚无核心执行记录。' });
  return h('div', { class: 'notice', style: 'margin-top:8px' }, [
    h('strong', { text: '核心实际执行：' }),
    h('span', {
      class: 'mono',
      text: `tick ${execution.tick} · ${execution.status} · ${execution.selectedAction}`,
    }),
    execution.reason === null ? null : h('span', { text: ` · 原因=${execution.reason}` }),
  ]);
}

function wealthLedgerView(ledger: ReturnType<typeof agentWealthLedger>): HTMLElement {
  if (ledger.length === 0)
    return h('p', { class: 'muted', text: '近期缓冲区内尚无财富变动分录。' });
  return table(
    ['tick', '原因 (cause)', '变动前', 'ΔValue', '变动后'],
    ledger
      .slice(0, 12)
      .map((row) => [
        `${row.tick}`,
        row.referenceId === null ? row.cause : `${row.cause} (${row.referenceId})`,
        formatNumber(row.before, 2),
        `${row.delta >= 0 ? '+' : ''}${formatNumber(row.delta, 2)}`,
        formatNumber(row.after, 2),
      ]),
    { maxHeight: 190 },
  );
}

function eventLedger(events: ReturnType<typeof agentEvents>): HTMLElement {
  if (events.length === 0) return h('p', { class: 'muted', text: '近期无其他关联事件。' });
  return h('details', { style: 'margin-top:10px' }, [
    h('summary', {
      class: 'muted',
      style: 'cursor:pointer;font-size:12px',
      text: `展开全部关联原始事件 (${events.length} 条)`,
    }),
    table(
      ['tick', 'seq', '类型', '摘要'],
      events.map((event) => [`${event.tick}`, `${event.seq}`, event.type, event.summary]),
      { maxHeight: 180 },
    ),
  ]);
}
