import type { RunConfig } from '../config/types.js';
import { computeConfigHash, computeParamsHash } from '../config/hash.js';
import { validateRunConfig } from '../config/validate.js';
import { canonicalize } from '../hash/jcs.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import { asAgentId, asSeed, type AgentId } from '../control/ids.js';
import { STATE_SCHEMA_VERSION } from '../control/versions.js';
import { DEATH_REASONS, type AgentState, type DeathReason } from './agent.js';
import { compareAgentId, type FlowWindowEntry, type SocietyState } from './society.js';
import type { SimState } from './state.js';

export type SerializedAgent = {
  id: string;
  alive: boolean;
  classIndex: number;
  maxClassIndex: number;
  value: number;
  ge: number;
  hard: number;
  initialLife: number;
  remainingLife: number;
  classAge: number;
  baselineSum: number;
  belowNeedStreak: number;
  lastAscentTick: number | null;
  lastDescentTick: number | null;
  ties: string[];
  deathTick: number | null;
  deathReason: DeathReason | null;
};

/**
 * 权威状态的 canonical 序列化形状（`stratify-state-v1`）。
 * 字段集合固定；字段增删或含义变化必须升级 `STATE_SCHEMA_VERSION`。
 */
export interface SerializedSimState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  config: RunConfig;
  configHash: string;
  paramsHash: string;
  seed: string;
  society: {
    tick: number;
    agents: SerializedAgent[];
    eByClass: number[];
    openness: number;
    initialClassShares: number[];
    gini: number;
    segregation: number;
    mUp: number;
    mDown: number;
    edgeCount: number;
    flowWindow: { tick: number; counts: number[][] }[];
    lastOpennessUpdateTick: number;
  };
}

function fail(path: string, message: string): never {
  throw new StratifyError(errorCodes.CONFIG_PATH, message, [{ path }]);
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `${path} 必须为有限数: ${String(value)}`);
  }
  return value;
}

function assertInteger(value: unknown, path: string, min: number, max: number): number {
  const number = assertFiniteNumber(value, path);
  if (!Number.isInteger(number) || number < min || number > max) {
    fail(path, `${path} 必须为 [${min}, ${max}] 内的整数: ${String(number)}`);
  }
  return number;
}

function assertNullableInteger(value: unknown, path: string, min: number): number | null {
  if (value === null) {
    return null;
  }
  return assertInteger(value, path, min, Number.MAX_SAFE_INTEGER);
}

function encodeAgent(agent: AgentState): SerializedAgent {
  return {
    id: agent.id,
    alive: agent.alive,
    classIndex: agent.classIndex,
    maxClassIndex: agent.maxClassIndex,
    value: agent.value,
    ge: agent.ge,
    hard: agent.hard,
    initialLife: agent.initialLife,
    remainingLife: agent.remainingLife,
    classAge: agent.classAge,
    baselineSum: agent.baselineSum,
    belowNeedStreak: agent.belowNeedStreak,
    lastAscentTick: agent.lastAscentTick,
    lastDescentTick: agent.lastDescentTick,
    ties: [...agent.ties].sort(compareAgentId),
    deathTick: agent.deathTick,
    deathReason: agent.deathReason,
  };
}

