import type { AgentRow } from '../../app/view-model.js';
import {
  agentDetail,
  agentEvents,
  agentRows,
  decisionsForAgent,
  formatNumber,
  formatPercent,
} from '../../app/view-model.js';
import { badge, card, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

export function renderInspector(root: HTMLElement, app: StratifyApp): void {
  const state = app.controller.getState();
  const rows = agentRows(state);
  if (rows.length === 0) {
    root.append(
      h('div', { class: 'span-12' }, [
        card('个体检查器', [
          h('p', { class: 'muted', text: '尚未初始化世界。先在实验设置页开始一次离线运行。' }),
        ]),
      ]),
    );
    return;
  }
  if (app.selectedAgentId === null || !rows.some((row) => row.id === app.selectedAgentId)) {
    app.selectedAgentId = rows.find((row) => row.alive)?.id ?? rows[0]?.id ?? null;
  }

  const listContainer = h('ul', { class: 'agent-list', role: 'listbox', ariaLabel: '个体名册' });
  const detailContainer = h('div', { class: 'detail-grid' });

  const search = h('input', {
    id: 'agent-search',
    type: 'text',
    placeholder: '搜索 a-0012',
    value: app.agentQuery,
    onInput: (event) => {
      app.agentQuery = (event.target as HTMLInputElement).value;
      renderList();
    },
  });
  const aliveFilter = h('select', {
    id: 'agent-filter',
    onChange: (event) => {
      app.agentFilter = (event.target as HTMLSelectElement).value as StratifyApp['agentFilter'];
      renderList();
    },
  });
  for (const [value, label] of [
    ['all', '全部'],
    ['alive', '存活'],
    ['dead', '已故'],
  ] as const) {
    aliveFilter.append(h('option', { value, text: label, selected: app.agentFilter === value }));
  }
  const classFilter = h('select', {
    id: 'agent-class',
    onChange: (event) => {
      app.agentClass = Number((event.target as HTMLSelectElement).value);
      renderList();
    },
  });
  classFilter.append(
    h('option', { value: '-1', text: '全部阶级', selected: app.agentClass === -1 }),
  );
  for (let index = 0; index < (state?.config.population.classCount ?? 5); index += 1) {
    classFilter.append(
      h('option', {
        value: String(index),
        text: `Class ${index}`,
        selected: app.agentClass === index,
      }),
    );
  }

  function filterRows(): AgentRow[] {
    const query = app.agentQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (query !== '' && !row.id.toLowerCase().includes(query)) return false;
      if (app.agentFilter === 'alive' && !row.alive) return false;
      if (app.agentFilter === 'dead' && row.alive) return false;
      if (app.agentClass >= 0 && row.classIndex !== app.agentClass) return false;
      return true;
    });
  }

  function renderList(): void {
    listContainer.replaceChildren();
    const filtered = filterRows();
    if (filtered.length === 0) {
      listContainer.append(h('li', { class: 'muted', text: '无匹配个体。' }));
      return;
    }
    for (const row of filtered) {
      listContainer.append(
        h('li', {}, [
          h(
            'button',
            {
              ariaCurrent: String(app.selectedAgentId === row.id),
              onClick: () => {
                app.selectedAgentId = row.id;
                app.render();
              },
            },
            [
              h('span', { text: `${row.alive ? '●' : '○'} C${row.classIndex} ${row.id}` }),
              h('br'),
              h('span', {
                text: `V ${formatNumber(row.value)} · need ${row.needRatio === null ? '—' : formatPercent(row.needRatio, 0)} · life ${Math.round(row.remainingLife)}d · ties ${row.ties}`,
              }),
            ],
          ),
        ]),
      );
    }
  }

  function renderDetail(): void {
    detailContainer.replaceChildren();
    const agentId = app.selectedAgentId;
    if (agentId === null) return;
    const detail = agentDetail(state, agentId);
    if (detail === null) {
      detailContainer.append(h('p', { class: 'muted', text: '个体不存在。' }));
      return;
    }
    const decisions = decisionsForAgent(app.getSnapshot(), agentId, 8);
    const events = agentEvents(app.getSnapshot().events, agentId, 30);
    detailContainer.append(
      card(
        `${detail.id} · 生存与阶级`,
        [
          h('dl', { class: 'detail-list' }, [
            h('dt', { text: '状态' }),
            h('dd', {}, [badge(detail.alive ? '存活' : '已故', detail.alive ? 'ok' : 'muted')]),
            h('dt', { text: '阶级 / 历史最高' }),
            h('dd', { text: `C${detail.classIndex} / C${detail.maxClassIndex}` }),
            h('dt', { text: 'Value / need' }),
            h('dd', { text: `${formatNumber(detail.value)} / ${formatNumber(detail.need)}` }),
            h('dt', { text: 'needRatio' }),
            h('dd', { text: detail.needRatio === null ? '—' : formatPercent(detail.needRatio) }),
            h('dt', { text: '剩余寿命 / 初始寿命' }),
            h('dd', {
              text: `${Math.round(detail.remainingLife)} / ${Math.round(detail.initialLife)} d`,
            }),
            h('dt', { text: 'classAge / streak' }),
            h('dd', { text: `${detail.classAge} d / ${detail.belowNeedStreak}` }),
            h('dt', { text: 'ge / hard' }),
            h('dd', { text: `${formatNumber(detail.ge)} / ${formatNumber(detail.hard)}` }),
            h('dt', { text: '特质 risk / cross' }),
            h('dd', {
              text: `${formatNumber(detail.riskTolerance)} / ${formatNumber(detail.crossClassOpenness)}`,
            }),
            h('dt', { text: 'last ascent / descent' }),
            h('dd', {
              text: `${detail.lastAscentTick === null ? '—' : detail.lastAscentTick} / ${detail.lastDescentTick === null ? '—' : detail.lastDescentTick}`,
            }),
          ]),
        ],
        { class: 'span-6' },
      ),
      card('决策 X 光', [decisionView(decisions)], { class: 'span-6' }),
      card('财富与事件账本', [eventLedger(events)], { class: 'span-6' }),
      card(
        '关系网络',
        [
          h('p', {
            class: 'muted',
            text: `邻居 ${detail.neighborIds.length} 人（maxDegree=${state?.config.network.maxDegree ?? '—'}）。`,
          }),
          h('p', { class: 'mono', text: detail.neighborIds.join(', ') || '—' }),
          h('p', {
            class: 'muted',
            text: '界面只读；微扰必须通过专门 fork 操作完成并记录唯一变更字段。',
          }),
        ],
        { class: 'span-6' },
      ),
    );
  }

  renderList();
  renderDetail();

  root.append(
    h('div', { class: 'span-3' }, [
      card('名册', [
        h('div', { class: 'field' }, [
          h('label', { class: 'field-label', for: 'agent-search', text: '搜索' }),
          search,
        ]),
        h('div', { class: 'form-grid', style: 'grid-template-columns:1fr 1fr' }, [
          h('div', { class: 'field' }, [
            h('label', { class: 'field-label', for: 'agent-filter', text: '状态' }),
            aliveFilter,
          ]),
          h('div', { class: 'field' }, [
            h('label', { class: 'field-label', for: 'agent-class', text: '阶级' }),
            classFilter,
          ]),
        ]),
        h('div', { style: 'max-height:520px;overflow:auto' }, [listContainer]),
      ]),
    ]),
    h('div', { class: 'span-9' }, [detailContainer]),
  );
}

