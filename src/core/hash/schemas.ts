import { HASH_DOMAINS } from './domains.js';

/**
 * 02 §8 要求每个语义 hash domain 提供字段级 canonical 输入 schema：
 * 字段名、可选性、null、数组顺序与排除字段。本表是文档化的机器可读形式，
 * 由 `test/golden/hash-domain-vectors.test.ts` 断言与 fixture 向量配套。
 *
 * 通用排除项（适用于所有 domain）：`seed`（除 initialPopulation）、API Key、
 * writeToken、wall-clock、日志与视图缓存。
 */
export interface FieldSchema {
  readonly name: string;
  readonly type: 'number' | 'string' | 'boolean' | 'null' | 'array' | 'object';
  /** 数组元素或对象字段的子 schema。 */
  readonly fields?: readonly FieldSchema[];
  readonly nullable?: boolean;
  /** 数组/对象的规范化顺序语义。 */
  readonly ordering?:
    | 'agentIdAscending'
    | 'lexicographic'
    | 'pairSorted'
    | 'requestOrder'
    | 'kindChunkIdSorted'
    | 'none';
  readonly description: string;
}

export interface DomainSchema {
  readonly domain: string;
  readonly fields: readonly FieldSchema[];
  readonly notes: string;
}

export const HASH_DOMAIN_INPUT_SCHEMAS: readonly DomainSchema[] = [
  {
    domain: HASH_DOMAINS.config,
    fields: [
      {
        name: '(RunConfig 全文)',
        type: 'object',
        ordering: 'none',
        description: '完整冻结 RunConfig；排除 seed/Key/token/wall-clock。',
      },
    ],
    notes:
      'configHash 覆盖完整冻结 RunConfig；schemaVersion/rulesVersion/schedule/metrics 全部纳入。',
  },
  {
    domain: HASH_DOMAINS.params,
    fields: [
      {
        name: '[]',
        type: 'array',
        ordering: 'lexicographic',
        description: '参数快照条目数组，按 name 升序。',
        fields: [
          { name: 'name', type: 'string', description: '注册参数点路径。' },
          { name: 'unit', type: 'string', description: '参数单位。' },
          { name: 'value', type: 'number', description: '解析后的参数值。' },
        ],
      },
    ],
    notes: 'paramsHash 覆盖注册表解析后的全部业务参数名、值与单位。',
  },
  {
    domain: HASH_DOMAINS.initialPopulation,
    fields: [
      { name: 'seed', type: 'string', description: 'run seed（只有本 domain 覆盖 seed）。' },
      {
        name: 'agents',
        type: 'array',
        ordering: 'agentIdAscending',
        description: '初始个体，按 id 升序；ties 字段不进入本 hash。',
        fields: [
          { name: 'id', type: 'string', description: 'agentId。' },
          { name: 'alive', type: 'boolean', description: '初始恒为 true。' },
          { name: 'classIndex', type: 'number', description: '初始阶级。' },
          { name: 'maxClassIndex', type: 'number', description: '初始等于 classIndex。' },
          { name: 'value', type: 'number', description: '初始 Value=population.initialValue。' },
          { name: 'ge', type: 'number', description: '天赋样本。' },
          { name: 'hard', type: 'number', description: '努力样本。' },
          { name: 'initialLife', type: 'number', description: '初始寿命样本。' },
          { name: 'remainingLife', type: 'number', description: '初始年龄模式应用后的余命。' },
          { name: 'classAge', type: 'number', description: '初始 0。' },
          { name: 'baselineSum', type: 'number', description: '初始 0。' },
          { name: 'belowNeedStreak', type: 'number', description: '初始 0。' },
          { name: 'lastAscentTick', type: 'null', nullable: true, description: '初始 null。' },
          { name: 'lastDescentTick', type: 'null', nullable: true, description: '初始 null。' },
          { name: 'deathTick', type: 'null', nullable: true, description: '初始 null。' },
          { name: 'deathReason', type: 'null', nullable: true, description: '初始 null。' },
        ],
      },
      {
        name: 'ties',
        type: 'array',
        ordering: 'pairSorted',
        description: '初始无向边 [a,b]（a<b），按 (a,b) 字典序升序。',
        fields: [
          { name: '[0]', type: 'string', description: '较小端点 id。' },
          { name: '[1]', type: 'string', description: '较大端点 id。' },
        ],
      },
    ],
    notes: 'initialPopulationHash 由 (config, seed) 纯函数派生的结果决定。',
  },
  {
    domain: HASH_DOMAINS.authoritativeState,
    fields: [
      { name: 'schemaVersion', type: 'string', description: 'stratify-state-v2。' },
      { name: 'config', type: 'object', ordering: 'none', description: '完整冻结 RunConfig。' },
      { name: 'seed', type: 'string', description: 'run seed。' },
      {
        name: 'society',
        type: 'object',
        ordering: 'none',
        description: '社会权威状态。',
        fields: [
          { name: 'tick', type: 'number', description: '下一个待结算 tick。' },
          {
            name: 'agents',
            type: 'array',
            ordering: 'agentIdAscending',
            description: '全部个体（含死亡者），字段同 initialPopulation 另加网络与死亡审计。',
            fields: [
              {
                name: 'ties',
                type: 'array',
                ordering: 'agentIdAscending',
                description: '按 id 升序的关系列表。',
              },
              { name: 'alive', type: 'boolean', description: '存活标记。' },
              {
                name: 'deathTick',
                type: 'null',
                nullable: true,
                description: '死亡 tick 或 null。',
              },
              {
                name: 'deathReason',
                type: 'null',
                nullable: true,
                description: "死亡原因或 null；当前仅 'age'。",
              },
            ],
          },
          { name: 'eByClass', type: 'array', ordering: 'none', description: 'E[C]，阶级序。' },
          {
            name: 'refIncome',
            type: 'array',
            ordering: 'none',
            description:
              '需求参照系 refIncome[C]（rules-v6）：上期各阶级人均收入的 EMA；own 模式保持初始值。',
          },
          { name: 'openness', type: 'number', description: 'O ∈ [0,1]。' },
          {
            name: 'initialClassShares',
            type: 'array',
            ordering: 'none',
            description: 'P0[C] 按实际人数。',
          },
          { name: 'gini', type: 'number', description: 'G ∈ [0,1]。' },
          { name: 'segregation', type: 'number', description: 'S ∈ [-1,1]。' },
          { name: 'mUp', type: 'number', description: 'Mup ∈ [0,1]。' },
          { name: 'mDown', type: 'number', description: 'Mdown ∈ [0,1]。' },
          { name: 'edgeCount', type: 'number', description: '存活网络无向边数。' },
          {
            name: 'flowWindow',
            type: 'array',
            ordering: 'none',
            description: 'flowWindowDays 滚动窗口内按 tick 的转移矩阵，按 tick 升序。',
            fields: [
              { name: 'tick', type: 'number', description: '发生转移的 tick。' },
              {
                name: 'counts',
                type: 'array',
                ordering: 'none',
                description: 'C×C 矩阵，counts[from][to]。',
              },
            ],
          },
          { name: 'lastOpennessUpdateTick', type: 'number', description: '上次 O 更新 tick。' },
        ],
      },
    ],
    notes: 'finalStateHash；事件/决策日志/统计缓存不进入权威状态。',
  },
  {
    domain: HASH_DOMAINS.labelThresholds,
    fields: [
      { name: 'classCount', type: 'number', description: '结构判异固定 C=5。' },
      { name: 'monotonicTolerance', type: 'number', description: '单调性容差（07 §10）。' },
      { name: 'modeTolerance', type: 'number', description: '众数容差。' },
      {
        name: 'labels',
        type: 'object',
        ordering: 'none',
        description:
          '六类标签的完整阈值条件表（pyramid/olive/bipolar/closedStratified/highFlowNetwork/topHeavy）。',
      },
    ],
    notes: 'labelThresholdsHash 与 preregistrationHash 同时覆盖，防止阈值被静默修改。',
  },
  {
    domain: HASH_DOMAINS.decisionState,
    fields: [
      { name: 'schema', type: 'string', description: "常量 'stratify-decision-v1'。" },
      { name: 'tick', type: 'number', description: '当前决策 tick。' },
      { name: 'decisionIntervalDays', type: 'number', description: 'decision.interval。' },
      {
        name: 'self',
        type: 'object',
        ordering: 'none',
        description: '到期个体自身状态（04 §3.2）。',
        fields: [
          { name: 'id', type: 'string', description: 'agentId。' },
          { name: 'classIndex', type: 'number', description: '当前阶级。' },
          { name: 'highestClassEver', type: 'number', description: '历史最高阶级。' },
          { name: 'value', type: 'number', description: '当前财富。' },
          { name: 'talent', type: 'number', description: 'ge。' },
          { name: 'effort', type: 'number', description: 'hard。' },
          { name: 'remainingLifeDays', type: 'number', description: '剩余寿命（日）。' },
          { name: 'daysInClass', type: 'number', description: 'classAge。' },
          {
            name: 'needRatio',
            type: 'number',
            nullable: true,
            description: 'need===0 时为 null，否则 Value/need。',
          },
          { name: 'belowNeedDays', type: 'number', description: 'belowNeedStreak。' },
          { name: 'neighborCount', type: 'number', description: '存活邻居数。' },
        ],
      },
      {
        name: 'society',
        type: 'object',
        ordering: 'none',
        description: '社会摘要。',
        fields: [
          { name: 'openness', type: 'number', description: 'O。' },
          { name: 'gini', type: 'number', description: 'G。' },
          {
            name: 'classPopulationShares',
            type: 'array',
            ordering: 'none',
            description: 'P[c]，长度 C。',
          },
        ],
      },
      {
        name: 'costs',
        type: 'object',
        ordering: 'none',
        description: '实际净额费用；不可用层为 null 且该行动不进入 legalActions。',
        fields: [
          {
            name: 'ascend',
            type: 'number',
            nullable: true,
            description: '含重返减免与开放度乘子的净额。',
          },
          { name: 'descend', type: 'number', nullable: true, description: '主动降阶净额。' },
        ],
      },
      {
        name: 'targets',
        type: 'array',
        ordering: 'none',
        description: '合法竞争目标，最多 candidateCount 个。',
        fields: [
          { name: 'id', type: 'string', description: '目标 agentId。' },
          { name: 'classIndex', type: 'number', description: '目标阶级。' },
          { name: 'value', type: 'number', description: '目标财富。' },
          { name: 'isNeighbor', type: 'boolean', description: '是否当前邻居。' },
        ],
      },
      {
        name: 'recentEvents',
        type: 'array',
        ordering: 'none',
        description:
          '最近 5 条事件，按 (tick,seq)；固定字段 tick/type/actorId/targetId/deltaValue/fromClass/toClass。',
      },
    ],
    notes: 'stateHash 覆盖发给 Jev 的完整序列化 state（P2-02 实现生产者并冻结 JSON Schema）。',
  },
  {
    domain: HASH_DOMAINS.actionSet,
    fields: [
      {
        name: '[]',
        type: 'array',
        ordering: 'requestOrder',
        description:
          'legalActions 字符串数组，按 accumulate<ascend<descend<compete:<id> 稳定排序。',
      },
    ],
    notes: 'actionSetHash 覆盖按请求顺序排列的合法行动键数组。',
  },
  {
    domain: HASH_DOMAINS.tickRow,
    fields: [
      {
        name: '(tick_stats 行)',
        type: 'object',
        ordering: 'none',
        description: '05 §4.3 的完整 tick 聚合行；排除 payloadHash 自身。',
      },
    ],
    notes: 'payloadHash 用于 (runId,tick) 幂等去重；P4 实现生产者。',
  },
  {
    domain: HASH_DOMAINS.agentRow,
    fields: [
      {
        name: '(agent_final 行)',
        type: 'object',
        ordering: 'none',
        description: '05 §4.4 的最终个体行；排除 payloadHash 自身。',
      },
    ],
    notes: 'payloadHash 用于 (runId,agentId) 幂等去重；P4 实现生产者。',
  },
  {
    domain: HASH_DOMAINS.summary,
    fields: [
      {
        name: '(run summary)',
        type: 'object',
        ordering: 'none',
        description: '完成摘要（05 §4.6 complete body 派生视图）；排除 wall-clock。',
      },
    ],
    notes: 'summaryHash 由 runner 在 complete 时计算。',
  },
  {
    domain: HASH_DOMAINS.artifactManifest,
    fields: [
      {
        name: 'chunks',
        type: 'array',
        ordering: 'kindChunkIdSorted',
        description: '按 (kind,chunkId) 排序的分块清单；排除 manifestHash 自身。',
        fields: [
          {
            name: 'kind',
            type: 'string',
            description: 'decisions|events|snapshot|final_state|metrics|manifest。',
          },
          { name: 'chunkId', type: 'string', description: '块 ID。' },
        ],
      },
    ],
    notes: 'artifactManifestHash 由 05 §4.5 清单契约定义。',
  },
  {
    domain: HASH_DOMAINS.preregistration,
    fields: [
      {
        name: 'schemaVersion',
        type: 'string',
        description: 'experiment manifest schema（07 §3）。',
      },
      { name: 'hypothesis', type: 'string', description: '预注册假设。' },
      { name: 'primaryMetric', type: 'string', description: 'TV(P)/G/Mup/Mdown/S/O 之一。' },
      { name: 'experimentType', type: 'string', description: '五类实验之一。' },
      { name: 'rulesVersion', type: 'string', description: '规则版本。' },
      { name: 'engineVersion', type: 'string', description: '引擎版本。' },
      { name: 'decisionSchemaVersion', type: 'string', description: '决策 schema 版本。' },
      { name: 'policyVersion', type: 'string', description: '策略版本。' },
      { name: 'promptVersion', type: 'string', description: 'prompt 版本。' },
      { name: 'promptStyle', type: 'string', description: 'neutral|survival_hint。' },
      { name: 'baseConfigHash', type: 'string', description: 'base config 的 configHash。' },
      { name: 'artifactProfile', type: 'string', description: 'full|metrics-only。' },
      {
        name: 'cells',
        type: 'array',
        ordering: 'none',
        description:
          'cellKey/overrides/fullConfigHash；排除 experimentId/createdAt/observedResponseModels/runtimeVersions 与运行后字段。',
      },
      { name: 'seeds', type: 'array', ordering: 'none', description: '预注册种子列表。' },
      { name: 'pairing', type: 'string', description: '配对方式描述。' },
      { name: 'warmupTicks', type: 'number', description: 'burn-in tick 数。' },
      { name: 'warmupDiagnostic', type: 'string', description: '平稳性诊断描述。' },
      { name: 'windows', type: 'array', ordering: 'none', description: '预注册窗口。' },
      { name: 'labelThresholdVersion', type: 'string', description: 'labels 版本。' },
      { name: 'labelThresholdsHash', type: 'string', description: '完整阈值表 hash。' },
      {
        name: 'budgets',
        type: 'object',
        ordering: 'none',
        description: 'maxRuns/maxWallMinutes/maxStorageBytes。',
      },
    ],
    notes:
      '排除 experimentId、createdAt、observedResponseModels、runtimeVersions、运行结果与失败次数。',
  },
];
