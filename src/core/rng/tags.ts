/**
 * 中央 eventTag 注册表（03 §4.2/§4.4）。
 *
 * - 初始化行为使用 `tick = -1`；
 * - 未在此注册的 tag 不得进入随机地址；新增随机行为必须先注册新 tag，
 *   不得复用含义相近的旧 tag；
 * - 每个 tag 的字符串一经发布即冻结；改名会破坏所有 golden 与回放。
 */
export const RNG_EVENT_TAGS = {
  /** 初始阶级多重集合洗牌；agentId 固定为 "population"。 */
  initClassShuffle: 'init_class_shuffle',
  initGe: 'init_ge',
  initHard: 'init_hard',
  initLife: 'init_life',
  /** 初始年龄；`uniform`/`newborn` 两种模式都消费该地址。 */
  initAge: 'init_age',
  networkInit: 'network_init',
  actionOrder: 'action_order',
  /** 竞争候选：counter 2k 选 local/global 来源，2k+1 选目标。 */
  competitionCandidate: 'competition_candidate',
  mockAction: 'mock_action',
  randomAction: 'random_action',
  /** Jev topK>1 时的加权采样；每次最终响应最多消费一次。 */
  jevTopk: 'jev_topk',
  /** 探索层 descend 权重阈值实验；不进入生产策略。 */
  exploreDescend: 'explore_descend',
  competitionResolve: 'competition_resolve',
  /** 位移准入（rules-v8，D-09）：上升前抽样目标阶级在位者；仅 'class' 参照系消费。 */
  displacementTarget: 'displacement_target',
  /** 位移准入份额（rules-v9，D-11）：决定本次上升走位移还是开放准入；share∈(0,1) 时消费。 */
  displacementAdmit: 'displacement_admit',
  /** 网络重构判定；counter 1 选旧边、counter 2 选新候选（03 §4.4）。 */
  networkRewire: 'network_rewire',
} as const;

export type RngEventTag = (typeof RNG_EVENT_TAGS)[keyof typeof RNG_EVENT_TAGS];

/** 初始化阶段使用的保留 tick（03 §4：初始化使用 tick=-1）。 */
export const RNG_INIT_TICK = -1;

/** 网络初始化/阶级洗牌使用的伪 agent 身份（非人口个体）。 */
export const RNG_POPULATION_ACTOR = 'population';

const REGISTERED_TAGS: ReadonlySet<string> = new Set<string>(Object.values(RNG_EVENT_TAGS));

export function isRegisteredEventTag(tag: string): boolean {
  return REGISTERED_TAGS.has(tag);
}