function decodeAgent(
  raw: unknown,
  path: string,
  classCount: number,
  maxDegree: number,
): AgentState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(path, 'agent 必须是对象');
  }
  const record = raw as Record<string, unknown>;
  const id = asAgentId(record['id'] as string);
  const agentPath = `${path}[${id}]`;
  const alive = record['alive'];
  if (typeof alive !== 'boolean') {
    fail(`${agentPath}.alive`, '必须为布尔值');
  }
  const classIndex = assertInteger(
    record['classIndex'],
    `${agentPath}.classIndex`,
    0,
    classCount - 1,
  );
  const maxClassIndex = assertInteger(
    record['maxClassIndex'],
    `${agentPath}.maxClassIndex`,
    0,
    classCount - 1,
  );
  if (maxClassIndex < classIndex) {
    fail(`${agentPath}.maxClassIndex`, '历史最高阶级不得低于当前阶级');
  }
  const value = assertFiniteNumber(record['value'], `${agentPath}.value`);
  if (value < 0) {
    fail(`${agentPath}.value`, '财富不得为负');
  }
  const ge = assertFiniteNumber(record['ge'], `${agentPath}.ge`);
  const hard = assertFiniteNumber(record['hard'], `${agentPath}.hard`);
  if (ge <= 0 || hard <= 0) {
    fail(`${agentPath}.ge`, 'ge/hard 必须为正数');
  }
  const initialLife = assertFiniteNumber(record['initialLife'], `${agentPath}.initialLife`);
  const remainingLife = assertFiniteNumber(record['remainingLife'], `${agentPath}.remainingLife`);
  if (initialLife <= 0 || remainingLife < 0) {
    fail(`${agentPath}.remainingLife`, 'initialLife 必须为正、remainingLife 不得为负');
  }
  const classAge = assertInteger(
    record['classAge'],
    `${agentPath}.classAge`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const baselineSum = assertFiniteNumber(record['baselineSum'], `${agentPath}.baselineSum`);
  const belowNeedStreak = assertInteger(
    record['belowNeedStreak'],
    `${agentPath}.belowNeedStreak`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const lastAscentTick = assertNullableInteger(
    record['lastAscentTick'],
    `${agentPath}.lastAscentTick`,
    0,
  );
  const lastDescentTick = assertNullableInteger(
    record['lastDescentTick'],
    `${agentPath}.lastDescentTick`,
    0,
  );
  const deathTick = assertNullableInteger(record['deathTick'], `${agentPath}.deathTick`, 0);
  const deathReason = record['deathReason'];
  if (
    deathReason !== null &&
    !(typeof deathReason === 'string' && (DEATH_REASONS as readonly string[]).includes(deathReason))
  ) {
    fail(`${agentPath}.deathReason`, `deathReason 必须为 null 或 ${DEATH_REASONS.join('/')}`);
  }
  if (alive && (deathTick !== null || deathReason !== null)) {
    fail(`${agentPath}.deathTick`, '存活个体的死亡审计字段必须为 null');
  }
  if (!alive && deathTick === null) {
    fail(`${agentPath}.deathTick`, '死亡个体必须携带 deathTick');
  }
  if (!Array.isArray(record['ties'])) {
    fail(`${agentPath}.ties`, '必须为数组');
  }
  const ties: AgentId[] = [];
  for (const entry of record['ties'] as unknown[]) {
    const neighbor = asAgentId(entry as string);
    if (neighbor === id) {
      fail(`${agentPath}.ties`, '不得自连');
    }
    if (ties.includes(neighbor)) {
      fail(`${agentPath}.ties`, '不得有重边');
    }
    ties.push(neighbor);
  }
  if (ties.length > maxDegree) {
    fail(`${agentPath}.ties`, `度 ${ties.length} 超过 maxDegree ${maxDegree}`);
  }
  return {
    id,
    alive,
    classIndex,
    maxClassIndex,
    value,
    ge,
    hard,
    initialLife,
    remainingLife,
    classAge,
    baselineSum,
    belowNeedStreak,
    lastAscentTick,
    lastDescentTick,
    ties,
    deathTick,
    deathReason: alive ? null : (deathReason as DeathReason),
  };
}

/** 权威状态 → plain JSON（深拷贝；`agents` 按 id 升序写出）。 */
export function encodeSimState(state: SimState): SerializedSimState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    // canonicalize 保证 config 为纯 JSON；JSON round-trip 提供深拷贝且不依赖运行时全局。
    config: JSON.parse(canonicalize(state.config)) as RunConfig,
    configHash: state.configHash,
    paramsHash: state.paramsHash,
    seed: state.seed,
    society: {
      tick: state.society.tick,
      agents: state.society.agents.map(encodeAgent),
      eByClass: [...state.society.eByClass],
      openness: state.society.openness,
      initialClassShares: [...state.society.initialClassShares],
      gini: state.society.gini,
      segregation: state.society.segregation,
      mUp: state.society.mUp,
      mDown: state.society.mDown,
      edgeCount: state.society.edgeCount,
      flowWindow: state.society.flowWindow.map((entry) => ({
        tick: entry.tick,
        counts: entry.counts.map((row) => [...row]),
      })),
      lastOpennessUpdateTick: state.society.lastOpennessUpdateTick,
    },
  };
}

