import { asAgentId, type AgentId } from '../../core/control/ids.js';
import type { TickEvent } from '../../core/events.js';
import {
  cachedClassShareSnapshot,
  computeAscendBarrier,
  computeAscendCost,
  computeAscendCrossBase,
  computeAscendCushion,
} from '../../core/legal-actions.js';
import { agentIndexFromId, type AgentState } from '../../core/model/agent.js';
import type { SimState } from '../../core/model/state.js';
import { formatNumber, formatPercent, needOf } from '../../app/view-model.js';
import { classSymbol, classTitle, h } from '../dom.js';
import { separateLaneNodes } from './physics.js';

export type ArenaLayoutMode = 'wealth' | 'network';

interface NodeSprite {
  x: number;
  y: number;
  tx: number;
  ty: number;
  radius: number;
  alive: boolean;
  classIndex: number;
}

interface ActionFX {
  readonly kind: 'ascend' | 'descend' | 'compete';
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  ttl: number;
  readonly maxTtl: number;
}

const OBSIDIAN_CLASS_HEX = ['#64748b', '#38bdf8', '#2dd4bf', '#a78bfa', '#f59e0b'] as const;
const PAPER_CLASS_HEX = ['#64748b', '#0284c7', '#0d9488', '#7c3aed', '#d97706'] as const;

function goldenPhase(index: number, salt = 1): number {
  const raw = ((index + 1) * 0.6180339887498949 * salt) % 1;
  return raw < 0 ? raw + 1 : raw;
}

export interface LivingArenaCallbacks {
  readonly onSelectAgent: (agentId: string) => void;
  readonly onPossessAgent: (agentId: AgentId) => void;
}

/**
 * 五阶层动态社会生态剧场画布引擎：
 * - 零 Math.random()，布局相位完全由确定性索引派生；
 * - 支持「财富晋升阶梯」与「社会关系星群」双视图平滑插值；
 * - 实时可视化升降阶流光、跨层竞争电弧与社交连边。
 */