function decisionView(decisions: ReturnType<typeof decisionsForAgent>): HTMLElement {
  if (decisions.length === 0) {
    return h('p', { class: 'muted', text: '尚无该个体的决策记录（可能不是决策 tick）。' });
  }
  const list = h('div', {});
  for (const decision of decisions) {
    const bars = h('div', {});
    for (const probability of decision.probabilities.slice(0, 8)) {
      bars.append(
        h('div', { class: 'prob-bar' }, [
          h('span', { text: probability.action }),
          h('div', { class: 'prob-track' }, [
            h('div', {
              class: 'prob-fill',
              style: `width:${Math.max(1, probability.value * 100).toFixed(2)}%`,
            }),
          ]),
          h('span', { text: formatPercent(probability.value) }),
        ]),
      );
    }
    list.append(
      h('div', { style: 'margin-bottom:12px' }, [
        h('div', { class: 'actions-row' }, [
          badge(`tick ${decision.tick}`, 'muted'),
          badge(decision.policyVersion, 'info'),
          badge(decision.source, decision.source === 'fallback' ? 'warn' : 'muted'),
          decision.fallbackReason === null ? null : badge(decision.fallbackReason, 'danger'),
        ]),
        h('p', {}, [
          h('strong', { text: 'selectedAction: ' }),
          h('span', { class: 'mono', text: decision.selectedAction }),
        ]),
        bars,
      ]),
    );
  }
  return list;
}

function eventLedger(events: ReturnType<typeof agentEvents>): HTMLElement {
  if (events.length === 0) return h('p', { class: 'muted', text: '近期无相关事件。' });
  return table(
    ['tick', 'seq', '类型', '摘要'],
    events.map((event) => [`${event.tick}`, `${event.seq}`, event.type, event.summary]),
  );
}
