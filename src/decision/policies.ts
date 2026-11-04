import { decideMockWeighted, POLICY_VERSION_MOCK } from './mock.js';
import type { DecisionInput, DecisionPolicy } from './policy.js';
import { decideRandomUniform, POLICY_VERSION_RANDOM } from './random.js';
import type { DecisionRecord } from './types.js';

/**
 * P2-01：内置确定性策略的 Policy 适配器。
 *
 * 它们与 `mock.ts` / `random.ts` 的纯函数逐位一致；适配器的意义是让
 * `runSingleWithPolicy` 与 live/replay 共用同一接口，从而真正实现「可替换」。
 * 两者都是同步实现（不读取网络），live 策略的 `decide` 返回 Promise。
 */

export class MockPolicy implements DecisionPolicy {
  readonly policyVersion = POLICY_VERSION_MOCK;

  decide(input: DecisionInput): DecisionRecord {
    return decideMockWeighted({
      runId: input.runId,
      seed: input.seed,
      state: input.simState,
      agentId: input.agentId,
      stateHash: input.stateHash,
      actionSetHash: input.actionSetHash,
      legal: input.legal,
    });
  }
}

export class RandomPolicy implements DecisionPolicy {
  readonly policyVersion = POLICY_VERSION_RANDOM;

  decide(input: DecisionInput): DecisionRecord {
    return decideRandomUniform({
      runId: input.runId,
      seed: input.seed,
      state: input.simState,
      agentId: input.agentId,
      stateHash: input.stateHash,
      actionSetHash: input.actionSetHash,
      legal: input.legal,
    });
  }
}