export class LivingArenaCanvas {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly tooltip: HTMLElement;
  private readonly sprites = new Map<string, NodeSprite>();
  private readonly effects: ActionFX[] = [];
  private lastEventSeqKey = '';
  private layoutMode: ArenaLayoutMode = 'wealth';
  private showAllEdges = true;
  private hoveredAgentId: string | null = null;
  private previewTargetId: string | null = null;
  private state: SimState | null = null;
  private selectedAgentId: string | null = null;
  private avatarId: string | null = null;
  private theme: 'obsidian' | 'paper' = 'obsidian';
  private rafId: number | null = null;
  private width = 760;
  private height = 430;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly callbacks: LivingArenaCallbacks) {
    this.canvas = h('canvas', {
      class: 'arena-canvas',
      ariaLabel: '五阶层动态社会生态画布',
    }) as HTMLCanvasElement;
    this.tooltip = h('div', { class: 'arena-tooltip', hidden: true });
    this.root = h('div', { class: 'arena-stage-wrap' }, [this.canvas, this.tooltip]);
    this.bindEvents();
  }

  setLayoutMode(mode: ArenaLayoutMode): void {
    this.layoutMode = mode;
    this.recomputeTargets();
    this.scheduleDraw();
  }

  getLayoutMode(): ArenaLayoutMode {
    return this.layoutMode;
  }

  setShowAllEdges(show: boolean): void {
    this.showAllEdges = show;
    this.scheduleDraw();
  }

  getShowAllEdges(): boolean {
    return this.showAllEdges;
  }

  setPreviewTarget(targetId: string | null): void {
    if (this.previewTargetId === targetId) return;
    this.previewTargetId = targetId;
    this.scheduleDraw();
  }

  update(
    state: SimState | null,
    events: readonly TickEvent[],
    options: {
      selectedAgentId: string | null;
      avatarId: string | null;
      theme: 'obsidian' | 'paper';
    },
  ): void {
    this.state = state;
    this.selectedAgentId = options.selectedAgentId;
    this.avatarId = options.avatarId;
    this.theme = options.theme;
    this.syncResizeObserver();
    this.recomputeTargets();
    this.ingestRecentEvents(events);
    this.scheduleDraw();
  }

  destroy(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private syncResizeObserver(): void {
    if (this.resizeObserver !== null || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const nextW = Math.max(320, Math.floor(entry.contentRect.width));
      const nextH = Math.max(340, Math.min(520, Math.floor(nextW * 0.56)));
      if (Math.abs(nextW - this.width) > 2 || Math.abs(nextH - this.height) > 2) {
        this.width = nextW;
        this.height = nextH;
        this.recomputeTargets();
        this.scheduleDraw();
      }
    });
    this.resizeObserver.observe(this.root);
  }

  private bindEvents(): void {
    this.canvas.addEventListener('mousemove', (event: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const mx = ((event.clientX - rect.left) / rect.width) * this.width;
      const my = ((event.clientY - rect.top) / rect.height) * this.height;
      const hit = this.pickAgentAt(mx, my);
      if (hit !== this.hoveredAgentId) {
        this.hoveredAgentId = hit;
        this.scheduleDraw();
      }
      if (hit !== null && this.state !== null) {
        this.renderTooltip(hit, event.clientX - rect.left, event.clientY - rect.top);
      } else {
        this.tooltip.hidden = true;
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (this.hoveredAgentId !== null) {
        this.hoveredAgentId = null;
        this.scheduleDraw();
      }
      this.tooltip.hidden = true;
    });

    this.canvas.addEventListener('click', (event: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const mx = ((event.clientX - rect.left) / rect.width) * this.width;
      const my = ((event.clientY - rect.top) / rect.height) * this.height;
      const hit = this.pickAgentAt(mx, my);
      if (hit !== null) {
        this.callbacks.onSelectAgent(hit);
      }
    });

    this.canvas.addEventListener('dblclick', (event: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const mx = ((event.clientX - rect.left) / rect.width) * this.width;
      const my = ((event.clientY - rect.top) / rect.height) * this.height;
      const hit = this.pickAgentAt(mx, my);
      if (hit !== null) {
        this.callbacks.onPossessAgent(hit as AgentId);
      }
    });
  }

  private pickAgentAt(mx: number, my: number): string | null {
    let bestId: string | null = null;
    let bestDist = 18 * 18;
    for (const [id, sprite] of this.sprites) {
      if (!sprite.alive) continue;
      const dx = mx - sprite.x;
      const dy = my - sprite.y;
      const d2 = dx * dx + dy * dy;
      const hitR = Math.max(11, sprite.radius + 5);
      if (d2 <= hitR * hitR && d2 < bestDist) {
        bestDist = d2;
        bestId = id;
      }
    }
    return bestId;
  }

  private renderTooltip(agentId: string, relX: number, relY: number): void {
    if (this.state === null) return;
    let agent: AgentState | undefined;
    try {
      agent = this.state.society.agents[agentIndexFromId(asAgentId(agentId))];
    } catch {
      agent = this.state.society.agents.find((a) => a.id === agentId);
    }
    if (agent === undefined) {
      this.tooltip.hidden = true;
      return;
    }
    const need = needOf(this.state.config, this.state, agent);
    const needRatio = need === null || need === 0 ? null : agent.value / need;
    const isAvatar = agent.id === this.avatarId;
    this.tooltip.replaceChildren(
      h('div', { class: 'arena-tip-head' }, [
        h('strong', { text: `${classSymbol(agent.classIndex)} ${agent.id}` }),
        h('span', {
          class: 'arena-tip-tag',
          text: isAvatar ? '★ 我的化身' : classTitle(agent.classIndex),
        }),
      ]),
      h('div', {
        class: 'arena-tip-row',
        text: `财富 V=${formatNumber(agent.value, 2)} · 需求比 ${formatPercent(needRatio, 0)}`,
      }),
      h('div', {
        class: 'arena-tip-row',
        text: `余命 ${Math.round(agent.remainingLife / 365)}年 · 邻居 ${agent.ties.length} · 单击检视 / 双击附身`,
      }),
    );
    const left = Math.min(Math.max(8, relX + 14), Math.max(8, this.width - 245));
    const top = Math.min(Math.max(8, relY - 12), Math.max(8, this.height - 84));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
    this.tooltip.hidden = false;
  }

  private laneGeometry(
    classCount: number,
    classAlive: readonly number[],
  ): {
    left: number;
    right: number;
    top: number;
    lanes: readonly { readonly y0: number; readonly h: number }[];
  } {
    const left = 88;
    const right = this.width - 84;
    const top = 16;
    const usableH = this.height - 32;
    const emptyCount = classAlive.filter((n) => n === 0).length;
    const collapsedH = 24;
    const activeCount = Math.max(0, classCount - emptyCount);
    const activeH =
      activeCount > 0
        ? Math.max(collapsedH, (usableH - emptyCount * collapsedH) / activeCount)
        : usableH / Math.max(1, classCount);

    const lanes: { y0: number; h: number }[] = new Array(classCount);
    let cursorY = top;
    for (let visualRow = 0; visualRow < classCount; visualRow += 1) {
      const c = classCount - 1 - visualRow;
      const h = activeCount > 0 && (classAlive[c] ?? 0) === 0 ? collapsedH : activeH;
      lanes[c] = { y0: cursorY, h };
      cursorY += h;
    }
    return { left, right, top, lanes };
  }

  private recomputeTargets(): void {
    if (this.state === null) {
      this.sprites.clear();
      return;
    }
    const agents = this.state.society.agents;
    const classCount = this.state.config.population.classCount;
    const classAlive = new Array<number>(classCount).fill(0);
    for (const agent of agents) {
      if (agent.alive) classAlive[agent.classIndex] = (classAlive[agent.classIndex] ?? 0) + 1;
    }
    const { left, right, lanes } = this.laneGeometry(classCount, classAlive);
    const innerW = Math.max(60, right - left - 24);

    // 计算最大 log(1+value) 以便财富轴平滑映射
    let maxLogVal = 4;
    for (const agent of agents) {
      if (!agent.alive) continue;
      const lv = Math.log1p(Math.max(0, agent.value));
      if (lv > maxLogVal) maxLogVal = lv;
    }
    // 也将最高阶上升门槛纳入坐标跨度，使门槛虚线落在画布可视区内
    for (let c = 0; c < classCount - 1; c += 1) {
      const th = this.classAscendThreshold(c);
      if (th !== null) {
        const lv = Math.log1p(Math.max(0, th)) * 1.08;
        if (lv > maxLogVal) maxLogVal = lv;
      }
    }

    const popScale = agents.length > 300 ? 0.65 : agents.length > 120 ? 0.82 : 1;

    for (let idx = 0; idx < agents.length; idx += 1) {
      const agent = agents[idx];
      if (agent === undefined) continue;
      const lane = lanes[agent.classIndex] ?? { y0: 16, h: 48 };
      const laneCenterY = lane.y0 + lane.h * 0.5;
      const jitterY = (goldenPhase(idx, 3) - 0.5) * Math.max(8, lane.h * 0.56);
      const ty = laneCenterY + jitterY;

      let tx: number;
      if (this.layoutMode === 'wealth') {
        const ratio = Math.min(1, Math.log1p(Math.max(0, agent.value)) / maxLogVal);
        const zeroJitter = agent.value <= 0.01 ? goldenPhase(idx, 5) * 28 : 0;
        tx = left + 12 + ratio * innerW + zeroJitter;
      } else {
        const phaseX = goldenPhase(idx, 1);
        const degreeShift =
          (agent.ties.length / Math.max(1, this.state.config.network.maxDegree) - 0.5) * 0.08;
        const clamped = Math.min(0.97, Math.max(0.03, phaseX + degreeShift));
        tx = left + 12 + clamped * innerW;
      }

      const baseR = (4.2 + Math.min(5.5, Math.log1p(Math.max(0, agent.value)) * 0.75)) * popScale;
      const existing = this.sprites.get(agent.id);
      if (existing === undefined) {
        this.sprites.set(agent.id, {
          x: tx,
          y: ty,
          tx,
          ty,
          radius: baseR,
          alive: agent.alive,
          classIndex: agent.classIndex,
        });
      } else {
        existing.tx = tx;
        existing.ty = ty;
        existing.radius = baseR;
        existing.alive = agent.alive;
        existing.classIndex = agent.classIndex;
      }
    }

    // 每层泳道内运行轻量碰撞分离，消除低阶层节点堆叠重叠
    for (let c = 0; c < classCount; c += 1) {
      const lane = lanes[c] ?? { y0: 16, h: 48 };
      const laneSprites: {
        sprite: NodeSprite;
        node: {
          x: number;
          y: number;
          radius: number;
          minX: number;
          maxX: number;
          minY: number;
          maxY: number;
        };
      }[] = [];
      for (const agent of agents) {
        if (!agent.alive || agent.classIndex !== c) continue;
        const sp = this.sprites.get(agent.id);
        if (sp === undefined) continue;
        laneSprites.push({
          sprite: sp,
          node: {
            x: sp.tx,
            y: sp.ty,
            radius: sp.radius,
            minX: left + sp.radius + 4,
            maxX: right - sp.radius - 4,
            minY: lane.y0 + sp.radius + 4,
            maxY: lane.y0 + lane.h - sp.radius - 4,
          },
        });
      }
      if (laneSprites.length > 1 && laneSprites.length <= 180) {
        separateLaneNodes(laneSprites.map((item) => item.node));
        for (const item of laneSprites) {
          item.sprite.tx = item.node.x;
          item.sprite.ty = item.node.y;
        }
      }
    }
  }

  private classAscendThreshold(classIndex: number): number | null {
    if (this.state === null) return null;
    const config = this.state.config;
    if (classIndex >= config.population.classCount - 1) return null;
    try {
      const dummy = { classIndex, maxClassIndex: classIndex };
      const cost = computeAscendCost(
        config,
        dummy,
        this.state.society.eByClass,
        this.state.society.openness,
        this.state.society.refIncome,
        cachedClassShareSnapshot(this.state.society.agents, config.population.classCount),
      );
      if (cost === null) return null;
      const cushion = computeAscendCushion(
        config,
        classIndex + 1,
        this.state.society.eByClass,
        this.state.society.refIncome,
      );
      const base = computeAscendCrossBase(
        config,
        dummy,
        this.state.society.eByClass,
        this.state.society.refIncome,
      );
      const barrier =
        base === null
          ? 0
          : computeAscendBarrier(
              config,
              classIndex,
              base.crossBase,
              this.state.society.occupancyPressure,
            );
      return cost + cushion + barrier;
    } catch {
      return null;
    }
  }

  private ingestRecentEvents(events: readonly TickEvent[]): void {
    if (events.length === 0) {
      this.lastEventSeqKey = '';
      return;
    }
    const last = events[events.length - 1];
    if (last === undefined) return;
    const key = `${last.tick}:${last.seq}`;
    if (key === this.lastEventSeqKey) return;
    this.lastEventSeqKey = key;

    // 仅抽取当前最新 tick 的关键交互事件转化为轻量流光粒子（上限 24 条防视觉过载）
    const targetTick = last.tick;
    let added = 0;
    for (let i = events.length - 1; i >= 0 && added < 24; i -= 1) {
      const ev = events[i];
      if (ev === undefined || ev.tick < targetTick) break;
      if (ev.type === 'class_ascended') {
        const sp = this.sprites.get(ev.agentId);
        if (sp !== undefined) {
          this.effects.push({
            kind: 'ascend',
            fromX: sp.x,
            fromY: sp.y,
            toX: sp.tx,
            toY: sp.ty,
            ttl: 22,
            maxTtl: 22,
          });
          added += 1;
        }
      } else if (ev.type === 'class_descended') {
        const sp = this.sprites.get(ev.agentId);
        if (sp !== undefined) {
          this.effects.push({
            kind: 'descend',
            fromX: sp.x,
            fromY: sp.y,
            toX: sp.tx,
            toY: sp.ty,
            ttl: 20,
            maxTtl: 20,
          });
          added += 1;
        }
      } else if (ev.type === 'competition_resolved') {
        const a = this.sprites.get(ev.initiatorId);
        const b = this.sprites.get(ev.targetId);
        if (a !== undefined && b !== undefined) {
          this.effects.push({
            kind: 'compete',
            fromX: a.x,
            fromY: a.y,
            toX: b.x,
            toY: b.y,
            ttl: 16,
            maxTtl: 16,
          });
          added += 1;
        }
      }
    }
    if (this.effects.length > 48) {
      this.effects.splice(0, this.effects.length - 48);
    }
  }

  private scheduleDraw(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.drawFrame();
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const needsMore = this.drawFrame();
      if (needsMore) this.scheduleDraw();
    });
  }

  private drawFrame(): boolean {
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
      return false;
    }
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = this.canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (ctx === null) return false;

    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const targetW = Math.round(this.width * dpr);
    const targetH = Math.round(this.height * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    ctx.save();
    ctx.scale(dpr, dpr);

    const isPaper = this.theme === 'paper';
    const palette = isPaper ? PAPER_CLASS_HEX : OBSIDIAN_CLASS_HEX;
    ctx.fillStyle = isPaper ? '#f8fafc' : '#070c18';
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.state === null) {
      ctx.fillStyle = isPaper ? '#64748b' : '#94a3b8';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        '选择上方探索剧本或点击「开始」，唤醒五阶层社会生态剧场',
        this.width / 2,
        this.height / 2,
      );
      ctx.restore();
      return false;
    }

    const config = this.state.config;
    const classCount = config.population.classCount;
    const innerWRef = { val: 0 };

    // 统计每层存活数与最大 logVal（用于画升阶门槛线）
    const classAlive = new Array<number>(classCount).fill(0);
    let maxLogVal = 4;
    for (const agent of this.state.society.agents) {
      if (!agent.alive) continue;
      classAlive[agent.classIndex] = (classAlive[agent.classIndex] ?? 0) + 1;
      const lv = Math.log1p(Math.max(0, agent.value));
      if (lv > maxLogVal) maxLogVal = lv;
    }
    const { left, right, lanes } = this.laneGeometry(classCount, classAlive);
    const innerW = Math.max(60, right - left - 24);
    innerWRef.val = innerW;
    for (let c = 0; c < classCount - 1; c += 1) {
      const th = this.classAscendThreshold(c);
      if (th !== null) {
        const lv = Math.log1p(Math.max(0, th)) * 1.08;
        if (lv > maxLogVal) maxLogVal = lv;
      }
    }

    // 1. 绘制五条阶级水平生态泳道（空泳道自动折叠为紧凑条）
    for (let c = 0; c < classCount; c += 1) {
      const visualRow = classCount - 1 - c;
      const lane = lanes[c] ?? { y0: 16, h: 48 };
      const y0 = lane.y0;
      const laneH = lane.h;
      const compact = laneH < 34;
      const color = palette[c] ?? '#38bdf8';

      ctx.fillStyle =
        visualRow % 2 === 0
          ? isPaper
            ? 'rgba(15, 23, 42, 0.025)'
            : 'rgba(30, 41, 59, 0.28)'
          : isPaper
            ? 'rgba(15, 23, 42, 0.008)'
            : 'rgba(15, 23, 42, 0.14)';
      ctx.fillRect(left, y0 + 2, right - left, laneH - 4);

      // 左侧阶级色标条与标题
      ctx.fillStyle = color;
      ctx.fillRect(left - 4, y0 + 4, 3, laneH - 8);

      ctx.font = '600 11.5px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = isPaper ? '#0f172a' : '#e2e8f0';
      ctx.fillText(
        `${classSymbol(c)} C${c}`,
        left - 12,
        compact ? y0 + laneH * 0.65 : y0 + laneH * 0.44,
      );

      if (!compact) {
        ctx.font = '10.5px JetBrains Mono, monospace';
        ctx.fillStyle = isPaper ? '#64748b' : '#94a3b8';
        const envVal = this.state.society.eByClass[c] ?? 1;
        ctx.fillText(`E=${envVal.toFixed(2)}`, left - 12, y0 + laneH * 0.44 + 14);
      }

      // 右侧存活人数统计与迷你占比柱
      const count = classAlive[c] ?? 0;
      const share =
        this.state.society.agents.length > 0 ? count / this.state.society.agents.length : 0;
      ctx.textAlign = 'left';
      ctx.fillStyle = isPaper ? '#334155' : '#cbd5e1';
      ctx.fillText(`${count}人`, right + 10, compact ? y0 + laneH * 0.65 : y0 + laneH * 0.46);
      if (!compact) {
        ctx.fillStyle = isPaper ? 'rgba(15,23,42,0.08)' : 'rgba(148,163,184,0.15)';
        ctx.fillRect(right + 10, y0 + laneH * 0.46 + 6, 54, 5);
        ctx.fillStyle = color;
        ctx.fillRect(right + 10, y0 + laneH * 0.46 + 6, Math.round(54 * Math.min(1, share)), 5);
      }

      // 财富模式下画出该阶级向上跨越门槛虚线
      if (this.layoutMode === 'wealth' && c < classCount - 1) {
        const threshold = this.classAscendThreshold(c);
        if (threshold !== null && threshold > 0) {
          const tx = left + 12 + Math.min(1, Math.log1p(threshold) / maxLogVal) * innerW;
          ctx.save();
          ctx.strokeStyle = isPaper ? 'rgba(2, 132, 199, 0.42)' : 'rgba(56, 189, 248, 0.36)';
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tx, y0 + 5);
          ctx.lineTo(tx, y0 + laneH - 5);
          ctx.stroke();
          ctx.fillStyle = isPaper ? '#0284c7' : '#38bdf8';
          ctx.font = '9.5px JetBrains Mono, monospace';
          ctx.textAlign = 'right';
          ctx.fillText(`▲${formatNumber(threshold, 0)}`, tx - 3, y0 + 13);
          ctx.restore();
        }
      }
    }

    // 2. 推进精灵平滑插值
    let stillMoving = false;
    for (const sprite of this.sprites.values()) {
      const dx = sprite.tx - sprite.x;
      const dy = sprite.ty - sprite.y;
      if (Math.abs(dx) > 0.35 || Math.abs(dy) > 0.35) {
        sprite.x += dx * 0.24;
        sprite.y += dy * 0.24;
        stillMoving = true;
      } else {
        sprite.x = sprite.tx;
        sprite.y = sprite.ty;
      }
    }

    // 3. 绘制社会关系连边（大人口自动收敛为仅绘制焦点/化身个体连边，保证 60fps 丝滑）
    const focusId = this.hoveredAgentId ?? this.selectedAgentId ?? this.avatarId;
    const totalAlive = classAlive.reduce((a, b) => a + b, 0);
    const drawGlobalEdges = this.showAllEdges && totalAlive <= 140;

    for (const agent of this.state.society.agents) {
      if (!agent.alive) continue;
      const spA = this.sprites.get(agent.id);
      if (spA === undefined) continue;
      for (const neighborId of agent.ties) {
        if (agent.id >= neighborId) continue;
        const isFocusedEdge = focusId !== null && (agent.id === focusId || neighborId === focusId);
        if (!drawGlobalEdges && !isFocusedEdge) continue;
        const spB = this.sprites.get(neighborId);
        if (spB === undefined || !spB.alive) continue;
        const cross = spA.classIndex !== spB.classIndex;
        ctx.beginPath();
        if (cross) {
          const midX = (spA.x + spB.x) * 0.5 + (spA.y - spB.y) * 0.12;
          const midY = (spA.y + spB.y) * 0.5;
          ctx.moveTo(spA.x, spA.y);
          ctx.quadraticCurveTo(midX, midY, spB.x, spB.y);
          ctx.strokeStyle = isFocusedEdge
            ? 'rgba(245, 158, 11, 0.85)'
            : isPaper
              ? 'rgba(217, 119, 6, 0.22)'
              : 'rgba(245, 158, 11, 0.18)';
        } else {
          ctx.moveTo(spA.x, spA.y);
          ctx.lineTo(spB.x, spB.y);
          ctx.strokeStyle = isFocusedEdge
            ? 'rgba(56, 189, 248, 0.85)'
            : isPaper
              ? 'rgba(100, 116, 139, 0.16)'
              : 'rgba(148, 163, 184, 0.12)';
        }
        ctx.lineWidth = isFocusedEdge ? 1.8 : 0.9;
        ctx.stroke();
      }
    }

    // 4. 绘制实时行动流光粒子（升降阶轨迹、竞争闪电弧）
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const fx = this.effects[i];
      if (fx === undefined) continue;
      const alpha = fx.ttl / fx.maxTtl;
      ctx.save();
      if (fx.kind === 'compete') {
        ctx.strokeStyle = `rgba(192, 132, 252, ${(alpha * 0.85).toFixed(2)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(fx.fromX, fx.fromY);
        ctx.lineTo(fx.toX, fx.toY);
        ctx.stroke();
      } else {
        const ringColor =
          fx.kind === 'ascend'
            ? `rgba(56, 189, 248, ${(alpha * 0.9).toFixed(2)})`
            : `rgba(251, 146, 60, ${(alpha * 0.9).toFixed(2)})`;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(fx.toX, fx.toY, 6 + (1 - alpha) * 16, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      fx.ttl -= 1;
      if (fx.ttl <= 0) {
        this.effects.splice(i, 1);
      } else {
        stillMoving = true;
      }
    }

    // 5. 绘制智能体精灵节点与生命弧（支持 Focus Dimming 聚光灯）
    const focusAgent =
      focusId === null ? undefined : this.state.society.agents.find((a) => a.id === focusId);
    const focusNeighbors = new Set<string>(focusAgent?.ties ?? []);
    const hasFocus = focusId !== null && focusAgent !== undefined && focusAgent.alive;

    for (const agent of this.state.society.agents) {
      const sp = this.sprites.get(agent.id);
      if (sp === undefined || !agent.alive) continue;
      const color = palette[agent.classIndex] ?? '#38bdf8';
      const isSelected = agent.id === this.selectedAgentId;
      const isHovered = agent.id === this.hoveredAgentId;
      const isAvatar = agent.id === this.avatarId;
      const inFocusScope = !hasFocus || agent.id === focusId || focusNeighbors.has(agent.id);

      // 濒临跌落琥珀预警光环
      if (
        inFocusScope &&
        agent.belowNeedStreak >= Math.max(3, Math.floor(config.need.belowNeedLimit * 0.5))
      ) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.65)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 主圆体
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = !inFocusScope ? 0.24 : isSelected || isHovered || isAvatar ? 1 : 0.88;
      ctx.fill();
      ctx.globalAlpha = 1;

      // 生命余量外弧（人口 <= 250 时绘制精细弧线）
      if (totalAlive <= 250 && agent.initialLife > 0) {
        const lifeFrac = Math.min(1, Math.max(0, agent.remainingLife / agent.initialLife));
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.radius + 2.1, -Math.PI / 2, -Math.PI / 2 + lifeFrac * Math.PI * 2);
        ctx.strokeStyle = isPaper ? 'rgba(15, 23, 42, 0.35)' : 'rgba(241, 245, 249, 0.42)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      // 焦点 / 化身星环高亮
      if (isAvatar) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.2;
        ctx.stroke();
      } else if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 6. 竞争瞄准预演弧线（悬停底部竞争卡时高亮目标）
    if (this.previewTargetId !== null && this.avatarId !== null) {
      const src = this.sprites.get(this.avatarId);
      const dst = this.sprites.get(this.previewTargetId);
      if (src !== undefined && dst !== undefined && src.alive && dst.alive) {
        ctx.save();
        const midX = (src.x + dst.x) * 0.5;
        const midY = (src.y + dst.y) * 0.5 - Math.max(24, Math.abs(src.x - dst.x) * 0.18);
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.quadraticCurveTo(midX, midY, dst.x, dst.y);
        ctx.strokeStyle = isPaper ? '#7c3aed' : '#c084fc';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([5, 4]);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(dst.x, dst.y, dst.radius + 7, 0, Math.PI * 2);
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
    return stillMoving;
  }
}