function decodeFlowWindow(raw: unknown, path: string, classCount: number): FlowWindowEntry[] {
  if (!Array.isArray(raw)) {
    fail(`${path}.flowWindow`, '必须为数组');
  }
  const entries: FlowWindowEntry[] = [];
  for (const [index, item] of (raw as unknown[]).entries()) {
    const entryPath = `${path}.flowWindow[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(entryPath, '必须是对象');
    }
    const record = item as Record<string, unknown>;
    const tick = assertInteger(record['tick'], `${entryPath}.tick`, 0, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(record['counts']) || record['counts'].length !== classCount) {
      fail(`${entryPath}.counts`, `flowWindow ${entryPath}.counts 必须为长度 ${classCount} 的矩阵`);
    }
    const counts: number[][] = [];
    for (const [from, row] of (record['counts'] as unknown[]).entries()) {
      if (!Array.isArray(row) || row.length !== classCount) {
        fail(`${entryPath}.counts[${from}]`, `必须为长度 ${classCount} 的行`);
      }
      counts.push(
        (row as unknown[]).map((cell, to) =>
          assertInteger(cell, `${entryPath}.counts[${from}][${to}]`, 0, Number.MAX_SAFE_INTEGER),
        ),
      );
    }
    entries.push({ tick, counts });
  }
  return entries;
}

/**
 * plain JSON → 权威状态。这是导入/恢复的信任边界：
 * 结构、有限性、范围、关系与网络不变量全部校验，失败抛路径化 `StratifyError`。
 */
export function decodeSimState(value: unknown): SimState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('$', '状态必须是对象');
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== STATE_SCHEMA_VERSION) {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知状态 schemaVersion: ${String(record['schemaVersion'])}`,
    );
  }
  const configResult = validateRunConfig(record['config']);
  if (!configResult.ok) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, '内嵌配置未通过校验', configResult.issues);
  }
  const validatedConfig: RunConfig = configResult.config;
  const seed = asSeed(record['seed'] as string);
  const societyRaw = record['society'];
  if (typeof societyRaw !== 'object' || societyRaw === null || Array.isArray(societyRaw)) {
    fail('$.society', '必须是对象');
  }
  const societyRecord = societyRaw as Record<string, unknown>;
  const classCount = validatedConfig.population.classCount;
  const tick = assertInteger(societyRecord['tick'], '$.society.tick', 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(societyRecord['agents'])) {
    fail('$.society.agents', '必须为数组');
  }
  const agents: AgentState[] = (societyRecord['agents'] as unknown[]).map((raw) =>
    decodeAgent(raw, `$.society.agents`, classCount, validatedConfig.network.maxDegree),
  );
  agents.sort((a, b) => compareAgentId(a.id, b.id));
  for (let index = 1; index < agents.length; index += 1) {
    if (agents[index]?.id === agents[index - 1]?.id) {
      fail(`$.society.agents[${index}].id`, 'agentId 重复');
    }
  }
  if (
    !Array.isArray(societyRecord['eByClass']) ||
    societyRecord['eByClass'].length !== classCount
  ) {
    fail('$.society.eByClass', `eByClass 必须为长度 ${classCount} 的数组`);
  }
  const eByClass = (societyRecord['eByClass'] as unknown[]).map((cell, index) => {
    const number = assertFiniteNumber(cell, `$.society.eByClass[${index}]`);
    if (number <= 0) {
      fail(`$.society.eByClass[${index}]`, 'E 必须为正数');
    }
    return number;
  });
  if (
    !Array.isArray(societyRecord['initialClassShares']) ||
    societyRecord['initialClassShares'].length !== classCount
  ) {
    fail('$.society.initialClassShares', `initialClassShares 必须为长度 ${classCount} 的数组`);
  }
  const initialClassShares = (societyRecord['initialClassShares'] as unknown[]).map(
    (cell, index) => {
      const number = assertFiniteNumber(cell, `$.society.initialClassShares[${index}]`);
      if (number < 0) {
        fail(`$.society.initialClassShares[${index}]`, 'initialClassShares 不得为负');
      }
      return number;
    },
  );
  const gini = assertFiniteNumber(societyRecord['gini'], '$.society.gini');
  const segregation = assertFiniteNumber(societyRecord['segregation'], '$.society.segregation');
  const mUp = assertFiniteNumber(societyRecord['mUp'], '$.society.mUp');
  const mDown = assertFiniteNumber(societyRecord['mDown'], '$.society.mDown');
  const openness = assertFiniteNumber(societyRecord['openness'], '$.society.openness');
  const edgeCount = assertInteger(
    societyRecord['edgeCount'],
    '$.society.edgeCount',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (gini < 0 || gini > 1) fail('$.society.gini', 'G 必须位于 [0,1]');
  if (segregation < -1 || segregation > 1) fail('$.society.segregation', 'S 必须位于 [-1,1]');
  if (mUp < 0 || mUp > 1) fail('$.society.mUp', 'Mup 必须位于 [0,1]');
  if (mDown < 0 || mDown > 1) fail('$.society.mDown', 'Mdown 必须位于 [0,1]');
  if (openness < 0 || openness > 1) fail('$.society.openness', 'O 必须位于 [0,1]');
  const lastOpennessUpdateTick = assertInteger(
    societyRecord['lastOpennessUpdateTick'],
    '$.society.lastOpennessUpdateTick',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (lastOpennessUpdateTick > tick) {
    fail('$.society.lastOpennessUpdateTick', 'lastOpennessUpdateTick 不得晚于当前 tick');
  }
  const flowWindow = decodeFlowWindow(societyRecord['flowWindow'], '$.society', classCount);
  for (const entry of flowWindow) {
    if (entry.tick >= tick) {
      fail(`$.society.flowWindow`, '窗口条目必须早于当前 tick');
    }
  }

  const society: SocietyState = {
    tick,
    agents,
    eByClass,
    openness,
    initialClassShares,
    gini,
    segregation,
    mUp,
    mDown,
    edgeCount,
    flowWindow,
    lastOpennessUpdateTick,
  };
  const state: SimState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    config: validatedConfig,
    configHash: record['configHash'] as string,
    paramsHash: record['paramsHash'] as string,
    seed,
    society,
  };
  // 关系网络不变量：对称、无自连/重边（自连/重边已在 agent 级拒绝）。
  const neighborSets = new Map<AgentId, Set<AgentId>>();
  for (const agent of agents) {
    neighborSets.set(agent.id, new Set(agent.ties));
  }
  for (const agent of agents) {
    for (const neighbor of agent.ties) {
      if (!neighborSets.get(neighbor)?.has(agent.id)) {
        fail(`$.society.agents[${agent.id}].ties`, `关系不对称: ${agent.id}-${neighbor}`);
      }
    }
    if (!agent.alive && agent.ties.length > 0) {
      fail(`$.society.agents[${agent.id}].ties`, '死亡个体不得保留关系');
    }
    if (agent.lastAscentTick !== null && agent.lastAscentTick >= tick) {
      fail(`$.society.agents[${agent.id}].lastAscentTick`, 'lastAscentTick 不得晚于当前 tick');
    }
    if (agent.lastDescentTick !== null && agent.lastDescentTick >= tick) {
      fail(`$.society.agents[${agent.id}].lastDescentTick`, 'lastDescentTick 不得晚于当前 tick');
    }
  }
  // configHash/paramsHash 必须与内嵌配置重算一致：拒绝被篡改或跨配置拼接的状态。
  if (state.configHash !== computeConfigHash(validatedConfig)) {
    fail('$.configHash', 'configHash 与内嵌配置重算结果不一致');
  }
  if (state.paramsHash !== computeParamsHash(validatedConfig)) {
    fail('$.paramsHash', 'paramsHash 与内嵌配置重算结果不一致');
  }
  return state;
}

/** 深拷贝权威状态；用于微扰克隆与 step 的输入隔离。 */
export function cloneSimState(state: SimState): SimState {
  return decodeSimState(encodeSimState(state));
}
