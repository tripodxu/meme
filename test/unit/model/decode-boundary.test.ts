import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { decodeSimState, encodeSimState } from '../../../src/core/model/serialize.js';

const SEED = asSeed('decode-boundary-seed');

function base(): Record<string, unknown> {
  const state = createSimulation(DEFAULT_RUN_CONFIG, SEED);
  return JSON.parse(JSON.stringify(encodeSimState(state))) as Record<string, unknown>;
}

function agentsOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  return (doc['society'] as Record<string, unknown>)['agents'] as Record<string, unknown>[];
}

function societyOf(doc: Record<string, unknown>): Record<string, unknown> {
  return doc['society'] as Record<string, unknown>;
}

describe('decodeSimState 边界校验', () => {
  it('合法状态通过', () => {
    expect(() => decodeSimState(base())).not.toThrow();
  });

  it('顶层结构拒绝', () => {
    expect(() => decodeSimState(null)).toThrowError(/状态必须是对象/);
    expect(() => decodeSimState([1])).toThrowError(/状态必须是对象/);
    expect(() => decodeSimState({ schemaVersion: 'stratify-state-v1' })).toThrowError();
  });

  it('society 结构拒绝', () => {
    const doc = base();
    (doc as Record<string, unknown>)['society'] = 5;
    expect(() => decodeSimState(doc)).toThrowError(/必须是对象/);

    const doc2 = base();
    societyOf(doc2)['agents'] = 'nope';
    expect(() => decodeSimState(doc2)).toThrowError(/必须为数组/);

    const doc3 = base();
    societyOf(doc3)['tick'] = -1;
    expect(() => decodeSimState(doc3)).toThrowError(/整数/);
  });

  it('agentId 重复拒绝', () => {
    const doc = base();
    const agents = agentsOf(doc);
    if (agents.length < 2) throw new Error('roster 过小');
    agents[1]!['id'] = agents[0]!['id'];
    expect(() => decodeSimState(doc)).toThrowError(/agentId 重复/);
  });

  it('agent 字段域校验', () => {
    const doc = base();
    const agents = agentsOf(doc);
    const first = agents[0];
    if (first === undefined) throw new Error('roster 为空');

    const badClass = structuredCloneFrom(doc);
    agentsOf(badClass)[0]!['classIndex'] = 9;
    expect(() => decodeSimState(badClass)).toThrowError(/classIndex/);

    const badMax = structuredCloneFrom(doc);
    agentsOf(badMax)[0]!['maxClassIndex'] = 0;
    agentsOf(badMax)[0]!['classIndex'] = 1;
    expect(() => decodeSimState(badMax)).toThrowError(/历史最高阶级/);

    const badGe = structuredCloneFrom(doc);
    agentsOf(badGe)[0]!['ge'] = 0;
    expect(() => decodeSimState(badGe)).toThrowError(/ge\/hard/);

    const badLife = structuredCloneFrom(doc);
    agentsOf(badLife)[0]!['remainingLife'] = -0.5;
    expect(() => decodeSimState(badLife)).toThrowError(/remainingLife/);

    const badDeathReason = structuredCloneFrom(doc);
    agentsOf(badDeathReason)[0]!['deathReason'] = 'starvation';
    expect(() => decodeSimState(badDeathReason)).toThrowError(/deathReason/);

    const badTies = structuredCloneFrom(doc);
    agentsOf(badTies)[0]!['ties'] = 'x';
    expect(() => decodeSimState(badTies)).toThrowError(/必须为数组/);

    const selfTie = structuredCloneFrom(doc);
    const firstId = agentsOf(selfTie)[0]!['id'];
    agentsOf(selfTie)[0]!['ties'] = [firstId];
    expect(() => decodeSimState(selfTie)).toThrowError(/不得自连/);

    const dupTie = structuredCloneFrom(doc);
    agentsOf(dupTie)[0]!['ties'] = ['a-0001', 'a-0001'];
    expect(() => decodeSimState(dupTie)).toThrowError(/不得有重边/);
  });

  it('度超过 maxDegree 拒绝', () => {
    const config = createDemoConfig({ network: { maxDegree: 1, initialDegree: 1 } });
    const state = createSimulation(config, SEED);
    const doc = JSON.parse(JSON.stringify(encodeSimState(state))) as Record<string, unknown>;
    const agents = agentsOf(doc);
    for (const agent of agents) {
      agent['ties'] = ['a-0000', 'a-0001', 'a-0002'].filter((id) => id !== agent['id']);
    }
    expect(() => decodeSimState(doc)).toThrowError(/maxDegree/);
  });

  it('宏观值域校验', () => {
    const badGini = structuredCloneFrom(base());
    societyOf(badGini)['gini'] = 1.5;
    expect(() => decodeSimState(badGini)).toThrowError(/G 必须位于/);

    const badS = structuredCloneFrom(base());
    societyOf(badS)['segregation'] = -1.5;
    expect(() => decodeSimState(badS)).toThrowError(/S 必须位于/);

    const badMup = structuredCloneFrom(base());
    societyOf(badMup)['mUp'] = 2;
    expect(() => decodeSimState(badMup)).toThrowError(/Mup 必须位于/);

    const badMdown = structuredCloneFrom(base());
    societyOf(badMdown)['mDown'] = -0.1;
    expect(() => decodeSimState(badMdown)).toThrowError(/Mdown 必须位于/);

    const badOpenness = structuredCloneFrom(base());
    societyOf(badOpenness)['openness'] = 1.1;
    expect(() => decodeSimState(badOpenness)).toThrowError(/O 必须位于/);

    const badEdgeCount = structuredCloneFrom(base());
    societyOf(badEdgeCount)['edgeCount'] = -1;
    expect(() => decodeSimState(badEdgeCount)).toThrowError(/edgeCount/);

    const badLastOpenness = structuredCloneFrom(base());
    societyOf(badLastOpenness)['lastOpennessUpdateTick'] = 99;
    expect(() => decodeSimState(badLastOpenness)).toThrowError(/lastOpennessUpdateTick/);

    const badE = structuredCloneFrom(base());
    societyOf(badE)['eByClass'] = [1, 1, 1, 1];
    expect(() => decodeSimState(badE)).toThrowError(/eByClass/);

    const badP0 = structuredCloneFrom(base());
    societyOf(badP0)['initialClassShares'] = [-1, 1, 1, 1, 1];
    expect(() => decodeSimState(badP0)).toThrowError(/initialClassShares/);
  });

  it('flowWindow 结构与窗口时序校验', () => {
    const badShape = structuredCloneFrom(base());
    societyOf(badShape)['flowWindow'] = [{ tick: 0, counts: [[1]] }];
    expect(() => decodeSimState(badShape)).toThrowError(/flowWindow/);

    const futureTick = structuredCloneFrom(base());
    societyOf(futureTick)['flowWindow'] = [
      {
        tick: 5,
        counts: [
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      },
    ];
    expect(() => decodeSimState(futureTick)).toThrowError(/早于当前 tick/);
  });

  it('configHash/paramsHash 与内嵌配置不一致时拒绝', () => {
    const doc = base();
    doc['configHash'] = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(() => decodeSimState(doc)).toThrowError(/configHash/);

    const doc2 = base();
    doc2['paramsHash'] = 'not-a-hash';
    expect(() => decodeSimState(doc2)).toThrowError(/paramsHash/);
  });

  it('agent 非对象与非布尔 alive 拒绝', () => {
    const notObject = structuredCloneFrom(base());
    agentsOf(notObject)[0] = 'agent' as unknown as Record<string, unknown>;
    expect(() => decodeSimState(notObject)).toThrowError(/agent 必须是对象/);

    const badAlive = structuredCloneFrom(base());
    agentsOf(badAlive)[0]!['alive'] = 1;
    expect(() => decodeSimState(badAlive)).toThrowError(/必须为布尔值/);
  });

  it('存活个体携带死亡审计字段拒绝', () => {
    const doc = structuredCloneFrom(base());
    const agent = agentsOf(doc)[0]!;
    agent['deathTick'] = 0;
    agent['deathReason'] = 'age';
    expect(() => decodeSimState(doc)).toThrowError(/存活个体/);
  });

  it('flowWindow 非数组/元素非对象/行非法拒绝', () => {
    const notArray = structuredCloneFrom(base());
    societyOf(notArray)['flowWindow'] = 'x';
    expect(() => decodeSimState(notArray)).toThrowError(/必须为数组/);

    const badEntry = structuredCloneFrom(base());
    societyOf(badEntry)['flowWindow'] = ['entry'];
    expect(() => decodeSimState(badEntry)).toThrowError(/必须是对象/);

    const badRow = structuredCloneFrom(base());
    societyOf(badRow)['flowWindow'] = [{ tick: 0, counts: ['row', 0, 0, 0, 0] }];
    expect(() => decodeSimState(badRow)).toThrowError(/必须为长度 5 的行/);
  });

  it('initialClassShares 非数组拒绝；合法窗口条目可解码', () => {
    const notArray = structuredCloneFrom(base());
    societyOf(notArray)['initialClassShares'] = 'x';
    expect(() => decodeSimState(notArray)).toThrowError(/initialClassShares/);

    const withWindow = structuredCloneFrom(base());
    const society = societyOf(withWindow);
    society['tick'] = 10;
    society['flowWindow'] = [
      {
        tick: 3,
        counts: [
          [0, 1, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      },
    ];
    agentsOf(withWindow)[0]!['lastAscentTick'] = 4;
    agentsOf(withWindow)[1]!['lastDescentTick'] = 5;
    expect(() => decodeSimState(withWindow)).not.toThrow();
  });

  it('lastAscent/DescentTick 晚于当前 tick 拒绝', () => {
    const doc = structuredCloneFrom(base());
    societyOf(doc)['tick'] = 10;
    agentsOf(doc)[0]!['lastAscentTick'] = 11;
    expect(() => decodeSimState(doc)).toThrowError(/lastAscentTick/);

    const doc2 = structuredCloneFrom(base());
    societyOf(doc2)['tick'] = 10;
    agentsOf(doc2)[0]!['lastDescentTick'] = 12;
    expect(() => decodeSimState(doc2)).toThrowError(/lastDescentTick/);
  });
});

function structuredCloneFrom(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
