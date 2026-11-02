import type { RunConfig } from '../../src/core/config/types.js';
import { errorCodes, StratifyError } from '../../src/core/control/errors.js';
import type { SimState } from '../../src/core/model/state.js';

/**
 * 03 §7 全部不变量的测试断言器。任何失败抛 `StratifyError`，
 * 由 fast-check 缩小并报告最小反例。
 */
export function assertInvariants(state: SimState): void {
  const config = state.config;
  const classCount = config.population.classCount;
  const maxDegree = config.network.maxDegree;
  const society = state.society;

  const fail = (message: string): never => {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, message);
  };

  if (society.tick < 0 || !Number.isInteger(society.tick)) fail('tick 非法');
  if (!(society.openness >= 0 && society.openness <= 1)) fail(`O 越界: ${society.openness}`);
  if (!(society.gini >= 0 && society.gini <= 1)) fail(`G 越界: ${society.gini}`);
  if (!(society.segregation >= -1 && society.segregation <= 1))
    fail(`S 越界: ${society.segregation}`);
  if (!(society.mUp >= 0 && society.mUp <= 1)) fail(`Mup 越界: ${society.mUp}`);
  if (!(society.mDown >= 0 && society.mDown <= 1)) fail(`Mdown 越界: ${society.mDown}`);
  if (!(society.edgeCount >= 0)) fail('edgeCount 为负');
  if (society.lastOpennessUpdateTick > society.tick) fail('lastOpennessUpdateTick 超前');
  for (const [index, e] of society.eByClass.entries()) {
    if (!Number.isFinite(e) || e <= 0) fail(`E[${index}] 非正或非有限`);
  }

  const ids = new Set<string>();
  for (const agent of society.agents) {
    if (ids.has(agent.id)) fail(`agentId 重复: ${agent.id}`);
    ids.add(agent.id);
    if (!Number.isFinite(agent.value) || agent.value < 0) fail(`Value 非法: ${agent.value}`);
    if (!Number.isFinite(agent.remainingLife) || agent.remainingLife < 0)
      fail('remainingLife 非法');
    if (!Number.isFinite(agent.baselineSum) || agent.baselineSum < 0) fail('baselineSum 非法');
    if (!Number.isFinite(agent.ge) || agent.ge <= 0) fail('ge 非法');
    if (!Number.isFinite(agent.hard) || agent.hard <= 0) fail('hard 非法');
    if (!(agent.classIndex >= 0 && agent.classIndex < classCount)) fail('classIndex 越界');
    if (!(agent.maxClassIndex >= agent.classIndex && agent.maxClassIndex < classCount)) {
      fail('maxClassIndex 非法');
    }
    if (agent.classAge < 0 || agent.belowNeedStreak < 0) fail('classAge/streak 为负');
    if (agent.lastAscentTick !== null && agent.lastAscentTick >= society.tick)
      fail('lastAscentTick 超前');
    if (agent.lastDescentTick !== null && agent.lastDescentTick >= society.tick)
      fail('lastDescentTick 超前');
    if (agent.alive && (agent.deathTick !== null || agent.deathReason !== null)) {
      fail('存活个体带死亡审计');
    }
    if (!agent.alive && agent.deathTick === null) fail('死亡个体缺 deathTick');
    if (!agent.alive && agent.ties.length > 0) fail('死亡个体保留关系');
    if (agent.ties.length > maxDegree) fail(`度超上限: ${agent.ties.length}`);
    if (new Set(agent.ties).size !== agent.ties.length) fail('重边');
    if (agent.ties.includes(agent.id)) fail('自连');
  }

  const byId = new Map(society.agents.map((agent) => [agent.id, agent]));
  let edgeCount = 0;
  for (const agent of society.agents) {
    for (const neighbor of agent.ties) {
      const other = byId.get(neighbor);
      if (other === undefined) fail(`邻居不存在: ${neighbor}`);
      if (!other?.ties.includes(agent.id)) fail('关系不对称');
      if (agent.alive && other?.alive) edgeCount += 1;
    }
  }
  if (edgeCount / 2 !== society.edgeCount) {
    fail(`edgeCount 不一致: state=${society.edgeCount} 实际=${edgeCount / 2}`);
  }
}

/** 事件级不变量：before+delta=after，after>=0，竞争 gain<=loss。 */
export function assertEventInvariants(
  events: readonly {
    type: string;
    agentId?: string;
    before?: number;
    delta?: number;
    after?: number;
    loss?: number;
    gain?: number;
  }[],
): void {
  for (const event of events) {
    if (event.type === 'wealth_changed') {
      if (event.before === undefined || event.delta === undefined || event.after === undefined) {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'wealth_changed 缺字段');
      }
      if (
        Math.abs(event.before + event.delta - event.after) >
        1e-9 * Math.max(1, Math.abs(event.after))
      ) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `wealth_changed 不守恒: ${JSON.stringify(event)}`,
        );
      }
      if (event.after < 0) {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'wealth 变负');
      }
    }
    if (event.type === 'competition_resolved') {
      if (
        event.loss !== undefined &&
        event.gain !== undefined &&
        event.gain > event.loss + 1e-12 * Math.max(1, event.loss)
      ) {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'gain > loss');
      }
    }
  }
}

/** 校验配置合法（用于性质测试生成的配置自检）。 */
export function assertValidConfig(config: RunConfig): void {
  if (
    !Number.isInteger(config.population.initialPopulation) ||
    config.population.initialPopulation < 2
  ) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '人口非法');
  }
}
